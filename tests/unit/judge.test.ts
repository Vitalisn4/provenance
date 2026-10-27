import { describe, expect, it, vi } from "vitest";
import type { MeterlessClient } from "../../app/adapters/meterless.ts";
import { judge } from "../../app/agents/judge.ts";
import type { Resolution } from "../../app/agents/resolver.ts";
import type { Evidence } from "../../app/agents/scout.ts";
import { policy } from "../../app/config/policy.ts";
import { decide } from "../../app/domain/decide.ts";
import { AppError } from "../../app/domain/errors.ts";
import { failure } from "./failure.ts";

const model = "nvidia/nemotron-3-ultra-550b-a55b";
const lei = "WRJR7GS4GTRECRRTVX92";

function evidence(erp: Partial<Evidence["erp"]>, edgar: Partial<Evidence["edgar"]> = null): Evidence {
  return {
    erp: {
      vendorId: "V-1",
      name: null,
      country: "US",
      lei: null,
      cik: null,
      sic: null,
      sicListDescription: null,
      ...erp,
    },
    gleif: null,
    edgar: edgar && {
      cik: "18230",
      name: null,
      sic: null,
      sicDescription: null,
      stateOfIncorporation: null,
      city: null,
      sicListDescription: null,
      ...edgar,
    },
    gaps: [],
  };
}

function clear(legalName: string, registrationStatus = "ISSUED"): Resolution {
  const entity = { lei, legalName, country: "US", registrationStatus, entityStatus: "ACTIVE" };
  return { identity: "clear", entity, candidates: [], compared: 0, notes: [] };
}

const unmatched: Resolution = { identity: "unmatched", candidates: [], compared: 0, notes: [] };

type Entry = Record<string, unknown>;

function verdict(field: string, extra: Entry = {}): Entry {
  return {
    field,
    agrees: {},
    accuracy: 3,
    appropriateness: 3,
    actionability: 3,
    reason: `${field} checked`,
    ...extra,
  };
}

// A test double for the deep lane: answers every call with `content`, and records what it was asked.
function chat(content: string) {
  return vi.fn<MeterlessClient["chat"]>(() => Promise.resolve({ content, model }));
}

function replying(...entries: Entry[]) {
  return chat(JSON.stringify({ facts: entries }));
}

// The facts the deep lane was asked about, on their own line between the instructions and the closing reminder
// of the reply format.
function asked(fake: ReturnType<typeof chat>): unknown {
  const [route, messages] = fake.mock.calls[0] ?? [];
  expect(route).toBe("deep");
  const lines = messages?.[0]?.content.split("\n") ?? [];
  expect(lines.at(-1)).toBe("Reply now with the JSON object only: no plan, steps or prose.");
  return JSON.parse(lines.filter((line) => line.startsWith('{"facts":')).at(-1) ?? "null");
}

const caterpillar = evidence(
  { name: "Caterpiller Inc", lei, sic: "3531" },
  { name: "CATERPILLAR INC", sic: "3531", sicListDescription: "Construction Machinery & Equipment" },
);

