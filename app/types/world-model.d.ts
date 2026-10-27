// Types for the parts of the World Model engine that Provenance uses. The engine is copied unchanged from
// Meterless and predates this project's strict compiler options, so the "#world-model" import resolves here for
// type checking and to the engine at run time (package.json "imports").

export function normalizeName(name: string): string;

export function nameSimilarity(a: string, b: string): number;

export function decide(
  similarity: number,
  autoMergeAt?: number,
  reviewLower?: number,
): "auto-merge" | "review" | "new";
