// Serves POST /run on PORT, on every interface so a container's port mapping reaches it. Each step is
// logged to stdout and to logs/trace-<run_id>.jsonl.
import { createApp } from "../api/server.ts";
import { port, sampleMode } from "../config/env.ts";
import { runCli } from "./runCli.ts";

await runCli(() => {
  const listening = port();
  const sample = sampleMode();
  createApp({ sampleDefault: sample, out: process.stdout }).listen(listening, "0.0.0.0", () => {
    console.log(`Provenance on http://0.0.0.0:${listening}/run${sample ? ", in sample mode" : ""}`);
  });
  // As a container's PID 1, Node ignores SIGINT and SIGTERM unless it handles them.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(0));
});