describe("Judge", () => {
  it("leaves only differently worded names to the model, and corrects the ERP from its verdict", async () => {
    const fake = replying(
      verdict("name", { agrees: { ERP: false } }),
      verdict("lei"),
      verdict("sic", { accuracy: 2 }),
    );

    const { check, reasons, model: answered } = await judge(fake, caterpillar, clear("CATERPILLAR INC."));

    expect(asked(fake)).toEqual({
      facts: [
        {
          field: "name",
          accepted: "CATERPILLAR INC.",
          values: [
            { source: "ERP", value: "Caterpiller Inc", agrees: null },
            { source: "GLEIF", value: "CATERPILLAR INC.", agrees: true },
            { source: "EDGAR", value: "CATERPILLAR INC", agrees: true },
          ],
        },
        {
          field: "lei",
          accepted: lei,
          values: [
            { source: "ERP", value: lei, agrees: true },
            { source: "GLEIF", value: lei, agrees: true },
          ],
        },
        {
          field: "sic",
          accepted: "3531",
          values: [
            { source: "ERP", value: "3531", agrees: true },
            { source: "EDGAR", value: "3531", agrees: true },
            { source: "company_dns", value: "Construction Machinery & Equipment", agrees: true },
          ],
        },
      ],
    });
    expect(check).toMatchObject({
      identity: "clear",
      registrationStatus: "ISSUED",
      facts: [
        {
          field: "name",
          claimed: { agrees: false },
          registries: [{ agrees: true }, { agrees: true }],
          judgeScore: 9,
        },
        { field: "lei", judgeScore: 9 },
        { field: "sic", judgeScore: 8 },
      ],
    });
    expect(reasons).toEqual({ name: "name checked", lei: "lei checked", sic: "sic checked" });
    expect(answered).toBe(model);
    expect(decide(check)).toMatchObject({
      decision: "fix",
      actions: [{ kind: "correct", field: "name", value: "CATERPILLAR INC.", source: "GLEIF" }],
    });
  });

  it("fills a blank LEI and disputes a SIC code the industry list lacks", async () => {
    const ibm = evidence({ name: "IBM CORP", sic: "3570" }, { name: "IBM CORP", sic: "3570" });
    const fake = replying(
      verdict("name", { agrees: { ERP: true, EDGAR: true } }),
      verdict("lei"),
      verdict("sic"),
    );

    const { check } = await judge(fake, ibm, clear("IBM CORPORATION"));

    expect(check).toMatchObject({
      facts: [
        { field: "name" },
        { field: "lei", claimed: null, accepted: lei },
        {
          field: "sic",
          registries: [
            { source: "EDGAR", agrees: true },
            { source: "company_dns", value: "no entry for 3570", agrees: false },
          ],
        },
      ],
    });
    expect(decide(check)).toMatchObject({
      decision: "escalate",
      actions: [
        { kind: "correct", field: "lei", value: lei },
        { kind: "escalate", reason: "the sources disagree on sic" },
      ],
    });
  });

  it("corrects an LEI the ERP copied from another entity", async () => {
    const siemens = evidence({ name: "Siemens AG", country: "DE", lei: "5299008LSFRCSQJPMO62" });
    const fake = replying(verdict("name", { agrees: { ERP: true } }), verdict("lei"));

    const { check } = await judge(fake, siemens, clear("SIEMENS AKTIENGESELLSCHAFT"));

    expect(asked(fake)).toMatchObject({ facts: [{ values: [{ source: "ERP", agrees: true }, {}] }, {}] });
    expect(fake.mock.calls[0]?.[1][0]?.content).toContain("AG = Aktiengesellschaft, A/S = Aktieselskab");
    expect(fake.mock.calls[0]?.[1]).toHaveLength(1);
    expect(decide(check)).toEqual({
      decision: "fix",
      facts: [
        { field: "name", status: "confirmed" },
        { field: "lei", status: "conflicting" },
      ],
      actions: [{ kind: "correct", field: "lei", value: lei, source: "GLEIF" }],
    });
  });

  it("never lets the model overturn an agreement settled by exact comparison", async () => {
    const fake = replying(
      verdict("name", { agrees: { ERP: true, EDGAR: true, GLEIF: false } }),
      verdict("lei", { agrees: { ERP: false, GLEIF: false } }),
      verdict("sic", { agrees: { company_dns: false } }),
    );

    const { check } = await judge(fake, caterpillar, clear("CATERPILLAR INC."));

    expect(decide(check)).toEqual({
      decision: "ready",
      facts: ["name", "lei", "sic"].map((field) => ({ field, status: "confirmed" })),
      actions: [],
    });
  });

  it("checks the ERP name against EDGAR's without GLEIF, and carries a lapsed registration", async () => {
    const fake = replying(verdict("name", { agrees: { ERP: true } }));

    const { check } = await judge(fake, evidence({ name: "Acme Inc" }, { name: "ACME INC" }), unmatched);
    expect(check).toEqual({
      identity: "clear",
      facts: [
        {
          field: "name",
          claimed: { source: "ERP", value: "Acme Inc", agrees: true },
          registries: [{ source: "EDGAR", value: "ACME INC", agrees: true }],
          accepted: "ACME INC",
          judgeScore: 9,
        },
      ],
    });

    const noSic = await judge(fake, evidence({ name: "Acme Inc" }, { name: "ACME INC", sic: "" }), unmatched);
    expect(noSic.check).toMatchObject({ facts: [{ field: "name" }] });

    const lapsed = await judge(
      replying(verdict("name"), verdict("lei")),
      evidence({ name: "X" }),
      clear("X", "LAPSED"),
    );
    expect(lapsed.check).toMatchObject({ registrationStatus: "LAPSED" });
  });

  it("asks no model when no registry covers the supplier, so only documents can settle it", async () => {
    const fake = chat("");

    const {
      check,
      reasons,
      model: answered,
    } = await judge(
      fake,
      evidence({ name: "Douala Cold Chain SARL", country: "CM", lei: "2549004XTX9UX53WO914", sic: "2011" }),
      unmatched,
    );

    expect(fake).not.toHaveBeenCalled();
    expect(answered).toBeNull();
    expect(reasons).toEqual({});
    const fields = ["name", "lei", "sic"];
    expect(check).toMatchObject({ facts: fields.map((field) => ({ field, judgeScore: null })) });
    expect(decide(check)).toEqual({
      decision: "fix",
      facts: fields.map((field) => ({ field, status: "unverified" })),
      actions: fields.map((field) => ({ kind: "request_document", field })),
    });
  });

  it("asks no model about an ambiguous identity", async () => {
    const fake = chat("");
    const ambiguous: Resolution = { identity: "ambiguous", candidates: [], compared: 0, notes: [] };

    await expect(judge(fake, caterpillar, ambiguous)).resolves.toEqual({
      check: { identity: "ambiguous" },
      reasons: {},
      model: null,
    });
    expect(fake).not.toHaveBeenCalled();
  });

  it("reads the answer after the model's reasoning, even inside a code fence", async () => {
    const reply = JSON.stringify({ facts: [verdict("name", { agrees: { ERP: true } }), verdict("lei")] });
    const fake = chat(`The user wants {"facts": []}.</think>\n\`\`\`json\n${reply}\n\`\`\``);

    const { check } = await judge(fake, evidence({ name: "Acme Inc" }), clear("ACME INC"));

    expect(check).toMatchObject({ facts: [{ claimed: { agrees: true }, judgeScore: 9 }, { field: "lei" }] });
  });

  it("asks once more when a reply lacks a complete verdict", async () => {
    const fake = replying(verdict("name", { agrees: { ERP: true } }), verdict("lei"));
    fake.mockResolvedValueOnce({ content: "1. Analyse the facts.", model });

    const onRevision = vi.fn();

    const { check } = await judge(fake, evidence({ name: "Acme" }), clear("ACME INC"), onRevision);

    expect(fake).toHaveBeenCalledTimes(2);
    expect(onRevision).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "The Judge's reply is not JSON" }),
    );
    expect(check).toMatchObject({ facts: [{ claimed: { agrees: true } }, { field: "lei" }] });
  });

  it("rejects a reply that is not JSON or lacks a complete verdict", async () => {
    const acme = evidence({ name: "Acme" });
    const name = (extra: Entry) =>
      JSON.stringify({ facts: [verdict("name", { agrees: { ERP: true }, ...extra })] });
    const incomplete = "The Judge's reply has no complete verdict on name";

    for (const [content, message] of [
      ["1. Analyse the facts.", "The Judge's reply is not JSON"],
      ['{"facts": [}', "The Judge's reply is not JSON"],
      ["{}", incomplete],
      [JSON.stringify({ facts: [verdict("lei")] }), incomplete],
      [name({ agrees: { ERP: "EDGAR" } }), incomplete],
      [name({ agrees: {} }), incomplete],
      [name({ accuracy: 4 }), incomplete],
      [name({ accuracy: 2.5 }), incomplete],
      [name({ actionability: -1 }), incomplete],
      [name({ appropriateness: "3" }), incomplete],
      [name({ reason: null }), incomplete],
    ]) {
      const fake = chat(content ?? "");
      const error = await failure(judge(fake, acme, clear("ACME INC")));
      expect(fake).toHaveBeenCalledTimes(policy.decision.judgeAttempts);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ type: "meterless", message, recoverable: false });
    }
  });
});
