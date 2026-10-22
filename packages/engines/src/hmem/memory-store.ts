// Derived from the Meterless H-MEM reference implementation, Apache-2.0.
// Tiered memory store with enrichment. A record with no source is rejected by construction.
// Enrichment on every add: domain, namespace, entities (cap 10), related records (cap 5, both ways),
// and supersedes detection.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cosine, embed, tokenize } from "./embeddings.js";
import type { TrustLedgerService } from "./trust-ledger.js";
import type { MemoryLayer, MemoryRecord, MemoryType, Provenance } from "./types.js";
import { clamp01, DEFAULTS } from "./types.js";

const TECH_TERMS = [
  "react",
  "python",
  "typescript",
  "javascript",
  "rust",
  "sqlite",
  "postgres",
  "indexeddb",
  "node",
  "docker",
  "graphql",
  "redis",
  "webrtc",
  "tauri",
  "electron",
  "llm",
  "embedding",
];
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  tech: ["code", "bug", "api", "database", "deploy", "framework", "library", "server", ...TECH_TERMS],
  work: ["meeting", "deadline", "client", "project", "sprint", "review", "report"],
  personal: ["family", "hobby", "prefer", "like", "dislike", "morning", "evening"],
};
const CORRECTION = /\b(actually|instead|no longer|not anymore|changed to|correction)\b/i;
const STOP_ENTITIES = new Set(["the", "this", "that", "with"]);

export interface AddInput {
  content: string;
  type?: MemoryType;
  layer?: MemoryLayer;
  tags?: string[];
  confidence?: number;
  source: string;
  provenance?: Provenance;
  chatId?: string;
  missionId?: string;
  goalRunId?: string;
  supersedes?: string;
  derivedFrom?: string[];
}

export function snapshot(r: MemoryRecord): Partial<MemoryRecord> {
  const { embedding: _embedding, ...rest } = structuredClone(r);
  return rest;
}

export class MemoryStoreService {
  private records = new Map<string, MemoryRecord>();
  private seq = 0;
  private readonly stateFile?: string;

  constructor(
    private readonly clock: () => number,
    private readonly ledger: TrustLedgerService,
    private readonly actor: string,
    persistDir?: string,
  ) {
    if (persistDir) {
      mkdirSync(persistDir, { recursive: true });
      this.stateFile = join(persistDir, "state.json");
      if (existsSync(this.stateFile)) {
        const saved = JSON.parse(readFileSync(this.stateFile, "utf-8")) as { seq: number; records: MemoryRecord[] };
        this.seq = saved.seq;
        for (const r of saved.records) this.records.set(r.id, r);
      }
    }
  }

