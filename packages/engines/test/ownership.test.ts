import { describe, expect, it } from "vitest";
import {
  type ControlLink,
  evaluateOwnership,
  type OwnershipOptions,
  type OwnershipRow,
  OwnershipWorld,
} from "../src/domain/ownership.js";

const OPTIONS: OwnershipOptions = { thresholdPercent: 50, aggregate: true, maxChainDepth: 5 };

let seq = 0;
function row(
  owned: string,
  owner: string,
  pct: string | null,
  kind: OwnershipRow["owner_party_kind"] = "external",
  asOf = "2026-01-01",
): OwnershipRow {
  seq += 1;
  return {
    ownership_id: `own-${seq}`,
    owned_party_id: owned,
    owner_party_id: owner,
    owner_party_kind: kind,
    owner_name: `Owner ${owner}`,
    ownership_pct: pct,
    as_of: asOf,
  };
}

const evaluate = (rows: OwnershipRow[], opts: Partial<OwnershipOptions> = {}, links: ControlLink[] = []) =>
  evaluateOwnership(rows, links, "CUST-1", { ...OPTIONS, ...opts });

describe("the threshold", () => {
  it("counts exactly 50 and not 49.9", () => {
    const exact = evaluate([row("CUST-1", "OFAC-1", "50", "listed")]);
    expect(exact.outcome).toBe("meets_threshold");
    expect(exact.owners[0]).toMatchObject({ ownerId: "OFAC-1", effectivePercent: 50, status: "meets" });
    const below = evaluate([row("CUST-1", "OFAC-1", "49.9", "listed")]);
    expect(below.outcome).toBe("below_threshold");
    expect(below.owners[0]?.effectivePercent).toBe(49.9);
  });

  it("uses a threshold from the policy", () => {
    expect(evaluate([row("CUST-1", "OFAC-1", "30", "listed")], { thresholdPercent: 25 }).outcome).toBe(
      "meets_threshold",
    );
  });

  it("reports no listed owner when nobody on the chain is listed", () => {
    const result = evaluate([row("CUST-1", "EXT-1", "100"), row("EXT-1", "EXT-2", "100")]);
    expect(result).toMatchObject({ outcome: "no_listed_owner", owners: [], loops: [] });
  });
});

describe("adding up and multiplying", () => {
  it("adds separate paths to the same listed party: 25% + 25% reaches 50%", () => {
    const rows = [
      row("CUST-1", "EXT-1", "50"),
      row("CUST-1", "EXT-2", "50"),
      row("EXT-1", "OFAC-1", "50", "listed"),
      row("EXT-2", "OFAC-1", "50", "listed"),
    ];
    const result = evaluate(rows);
    expect(result.outcome).toBe("meets_threshold");
    expect(result.owners[0]?.paths.map((p) => p.percent)).toEqual([25, 25]);
    expect(result.owners[0]?.effectivePercent).toBe(50);
    // Without aggregation only the single largest path counts for effective ownership (25%), but each company is
    // 50% owned by the listed party, so each is blocked and the customer, held by them in full, is blocked too.
    const single = evaluate(rows, { aggregate: false });
    expect(single.owners[0]?.status).toBe("below");
    expect(single.outcome).toBe("meets_threshold");
  });

  it("adds two register rows for one owner of the same company: 25% + 25%", () => {
    const result = evaluate([row("CUST-1", "OFAC-1", "25", "listed"), row("CUST-1", "OFAC-1", "25", "listed")]);
    expect(result.outcome).toBe("meets_threshold");
    expect(result.owners[0]?.paths[0]?.edges).toHaveLength(2);
  });

  it("multiplies along a two-level chain and keeps the evidence path", () => {
    const rows = [row("CUST-1", "EXT-1", "70"), row("EXT-1", "OFAC-1", "80", "listed")];
    const result = evaluate(rows);
    expect(result.outcome).toBe("meets_threshold");
    expect(result.owners[0]?.effectivePercent).toBe(56);
    expect(result.owners[0]?.paths[0]).toMatchObject({ nodes: ["CUST-1", "EXT-1", "OFAC-1"], percent: 56 });
    expect(result.owners[0]?.paths[0]?.edges).toEqual([rows[0]?.ownership_id, rows[1]?.ownership_id]);
  });

  it("follows a three-level chain: 90% x 70% x 90% is 56.7%", () => {
    const result = evaluate([
      row("CUST-1", "EXT-1", "90"),
      row("EXT-1", "EXT-2", "70"),
      row("EXT-2", "OFAC-1", "90", "listed"),
    ]);
    expect(result.outcome).toBe("meets_threshold");
    expect(result.owners[0]?.effectivePercent).toBe(56.7);
  });

  it("blocks a chain whose product is below the threshold when the company in between is blocked: 70% of a 60% holder", () => {
    const result = evaluate([row("CUST-1", "EXT-1", "70"), row("EXT-1", "OFAC-1", "60", "listed")]);
    // Effective ownership is 42%, but EXT-1 is 60% owned by a listed party, so it is blocked and owns 70% of CUST-1.
    expect(result.owners[0]?.effectivePercent).toBe(42);
    expect(result.owners[0]?.status).toBe("below");
    expect(result.outcome).toBe("meets_threshold");
    expect(result.cascade).toBe("blocked");
    expect(result.blockedEntities).toEqual([
      { id: "CUST-1", blockedPercent: 70 },
      { id: "EXT-1", blockedPercent: 60 },
    ]);
    expect(result.reasons.join(" ")).toContain("EXT-1 is itself blocked");
  });

  it("does not stop at the first listed owner of several", () => {
    const result = evaluate([row("CUST-1", "OFAC-1", "30", "listed"), row("CUST-1", "OFAC-2", "55", "listed")]);
    expect(result.owners.map((o) => [o.ownerId, o.status])).toEqual([
      ["OFAC-2", "meets"],
      ["OFAC-1", "below"],
    ]);
  });
});

