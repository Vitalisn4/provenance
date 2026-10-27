import { createMeterlessClient } from "../adapters/meterless.ts";
import { readRecording, replayer } from "../adapters/sample.ts";
import { createZetarisClient } from "../adapters/zetaris.ts";
import { meterlessConfig, secUserAgent, zetarisConfig } from "../config/env.ts";
import { newRunId, openTrace, type Trace } from "./trace.ts";
import type { Clients } from "./verify.ts";

// A run's clients and trace: live clients from the settings, whose secret values the trace masks, or in sample
// mode the recorded answers, which need no settings.
export function openRun({
  sample,
  out,
  runId = newRunId(),
}: {
  sample: boolean;
  out: { write: (line: string) => unknown };
  runId?: string;
}): { clients: Clients; trace: Trace } {
  if (sample) {
    const clients = { ...replayer(readRecording()), secUserAgent: "Provenance sample mode" };
    const trace = openTrace(runId, { secrets: [], out });
    trace.log({
      agent: "Pipeline",
      action: "sample_mode",
      output: "replaying recorded Zetaris and Nightshift answers",
    });
    return { clients, trace };
  }
  const zetaris = zetarisConfig();
  const meterless = meterlessConfig();
  const userAgent = secUserAgent();
  const clients = {
    zetaris: createZetarisClient(zetaris),
    chat: createMeterlessClient(meterless).chat,
    secUserAgent: userAgent,
  };
  return {
    clients,
    trace: openTrace(runId, { secrets: [zetaris.apiKey, meterless.runtimeToken, userAgent], out }),
  };
}
