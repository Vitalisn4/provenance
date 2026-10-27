import { policy } from "../config/policy.ts";
import type { Action, Decision, Fact, FactStatus, SupplierCheck } from "./types.ts";

// The only place a supplier's decision is made. A field no registry covers asks for documents and never
// escalates, so a supplier from a country with little registry coverage is not penalised for the gap.
export function decide(check: SupplierCheck): {
  decision: Decision;
  facts: { field: string; status: FactStatus }[];
  actions: Action[];
} {
  if (check.identity === "ambiguous") {
    return {
      decision: "escalate",
      facts: [],
      actions: [escalate("the Resolver could not settle on one legal entity")],
    };
  }

  const verdicts = check.facts.map(judgeFact);
  const actions = verdicts.flatMap((verdict) => verdict.action ?? []);
  if (verdicts.length === 0) actions.push(escalate("no fact was checked"));
  if (check.registrationStatus !== undefined && check.registrationStatus !== "ISSUED") {
    actions.push(escalate(`the LEI registration status is ${check.registrationStatus}`));
  }
  const decision = actions.some((action) => action.kind === "escalate")
    ? "escalate"
    : actions.length > 0
      ? "fix"
      : "ready";
  return { decision, facts: verdicts.map(({ field, status }) => ({ field, status })), actions };
}

function judgeFact({ field, claimed, registries, accepted, judgeScore, rule }: Fact): {
  field: string;
  status: FactStatus;
  action?: Action;
} {
  if (registries.length === 0) {
    return { field, status: "unverified", action: { kind: "request_document", field } };
  }

  const support = registries.find((evidence) => evidence.agrees);
  if (accepted === null || !support || registries.some((evidence) => !evidence.agrees)) {
    return { field, status: "conflicting", action: escalate(`the sources disagree on ${field}`) };
  }

  const agreeing = registries.length + (claimed?.agrees ? 1 : 0);
  const status = claimed?.agrees === false ? "conflicting" : agreeing >= 2 ? "confirmed" : "unverified";
  const { minJudgeScore, maxJudgeScore } = policy.decision;
  if (
    rule === undefined &&
    (judgeScore === null ||
      !Number.isInteger(judgeScore) ||
      judgeScore < minJudgeScore ||
      judgeScore > maxJudgeScore)
  ) {
    return {
      field,
      status,
      action: escalate(`the Judge scored its ${field} verdict ${judgeScore}/${maxJudgeScore}`),
    };
  }
  if (claimed?.agrees) return { field, status };
  return { field, status, action: { kind: "correct", field, value: accepted, source: support.source } };
}

function escalate(reason: string): Action {
  return { kind: "escalate", reason };
}