describe("OFAC's 50 percent rule, counted as a cascade", () => {
  it("blocks 50% of a 50% holder (OFAC's own example), though the product is 25%", () => {
    const result = evaluate([row("CUST-1", "EXT-A", "50"), row("EXT-A", "OFAC-X", "50", "listed")]);
    expect(result.owners[0]?.effectivePercent).toBe(25);
    expect(result).toMatchObject({ outcome: "meets_threshold", cascade: "blocked", blockedPercent: 50 });
  });

  it("adds a direct share to the share of a blocked holder (OFAC's own example: 10% direct + 40% through A)", () => {
    const result = evaluate([
      row("CUST-1", "OFAC-X", "10", "listed"),
      row("CUST-1", "EXT-A", "40"),
      row("EXT-A", "OFAC-X", "50", "listed"),
    ]);
    // Effective ownership: 10% + 20% = 30%. Under the rule A is blocked and its 40% counts in full: 50%.
    expect(result.owners[0]?.effectivePercent).toBe(30);
    expect(result).toMatchObject({ outcome: "meets_threshold", cascade: "blocked", blockedPercent: 50 });
  });

  it("adds up holdings of different blocked parties at each level", () => {
    const result = evaluate([
      row("CUST-1", "EXT-A", "60"),
      row("EXT-A", "OFAC-1", "30", "listed"),
      row("EXT-A", "UN-2", "20", "listed"),
    ]);
    expect(result.blockedEntities).toEqual([
      { id: "CUST-1", blockedPercent: 60 },
      { id: "EXT-A", blockedPercent: 50 },
    ]);
    expect(result.outcome).toBe("meets_threshold");
    // Without aggregation no single blocked party holds 50% of EXT-A, so nothing is blocked.
    expect(
      evaluate(
        [
          ...[row("CUST-1", "EXT-A", "60")],
          row("EXT-A", "OFAC-1", "30", "listed"),
          row("EXT-A", "UN-2", "20", "listed"),
        ],
        { aggregate: false },
      ).outcome,
    ).toBe("below_threshold");
  });

  it("counts exactly 50% at every level and not 49.9%", () => {
    const exact = evaluate([row("CUST-1", "EXT-A", "50"), row("EXT-A", "OFAC-1", "50", "listed")]);
    expect(exact.cascade).toBe("blocked");
    const upper = evaluate([row("CUST-1", "EXT-A", "50"), row("EXT-A", "OFAC-1", "49.9", "listed")]);
    expect(upper).toMatchObject({ cascade: "clear", outcome: "below_threshold", blockedEntities: [] });
    const lower = evaluate([row("CUST-1", "EXT-A", "49.9"), row("EXT-A", "OFAC-1", "100", "listed")]);
    expect(lower).toMatchObject({ cascade: "clear", outcome: "below_threshold", blockedPercent: 49.9 });
    expect(lower.blockedEntities).toEqual([{ id: "EXT-A", blockedPercent: 100 }]);
  });

  it("follows a three-level cascade", () => {
    const result = evaluate([
      row("CUST-1", "EXT-1", "50"),
      row("EXT-1", "EXT-2", "50"),
      row("EXT-2", "OFAC-1", "50", "listed"),
    ]);
    expect(result.owners[0]?.effectivePercent).toBe(12.5);
    expect(result.blockedEntities.map((b) => b.id)).toEqual(["CUST-1", "EXT-1", "EXT-2"]);
    expect(result.outcome).toBe("meets_threshold");
  });

  it("is unknown when a company in between has a blocked owner with no percentage", () => {
    const result = evaluate([row("CUST-1", "EXT-1", "70"), row("EXT-1", "OFAC-1", null, "listed")]);
    expect(result).toMatchObject({ cascade: "unknown", outcome: "needs_review" });
  });

  it("is clear when even the most a company in between could hold is below the threshold", () => {
    const result = evaluate([row("CUST-1", "EXT-1", "40"), row("EXT-1", "OFAC-1", null, "listed")]);
    expect(result.cascade).toBe("clear");
    // Effective ownership still has an unknown path, so the case still goes to review.
    expect(result.outcome).toBe("needs_review");
  });

  it("never turns a result that effective ownership meets into a clear one", () => {
    // EXT-1 is 49% listed (not blocked), but 98% x 49% + 2% direct is 50.02% effectively.
    const result = evaluate([
      row("CUST-1", "EXT-1", "98"),
      row("CUST-1", "OFAC-1", "2", "listed"),
      row("EXT-1", "OFAC-1", "49", "listed"),
    ]);
    expect(result.cascade).toBe("clear");
    expect(result.outcome).toBe("meets_threshold");
  });
});

