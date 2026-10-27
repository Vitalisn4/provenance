import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTrace } from "../../app/pipeline/trace.ts";

interface TraceEvent {
  timestamp: string;
  run_id: string;
  vendor_id: string | null;
  agent_name: string;
  action: string;
  input_summary: string | null;
  output_summary: string;
  model: string | null;
  status: string;
}

// A trace in a fresh temporary directory, the readable lines it wrote and the events in its file.
export function testTrace(runId = "run-1", secrets: string[] = []) {
  const lines: string[] = [];
  const trace = openTrace(runId, {
    secrets,
    out: { write: (line: string) => lines.push(line) },
    dir: mkdtempSync(join(tmpdir(), "trace-")),
  });
  const events = () =>
    readFileSync(trace.file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TraceEvent);
  return { trace, lines, events };
}
