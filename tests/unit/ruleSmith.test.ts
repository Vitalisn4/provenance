import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Resolution } from "../../app/agents/resolver.ts";
import { openRuleSmith } from "../../app/agents/ruleSmith.ts";
import type { Evidence } from "../../app/agents/scout.ts";
import type { Fact } from "../../app/domain/types.ts";
import { testTrace } from "./testTrace.ts";

// A learning supplier the Judge scored on its name, LEI and SIC code, with a city no registry covers.
function supplier(vendorId: string, name: string, legalName: string, rules: string[]) {
  const lei = `LEI${vendorId}`;
  const evidence: Evidence = {
    erp: { vendorId, name, country: "US", lei, cik: null, sic: "3531", sicListDescription: null },
    gleif: {
      lei,
      legalName,
      country: "US",
      jurisdiction: "US",
      registrationStatus: "ISSUED",
      entityStatus: "ACTIVE",
    },
    edgar: null,
    gaps: [],
    rules,
  };
  const entity = { lei, legalName, country: "US", registrationStatus: "ISSUED", entityStatus: "ACTIVE" };
  const resolution: Resolution = { identity: "clear", entity, candidates: [], compared: 1, notes: [] };
  const agreed = name.replace(/\W/g, "").toUpperCase() === legalName.replace(/\W/g, "").toUpperCase();
  const scored = (field: string, value: string, agrees: boolean, registries: [string, string][]): Fact => ({
    field,
    claimed: { value, agrees },
    registries: registries.map(([source, registryValue]) => ({ source, value: registryValue, agrees: true })),
    accepted: registries[0]?.[1] ?? null,
    judgeScore: 9,
  });
  const facts: Fact[] = [
    scored("name", name, agreed, [["GLEIF", legalName]]),
    scored("lei", lei, true, [["GLEIF", lei]]),
    scored("sic", "3531", true, [
      ["EDGAR", "3531"],
      ["company_dns", "Construction Machinery"],
    ]),
    {
      field: "city",
      claimed: { value: "Peoria", agrees: false },
      registries: [],
      accepted: null,
      judgeScore: null,
    },
  ];
  return [vendorId, evidence, resolution, facts] as const;
}

const same = ["name_is_gleif_legal_name", "name_shares_first_word", "lei_is_claimed_record"];
const listed = [...same, "sic_is_listed_edgar_code"];

function learnt() {
  const dir = mkdtempSync(join(tmpdir(), "hmem-"));
  const { trace, events } = testTrace();
  const ruleSmith = openRuleSmith(trace, dir);
  ruleSmith.remember(...supplier("V-1", "Acme Inc", "ACME INC.", listed));
  ruleSmith.remember(...supplier("V-2", "Globex Corp", "GLOBEX CORP", listed));
  ruleSmith.remember(...supplier("V-3", "Initech LLC", "INITECH LLC", same));
  ruleSmith.remember(...supplier("V-4", "Umbrella Plc", "UMBRELLA PLC", same));
  ruleSmith.remember(
    ...supplier("V-5", "Honeywell Intl", "HONEYWELL INTERNATIONAL INC.", [
      "name_shares_first_word",
      "lei_is_claimed_record",
    ]),
  );
  ruleSmith.learn();
  return { ruleSmith, reports: ruleSmith.reports(), events, dir };
}

describe("Rule Smith", () => {
  it("promotes the rules the Judge confirmed every time, rejects the one it contradicted, and skips the thin", () => {
    const { ruleSmith, reports } = learnt();

    expect(reports).toEqual([
      expect.objectContaining({ id: "name_is_gleif_legal_name", status: "promoted", support: 4 }),
      expect.objectContaining({
        id: "name_shares_first_word",
        status: "rejected",
        support: 5,
        contradictedBy: ["V-5"],
        reason: "the Judge contradicted it on V-5",
      }),
      expect.objectContaining({ id: "lei_is_claimed_record", status: "promoted", support: 5 }),
    ]);
    expect(ruleSmith.promoted().map(({ id }) => id)).toEqual([
      "name_is_gleif_legal_name",
      "lei_is_claimed_record",
    ]);
  });

  it("logs its dreaming and back-tests, and records each promotion in H-MEM's trust ledger", () => {
    const { events, dir } = learnt();

    const steps = events().map(
      ({ agent_name, action, output_summary }) => `${agent_name} ${action}: ${output_summary}`,
    );
    expect(steps[0]).toBe("Rule Smith dream: H-MEM dreamt 1 cluster from 15 Judge verdicts");
    expect(steps).toContain(
      "Rule Smith back_test: name_is_gleif_legal_name promoted: held for 4 learning verdicts and the Judge confirmed every one",
    );
    expect(
      events().find(({ output_summary }) => output_summary.startsWith("name_shares_first_word")),
    ).toMatchObject({ confidence: 0.8 });
    const ledger = readFileSync(join(dir, "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { memoryId: string; action: string; actor: string });
    expect(ledger.filter(({ action }) => action === "promote").map(({ memoryId }) => memoryId)).toEqual([
      "name_is_gleif_legal_name",
      "lei_is_claimed_record",
    ]);
    expect(ledger.filter(({ action }) => action.startsWith("dream_")).map(({ action }) => action)).toEqual([
      "dream_proposed",
      "dream_approved",
    ]);
    expect(ledger.every(({ actor }) => actor === "Rule Smith")).toBe(true);
  });

  it("back-tests each rule once, however often H-MEM dreams it up", () => {
    const { ruleSmith, events } = learnt();

    ruleSmith.learn();

    expect(events().filter(({ action }) => action === "back_test")).toHaveLength(3);
  });

  it("keeps H-MEM's files only for a run with Judge verdicts to remember", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "hmem-")), "memory");
    const ruleSmith = openRuleSmith(testTrace().trace, dir);
    expect(existsSync(dir)).toBe(false);

    ruleSmith.remember(...supplier("V-1", "Acme Inc", "ACME INC.", same));
    expect(existsSync(join(dir, "state.json"))).toBe(true);
  });

  it("demotes a promoted rule the Judge overturns, and only a promoted one", () => {
    const { ruleSmith, events } = learnt();

    ruleSmith.demote("lei_is_claimed_record", "V-9");
    ruleSmith.demote("lei_is_claimed_record", "V-10");
    ruleSmith.demote("name_shares_first_word", "V-9");

    expect(ruleSmith.promoted().map(({ id }) => id)).toEqual(["name_is_gleif_legal_name"]);
    expect(ruleSmith.reports()).toEqual([
      expect.objectContaining({ id: "name_is_gleif_legal_name", status: "promoted" }),
      expect.objectContaining({ id: "name_shares_first_word", status: "rejected", contradictedBy: ["V-5"] }),
      expect.objectContaining({ id: "lei_is_claimed_record", status: "demoted", contradictedBy: ["V-9"] }),
    ]);
    expect(events().filter(({ action }) => action === "demote")).toMatchObject([
      {
        output_summary: "lei_is_claimed_record: the Judge contradicted it on V-9 after its promotion",
        status: "needs_revision",
      },
    ]);
  });
});