describe("unknown percentages", () => {
  it("treats a missing percentage as unknown, never zero", () => {
    const result = evaluate([row("CUST-1", "OFAC-1", null, "listed")]);
    expect(result.outcome).toBe("needs_review");
    expect(result.owners[0]).toMatchObject({ status: "unknown", effectivePercent: 0 });
    expect(result.reasons.join(" ")).toContain("no percentage");
  });

  it("stays unknown when a known share is below the threshold and another path is unknown", () => {
    const result = evaluate([
      row("CUST-1", "OFAC-1", "30", "listed"),
      row("CUST-1", "EXT-1", "40"),
      row("EXT-1", "OFAC-1", null, "listed"),
    ]);
    expect(result.owners[0]).toMatchObject({ status: "unknown", effectivePercent: 30 });
    expect(result.outcome).toBe("needs_review");
  });

  it("still meets the threshold when the known share alone is enough", () => {
    const result = evaluate([
      row("CUST-1", "OFAC-1", "60", "listed"),
      row("CUST-1", "EXT-1", "40"),
      row("EXT-1", "OFAC-1", null, "listed"),
    ]);
    expect(result.outcome).toBe("meets_threshold");
  });

  it("treats an unreadable percentage as unknown", () => {
    expect(evaluate([row("CUST-1", "OFAC-1", "", "listed")]).outcome).toBe("needs_review");
    expect(evaluate([row("CUST-1", "OFAC-1", "n/a", "listed")]).outcome).toBe("needs_review");
  });
});

describe("loops and depth", () => {
  it("terminates on circular ownership, reports the loop and still finds the listed owner", () => {
    const result = evaluate([
      row("CUST-1", "EXT-1", "60"),
      row("EXT-1", "CUST-1", "60"),
      row("CUST-1", "OFAC-1", "55", "listed"),
    ]);
    expect(result.loops).toEqual([["CUST-1", "EXT-1", "CUST-1"]]);
    expect(result.outcome).toBe("meets_threshold");
    expect(result.reasons.join(" ")).toContain("circular ownership");
  });

  it("sends a loop with nothing listed to review", () => {
    const result = evaluate([
      row("CUST-1", "EXT-1", "100"),
      row("EXT-1", "EXT-2", "100"),
      row("EXT-2", "EXT-1", "100"),
    ]);
    expect(result.outcome).toBe("needs_review");
    expect(result.loops).toEqual([["CUST-1", "EXT-1", "EXT-2", "EXT-1"]]);
  });

  it("cuts a chain longer than the policy depth and says so", () => {
    const chain = [
      row("CUST-1", "EXT-1", "100"),
      row("EXT-1", "EXT-2", "100"),
      row("EXT-2", "EXT-3", "100"),
      row("EXT-3", "OFAC-1", "100", "listed"),
    ];
    const cut = evaluate(chain, { maxChainDepth: 2 });
    expect(cut.depthLimitReached).toBe(true);
    expect(cut.outcome).toBe("needs_review");
    expect(cut.owners).toEqual([]);
    // A listed owner exactly at the limit is still reached.
    const reached = evaluate(chain, { maxChainDepth: 4 });
    expect(reached.outcome).toBe("meets_threshold");
    expect(reached.depthLimitReached).toBe(false);
    // The last permitted owner with nobody above it is not a limit problem.
    expect(evaluate(chain.slice(0, 2), { maxChainDepth: 2 }).depthLimitReached).toBe(false);
  });
});

