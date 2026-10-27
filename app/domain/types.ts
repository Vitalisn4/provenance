export type FactStatus = "confirmed" | "conflicting" | "unverified";

export type Decision = "ready" | "fix" | "escalate";

// `agrees` is the Judge's call that a value states the accepted fact, possibly in other words: EDGAR's city
// "Armonk" and GLEIF's "North Castle" name the same place.
interface SourceValue {
  value: string;
  agrees: boolean;
}

interface Evidence extends SourceValue {
  source: string;
}

// One field of a supplier's ERP record, checked against the registries.
export interface Fact {
  field: string;
  // The ERP's value, or null when the field is blank.
  claimed: SourceValue | null;
  registries: Evidence[];
  // The value the Judge accepted, or null when the evidence let it accept none.
  accepted: string | null;
  // The Judge's rubric score out of 9, or null when no registry covers the field and so nothing was judged.
  judgeScore: number | null;
}

export type SupplierCheck =
  // The Resolver matched the supplier to more than one legal entity, so no fact can be checked.
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
