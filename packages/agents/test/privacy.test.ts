import { createFallbackRulesGenerator, type GenerateRequest, type Generator } from "@sanctions-desk/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  askCloud,
  gatherEvidence,
  privacyMapOf,
  pseudonymise,
  rawValuesIn,
  restore,
  runReview,
  sampleRules,
} from "../src/index.js";
import { caseFacts, sampleDeps } from "./helpers.js";

const isLocal = (r: GenerateRequest) => /^TASK: (screener|safety)/.test(r.prompt);

/** The sample-mode stand-in, with every request kept so the test can read what would have left the machine. */
function recording(): { generator: Generator; requests: GenerateRequest[] } {
  const inner = createFallbackRulesGenerator(sampleRules);
  const requests: GenerateRequest[] = [];
  return {
    requests,
    generator: async (req) => {
      requests.push(req);
      return inner(req);
    },
  };
}

function privateDeps(generator?: Generator) {
  const deps = sampleDeps(generator ? { generator } : {});
  return { ...deps, config: { ...deps.config, privacyMode: "pseudonymise" as const } };
}

describe("the token map", () => {
  it("gives every name, identifier, date of birth and country of the case a stable token", async () => {
    const evidence = await gatherEvidence(sampleDeps(), caseFacts("tm_identifier").alertId);
    const map = privacyMapOf(evidence);
    const kinds = new Set(map.tokens.map((t) => t.kind));
    for (const k of ["party", "listed", "dob", "country"]) expect(kinds.has(k as never)).toBe(true);
    expect(privacyMapOf(evidence)).toBe(map);
    const name = evidence.customer.full_name as string;
    const text = pseudonymise(JSON.stringify({ full_name: name, note: `seen ${name} today` }), map);
    expect(text).not.toContain(name);
    expect(rawValuesIn(text, map)).toEqual([]);
    expect(restore(JSON.parse(text), map)).toEqual({ full_name: name, note: `seen ${name} today` });
  });

  it("reports raw values left in a text, by kind, and nothing for a clean one", async () => {
    const evidence = await gatherEvidence(sampleDeps(), caseFacts("tm_identifier").alertId);
    const map = privacyMapOf(evidence);
    const dob = map.tokens.find((t) => t.kind === "dob")?.value as string;
    const name = evidence.customer.full_name as string;
    const left = rawValuesIn(`{"date_of_birth":"${dob}"} and ${name}`, map);
    expect(left.map((t) => t.kind).sort()).toEqual(["dob", "party"]);
    expect(rawValuesIn("PARTY_A and DOB_1", map)).toEqual([]);
  });
});

describe("askCloud", () => {
  const schema = z.object({ verdict: z.string(), issues: z.array(z.string()) });

  it("with privacy mode off, sends the prompt unchanged", async () => {
    const { generator, requests } = recording();
    const deps = sampleDeps({ generator });
    const evidence = await gatherEvidence(deps, caseFacts("tm_identifier").alertId);
    const prompt = `TASK: critic\n${JSON.stringify({ full_name: evidence.customer.full_name })}`;
    await askCloud(deps, evidence, "critic", { agent: "critic", system: "s", prompt, schema }).catch(() => undefined);
    expect(requests.at(-1)?.prompt).toContain(evidence.customer.full_name as string);
    expect(evidence.privacy).toBeUndefined();
  });

  it("with privacy mode on, sends tokens only and maps the answer back", async () => {
    const requests: GenerateRequest[] = [];
    const generator: Generator = async (req) => {
      requests.push(req);
      return {
        text: '{"verdict":"reject","issues":["PARTY_A has DOB_1"]}',
        provider: "fallback-rules",
        requestedModel: "m",
        routedModel: "m",
        routeKind: "cloud",
        latencyMs: 1,
        modeMismatch: false,
      };
    };
    const deps = privateDeps(generator);
    const evidence = await gatherEvidence(deps, caseFacts("fp_name_order").alertId);
    const name = evidence.customer.full_name as string;
    const dob = evidence.customer.date_of_birth as string;
    expect(dob).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const prompt = `TASK: critic\n${JSON.stringify({ full_name: name, date_of_birth: dob })}`;
    const { value } = await askCloud(deps, evidence, "critic", { agent: "critic", system: "s", prompt, schema });
    const sent = requests.at(-1)?.prompt ?? "";
    expect(sent).not.toContain(name);
    expect(sent).not.toContain(dob);
    expect(sent).toContain("<privacy>");
    expect(value.issues[0]).toBe(`${name} has ${dob}`);
    expect(evidence.cloudPayloads?.at(-1)?.prompt_chars).toBe(sent.length);
  });
});

describe("a whole review in privacy mode", () => {
  it.each(["tm_identifier", "fp_name_order", "ob_chain_42", "pj_beneficiary_country"])(
    "%s: no raw name, identifier or date of birth reaches a cloud request, and the outcome is the same as without",
    async (kind) => {
      const facts = caseFacts(kind);
      const off = await runReview(sampleDeps(), {
        runId: `priv-off-${kind}`,
        alertId: facts.alertId,
        sampleMode: true,
      });
      const { generator, requests } = recording();
      const deps = privateDeps(generator);
      const on = await runReview(deps, { runId: `priv-on-${kind}`, alertId: facts.alertId, sampleMode: true });
      expect(on.decision).toBe(off.decision);
      const evidence = await gatherEvidence(sampleDeps(), facts.alertId);
      const map = privacyMapOf(evidence);
      const cloud = requests.filter((r) => !isLocal(r));
      expect(cloud.length).toBeGreaterThan(0);
      for (const r of cloud) expect(rawValuesIn(`${r.system ?? ""}\n${r.prompt}`, map)).toEqual([]);
    },
  );
});