describe("dates and list links", () => {
  it("ignores rows dated after the as-of day and uses the latest row for a pair", () => {
    const rows = [
      row("CUST-1", "OFAC-1", "60", "listed", "2026-01-01"),
      row("CUST-1", "OFAC-1", "40", "listed", "2026-06-01"),
    ];
    expect(evaluate(rows, { asOf: "2026-03-01" }).outcome).toBe("meets_threshold");
    expect(evaluate(rows, { asOf: "2026-07-01" }).outcome).toBe("below_threshold");
    expect(evaluate(rows, { asOf: "2025-12-31" }).outcome).toBe("no_listed_owner");
  });

  it("uses 'owned or controlled by' links from a list, unknown unless a percentage is assumed", () => {
    const rows = [row("CUST-1", "EXT-1", "100")];
    const links: ControlLink[] = [
      {
        relationship_id: "OFAC-rel-1",
        from_entry_id: "EXT-1",
        to_entry_id: "OFAC-9",
        relation_type: "owned_or_controlled_by",
        is_former: false,
      },
      {
        relationship_id: "OFAC-rel-2",
        from_entry_id: "EXT-1",
        to_entry_id: "OFAC-8",
        relation_type: "owned_or_controlled_by",
        is_former: true,
      },
      {
        relationship_id: "OFAC-rel-3",
        from_entry_id: "EXT-1",
        to_entry_id: "OFAC-7",
        relation_type: "family_member_of",
        is_former: false,
      },
    ];
    const unknown = evaluate(rows, { listedIds: ["OFAC-9", "OFAC-8", "OFAC-7"] }, links);
    expect(unknown.outcome).toBe("needs_review");
    expect(unknown.owners.map((o) => o.ownerId)).toEqual(["OFAC-9"]);
    expect(unknown.owners[0]?.paths[0]?.edges).toEqual([rows[0]?.ownership_id, "OFAC-rel-1"]);
    const assumed = evaluate(rows, { listedIds: ["OFAC-9"], controlLinkPercent: 50 }, links);
    expect(assumed.outcome).toBe("meets_threshold");
  });
});

describe("OwnershipWorld", () => {
  const rows = [
    row("CUST-1", "EXT-1", "70", "external", "2026-01-01"),
    row("EXT-1", "OFAC-1", "80", "listed", "2026-02-01"),
    row("CUST-1", "CUST-2", "10", "customer", "2026-03-01"),
  ];
  const links: ControlLink[] = [
    {
      relationship_id: "OFAC-rel-1",
      from_entry_id: "OFAC-1",
      to_entry_id: "OFAC-2",
      relation_type: "owned_or_controlled_by",
      is_former: false,
    },
  ];

  it("stores the register with provenance and reads it back unchanged", async () => {
    const world = new OwnershipWorld("t");
    await world.load(rows, links);
    expect(world.rows()).toEqual(rows);
    expect(world.links()).toEqual(links);
    expect(world.auditLength()).toBeGreaterThan(rows.length);
    expect(world.evaluate("CUST-1", OPTIONS)).toEqual(evaluateOwnership(rows, links, "CUST-1", OPTIONS));
  });

  it("answers as of a past day", async () => {
    const world = new OwnershipWorld();
    await world.load(rows);
    expect(world.rows("2026-01-15")).toHaveLength(1);
    expect(world.evaluate("CUST-1", { ...OPTIONS, asOf: "2026-01-15" }).outcome).toBe("no_listed_owner");
    expect(world.evaluate("CUST-1", { ...OPTIONS, asOf: "2026-02-15" }).outcome).toBe("meets_threshold");
  });

  it("adds up different listed owners: 25% + 25% held by two listed parties reaches 50%", () => {
    const rows = [row("CUST-1", "OFAC-1", "25", "listed"), row("CUST-1", "OFAC-2", "25", "listed")];
    const result = evaluate(rows);
    expect(result.outcome).toBe("meets_threshold");
    expect(result.combinedPercent).toBe(50);
    expect(result.reasons.join(" ")).toContain("2 listed parties together hold 50%");
    expect(result.owners.map((o) => o.status)).toEqual(["below", "below"]);
  });

  it("does not add different listed owners up to 49%, or when aggregation is off", () => {
    const rows = [row("CUST-1", "OFAC-1", "25", "listed"), row("CUST-1", "OFAC-2", "24", "listed")];
    expect(evaluate(rows).outcome).toBe("below_threshold");
    expect(
      evaluate([row("CUST-1", "OFAC-1", "25", "listed"), row("CUST-1", "OFAC-2", "25", "listed")], { aggregate: false })
        .outcome,
    ).toBe("below_threshold");
  });

  it("keeps several owners of one company open at the same time", async () => {
    const world = new OwnershipWorld();
    await world.load([row("CUST-5", "OFAC-1", "25", "listed"), row("CUST-5", "OFAC-2", "30", "listed")]);
    const result = evaluateOwnership(world.rows(), [], "CUST-5", OPTIONS);
    expect(result.owners.map((o) => o.ownerId).sort()).toEqual(["OFAC-1", "OFAC-2"]);
  });
});
