import { describe, expect, it } from "vitest";
import { policy } from "../../app/config/policy.ts";
import { decide } from "../../app/domain/decide.ts";
import type { Fact } from "../../app/domain/types.ts";

const edgarCity = { source: "EDGAR", value: "ARMONK", agrees: true };

const ibmCity: Fact = {
  field: "city",
  claimed: { value: "Armonk", agrees: true },
  registries: [edgarCity, { source: "GLEIF", value: "North Castle", agrees: true }],
  accepted: "Armonk",
  judgeScore: 9,
};

const siemensLei: Fact = {
  field: "lei",
  claimed: { value: "5299008LSFRCSQJPMO62", agrees: false },
  registries: [{ source: "GLEIF", value: "W38RGI023J3WT1HWRP32", agrees: true }],
  accepted: "W38RGI023J3WT1HWRP32",
  judgeScore: 9,
};

const correctSiemensLei = { kind: "correct", field: "lei", value: "W38RGI023J3WT1HWRP32", source: "GLEIF" };

function checked(...facts: Fact[]) {
  return decide({ identity: "clear", registrationStatus: "ISSUED", facts });
}

describe("decide", () => {
  it("is ready when every fact is confirmed, even in other words", () => {
    expect(checked(ibmCity)).toEqual({
      decision: "ready",
      facts: [{ field: "city", status: "confirmed" }],
      actions: [],
    });
  });

  it("asks to correct an ERP value a registry contradicts", () => {
    expect(checked(ibmCity, siemensLei)).toEqual({
      decision: "fix",
      facts: [
        { field: "city", status: "confirmed" },
        { field: "lei", status: "conflicting" },
      ],
      actions: [correctSiemensLei],
    });
  });

  it("fills a blank ERP field from a registry; one source alone leaves it unverified", () => {
    expect(checked({ ...siemensLei, claimed: null })).toMatchObject({
      facts: [{ status: "unverified" }],
      actions: [correctSiemensLei],
    });
    expect(checked({ ...ibmCity, claimed: null }).facts).toEqual([{ field: "city", status: "confirmed" }]);
  });

  it("requests documents, never escalates, when no registry covers a field", () => {
    const uncovered: Fact = {
      field: "legal_name",
      claimed: { value: "Douala Cold Chain SARL", agrees: false },
      registries: [],
      accepted: null,
      judgeScore: null,
    };

    expect(decide({ identity: "clear", facts: [uncovered] })).toEqual({
      decision: "fix",
      facts: [{ field: "legal_name", status: "unverified" }],
      actions: [{ kind: "request_document", field: "legal_name" }],
    });
  });

  it("escalates when the registries disagree", () => {
    const disputed: Fact = {
      ...ibmCity,
      registries: [edgarCity, { source: "GLEIF", value: "Poughkeepsie", agrees: false }],
    };

    expect(checked(disputed)).toEqual({
      decision: "escalate",
      facts: [{ field: "city", status: "conflicting" }],
      actions: [{ kind: "escalate", reason: "the sources disagree on city" }],
    });
  });

  it("escalates a verdict the Judge scored below the bar", () => {
    const score = policy.decision.minJudgeScore - 1;

    expect(checked({ ...ibmCity, judgeScore: score })).toMatchObject({
      decision: "escalate",
      actions: [{ kind: "escalate", reason: `the Judge scored its city verdict ${score}/9` }],
    });
  });

  it("escalates a malformed Judge score and accepts the bar and the maximum", () => {
    const { minJudgeScore, maxJudgeScore } = policy.decision;

    for (const judgeScore of [null, NaN, Infinity, maxJudgeScore + 1, minJudgeScore + 0.5]) {
      expect(checked({ ...ibmCity, judgeScore }).decision).toBe("escalate");
    }
    for (const judgeScore of [minJudgeScore, maxJudgeScore]) {
      expect(checked({ ...ibmCity, judgeScore }).decision).toBe("ready");
    }
  });

  it("acts on a fact a learned rule settled without a Judge score, as the comparisons stand", () => {
    const settled = { judgeScore: null, rule: "lei_is_claimed_record" };

    expect(checked({ ...ibmCity, ...settled }).decision).toBe("ready");
    expect(checked({ ...siemensLei, ...settled })).toMatchObject({
      decision: "fix",
      actions: [correctSiemensLei],
    });
    expect(checked({ ...ibmCity, ...settled, registries: [{ ...edgarCity, agrees: false }] }).decision).toBe(
      "escalate",
    );
  });

  it("never calls a supplier ready when no fact was checked", () => {
    expect(checked()).toEqual({
      decision: "escalate",
      facts: [],
      actions: [{ kind: "escalate", reason: "no fact was checked" }],
    });
  });

  it("escalates a registration that is not current", () => {
    expect(decide({ identity: "clear", registrationStatus: "LAPSED", facts: [ibmCity] })).toMatchObject({
      decision: "escalate",
      actions: [{ kind: "escalate", reason: "the LEI registration status is LAPSED" }],
    });
  });

  it("escalates an ambiguous identity without advice drawn from either entity", () => {
    expect(decide({ identity: "ambiguous" })).toEqual({
      decision: "escalate",
      facts: [],
      actions: [{ kind: "escalate", reason: "the Resolver could not settle on one legal entity" }],
    });
  });
});
