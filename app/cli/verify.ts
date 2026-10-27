// Verifies the given suppliers, or every supplier, and prints the results as one JSON array. Each step is
// logged to stderr, keeping stdout for the results, and to logs/trace-<run_id>.jsonl.
import { createMeterlessClient } from "../adapters/meterless.ts";
import { createZetarisClient } from "../adapters/zetaris.ts";
import { meterlessConfig, secUserAgent, zetarisConfig } from "../config/env.ts";
import { newRunId, openTrace } from "../pipeline/trace.ts";
import { verify } from "../pipeline/verify.ts";
import { runCli } from "./runCli.ts";

await runCli(async (requested) => {
  const zetaris = zetarisConfig();
  const meterless = meterlessConfig();
  const userAgent = secUserAgent();
  const trace = openTrace(newRunId(), {
    secrets: [zetaris.apiKey, meterless.runtimeToken, userAgent],
    out: process.stderr,
  });
  const clients = {
    zetaris: createZetarisClient(zetaris),
    chat: createMeterlessClient(meterless).chat,
    secUserAgent: userAgent,
  };
  const results = await verify(clients, trace, requested);
  if (results.some((result) => "error" in result)) process.exitCode = 1;
  console.log(JSON.stringify(results, null, 2));
  console.error(`Trace: ${trace.file}`);
});
