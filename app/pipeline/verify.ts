import { decide as band } from "#world-model";
import type { MeterlessClient } from "../adapters/meterless.ts";
import type { ZetarisClient } from "../adapters/zetaris.ts";
import { judge } from "../agents/judge.ts";
import { openResolver, type Resolution } from "../agents/resolver.ts";
import { openScout, type Evidence, type NewSupplier } from "../agents/scout.ts";
import { policy } from "../config/policy.ts";
import { decide } from "../domain/decide.ts";
import { AppError, errorText } from "../domain/errors.ts";
import type { Action } from "../domain/types.ts";
import { tracedChat, tracedZetaris, type Trace } from "./trace.ts";

export interface Clients {
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

// Runs `work` on every item, at most `limit` at a time, and returns the results in the items' order. After a
// failure no item starts, though items already running finish.
async function inParallel<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    for (let index = next++; index < items.length && !failed; index = next++) {
      try {
        results[index] = await work(items[index] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
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

const count = (n: number, noun: string, plural = `${noun}s`) => `${n} ${n === 1 ? noun : plural}`;

function describeResolution(resolution: Resolution): string {
  const outcome =
    resolution.identity === "clear"
      ? `clear: ${resolution.entity.legalName} (${resolution.entity.lei})`
      : `${resolution.identity}: ${count(resolution.candidates.length, "candidate")}`;
  return [outcome, ...resolution.notes].join("; ");
}

function describeScores({ compared, candidates }: Resolution): string {
  const closest = candidates
    .slice(0, 3)
    .map(({ entity, similarity }) => `${entity.legalName} ${similarity.toFixed(2)} (${band(similarity)})`);
  const summary = `World Model scored ${count(compared, "GLEIF entity", "GLEIF entities")}: ${candidates.length} at or above the review band`;
  return [summary, ...closest].join("; ");
}

export function describeAction(action: Action): string {
  if (action.kind === "correct") return `correct ${action.field} to "${action.value}" from ${action.source}`;
  if (action.kind === "request_document") return `request a document for ${action.field}`;
  return `escalate: ${action.reason}`;
}

// Verifies each requested ERP supplier and each typed-in supplier, or with neither every ERP supplier: the
// Scout gathers its registry evidence, the Resolver finds its legal entity, the Judge rules on each fact and
// `decide` turns the verdicts into a decision. A supplier that fails is reported in its place, so one outage
// does not cost the other results.
export async function verify(
  { zetaris, chat, secUserAgent }: Clients,
  trace: Trace,
  requested: readonly string[],
  typed: readonly NewSupplier[] = [],
): Promise<SupplierResult[]> {
  const { vendorIds, gather } = await openScout(tracedZetaris(zetaris, trace, "Scout"), secUserAgent, typed);
  const fromErp = requested.length > 0 || typed.length === 0 ? selectSuppliers(requested, vendorIds) : [];
  const selected = [...fromErp, ...typed.map(({ vendorId }) => vendorId)];
  const { resolve } = openResolver(tracedZetaris(zetaris, trace, "Resolver"));
  const judgeChat = tracedChat(chat, trace, "Judge");
  const { concurrency } = policy.pipeline;
  const typedIn = typed.length > 0 ? ` and ${typed.length} typed in` : "";
  trace.log({
    agent: "Pipeline",
    action: "start",
    output: `${fromErp.length} of ${vendorIds.length} ERP suppliers${typedIn}, ${concurrency} at a time`,
    target: "Scout",
  });

  async function verifyOne(vendorId: string): Promise<SupplierResult> {
    try {
      const evidence = await gather(vendorId);
      trace.log({
        agent: "Scout",
        action: "gather_evidence",
        output: describeEvidence(evidence),
        target: "Resolver",
      });
      const resolution = await resolve(evidence);
      if (resolution.compared > 0) {
        const [closest] = resolution.candidates;
        trace.log({
          agent: "Resolver",
          action: "world_model_score",
          input: evidence.erp.name ?? "",
          output: describeScores(resolution),
          ...(closest && { confidence: closest.similarity }),
        });
      }
      // The Judge has nothing to rule on for an ambiguous supplier, so the Resolver hands it straight on.
      const judged = resolution.identity !== "ambiguous";
      trace.log({
        agent: "Resolver",
        action: "resolve_identity",
        output: describeResolution(resolution),
        target: judged ? "Judge" : "Decision",
      });
      const { check, reasons, model } = await judge(judgeChat, evidence, resolution, (problem) => {
        trace.log({
          agent: "Judge",
          action: "critique",
          output: `${problem.message}; asking the model again`,
          status: "needs_revision",
        });
      });
      if (judged) {
        const verdicts = Object.entries(reasons).map(([field, reason]) => `${field}: ${reason}`);
        const scores = check.identity === "clear" ? check.facts.flatMap((fact) => fact.judgeScore ?? []) : [];
        trace.log({
          agent: "Judge",
          action: "judge_facts",
          output: verdicts.join(" ") || "no fact needed the model",
          target: "Decision",
          model,
          ...(scores.length > 0 && { confidence: Math.min(...scores) / policy.decision.maxJudgeScore }),
        });
      }
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
  trace.log({ agent: "Pipeline", action: "finish", output: tally(results) });
  return results;
}

// How many suppliers each decision went to, and how many failed: "11 escalate, 16 fix, 4 ready".
export function tally(results: SupplierResult[]): string {
  const counts = new Map<string, number>();
  for (const result of results) {
    const outcome = "error" in result ? "failed" : result.decision;
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  return [...counts].map(([outcome, count]) => `${count} ${outcome}`).join(", ") || "no suppliers";
}
