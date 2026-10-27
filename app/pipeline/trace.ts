import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { RetryListener } from "../adapters/http.ts";
import type { MeterlessClient } from "../adapters/meterless.ts";
import type { QueryResult, ZetarisClient } from "../adapters/zetaris.ts";
import { policy } from "../config/policy.ts";
import { AppError, errorText } from "../domain/errors.ts";

// `target` is the agent the step hands the supplier to, and `confidence` runs from 0 to 1.
interface Step {
  agent: string;
  action: string;
  input?: string;
  output: string;
  target?: string;
  model?: string | null;
  confidence?: number;
  retries?: number;
  status?: "success" | "error" | "retrying" | "needs_revision";
}

export interface Trace {
  runId: string;
  file: string;
  log: (step: Step) => void;
  // Runs `work` with every step it logs attributed to the supplier, so concurrent suppliers stay apart.
  forSupplier: <T>(vendorId: string, work: () => Promise<T>) => Promise<T>;
}

type Chat = MeterlessClient["chat"];

export function newRunId(now = new Date()): string {
  return `run-${now.toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

// Each run gets a file of its own: under a reused run ID, such as an example's, a suffix keeps the earlier
// run's trace whole rather than overwriting it or mixing into it.
function createTraceFile(dir: string, runId: string): string {
  for (let suffix = ""; ; suffix = `-${randomUUID().slice(0, 8)}`) {
    const file = `${dir}/trace-${runId}${suffix}.jsonl`;
    try {
      writeFileSync(file, "", { flag: "wx" });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
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
  const file = createTraceFile(dir, runId);
  const supplier = new AsyncLocalStorage<string>();
  const masked = secrets.filter(Boolean);
  const mask = (text: string) =>
    masked.reduce((result, secret) => result.replaceAll(secret, "...redacted"), text);

  function log({
    agent,
    action,
    input,
    output,
    target,
    model = null,
    confidence,
    retries = 0,
    status = "success",
  }: Step): void {
    const vendorId = supplier.getStore() ?? null;
    const event = {
      timestamp: new Date().toISOString(),
      run_id: runId,
      vendor_id: vendorId,
      agent_name: agent,
      action,
      input_summary: input === undefined ? null : mask(input),
      output_summary: mask(output),
      target_agent: target ?? null,
      model,
      confidence: confidence ?? null,
      retry_count: retries,
      status,
    };
    appendFileSync(file, `${JSON.stringify(event)}\n`);
    const line = [
      `[${status === "error" ? "ERROR" : status === "success" ? "INFO" : "WARN"}] run_id=${runId}`,
      vendorId && `vendor=${vendorId}`,
      `${agent} ${action}${target ? ` -> ${target}` : ""}:`,
      event.output_summary,
      confidence !== undefined && `(confidence ${confidence.toFixed(2)})`,
      retries > 0 && `(after ${retries} ${retries === 1 ? "retry" : "retries"})`,
      model && `(model: ${model})`,
    ];
    out.write(`${line.filter(Boolean).join(" ").replace(/\s+/g, " ")}\n`);
  }

  return { runId, file, log, forSupplier: (vendorId, work) => supplier.run(vendorId, work) };
}

async function observe<T>(
  trace: Trace,
  step: Omit<Step, "output">,
  start: (onRetry: RetryListener) => Promise<T>,
  describe: (result: T) => Pick<Step, "output" | "model">,
): Promise<T> {
  let retries = 0;
  const onRetry: RetryListener = (error, delayMs) => {
    retries++;
    trace.log({
      agent: step.agent,
      action: "retry",
      input: step.action,
      output: `${errorText(error)}; retry ${retries} in ${delayMs / 1000} s`,
      retries,
      status: "retrying",
    });
  };
  try {
    const result = await start(onRetry);
    trace.log({ ...step, ...describe(result), retries });
    return result;
  } catch (error) {
    trace.log({
      ...step,
      output: error instanceof AppError ? errorText(error) : String(error),
      retries,
      status: "error",
    });
    throw error;
  }
}

export function tracedZetaris(zetaris: ZetarisClient, trace: Trace, agent: string): ZetarisClient {
  const describe = ({ rows }: QueryResult) => ({ output: `${rows.length} rows` });
  return {
    query: (sql) =>
      observe(
        trace,
        { agent, action: "zetaris_query", input: sql },
        (onRetry) => zetaris.query(sql, onRetry),
        describe,
      ),
    execute: (sql) =>
      observe(trace, { agent, action: "zetaris_execute", input: sql }, () => zetaris.execute(sql), describe),
  };
}

export function tracedChat(chat: Chat, trace: Trace, agent: string): Chat {
  return (route, messages) => {
    const started = Date.now();
    const step = { agent, action: "nightshift_chat", input: policy.meterless.routes[route] };
    return observe(
      trace,
      step,
      (onRetry) => chat(route, messages, onRetry),
      ({ content, model }) => ({
        output: `${content.length} characters in ${((Date.now() - started) / 1000).toFixed(1)} s`,
        model,
      }),
    );
  };
}