  persist(): void {
    if (!this.stateFile) return;
    const records = [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id));
    writeFileSync(this.stateFile, `${JSON.stringify({ seq: this.seq, records }, null, 2)}\n`, "utf-8");
  }

  add(input: AddInput): MemoryRecord {
    if (!input.source || input.source.trim() === "") {
      throw new Error("H-MEM: a memory record with no source must be rejected by construction");
    }
    const now = this.clock();
    this.seq += 1;
    const id = `mem-${this.seq}`;
    const type = input.type ?? "general";
    const tags = [...(input.tags ?? [])];
    const domain = this.classifyDomain(input.content, tags, type);
    const record: MemoryRecord = {
      id,
      content: input.content,
      type,
      layer: input.layer ?? "working",
      timestamp: now,
      lastAccessed: now,
      accessCount: 0,
      tags,
      embedding: embed(input.content),
      confidence: clamp01(input.confidence ?? 0.7),
      source: input.source,
      provenance: input.provenance ?? { origin: "manual", learnedAt: now, label: input.source },
      chatId: input.chatId,
      missionId: input.missionId,
      goalRunId: input.goalRunId,
      domain,
      namespace: this.namespace(domain, type),
      entities: this.extractEntities(input.content),
      relatedTo: [],
      supersedes: input.supersedes,
      derivedFrom: input.derivedFrom,
    };
    this.discoverRelationships(record);
    this.records.set(id, record);
    this.ledger.log(id, "create", this.actor, { newState: snapshot(record) });
    this.persist();
    return record;
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  all(): MemoryRecord[] {
    return [...this.records.values()];
  }

  update(id: string, patch: Partial<MemoryRecord>): MemoryRecord {
    const rec = this.mustGet(id);
    const prev = snapshot(rec);
    Object.assign(rec, patch);
    this.ledger.log(id, "update", this.actor, { previousState: prev, newState: snapshot(rec) });
    this.persist();
    return rec;
  }

  delete(id: string, reason: string): void {
    const rec = this.mustGet(id);
    this.records.delete(id);
    this.ledger.log(id, "delete", this.actor, { previousState: snapshot(rec), details: { reason } });
    this.persist();
  }

  touch(id: string): void {
    const rec = this.mustGet(id);
    rec.lastAccessed = this.clock();
    rec.accessCount += 1;
  }

  promote(id: string, layer: MemoryLayer): void {
    const rec = this.mustGet(id);
    const prev = snapshot(rec);
    rec.layer = layer;
    this.ledger.log(id, "promote", this.actor, { previousState: prev, newState: snapshot(rec) });
    this.persist();
  }

  restoreAll(records: MemoryRecord[], seq: number): void {
    this.records = new Map(records.map((r) => [r.id, structuredClone(r)]));
    this.seq = seq;
    this.persist();
  }

  snapshotAll(): { records: MemoryRecord[]; seq: number } {
    return { records: structuredClone([...this.records.values()]), seq: this.seq };
  }

  private mustGet(id: string): MemoryRecord {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`H-MEM: unknown memory id ${id}`);
    return rec;
  }

  /** Multi-pass domain classification: explicit tags first, then keyword overlap. */
  classifyDomain(content: string, tags: string[], type: MemoryType): string {
    for (const t of tags) {
      if (t.startsWith("project:")) return t.slice("project:".length);
      if (t.startsWith("tech:")) return "tech";
    }
    const tokens = new Set(tokenize(content));
    let best = "general";
    let bestScore = 0;
    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      let score = keywords.reduce((s, kw) => s + (tokens.has(kw) ? 1 : 0), 0);
      if (domain === "personal" && (type === "personal" || type === "preference")) score += 1;
      if (score > bestScore) {
        best = domain;
        bestScore = score;
      }
    }
    return bestScore > 0 ? best : "general";
  }

  private namespace(domain: string, type: MemoryType): string {
    const bucket = type === "preference" || type === "personal" ? "profile" : type === "factual" ? "facts" : "notes";
    return `${domain}/${bucket}`;
  }

  extractEntities(content: string): string[] {
    const entities = new Set<string>();
    for (const t of tokenize(content)) if (TECH_TERMS.includes(t)) entities.add(t);
    for (const m of content.matchAll(/\b([A-Z][a-zA-Z]{2,})\b/g)) {
      const norm = (m[1] ?? "").toLowerCase();
      if (norm !== "" && !STOP_ENTITIES.has(norm)) entities.add(norm);
    }
    return [...entities].slice(0, DEFAULTS.entityCap);
  }

  private discoverRelationships(record: MemoryRecord): void {
    for (const other of this.records.values()) {
      if (record.relatedTo.length >= DEFAULTS.relatedCap) break;
      const sim = cosine(record.embedding, other.embedding);
      if (!record.supersedes && sim > 0.85 && CORRECTION.test(record.content)) {
        record.supersedes = other.id;
        continue;
      }
      const shared = other.entities.some((e) => record.entities.includes(e));
      if (shared && other.domain === record.domain) this.link(record, other);
    }
  }

  private link(record: MemoryRecord, other: MemoryRecord): void {
    record.relatedTo.push(other.id);
    if (other.relatedTo.length < DEFAULTS.relatedCap && !other.relatedTo.includes(record.id)) {
      other.relatedTo.push(record.id);
    }
  }
}
