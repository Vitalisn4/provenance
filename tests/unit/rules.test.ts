import { describe, expect, it } from "vitest";
import type { Resolution } from "../../app/agents/resolver.ts";
import { confirms, holds, ruleLibrary, type Rule } from "../../app/agents/rules.ts";
import type { Evidence } from "../../app/agents/scout.ts";
import { policy } from "../../app/config/policy.ts";
import type { Fact } from "../../app/domain/types.ts";

const rule = (id: string) => ruleLibrary.find((candidate) => candidate.id === id) as Rule;

const evidence = (rules: string[]): Evidence => ({
  erp: {
    vendorId: "V-1",
    name: "Acme Ltd",
    country: "GB",
    lei: "L1",
    cik: null,
    sic: null,
    sicListDescription: null,
  },
  gleif: {
    lei: "L1",
    legalName: "ACME LTD",
    country: "GB",
    jurisdiction: "GB",
    registrationStatus: "ISSUED",
    entityStatus: "ACTIVE",
  },
  edgar: null,
  gaps: [],
  rules,
});

const clear = (lei: string): Resolution => ({
  identity: "clear",
  entity: { lei, legalName: "ACME LTD", country: "GB", registrationStatus: "ISSUED", entityStatus: "ACTIVE" },
  candidates: [],
  compared: 1,
  notes: [],
});
const unmatched: Resolution = { identity: "unmatched", candidates: [], compared: 0, notes: [] };

const fact = (judgeScore: number | null, erp: boolean, registries: [string, boolean][]): Fact => ({
  field: "name",
  claimed: { value: "x", agrees: erp },
  registries: registries.map(([source, agrees]) => ({ source, value: "x", agrees })),
  accepted: "x",
  judgeScore,
});

describe("Rule library", () => {
  it("holds a rule only where Zetaris found it true and, for the claimed record's rules, the Resolver agrees", () => {
    const name = rule("name_is_gleif_legal_name");
    expect(holds(name, evidence([name.id]), clear("L1"))).toBe(true);
    expect(holds(name, evidence([]), clear("L1"))).toBe(false);
    expect(holds(name, evidence([name.id]), clear("L2"))).toBe(false);
    expect(holds(name, evidence([name.id]), unmatched)).toBe(false);
    expect(holds(rule("sic_missing_from_list"), evidence(["sic_missing_from_list"]), unmatched)).toBe(true);
  });

  it("counts a verdict as confirming only when the Judge scored it enough and no source the rule trusts disagrees", () => {
    const name = rule("name_is_gleif_legal_name");
    const { minJudgeScore } = policy.decision;
    expect(confirms(name, fact(minJudgeScore, true, [["GLEIF", true]]))).toBe(true);
    expect(
      confirms(
        name,
        fact(minJudgeScore, true, [
          ["GLEIF", true],
          ["EDGAR", false],
        ]),
      ),
    ).toBe(true);
    expect(confirms(name, fact(minJudgeScore - 1, true, [["GLEIF", true]]))).toBe(false);
    expect(confirms(name, fact(null, true, [["GLEIF", true]]))).toBe(false);
    expect(confirms(name, fact(9, false, [["GLEIF", true]]))).toBe(false);
    expect(confirms(name, fact(9, true, [["GLEIF", false]]))).toBe(false);
    expect(confirms(name, undefined)).toBe(false);
    expect(confirms(rule("sic_missing_from_list"), fact(9, false, [["company_dns", false]]))).toBe(true);
  });
});
