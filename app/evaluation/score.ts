import { readFileSync } from "node:fs";
import type { Action, Decision } from "../domain/types.ts";

interface Issue {
  pattern: string;
  field?: "lei" | "name" | "sic";
  correct?: string;
  candidates?: string[];
}

export interface AnswerKey {
  patterns: Record<string, { origin: string; learnable: boolean; description: string }>;
  suppliers: Record<string, { batch: string; decision: Decision; issues: Issue[] }>;
}

export function readAnswerKey(): AnswerKey {
  return JSON.parse(
    readFileSync(new URL("../../data/answer-key.json", import.meta.url), "utf8"),
  ) as AnswerKey;
}

// One supplier's line of a run, as `npm run judge` prints it.
export type RunResult = { vendorId: string } & (
  { decision: Decision; actions: Action[] } | { error: string }
);

interface SupplierScore {
  vendorId: string;
  batch: string;
  expected: Decision;
  decision: Decision | null;
  // Corrections the answer key expects and the run lacks, and corrections the run makes that it does not
  // expect.
  missing: string[];
  unexpected: string[];
  correct: boolean;
}

function correction(field: string, value: string): string {
  return `${field} = ${value}`;
}

// A supplier is correct only with the expected decision and exactly the expected corrections: a missing
// correction leaves a wrong ERP value, and an unexpected one overwrites a right value. Suppliers the run
// does not cover are left out, so a partial run scores what it covers; one covered twice is rejected.
export function score(
  results: RunResult[],
  key: AnswerKey,
): { suppliers: SupplierScore[]; batches: Record<string, { correct: number; total: number }> } {
  const seen = new Set<string>();
  const suppliers = results.map((result) => {
    const labelled = key.suppliers[result.vendorId];
    if (!labelled) throw new Error(`${result.vendorId} is not in the answer key`);
    if (seen.has(result.vendorId)) throw new Error(`${result.vendorId} appears in the run twice`);
    seen.add(result.vendorId);
    const expected = labelled.issues.flatMap(({ field, correct }) =>
      field && correct ? [correction(field, correct)] : [],
    );
    const made =
      "actions" in result
        ? result.actions.flatMap((action) =>
            action.kind === "correct" ? [correction(action.field, action.value)] : [],
          )
        : [];
    const decision = "decision" in result ? result.decision : null;
    const missing = expected.filter((item) => !made.includes(item));
    const unexpected = made.filter((item) => !expected.includes(item));
    return {
      vendorId: result.vendorId,
      batch: labelled.batch,
      expected: labelled.decision,
      decision,
      missing,
      unexpected,
      correct: decision === labelled.decision && missing.length === 0 && unexpected.length === 0,
    };
  });

  const batches: Record<string, { correct: number; total: number }> = {};
  for (const { batch, correct } of suppliers) {
    const tally = (batches[batch] ??= { correct: 0, total: 0 });
    tally.total++;
    if (correct) tally.correct++;
  }
  return { suppliers, batches };
}
