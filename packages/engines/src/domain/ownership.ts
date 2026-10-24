import type { ListRelationshipRow } from "@sanctions-desk/data";
import { type Relationship, WorldModel } from "../world-model/index.js";

/**
 * Ownership by listed parties: is a company owned, directly or through a chain of owners, by blocked parties?
 *
 * Two measures are computed, and the threshold is met when either one reaches it:
 *  - OFAC's 50 percent rule (a cascade): a company owned 50 percent or more, in the aggregate, by one or more
 *    blocked parties is itself blocked, and its own holdings then count in full. So if a listed party owns 60% of
 *    a holding company that owns 70% of the customer, the holding company is blocked and the customer, 70% owned
 *    by it, is blocked too. Shares held by several blocked parties are added up when aggregation is on.
 *  - effective (look-through) ownership: along a chain, percentages multiply (70% of 80% is 56%), and separate
 *    paths to the same listed party add up (25% + 25% is 50%) when aggregation is on. It is kept because it shows
 *    each listed party's economic interest, and because counting it as well can only make the result stricter.
 *
 * Shared rules:
 *  - the threshold counts exactly: 50 reaches a 50 threshold, 49.9 does not;
 *  - a percentage that is not on the register is unknown, never zero: a path with an unknown link can
 *    neither prove nor rule out control, so the result is "needs review";
 *  - circular ownership is detected, reported, and never followed twice, so it cannot hang;
 *  - chains longer than the policy depth are cut and reported (the policy answer is to escalate).
 *
 * Why a plain computation and not the World Model's own traversal: the arithmetic needs every separate
 * path with its own product, but the engine's traversal visits each entity once. The World Model is used
 * as the store of record instead (OwnershipWorld): every edge is written with provenance and a validity
 * date, so the ownership picture can be read as of a past date, and the review evaluates what it reads back.
 */

/** One register row. These are the columns of the beneficial_owner table; every value is a string, as Zetaris returns it. */
export interface OwnershipRow {
  ownership_id: string;
  owned_party_id: string;
  owner_party_id: string;
  owner_party_kind: "customer" | "listed" | "external";
  owner_name: string;
  /** Percent such as "50", "49.9" or "25.5"; null when the register does not say. */
  ownership_pct: string | null;
  /** YYYY-MM-DD. */
  as_of: string;
}
export type ControlLink = Pick<
  ListRelationshipRow,
  "relationship_id" | "from_entry_id" | "to_entry_id" | "relation_type" | "is_former"
>;

export interface OwnershipOptions {
  /** Percent at which control starts. Exactly this value counts. Policy: ownership.thresholdPercent. */
  thresholdPercent: number;
  /** Add up separate paths to the same listed party. Policy: ownership.aggregate. */
  aggregate: boolean;
  /** Longest chain of owners followed, in links. Policy: ownership.maxChainDepth. */
  maxChainDepth: number;
  /** Ignore ownership rows dated after this day (YYYY-MM-DD). */
  asOf?: string;
  /**
   * The percentage assumed for an "owned or controlled by" link on a published list, which carries none.
   * `null` (the default) keeps it unknown.
   */
  controlLinkPercent?: number | null;
  /** Extra parties known to be listed, besides the owners the register marks as listed. */
  listedIds?: Iterable<string>;
}

export interface OwnershipPath {
  /** From the owned company up to the listed owner. */
  nodes: string[];
  /** The register rows (ownership ids) or list relationship ids behind each link. */
  edges: string[];
  /** Share of the company held through this path, in percent; null when a link has no percentage. */
  percent: number | null;
}

export type OwnerStatus = "meets" | "below" | "unknown";

export interface ListedOwner {
  ownerId: string;
  ownerName: string | null;
  /** Sum (or maximum, without aggregation) of the paths with known percentages. */
  effectivePercent: number;
  status: OwnerStatus;
  paths: OwnershipPath[];
}

export type OwnershipOutcome = "meets_threshold" | "needs_review" | "below_threshold" | "no_listed_owner";

