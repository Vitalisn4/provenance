// Scores a saved run, the JSON `npm run judge` prints, against the answer key: each batch's tally, then
// every supplier the run got wrong and why.
import { readFileSync } from "node:fs";
import { readAnswerKey, score, type RunResult } from "../evaluation/score.ts";
import { runCli } from "./runCli.ts";

await runCli(([path]) => {
  if (!path) {
    console.error("Usage: npm run evaluate -- <run.json>");
    process.exitCode = 2;
    return;
  }
  const results: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(results)) throw new Error(`${path} holds no list of supplier results`);
  const { suppliers, batches } = score(results as RunResult[], readAnswerKey());

  for (const [batch, { correct, total }] of Object.entries(batches)) {
    console.log(`${batch.padEnd(9)} ${correct}/${total} correct`);
  }
  for (const { vendorId, expected, decision, missing, unexpected, correct } of suppliers) {
    if (correct) continue;
    const details = [
      `expected ${expected}, got ${decision ?? "an error"}`,
      ...missing.map((item) => `missing ${item}`),
      ...unexpected.map((item) => `unexpected ${item}`),
    ];
    console.log(`miss      ${vendorId}: ${details.join("; ")}`);
  }
});
