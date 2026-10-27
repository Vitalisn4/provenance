import { describe, expect, it } from "vitest";
import { AppError } from "../../app/domain/errors.ts";
import { score, type AnswerKey, type RunResult } from "../../app/evaluation/score.ts";

const key: AnswerKey = {
  patterns: {},
  suppliers: {
    "V-1": { batch: "learning", decision: "ready", issues: [] },
    "V-2": {
      batch: "held_out",
      decision: "fix",
      issues: [{ pattern: "lei_of_other_entity", field: "lei", correct: "W38RGI023J3WT1HWRP32" }],
    },
    "V-3": { batch: "held_out", decision: "fix", issues: [{ pattern: "no_registry_coverage" }] },
  },
};

const fixLei = { kind: "correct", field: "lei", value: "W38RGI023J3WT1HWRP32", source: "GLEIF" } as const;

describe("score", () => {
  it("counts a supplier correct only with the expected decision and exactly the expected corrections", () => {
    const { suppliers, batches } = score(
      [
        { vendorId: "V-1", decision: "ready", actions: [] },
        { vendorId: "V-2", decision: "fix", actions: [fixLei] },
        { vendorId: "V-3", decision: "fix", actions: [{ kind: "request_document", field: "name" }] },
      ],
      key,
    );

    expect(suppliers.every((supplier) => supplier.correct)).toBe(true);
    expect(batches).toEqual({ learning: { correct: 1, total: 1 }, held_out: { correct: 2, total: 2 } });
  });

  it("reports a wrong decision, a failed supplier, and a missing or unexpected correction alone", () => {
    const fixName = { ...fixLei, field: "name", value: "ACME INC." };
    const { suppliers, batches } = score(
      [
        { vendorId: "V-1", decision: "fix", actions: [] },
        { vendorId: "V-2", decision: "fix", actions: [fixLei, fixName] },
        { vendorId: "V-3", error: "meterless error: Nightshift is unreachable" },
      ],
      key,
    );

    expect(suppliers).toEqual([
      {
        vendorId: "V-1",
        batch: "learning",
        expected: "ready",
        decision: "fix",
        missing: [],
        unexpected: [],
        correct: false,
      },
      {
        vendorId: "V-2",
        batch: "held_out",
        expected: "fix",
        decision: "fix",
        missing: [],
        unexpected: ["name = ACME INC."],
        correct: false,
      },
      {
        vendorId: "V-3",
        batch: "held_out",
        expected: "fix",
        decision: null,
        missing: [],
        unexpected: [],
        correct: false,
      },
    ]);
    expect(batches).toEqual({ learning: { correct: 0, total: 1 }, held_out: { correct: 0, total: 2 } });

    const [missing] = score([{ vendorId: "V-2", decision: "fix", actions: [] }], key).suppliers;
    expect(missing).toMatchObject({
      missing: ["lei = W38RGI023J3WT1HWRP32"],
      unexpected: [],
      correct: false,
    });
  });

  it("scores only the suppliers a run covers, and rejects one unlabelled or covered twice", () => {
    const ready: RunResult = { vendorId: "V-1", decision: "ready", actions: [] };
    expect(score([ready], key).batches).toEqual({ learning: { correct: 1, total: 1 } });
    const thrown = (results: RunResult[]) => {
      try {
        score(results, key);
      } catch (error) {
        return error;
      }
    };
    expect(thrown([{ ...ready, vendorId: "V-9" }])).toStrictEqual(
      new AppError("input", "V-9 is not in the answer key", false),
    );
    expect(thrown([ready, ready])).toStrictEqual(
      new AppError("input", "V-1 appears in the run twice", false),
    );
  });
});
