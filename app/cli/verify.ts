// Verifies the given suppliers, or every supplier, learning rules from the answer key's learning batch, and
// prints the results as one JSON array. Each step is logged to stderr, keeping stdout for the results, and to
// logs/trace-<run_id>.jsonl.
import { sampleMode } from "../config/env.ts";
import { learningBatch, readAnswerKey } from "../evaluation/score.ts";
import { openRun } from "../pipeline/run.ts";
import { verify } from "../pipeline/verify.ts";
import { runCli } from "./runCli.ts";

await runCli(async (requested) => {
  const { clients, trace } = openRun({ sample: sampleMode(), out: process.stderr });
  const { suppliers: results } = await verify(clients, trace, requested, [], learningBatch(readAnswerKey()));
  if (results.some((result) => "error" in result)) process.exitCode = 1;
  console.log(JSON.stringify(results, null, 2));
  console.error(`Trace: ${trace.file}`);
});
