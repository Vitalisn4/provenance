import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import type { MeterlessClient } from "../adapters/meterless.ts";
import type { ZetarisClient } from "../adapters/zetaris.ts";
import { policy } from "../config/policy.ts";
import { AppError, errorText } from "../domain/errors.ts";

interface Step {
  agent: string;
  action: string;
  input?: string;
  output: string;
  model?: string | null;
  status?: "success" | "error";
}

export interface Trace {
  file: string;
  log: (step: Step) => void;
  // Runs `work` with every step it logs attributed to the supplier, so concurrent suppliers stay apart.
  forSupplier: <T>(vendorId: string, work: () => Promise<T>) => Promise<T>;
}

type Chat = MeterlessClient["chat"];

export function newRunId(now = new Date()): string {
  return `run-${now.toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

// Technical Execution Guide, section 8: one JSONL file per run, logs/trace-<run_id>.jsonl, and a readable line
// on `out` for each step. Each secret value is masked wherever it appears.
export function openTrace(
  runId: string,
  {
    secrets,
    out,
    dir = "logs",
  }: { secrets: string[]; out: { write: (line: string) => unknown }; dir?: string },
): Trace {
  // The run ID names the trace file, so it cannot carry a path.
  if (!/^[\w-]{1,64}$/.test(runId)) {
    throw new AppError("input", "run_id must be 1 to 64 letters, digits, _ or -", false);
  }
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/trace-${runId}.jsonl`;
  const supplier = new AsyncLocalStorage<string>();
  const masked = secrets.filter(Boolean);
  const mask = (text: string) =>
    masked.reduce((result, secret) => result.replaceAll(secret, "...redacted"), text);

  function log({ agent, action, input, output, model = null, status = "success" }: Step): void {
    const vendorId = supplier.getStore() ?? null;
    const event = {
      timestamp: new Date().toISOString(),
      run_id: runId,
      vendor_id: vendorId,
      agent_name: agent,
      action,
      input_summary: input === undefined ? null : mask(input),
      output_summary: mask(output),
      model,
      status,
    };
    appendFileSync(file, `${JSON.stringify(event)}\n`);
    const line = [
      `[${status === "error" ? "ERROR" : "INFO"}] run_id=${runId}`,
      vendorId && `vendor=${vendorId}`,
      `${agent} ${action}:`,
      event.output_summary,
      model && `(model: ${model})`,
    ];
    out.write(`${line.filter(Boolean).join(" ").replace(/\s+/g, " ")}\n`);
  }

  return { file, log, forSupplier: (vendorId, work) => supplier.run(vendorId, work) };
}

async function observe<T>(
  trace: Trace,
  step: Omit<Step, "output">,
  pending: Promise<T>,
  describe: (result: T) => Pick<Step, "output" | "model">,
): Promise<T> {
  try {
    const result = await pending;
    trace.log({ ...step, ...describe(result) });
    return result;
  } catch (error) {
    trace.log({
      ...step,
      output: error instanceof AppError ? errorText(error) : String(error),
      status: "error",
    });
    throw error;
  }
}

export function tracedZetaris(zetaris: ZetarisClient, trace: Trace, agent: string): ZetarisClient {
  const traced = (action: keyof ZetarisClient) => (sql: string) =>
    observe(trace, { agent, action: `zetaris_${action}`, input: sql }, zetaris[action](sql), ({ rows }) => ({
      output: `${rows.length} rows`,
    }));
  return { query: traced("query"), execute: traced("execute") };
}

export function tracedChat(chat: Chat, trace: Trace, agent: string): Chat {
  return (route, messages) => {
    const started = Date.now();
    const step = { agent, action: "nightshift_chat", input: policy.meterless.routes[route] };
    return observe(trace, step, chat(route, messages), ({ content, model }) => ({
      output: `${content.length} characters in ${((Date.now() - started) / 1000).toFixed(1)} s`,
      model,
    }));
  };
}
