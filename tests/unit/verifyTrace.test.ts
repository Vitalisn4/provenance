import { describe, expect, it, vi } from "vitest";
import { judge } from "../../app/agents/judge.ts";
import { openResolver, type Resolution } from "../../app/agents/resolver.ts";
import { openScout, type Evidence } from "../../app/agents/scout.ts";
import { AppError } from "../../app/domain/errors.ts";
import { verify } from "../../app/pipeline/verify.ts";
import { testTrace } from "./testTrace.ts";

vi.mock(import("../../app/agents/scout.ts"), async (original) => ({
  ...(await original()),
  openScout: vi.fn(),
}));
vi.mock(import("../../app/agents/resolver.ts"), async (original) => ({
  ...(await original()),
  openResolver: vi.fn(),
}));
vi.mock(import("../../app/agents/judge.ts"), async (original) => ({ ...(await original()), judge: vi.fn() }));

const entity = (lei: string, legalName: string) => ({
  lei,
  legalName,
  country: "GB",
  registrationStatus: "ISSUED",
  entityStatus: "ACTIVE",
});
const acme = entity("L1", "ACME LIMITED");
const scored = [
  { entity: acme, similarity: 0.97 },
  { entity: entity("L2", "ACME HOLDINGS LIMITED"), similarity: 0.83 },
];
const resolutions: Record<string, Resolution> = {
  "V-1": { identity: "clear", entity: acme, candidates: scored.slice(0, 1), compared: 1, notes: [] },
  "V-2": { identity: "ambiguous", candidates: scored, compared: 5, notes: ["no candidate is a clear match"] },
};

function evidence(vendorId: string): Evidence {
  const erp = {
    vendorId,
    name: "Acme Ltd",
    country: "GB",
    lei: null,
    cik: null,
    sic: null,
    sicListDescription: null,
  };
  return { erp, gleif: null, edgar: null, gaps: [] };
}

describe("Pipeline trace", () => {
  it("shows each handoff, the World Model's scores, the Judge's critique and its confidence", async () => {
    vi.mocked(openScout).mockResolvedValue({
      vendorIds: ["V-1", "V-2"],
      gather: (vendorId) => Promise.resolve(evidence(vendorId)),
    });
    vi.mocked(openResolver).mockReturnValue({
      resolve: ({ erp }) => Promise.resolve(resolutions[erp.vendorId ?? ""] as Resolution),
    });
    vi.mocked(judge).mockImplementation((_chat, _evidence, resolution, onRevision) => {
      if (resolution.identity === "ambiguous") {
        return Promise.resolve({ check: { identity: "ambiguous" }, reasons: {}, model: null });
      }
      onRevision?.(new AppError("meterless", "The Judge's reply is not JSON", false));
      const fact = (field: string, judgeScore: number) => ({
        field,
        claimed: { source: "ERP", value: "x", agrees: true },
        registries: [{ source: "GLEIF", value: "x", agrees: true }],
        accepted: "x",
        judgeScore,
      });
      return Promise.resolve({
        check: { identity: "clear", facts: [fact("name", 9), fact("lei", 7)] },
        reasons: { name: "same name", lei: "same LEI" },
        model: "nvidia/ultra",
      });
    });
    const { trace, events } = testTrace();
    const chat = () => Promise.reject(new Error("the Judge is stubbed"));

    await verify({ zetaris: { query: vi.fn(), execute: vi.fn() }, chat, secUserAgent: "t" }, trace, []);

    const steps = (vendorId: string | null) =>
      events()
        .filter((event) => event.vendor_id === vendorId)
        .map(({ agent_name, action, target_agent, confidence, status }) => ({
          step: `${agent_name} ${action}`,
          ...(target_agent && { target_agent }),
          ...(confidence !== null && { confidence }),
          ...(status !== "success" && { status }),
        }));
    expect(steps(null)).toEqual([
      { step: "Pipeline start", target_agent: "Scout" },
      { step: "Pipeline finish" },
    ]);
    expect(steps("V-1")).toEqual([
      { step: "Scout gather_evidence", target_agent: "Resolver" },
      { step: "Resolver world_model_score", confidence: 0.97 },
      { step: "Resolver resolve_identity", target_agent: "Judge" },
      { step: "Judge critique", status: "needs_revision" },
      { step: "Judge judge_facts", target_agent: "Decision", confidence: 7 / 9 },
      { step: "Decision decide" },
    ]);
    expect(steps("V-2")).toEqual([
      { step: "Scout gather_evidence", target_agent: "Resolver" },
      { step: "Resolver world_model_score", confidence: 0.97 },
      { step: "Resolver resolve_identity", target_agent: "Decision" },
      { step: "Decision decide" },
    ]);
    const output = (action: string, vendorId: string) =>
      events().find((event) => event.action === action && event.vendor_id === vendorId)?.output_summary;
    expect(output("world_model_score", "V-2")).toBe(
      "World Model scored 5 GLEIF entities: 2 at or above the review band; " +
        "ACME LIMITED 0.97 (auto-merge); ACME HOLDINGS LIMITED 0.83 (review)",
    );
    expect(output("critique", "V-1")).toBe("The Judge's reply is not JSON; asking the model again");
    expect(output("world_model_score", "V-1")).toBe(
      "World Model scored 1 GLEIF entity: 1 at or above the review band; ACME LIMITED 0.97 (auto-merge)",
    );
    expect(output("resolve_identity", "V-2")).toBe("ambiguous: 2 candidates; no candidate is a clear match");
  });

  it("gives no confidence where nothing was scored or no entity came near", async () => {
    vi.mocked(openScout).mockResolvedValue({
      vendorIds: ["V-1", "V-2"],
      gather: (vendorId) => Promise.resolve(evidence(vendorId)),
    });
    vi.mocked(openResolver).mockReturnValue({
      resolve: ({ erp }) =>
        Promise.resolve({
          identity: "unmatched",
          candidates: [],
          compared: erp.vendorId === "V-1" ? 0 : 4,
          notes: [],
        }),
    });
    vi.mocked(judge).mockResolvedValue({ check: { identity: "clear", facts: [] }, reasons: {}, model: null });
    const { trace, events, lines } = testTrace();

    await verify(
      { zetaris: { query: vi.fn(), execute: vi.fn() }, chat: vi.fn(), secUserAgent: "t" },
      trace,
      [],
    );

    expect(events().find((event) => event.action === "judge_facts")).toMatchObject({ confidence: null });
    expect(lines.find((line) => line.includes("judge_facts"))).not.toContain("confidence");
    expect(events().filter((event) => event.action === "world_model_score")).toMatchObject([
      {
        vendor_id: "V-2",
        output_summary: "World Model scored 4 GLEIF entities: 0 at or above the review band",
        confidence: null,
      },
    ]);
  });
});