/** Under OFAC's rule: blocked, not blocked, or not decidable from the register (a missing percentage, a loop, the depth limit). */
export type BlockStatus = "blocked" | "clear" | "unknown";

export interface BlockedEntity {
  /** A company in the chain (or the subject itself) that is blocked because blocked parties own enough of it. */
  id: string;
  /** The share of it held by blocked parties, in percent (known percentages only). */
  blockedPercent: number;
}

export interface OwnershipResult {
  subject: string;
  thresholdPercent: number;
  outcome: OwnershipOutcome;
  owners: ListedOwner[];
  /** What all the listed owners hold together, in percent (only the paths with known percentages). */
  combinedPercent: number;
  /** OFAC's rule for the subject: is it owned at or above the threshold by blocked parties, counted as a cascade? */
  cascade: BlockStatus;
  /** The share of the subject held directly by blocked parties (listed, or blocked under the cascade), in percent. */
  blockedPercent: number;
  /** Every company that the cascade found blocked, the subject included, nearest to the subject first. */
  blockedEntities: BlockedEntity[];
  /** Each loop as the chain of parties that closes on itself, for example [A, B, A]. */
  loops: string[][];
  depthLimitReached: boolean;
  reasons: string[];
}

interface Edge {
  owner: string;
  ownerListed: boolean;
  ownerName: string | null;
  percent: number | null;
  ids: string[];
}

