import { policy } from "../config/policy.ts";
import type { Fact } from "../domain/types.ts";
import type { Resolution } from "./resolver.ts";
import type { Evidence } from "./scout.ts";

// The shapes of rule the Rule Smith can learn, each a boolean Zetaris SQL expression over the Scout's evidence
// query: the ERP row e, the claimed LEI's GLEIF record g, the EDGAR filer s and the SIC list l. A rule that holds
// settles its field without the model: the sources in `agree` agree, and every other value stands as compared.
// The shapes are fixed and include tempting wrong ones; which rules are promoted is learned from the Judge.
export interface Rule {
  id: string;
  field: "name" | "lei" | "sic";
  description: string;
  sql: string;
  needs: "gleif" | "edgar";
  agree: readonly string[];
  // Holds only when the Resolver confirmed the claimed LEI's entity, since g is that entity's record.
  claimedEntity: boolean;
}

export function holds(rule: Rule, evidence: Evidence, resolution: Resolution): boolean {
  const claimed = resolution.identity === "clear" && resolution.entity.lei === evidence.gleif?.lei;
  return evidence.rules.includes(rule.id) && (claimed || !rule.claimedEntity);
}

export function sourced({ claimed, registries }: Fact): { source: string; agrees: boolean }[] {
  return [...(claimed ? [{ source: "ERP", ...claimed }] : []), ...registries];
}

// A verdict confirms a rule when the Judge scored it high enough to act on and no source the rule says agrees
// was found to disagree.
export function confirms(rule: Rule, fact: Fact | undefined): boolean {
  if (fact?.judgeScore == null || fact.judgeScore < policy.decision.minJudgeScore) return false;
  return sourced(fact).every(({ source, agrees }) => agrees || !rule.agree.includes(source));
}

const compact = (column: string) => `regexp_replace(upper(${column}), '[^A-Z0-9]', '')`;
const gleifName = "g.data.attributes.entity.legalName.name";

export const ruleLibrary: readonly Rule[] = [
  {
    id: "name_is_gleif_legal_name",
    field: "name",
    description: "The ERP name is GLEIF's legal name, ignoring case, spaces and punctuation",
    sql: `${compact("e.vendor_name")} = ${compact(gleifName)}`,
    needs: "gleif",
    agree: ["ERP", "GLEIF"],
    claimedEntity: true,
  },
  {
    id: "name_shares_first_word",
    field: "name",
    description: "The ERP name starts with the same word as GLEIF's legal name",
    sql: `split(upper(e.vendor_name), ' ')[0] = split(upper(${gleifName}), ' ')[0]`,
    needs: "gleif",
    agree: ["ERP", "GLEIF"],
    claimedEntity: true,
  },
  {
    id: "lei_is_claimed_record",
    field: "lei",
    description: "The ERP's LEI is the LEI of the GLEIF record it names",
    sql: "e.claimed_lei = g.data.attributes.lei",
    needs: "gleif",
    agree: ["ERP", "GLEIF"],
    claimedEntity: true,
  },
  {
    id: "sic_is_listed_edgar_code",
    field: "sic",
    description: "The ERP's SIC code is EDGAR's, and the company_dns list has it",
    sql: "e.claimed_sic = s.sic AND l.codes[s.sic] IS NOT NULL",
    needs: "edgar",
    agree: ["ERP", "EDGAR", "company_dns"],
    claimedEntity: false,
  },
  {
    id: "sic_missing_from_list",
    field: "sic",
    description: "EDGAR's SIC code is missing from the company_dns list, so the industry is disputed",
    sql: "s.sic IS NOT NULL AND l.codes[s.sic] IS NULL",
    needs: "edgar",
    agree: [],
    claimedEntity: false,
  },
];
