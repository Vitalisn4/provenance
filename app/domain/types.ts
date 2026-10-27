export type FactStatus = "confirmed" | "conflicting" | "unverified";

export type Decision = "ready" | "fix" | "escalate";

// `agrees` says whether a value states the accepted fact, possibly in other words: the ERP's "Siemens A/S" and
// GLEIF's "SIEMENS AKTIESELSKAB" name the same entity.
interface SourceValue {
  value: string;
  agrees: boolean;
}

interface RegistryValue extends SourceValue {
  source: string;
}

// One field of a supplier's ERP record, checked against the registries.
export interface Fact {
  field: string;
  // The ERP's value, or null when the field is blank.
  claimed: SourceValue | null;
  registries: RegistryValue[];
  // The registry value the field is checked against, or null when no registry gives one.
  accepted: string | null;
  // The Judge's rubric score, or null when no registry covers the field or a learned rule settled it.
  judgeScore: number | null;
  // The learned rule that settled the field in the Judge's place.
  rule?: string;
}

export type SupplierCheck =
  // The Resolver could not settle on one legal entity for the supplier, so no fact can be checked.
  | { identity: "ambiguous" }
  // At most one legal entity matched; with none, only the ERP knows the supplier.
  | {
      identity: "clear";
      // GLEIF registration status of the matched LEI ("ISSUED", "LAPSED", ...), absent when no LEI matched.
      registrationStatus?: string;
      facts: Fact[];
    };

export type Action =
  | { kind: "correct"; field: string; value: string; source: string }
  | { kind: "request_document"; field: string }
  | { kind: "escalate"; reason: string };
