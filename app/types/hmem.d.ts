// Types for the parts of the H-MEM engine that Provenance uses. Like the World Model, the engine is copied unchanged
// from Meterless, so the "#hmem" import resolves here for type checking and to the engine at run time.

interface Provenance {
  origin: "model_response";
  learnedAt: number;
  label: string;
  refs?: string[];
}

interface MemoryRecord {
  id: string;
}

interface DreamProposal {
  id: string;
  type: "insight" | "domain" | "invariant";
  derivedFrom: string[];
}

export class HMEM {
  constructor(opts?: { persistDir?: string; actor?: string });
  add(input: {
    content: string;
    type: "factual";
    tags: string[];
    confidence: number;
    source: string;
    provenance: Provenance;
  }): MemoryRecord;
  readonly dreaming: {
    dream(): DreamProposal[];
    approve(proposalId: string): unknown;
    reject(proposalId: string): void;
  };
  readonly ledger: {
    log(memoryId: string, action: "promote" | "demote", actor: string, extra: { details: object }): unknown;
  };
}
