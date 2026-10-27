import type { MeterlessClient } from "../adapters/meterless.ts";
import type { ZetarisClient } from "../adapters/zetaris.ts";
import { judge } from "../agents/judge.ts";
import { openResolver, type Resolution } from "../agents/resolver.ts";
import { openScout, type Evidence } from "../agents/scout.ts";
import { policy } from "../config/policy.ts";
import { decide } from "../domain/decide.ts";
import { AppError, errorText } from "../domain/errors.ts";
import type { Action } from "../domain/types.ts";
import { tracedChat, tracedZetaris, type Trace } from "./trace.ts";

interface Clients {
  zetaris: ZetarisClient;
  chat: MeterlessClient["chat"];
  secUserAgent: string;
}

type SupplierResult = { vendorId: string } & (
  (ReturnType<typeof decide> & { reasons: Record<string, string>; model: string | null }) | { error: string }
);

// The requested vendor IDs in ERP order, or every ID when none is requested.
export function selectSuppliers(requested: readonly string[], vendorIds: string[]): string[] {
  const unknown = requested.filter((id) => !vendorIds.includes(id));
  if (unknown.length > 0) throw new AppError("input", `Not in the ERP: ${unknown.join(", ")}`, false);
  return requested.length === 0 ? vendorIds : vendorIds.filter((id) => requested.includes(id));
}

// Runs `work` on every item, at most `limit` at a time, and returns the results in the items' order.
async function inParallel<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await work(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function describeEvidence({ erp, gleif, edgar, gaps }: Evidence): string {
  return [
    `ERP "${erp.name ?? ""}" (${erp.country ?? "no country"})`,
    `GLEIF: ${gleif ? `${gleif.legalName ?? ""} (${gleif.lei ?? ""})` : "no record"}`,
    `EDGAR: ${edgar ? `${edgar.name ?? ""} (CIK ${edgar.cik ?? ""})` : "no record"}`,
    ...gaps,
  ].join("; ");
}

function describeResolution(resolution: Resolution): string {
  const outcome =
    resolution.identity === "clear"
      ? `clear: ${resolution.entity.legalName} (${resolution.entity.lei})`
      : `${resolution.identity}: ${resolution.candidates.length} candidates`;
  return [outcome, ...resolution.notes].join("; ");
}

function describeAction(action: Action): string {
  if (action.kind === "correct") return `correct ${action.field} to "${action.value}" from ${action.source}`;
  if (action.kind === "request_document") return `request a document for ${action.field}`;
  return `escalate: ${action.reason}`;
}

// Verifies each supplier: the Scout gathers its registry evidence, the Resolver finds its legal entity, the
// Judge rules on each fact and `decide` turns the verdicts into a decision. A supplier that fails is reported
// in its place, so one outage does not cost the other results.
export async function verify(
  { zetaris, chat, secUserAgent }: Clients,
  trace: Trace,
  requested: readonly string[],
): Promise<SupplierResult[]> {
  const { vendorIds, gather } = await openScout(tracedZetaris(zetaris, trace, "Scout"), secUserAgent);
  const selected = selectSuppliers(requested, vendorIds);
  const { resolve } = openResolver(tracedZetaris(zetaris, trace, "Resolver"));
  const judgeChat = tracedChat(chat, trace, "Judge");
  const { concurrency } = policy.pipeline;
  trace.log({
    agent: "Pipeline",
    action: "start",
    output: `${selected.length} of ${vendorIds.length} ERP suppliers, ${concurrency} at a time`,
  });

  async function verifyOne(vendorId: string): Promise<SupplierResult> {
    try {
      const evidence = await gather(vendorId);
      trace.log({ agent: "Scout", action: "gather_evidence", output: describeEvidence(evidence) });
      const resolution = await resolve(evidence);
      trace.log({ agent: "Resolver", action: "resolve_identity", output: describeResolution(resolution) });
      const { check, reasons, model } = await judge(judgeChat, evidence, resolution);
      const verdicts = Object.entries(reasons).map(([field, reason]) => `${field}: ${reason}`);
      trace.log({
        agent: "Judge",
        action: "judge_facts",
        output: verdicts.join(" ") || "no fact needed the model",
        model,
      });
      const outcome = decide(check);
      const actions = outcome.actions.map(describeAction);
      trace.log({ agent: "Decision", action: "decide", output: [outcome.decision, ...actions].join("; ") });
      return { vendorId, ...outcome, reasons, model };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const output = `${errorText(error)}; reported in its place while the run continues`;
      trace.log({ agent: "Pipeline", action: "supplier_failed", output, status: "error" });
      return { vendorId, error: errorText(error) };
    }
  }

  const results = await inParallel(selected, concurrency, (id) => trace.forSupplier(id, () => verifyOne(id)));
  const tally = new Map<string, number>();
  for (const result of results) {
    const outcome = "error" in result ? "failed" : result.decision;
    tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
  }
  const summary = [...tally].map(([outcome, count]) => `${count} ${outcome}`).join(", ");
  trace.log({ agent: "Pipeline", action: "finish", output: summary || "no suppliers" });
  return results;
}
