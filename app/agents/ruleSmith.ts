import { HMEM } from "#hmem";
import { policy } from "../config/policy.ts";
import type { Fact } from "../domain/types.ts";
import { count, type Trace } from "../pipeline/trace.ts";
import type { Resolution } from "./resolver.ts";
import { confirms, holds, ruleLibrary, sourced, type Rule } from "./rules.ts";
import type { Evidence } from "./scout.ts";

export interface RuleReport {
  id: string;
  field: string;
  description: string;
  sql: string;
  status: "promoted" | "rejected" | "demoted";
  // Learning-batch verdicts on facts the rule held for, and the suppliers whose verdicts contradicted it.
  support: number;
  contradictedBy: string[];
  reason: string;
}

interface Observation {
  vendorId: string;
  fact: Fact;
  held: string[];
}

const agent = "Rule Smith";

// Learns rules from the Judge's verdicts, and demotes a promoted rule the Judge later overturns. H-MEM's state
// and trust ledger are kept in `dir`, created at the first verdict.
export function openRuleSmith(trace: Trace, dir: string) {
  let memory: HMEM | undefined;
  const open = () => (memory ??= new HMEM({ persistDir: dir, actor: agent }));
  const observations = new Map<string, Observation>();
  const reports = new Map<string, RuleReport>();

  function remember(vendorId: string, evidence: Evidence, resolution: Resolution, facts: Fact[]): void {
    for (const fact of facts) {
      if (fact.judgeScore === null) continue;
      const held = ruleLibrary
        .filter((rule) => rule.field === fact.field && holds(rule, evidence, resolution))
        .map(({ id }) => id);
      const verdict = sourced(fact).map(
        ({ source, agrees }) => `${source} ${agrees ? "agrees" : "disagrees"}`,
      );
      const { id } = open().add({
        content: `${fact.field} verdict: ${verdict.join(", ")}; rules held: ${held.join(", ") || "none"}`,
        type: "factual",
        tags: [`field:${fact.field}`, ...held.map((rule) => `rule:${rule}`)],
        confidence: fact.judgeScore / policy.decision.maxJudgeScore,
        source: "Judge",
        provenance: {
          origin: "model_response",
          learnedAt: Date.now(),
          label: "Judge verdict",
          refs: [vendorId],
        },
      });
      observations.set(id, { vendorId, fact, held });
    }
  }

  function backTest(rule: Rule): RuleReport {
    const tested = [...observations.values()].filter(({ held }) => held.includes(rule.id));
    const contradictedBy = tested.filter(({ fact }) => !confirms(rule, fact)).map(({ vendorId }) => vendorId);
    const promoted = contradictedBy.length === 0;
    const { id, field, description, sql } = rule;
    const report: RuleReport = {
      id,
      field,
      description,
      sql,
      status: promoted ? "promoted" : "rejected",
      support: tested.length,
      contradictedBy,
      reason: promoted
        ? `held for ${tested.length} learning verdicts and the Judge confirmed every one`
        : `the Judge contradicted it on ${contradictedBy.join(", ")}`,
    };
    if (promoted) open().ledger.log(id, "promote", agent, { details: { sql, support: tested.length } });
    trace.log({
      agent,
      action: "back_test",
      input: sql,
      output: `${id} ${report.status}: ${report.reason}`,
      confidence: (tested.length - contradictedBy.length) / tested.length,
    });
    return report;
  }

  // Each insight H-MEM dreams up is a cluster of verdicts; the library rules that held for at least
  // `minSupport` of them are back-tested against every verdict, and the proposal is approved when one of them
  // is promoted.
  function learn(): void {
    const proposals = open()
      .dreaming.dream()
      .filter(({ type }) => type === "insight");
    trace.log({
      agent,
      action: "dream",
      output: `H-MEM dreamt ${count(proposals.length, "cluster")} from ${count(observations.size, "Judge verdict")}`,
    });
    for (const proposal of proposals) {
      const members = proposal.derivedFrom.flatMap((id) => observations.get(id) ?? []);
      const candidates = ruleLibrary.filter(
        ({ id }) =>
          !reports.has(id) &&
          members.filter(({ held }) => held.includes(id)).length >= policy.ruleSmith.minSupport,
      );
      for (const rule of candidates) reports.set(rule.id, backTest(rule));
      const promoted = candidates.some(({ id }) => reports.get(id)?.status === "promoted");
      if (promoted) open().dreaming.approve(proposal.id);
      else open().dreaming.reject(proposal.id);
    }
  }

  function demote(ruleId: string, vendorId: string): void {
    const report = reports.get(ruleId);
    if (report?.status !== "promoted") return;
    report.status = "demoted";
    report.contradictedBy.push(vendorId);
    report.reason = `the Judge contradicted it on ${vendorId} after its promotion`;
    open().ledger.log(ruleId, "demote", agent, { details: { vendorId } });
    trace.log({ agent, action: "demote", output: `${ruleId}: ${report.reason}`, status: "needs_revision" });
  }

  return {
    remember,
    learn,
    demote,
    promoted: (): Rule[] => ruleLibrary.filter(({ id }) => reports.get(id)?.status === "promoted"),
    reports: (): RuleReport[] => [...reports.values()],
  };
}
