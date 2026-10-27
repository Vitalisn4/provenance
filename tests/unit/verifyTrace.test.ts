import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { judge } from "../../app/agents/judge.ts";
import { openResolver, type Resolution } from "../../app/agents/resolver.ts";
import { openScout, type Evidence } from "../../app/agents/scout.ts";
import { policy } from "../../app/config/policy.ts";
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
  return { erp, gleif: null, edgar: null, gaps: [], rules: [] };
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
    vi.mocked(judge).mockImplementation((_chat, _evidence, resolution, { onRevision } = {}) => {
      if (resolution.identity === "ambiguous") {
        return Promise.resolve({
          check: { identity: "ambiguous" },
          reasons: {},
          model: null,
          rules: [],
          contradicted: [],
        });
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
        rules: [],
        contradicted: [],
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

  it("verifies the learning batch first, so the Judge can use the rules the Rule Smith learns from it", async () => {
    const vendorIds = ["V-1", "V-2", "V-3", "V-4", "V-5"];
    const rule = "lei_is_claimed_record";
    vi.mocked(openScout).mockResolvedValue({
      vendorIds,
      gather: (vendorId) =>
        Promise.resolve({
          ...evidence(vendorId),
          gleif: { ...acme, jurisdiction: "GB" },
          rules: [rule],
        }),
    });
    vi.mocked(openResolver).mockReturnValue({
      resolve: () =>
        Promise.resolve({ identity: "clear", entity: acme, candidates: [], compared: 1, notes: [] }),
    });
    const judged: { vendorId: string | null; rules: string[] }[] = [];
    vi.mocked(judge).mockImplementation((_chat, { erp }, _resolution, { rules = [] } = {}) => {
      judged.push({ vendorId: erp.vendorId, rules: rules.map(({ id }) => id) });
      const fact = {
        field: "lei",
        claimed: { value: "L1", agrees: true },
        registries: [{ source: "GLEIF", value: "L1", agrees: true }],
        accepted: "L1",
        judgeScore: erp.vendorId === "V-1" ? null : 9,
      };
      return Promise.resolve({
        check: { identity: "clear", facts: [fact] },
        reasons: {},
        model: erp.vendorId === "V-1" ? null : "nvidia/ultra",
        rules: erp.vendorId === "V-1" ? [rule] : [],
        contradicted: erp.vendorId === "V-5" ? [rule] : [],
      });
    });
    const { trace, events } = testTrace();

    const { suppliers, rules } = await verify(
      { zetaris: { query: vi.fn(), execute: vi.fn() }, chat: vi.fn(), secUserAgent: "t" },
      trace,
      [],
      [],
      new Set(["V-2", "V-3", "V-4"]),
    );

    expect(judged.slice(0, 3)).toEqual(
      expect.arrayContaining(["V-2", "V-3", "V-4"].map((vendorId) => ({ vendorId, rules: [] }))),
    );
    expect(judged.slice(3)).toEqual(
      expect.arrayContaining(["V-1", "V-5"].map((vendorId) => ({ vendorId, rules: [rule] }))),
    );
    expect(suppliers.map(({ vendorId }) => vendorId)).toEqual(vendorIds);
    expect(suppliers[0]).toMatchObject({ vendorId: "V-1", rules: [rule], model: null });
    expect(rules).toMatchObject([{ id: rule, status: "demoted", support: 3, contradictedBy: ["V-5"] }]);
    const step = (action: string) => events().find((event) => event.action === action);
    expect(step("start")?.output_summary).toBe(
      `5 of 5 ERP suppliers, ${policy.pipeline.concurrency} at a time; the 3 in the learning batch first`,
    );
    expect(step("learn")).toMatchObject({
      agent_name: "Pipeline",
      output_summary: "3 learning suppliers verified",
      target_agent: "Rule Smith",
    });
    expect(step("apply_rules")).toMatchObject({
      vendor_id: "V-1",
      output_summary: `learned rules settled every fact, so the model was not asked: ${rule}`,
      target_agent: "Decision",
    });
    expect(step("demote")).toMatchObject({ agent_name: "Rule Smith", vendor_id: "V-5" });
    const memory = JSON.parse(readFileSync(trace.file.replace(/\.jsonl$/, "-hmem/state.json"), "utf8")) as {
      records: { provenance: { refs?: string[] } }[];
    };
    expect(memory.records.flatMap(({ provenance }) => provenance.refs ?? []).sort()).toEqual([
      "V-2",
      "V-3",
      "V-4",
    ]);
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
    vi.mocked(judge).mockResolvedValue({
      check: { identity: "clear", facts: [] },
      reasons: {},
      model: null,
      rules: [],
      contradicted: [],
    });
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
