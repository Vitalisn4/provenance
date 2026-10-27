import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { NewSupplier } from "../agents/scout.ts";
import { AppError, errorText, type ErrorType } from "../domain/errors.ts";
import { readAnswerKey, score } from "../evaluation/score.ts";
import { openRun } from "../pipeline/run.ts";
import type { Trace } from "../pipeline/trace.ts";
import { describeAction, tally, verify } from "../pipeline/verify.ts";

const agents = [
  {
    name: "Scout",
    role: "Registers the GLEIF and SEC EDGAR records a supplier's identifiers name as Zetaris REST tables, then reads the ERP row and those records in one Zetaris query",
  },
  {
    name: "Resolver",
    role: "Finds the supplier's legal entity: the one its LEI names, or else the best match from a GLEIF search through Zetaris, scored with the Meterless World Model",
  },
  {
    name: "Judge",
    role: "Asks NVIDIA Nemotron through Meterless Nightshift which registry values state the ERP's facts",
  },
  { name: "Decision", role: "Turns the verdicts into ready, fix or escalate under a fixed policy" },
];

const httpStatus: Record<ErrorType, number> = { input: 400, config: 503, zetaris: 502, meterless: 502 };
const maxBody = 64 * 1024;
const maxSuppliers = 10;

interface RunRequest {
  runId?: string;
  vendorIds: string[];
  suppliers: NewSupplier[];
  sample?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(supplier: Record<string, unknown>, field: string, label: string, max: number): string | null {
  const value = supplier[field] ?? null;
  if (value !== null && (typeof value !== "string" || value.length > max)) {
    throw new AppError("input", `${label}.${field} must be text of at most ${max} characters`, false);
  }
  return value?.trim() || null;
}

// A typed-in supplier: a name and country, and the identifiers it claims, as an ERP record would hold them.
function parseSupplier(supplier: unknown, index: number): NewSupplier {
  const label = `input.suppliers[${index}]`;
  if (!isRecord(supplier)) throw new AppError("input", `${label} must be an object`, false);
  const name = text(supplier, "name", label, 200);
  if (!name) throw new AppError("input", `${label}.name is required`, false);
  const country = text(supplier, "country", label, 2);
  if (!country || !/^[a-z]{2}$/i.test(country)) {
    throw new AppError("input", `${label}.country must be a two-letter ISO country code`, false);
  }
  return {
    vendorId: `input-${index + 1}`,
    name,
    country: country.toUpperCase(),
    lei: text(supplier, "lei", label, 40),
    cik: text(supplier, "cik", label, 40),
    sic: text(supplier, "sic", label, 40),
  };
}

export function parseRequest(body: string): RunRequest {
  let request: unknown;
  try {
    request = JSON.parse(body || "{}");
  } catch {
    throw new AppError("input", "The request body is not JSON", false);
  }
  if (!isRecord(request)) throw new AppError("input", "The request body must be a JSON object", false);
  const { run_id: runId, input = {}, options = {} } = request;
  if (runId !== undefined && typeof runId !== "string") {
    throw new AppError("input", "run_id must be a string", false);
  }
  if (!isRecord(input)) throw new AppError("input", "input must be an object", false);
  const { vendor_ids: vendorIds = [], suppliers = [] } = input;
  if (!Array.isArray(vendorIds) || !vendorIds.every((id) => typeof id === "string")) {
    throw new AppError("input", "input.vendor_ids must be a list of ERP vendor IDs", false);
  }
  if (!Array.isArray(suppliers) || suppliers.length > maxSuppliers) {
    throw new AppError("input", `input.suppliers must be a list of at most ${maxSuppliers} suppliers`, false);
  }
  if (!isRecord(options)) throw new AppError("input", "options must be an object", false);
  const { sample_mode: sample } = options;
  if (sample !== undefined && typeof sample !== "boolean") {
    throw new AppError("input", "options.sample_mode must be true or false", false);
  }
  return { runId, vendorIds, suppliers: suppliers.map(parseSupplier), sample };
}

// Reads the whole body but keeps at most `maxBody` bytes of it.
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= maxBody) chunks.push(chunk);
  }
  if (size > maxBody) throw new AppError("input", "The request body is over 64 KB", false);
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

// Technical Execution Guide, section 2: POST /run verifies the requested ERP suppliers and any typed-in ones,
// or every ERP supplier, and answers with the results and the run's trace, or with a structured error.
export function createApp({
  sampleDefault,
  out,
}: {
  sampleDefault: boolean;
  out: { write: (line: string) => unknown };
}): Server {
  async function run(request: IncomingMessage): Promise<{ status: number; body: object }> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started) / 1000;
    let runId: string | undefined;
    let trace: Trace | undefined;
    try {
      const parsed = parseRequest(await readBody(request));
      runId = parsed.runId;
      const sample = parsed.sample ?? sampleDefault;
      const opened = openRun({ sample, out, runId });
      trace = opened.trace;
      const results = await verify(opened.clients, trace, parsed.vendorIds, parsed.suppliers);
      const key = readAnswerKey();
      return {
        status: 200,
        body: {
          run_id: trace.runId,
          status: results.some((result) => "error" in result) ? "partial" : "success",
          output: {
            sample_mode: sample,
            summary: `Suppliers verified: ${results.length} (${tally(results)})`,
            recommendations: results.flatMap((result) =>
              "actions" in result
                ? result.actions.map((action) => `${result.vendorId}: ${describeAction(action)}`)
                : [],
            ),
            suppliers: results,
            evaluation: score(
              results.filter(({ vendorId }) => Object.hasOwn(key.suppliers, vendorId)),
              key,
            ).batches,
          },
          agents,
          ...traceFields(trace),
          execution_time_seconds: elapsed(),
        },
      };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      trace?.log({ agent: "Pipeline", action: "run_failed", output: errorText(error), status: "error" });
      return {
        status: httpStatus[error.type],
        body: {
          run_id: runId ?? null,
          status: "error",
          error: { type: error.type, message: error.message, recoverable: error.recoverable },
          ...(trace && traceFields(trace)),
          execution_time_seconds: elapsed(),
        },
      };
    }
  }

  return createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/run") {
      send(response, 404, {
        status: "error",
        error: { type: "input", message: "Only POST /run is served", recoverable: false },
      });
      return;
    }
    run(request).then(
      ({ status, body }) => {
        send(response, status, body);
      },
      (error: unknown) => {
        console.error(error);
        send(response, 500, {
          status: "error",
          error: { type: "internal", message: "Unexpected failure; see the server log", recoverable: false },
        });
      },
    );
  });
}

function traceFields({ runId, file }: Trace): { trace_id: string; log_file: string } {
  return { trace_id: `trace-${runId}`, log_file: file };
}