const EPSILON = 1e-9;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function parsePercent(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** One edge per (company, owner) pair: the latest rows for the pair, with split entries added together. */
function registerEdges(rows: readonly OwnershipRow[], asOf: string | undefined): Array<[string, Edge]> {
  const byPair = new Map<string, OwnershipRow[]>();
  for (const row of rows) {
    if (asOf !== undefined && row.as_of > asOf) continue;
    const key = `${row.owned_party_id}\u0000${row.owner_party_id}`;
    byPair.set(key, [...(byPair.get(key) ?? []), row]);
  }
  const edges: Array<[string, Edge]> = [];
  for (const pair of byPair.values()) {
    const latest = pair
      .map((r) => r.as_of)
      .sort()
      .at(-1);
    const current = pair.filter((r) => r.as_of === latest);
    const first = current[0];
    if (!first) continue;
    const percents = current.map((r) => parsePercent(r.ownership_pct));
    edges.push([
      first.owned_party_id,
      {
        owner: first.owner_party_id,
        ownerListed: first.owner_party_kind === "listed",
        ownerName: first.owner_name,
        percent: percents.some((p) => p === null) ? null : percents.reduce<number>((s, p) => s + (p ?? 0), 0),
        ids: current.map((r) => r.ownership_id),
      },
    ]);
  }
  return edges;
}

/** "Owned or controlled by" links from a published list; they carry no percentage. */
function linkEdges(links: readonly ControlLink[], percent: number | null): Array<[string, Edge]> {
  return links
    .filter((l) => l.relation_type === "owned_or_controlled_by" && !l.is_former)
    .map((l) => [
      l.from_entry_id,
      { owner: l.to_entry_id, ownerListed: false, ownerName: null, percent, ids: [l.relationship_id] },
    ]);
}

function buildGraph(
  rows: readonly OwnershipRow[],
  links: readonly ControlLink[],
  options: OwnershipOptions,
): Map<string, Edge[]> {
  const graph = new Map<string, Edge[]>();
  const all = [...registerEdges(rows, options.asOf), ...linkEdges(links, options.controlLinkPercent ?? null)];
  for (const [owned, edge] of all) graph.set(owned, [...(graph.get(owned) ?? []), edge]);
  return graph;
}

interface Walk {
  graph: Map<string, Edge[]>;
  listed: Set<string>;
  options: OwnershipOptions;
  paths: Map<string, OwnershipPath[]>;
  loops: string[][];
  depthLimitReached: boolean;
}

interface Position {
  trail: string[];
  edges: string[];
  /** Share of the company held at this point of the chain (1 = all of it); null once a link has no percentage. */
  fraction: number | null;
}

function walk(ctx: Walk, node: string, at: Position): void {
  for (const edge of ctx.graph.get(node) ?? []) follow(ctx, edge, at);
}

/** Follow one ownership link: close a loop, reach a listed owner, hit the depth limit, or climb further. */
function follow(ctx: Walk, edge: Edge, at: Position): void {
  const nodes = [...at.trail, edge.owner];
  const fraction = at.fraction === null || edge.percent === null ? null : (at.fraction * edge.percent) / 100;
  const edges = [...at.edges, ...edge.ids];
  if (at.trail.includes(edge.owner)) {
    ctx.loops.push(nodes);
  } else if (ctx.listed.has(edge.owner)) {
    const path: OwnershipPath = { nodes, edges, percent: fraction === null ? null : round6(fraction * 100) };
    ctx.paths.set(edge.owner, [...(ctx.paths.get(edge.owner) ?? []), path]);
  } else if (nodes.length - 1 >= ctx.options.maxChainDepth) {
    // The chain would be longer than allowed. It only matters if there is more above this owner.
    if ((ctx.graph.get(edge.owner) ?? []).length > 0) ctx.depthLimitReached = true;
  } else {
    walk(ctx, edge.owner, { trail: nodes, edges, fraction });
  }
}

function judgeOwner(
  ownerId: string,
  paths: OwnershipPath[],
  names: Map<string, string | null>,
  o: OwnershipOptions,
): ListedOwner {
  const known = paths.flatMap((p) => (p.percent === null ? [] : [p.percent]));
  const effective = o.aggregate ? known.reduce((s, p) => s + p, 0) : Math.max(0, ...known);
  const unknownPaths = paths.length - known.length;
  const meets = effective >= o.thresholdPercent - EPSILON;
  return {
    ownerId,
    ownerName: names.get(ownerId) ?? null,
    effectivePercent: round6(effective),
    status: meets ? "meets" : unknownPaths > 0 ? "unknown" : "below",
    paths,
  };
}

interface Cascade {
  graph: Map<string, Edge[]>;
  listed: Set<string>;
  options: OwnershipOptions;
  blocked: Map<string, number>;
}

/**
 * OFAC's rule for one company: add up what its blocked owners hold (an owner is blocked when it is listed or, in
 * turn, owned enough by blocked parties). An owner that cannot be decided, or a blocked owner with no percentage,
 * makes the answer unknown unless the known blocked share already reaches the threshold or cannot reach it.
 * `trail` runs from the subject to `node`; its length is the number of links followed to get here plus one.
 */
function blockStatus(ctx: Cascade, node: string, trail: string[]): { status: BlockStatus; percent: number } {
  const { thresholdPercent, aggregate, maxChainDepth } = ctx.options;
  let known = 0;
  let upper = 0;
  for (const edge of ctx.graph.get(node) ?? []) {
    let owner: BlockStatus;
    if (trail.includes(edge.owner)) owner = "unknown";
    else if (ctx.listed.has(edge.owner)) owner = "blocked";
    else if (trail.length >= maxChainDepth) owner = (ctx.graph.get(edge.owner) ?? []).length > 0 ? "unknown" : "clear";
    else owner = blockStatus(ctx, edge.owner, [...trail, edge.owner]).status;
    if (owner === "clear") continue;
    const share = edge.percent ?? 100;
    if (owner === "blocked" && edge.percent !== null)
      known = aggregate ? known + edge.percent : Math.max(known, edge.percent);
    upper = aggregate ? upper + share : Math.max(upper, share);
  }
  if (known >= thresholdPercent - EPSILON) {
    if (!ctx.blocked.has(node)) ctx.blocked.set(node, round6(known));
    return { status: "blocked", percent: round6(known) };
  }
  return { status: upper >= thresholdPercent - EPSILON ? "unknown" : "clear", percent: round6(known) };
}

function summarise(
  owners: ListedOwner[],
  loops: string[][],
  depthLimitReached: boolean,
  combined: { percent: number; meets: boolean },
  cascade: { status: BlockStatus; percent: number; blocked: BlockedEntity[]; subject: string },
): {
  outcome: OwnershipOutcome;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (combined.meets && owners.length > 1) {
    reasons.push(`${owners.length} listed parties together hold ${round6(combined.percent)}% effectively`);
  }
  for (const o of owners) {
    if (o.status === "meets") reasons.push(`${o.ownerId} holds ${o.effectivePercent}% effectively`);
    if (o.status === "unknown") reasons.push(`${o.ownerId}: a link has no percentage on the register`);
  }
  if (loops.length > 0) reasons.push(`circular ownership: ${loops.map((l) => l.join(" > ")).join("; ")}`);
  if (depthLimitReached) reasons.push("the ownership chain is longer than the policy allows");

  for (const b of cascade.blocked) {
    if (b.id === cascade.subject) {
      reasons.push(`blocked parties own ${b.blockedPercent}% of ${b.id} (the 50 percent rule, counted as a cascade)`);
    } else {
      reasons.push(
        `${b.id} is itself blocked: blocked parties own ${b.blockedPercent}% of it, so its holdings count in full`,
      );
    }
  }
  if (cascade.status === "unknown") reasons.push("the 50 percent rule cannot be decided from the register");

  const meets = combined.meets || owners.some((o) => o.status === "meets") || cascade.status === "blocked";
  if (meets) return { outcome: "meets_threshold", reasons };
  if (
    owners.some((o) => o.status === "unknown") ||
    loops.length > 0 ||
    depthLimitReached ||
    cascade.status === "unknown"
  ) {
    return { outcome: "needs_review", reasons };
  }
  return { outcome: owners.length > 0 ? "below_threshold" : "no_listed_owner", reasons };
}

export function evaluateOwnership(
  rows: readonly OwnershipRow[],
  links: readonly ControlLink[],
  subject: string,
  options: OwnershipOptions,
): OwnershipResult {
  const graph = buildGraph(rows, links, options);
  const listed = new Set(options.listedIds ?? []);
  const names = new Map<string, string | null>();
  for (const edges of graph.values()) {
    for (const e of edges) {
      if (e.ownerListed) listed.add(e.owner);
      names.set(e.owner, e.ownerName ?? names.get(e.owner) ?? null);
    }
  }
  const ctx: Walk = { graph, listed, options, paths: new Map(), loops: [], depthLimitReached: false };
  walk(ctx, subject, { trail: [subject], edges: [], fraction: 1 });

  const owners = [...ctx.paths.entries()]
    .map(([id, paths]) => judgeOwner(id, paths, names, options))
    .sort((a, b) => b.effectivePercent - a.effectivePercent || a.ownerId.localeCompare(b.ownerId));
  // Listed owners count together: ownership by several blocked parties adds up, as the 50 percent rule says.
  const combinedPercent = round6(owners.reduce((sum, o) => sum + o.effectivePercent, 0));
  const combined = {
    percent: combinedPercent,
    meets: options.aggregate && owners.length > 1 && combinedPercent >= options.thresholdPercent - EPSILON,
  };
  const cascadeCtx: Cascade = { graph, listed, options, blocked: new Map() };
  const subjectBlock = blockStatus(cascadeCtx, subject, [subject]);
  // Nearest to the subject first: the subject, then the companies in the order the cascade decided them, reversed.
  const blockedEntities = [...cascadeCtx.blocked.entries()]
    .reverse()
    .map(([id, blockedPercent]) => ({ id, blockedPercent }));
  const { outcome, reasons } = summarise(owners, ctx.loops, ctx.depthLimitReached, combined, {
    ...subjectBlock,
    blocked: blockedEntities,
    subject,
  });
  return {
    subject,
    thresholdPercent: options.thresholdPercent,
    outcome,
    owners,
    combinedPercent,
    cascade: subjectBlock.status,
    blockedPercent: subjectBlock.percent,
    blockedEntities,
    loops: ctx.loops,
    depthLimitReached: ctx.depthLimitReached,
    reasons,
  };
}

const OWNED_BY = "owned-by";
/** The validity date used when a register row has no readable date; such a row counts at every date. */
const UNDATED = "1970-01-01T00:00:00.000Z";
const dayStart = (asOf: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(asOf) ? `${asOf}T00:00:00.000Z` : UNDATED);
const partyId = (id: string): string => `party:bank:${id}`;
const plainId = (id: string): string => id.replace(/^party:bank:/, "");

/**
 * The ownership picture kept in the World Model: one entity per party and one `owned-by` edge per register
 * row, each with provenance and a validity date. Reading it back as of a date gives the picture then.
 */
export class OwnershipWorld {
  private readonly world: WorldModel;
  private readonly owners = new Map<string, Pick<OwnershipRow, "owner_party_kind" | "owner_name">>();

  constructor(namespace = "ownership") {
    this.world = new WorldModel({ namespace, storage: "memory" });
  }

  async load(rows: readonly OwnershipRow[], links: readonly ControlLink[] = []): Promise<void> {
    for (const row of rows) {
      const source = { kind: "pipeline", by: "ownership", at: dayStart(row.as_of) };
      await this.world.upsertEntity({ type: "party", externalKey: { system: "bank", id: row.owned_party_id }, source });
      await this.world.upsertEntity({
        type: "party",
        externalKey: { system: "bank", id: row.owner_party_id },
        name: row.owner_name,
        source,
      });
      this.owners.set(row.owner_party_id, { owner_party_kind: row.owner_party_kind, owner_name: row.owner_name });
      await this.world.relate({
        from: partyId(row.owned_party_id),
        type: OWNED_BY,
        to: partyId(row.owner_party_id),
        // A separate context per row keeps several owners of one company open at the same time.
        context: `own:${row.ownership_id}`,
        attrs: {
          ownership_id: row.ownership_id,
          pct: row.ownership_pct,
          kind: row.owner_party_kind,
          name: row.owner_name,
          // The register's own date, kept as it was read, so the rows read back are the rows written.
          as_of: row.as_of,
        },
        validFrom: source.at,
        source,
      });
    }
    for (const link of links) {
      const source = { kind: "file", by: "list", at: "1970-01-01T00:00:00.000Z" };
      await this.world.relate({
        from: partyId(link.from_entry_id),
        type: "controlled-by",
        to: partyId(link.to_entry_id),
        context: `link:${link.relationship_id}`,
        attrs: { relationship_id: link.relationship_id, former: link.is_former },
        source,
      });
    }
  }

  /** The register rows as stored, optionally as they stood on a day. */
  rows(asOf?: string): OwnershipRow[] {
    const day = asOf === undefined ? undefined : `${asOf}T23:59:59.999Z`;
    return this.world
      .events()
      .filter((e) => e.kind === "relate" && (e.payload as Relationship).type === OWNED_BY)
      .map((e) => e.payload as Relationship)
      .filter((r) => day === undefined || (r.validFrom ?? "") <= day)
      .map((r) => {
        const attrs = r.attrs ?? {};
        return {
          ownership_id: String(attrs.ownership_id),
          owned_party_id: plainId(r.from),
          owner_party_id: plainId(r.to),
          owner_party_kind: attrs.kind as OwnershipRow["owner_party_kind"],
          owner_name: String(attrs.name ?? ""),
          ownership_pct: (attrs.pct as string | null) ?? null,
          as_of: typeof attrs.as_of === "string" ? attrs.as_of : (r.validFrom ?? "").slice(0, 10),
        };
      });
  }

  links(): ControlLink[] {
    return this.world
      .events()
      .filter((e) => e.kind === "relate" && (e.payload as Relationship).type === "controlled-by")
      .map((e) => {
        const r = e.payload as Relationship;
        return {
          relationship_id: String(r.attrs?.relationship_id),
          from_entry_id: plainId(r.from),
          to_entry_id: plainId(r.to),
          relation_type: "owned_or_controlled_by",
          is_former: r.attrs?.former === true,
        };
      });
  }

  evaluate(subject: string, options: OwnershipOptions): OwnershipResult {
    return evaluateOwnership(this.rows(options.asOf), this.links(), subject, options);
  }

  /** Every write is audited by the engine. */
  auditLength(): number {
    return this.world.audit().length;
  }
}
