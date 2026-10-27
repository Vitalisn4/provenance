import { describe, expect, it, vi } from "vitest";
import { openResolver, sameName } from "../../app/agents/resolver.ts";
import type { Evidence } from "../../app/agents/scout.ts";
import { AppError } from "../../app/domain/errors.ts";
import { failure } from "./failure.ts";

type Page = { total: number; records: unknown } | "unreachable";

function record(lei: string, name: string, status = "ACTIVE") {
  return {
    attributes: {
      lei,
      entity: { legalName: { name }, legalAddress: { country: "DE" }, status },
      registration: { status: "ISSUED" },
    },
  };
}

// A fake Zetaris holding one GLEIF search result page per searched name; a name it does not hold finds nothing.
function fakeZetaris(pages: Record<string, Page> = {}) {
  const searched = new Map<string, string>();
  const query = vi.fn((sql: string) => {
    if (sql.startsWith("SHOW")) return Promise.resolve({ columns: ["name"], rows: [] });
    const rows = [...sql.matchAll(/FROM prov_gleif\.(\w+)/g)].map(([, table = ""]) => {
      const page = pages[searched.get(table) ?? ""];
      const { total, records } = typeof page === "object" ? page : { total: 0, records: [] };
      return [`prov_gleif.${table}`, String(total), JSON.stringify(records)];
    });
    return Promise.resolve({ columns: ["search", "total", "records"], rows });
  });
  const execute = vi.fn((ddl: string) => {
    const [, table = "", name = ""] = /TABLE (\w+) .*legalName%5D=([^&]+)/s.exec(ddl) ?? [];
    if (pages[decodeURIComponent(name)] === "unreachable") {
      return Promise.reject(new AppError("zetaris", "Zetaris: REST API call failed: https://x", false));
    }
    searched.set(table, decodeURIComponent(name));
    return Promise.resolve({ columns: [], rows: [] });
  });
  return { zetaris: { query, execute }, query, execute };
}

function evidence(name: string | null, country: string | null, gleif: Partial<Evidence["gleif"]> = null) {
  return {
    erp: { vendorId: "V-1", name, country, lei: null, cik: null, sic: null, sicListDescription: null },
    gleif: gleif && {
      lei: null,
      legalName: null,
      country: null,
      jurisdiction: null,
      registrationStatus: null,
      entityStatus: null,
      ...gleif,
    },
    edgar: null,
    gaps: [],
    rules: [],
  };
}

describe("Resolver", () => {
  it("takes the claimed LEI's entity when it is in the supplier's country", async () => {
    const { zetaris, query, execute } = fakeZetaris();
    const claimed = { lei: "L1", legalName: "Siemens Aktiengesellschaft", country: "DE", jurisdiction: "DE" };

    const resolution = await openResolver(zetaris).resolve(evidence("Siemens AG", "DE", claimed));

    expect(resolution).toEqual({
      identity: "clear",
      entity: {
        lei: "L1",
        legalName: "Siemens Aktiengesellschaft",
        country: "DE",
        registrationStatus: null,
        entityStatus: null,
      },
      candidates: [],
      compared: 0,
      notes: [],
    });
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("searches instead when the claimed LEI's entity is inactive", async () => {
    const { zetaris } = fakeZetaris({
      "Acme GmbH": { total: 2, records: [record("L9", "Acme GmbH", "INACTIVE"), record("L1", "Acme GmbH")] },
    });
    const claimed = { lei: "L9", legalName: "Acme GmbH", country: "DE", entityStatus: "INACTIVE" };

    const resolution = await openResolver(zetaris).resolve(evidence("Acme GmbH", "DE", claimed));

    expect(resolution).toMatchObject({
      identity: "clear",
      entity: { lei: "L1" },
      compared: 1,
      notes: ["claimed LEI L9 is Acme GmbH in DE, which GLEIF records as inactive"],
    });
  });

  it("searches every spelling of the legal form when the claimed LEI is another country's entity", async () => {
    const { zetaris, query, execute } = fakeZetaris({
      "Siemens AG": {
        total: 2,
        records: [record("L2", "Siemens Healthineers AG"), record("L3", "Siemens AG", "INACTIVE")],
      },
      "Siemens Aktiengesellschaft": { total: 1, records: [record("L1", "Siemens Aktiengesellschaft")] },
    });
    const claimed = { lei: "L9", legalName: "Siemens Aktieselskab", country: "DK" };

    const resolution = await openResolver(zetaris).resolve(evidence("Siemens AG", "DE", claimed));

    const [first, second] = execute.mock.calls.map(([ddl]) => ddl);
    expect(first).toMatch(/^CREATE LIGHTNING REST TABLE search_[0-9a-f]{16} FROM PROV_GLEIF /);
    expect(first).toContain(
      "filter%5Bentity.legalName%5D=Siemens%20AG&filter%5Bentity.legalAddress.country%5D=DE",
    );
    expect(first).toContain('HEADER (accept "application/vnd.api+json")');
    expect(second).toContain("filter%5Bentity.legalName%5D=Siemens%20Aktiengesellschaft&");
    expect(resolution).toMatchObject({
      identity: "clear",
      entity: {
        lei: "L1",
        legalName: "Siemens Aktiengesellschaft",
        country: "DE",
        registrationStatus: "ISSUED",
        entityStatus: "ACTIVE",
      },
      candidates: [{ entity: { lei: "L1" }, similarity: 1 }],
      notes: ["claimed LEI L9 is Siemens Aktieselskab in DK"],
    });
    const read = query.mock.calls.at(-1)?.[0] ?? "";
    expect(read).toMatch(
      /^SELECT 'prov_gleif\.search_[0-9a-f]{16}' AS search, meta\.pagination\.total AS total, to_json\(data\) AS records FROM prov_gleif\.search_/,
    );
    expect(read).toContain("\nUNION ALL\n");
  });

  it("matches a legal form under any spelling and never across forms", async () => {
    const { zetaris } = fakeZetaris({
      "Siemens A/S": { total: 1, records: [record("L1", "Siemens AB")] },
      "Siemens Aktieselskab": { total: 1, records: [record("L2", "Siemens Aktieselskab")] },
      "Intel Corp": { total: 1, records: [record("L3", "Intel Corporation")] },
      "Cisco Systems Incorporated": { total: 1, records: [record("L4", "CISCO SYSTEMS, INC.")] },
    });
    const { resolve } = openResolver(zetaris);

    expect(await resolve(evidence("Cisco Systems,Inc.", "US"))).toMatchObject({
      identity: "clear",
      entity: { lei: "L4" },
    });

    expect(await resolve(evidence("Siemens A/S", "DK"))).toMatchObject({
      identity: "clear",
      entity: { lei: "L2" },
      candidates: [{ entity: { lei: "L2" } }],
    });
    expect(await resolve(evidence("Intel Corp.", "US"))).toMatchObject({
      identity: "clear",
      entity: { lei: "L3" },
    });
  });

  it("knows a name under any spelling of its legal form, and nothing else as the same name", () => {
    expect(sameName("Siemens A/S", "SIEMENS AKTIESELSKAB")).toBe(true);
    expect(sameName("Cisco Systems,Inc.", "CISCO SYSTEMS INC")).toBe(true);
    expect(sameName("Siemens AG", "Siemens AB")).toBe(false);
    expect(sameName("Caterpiller Inc", "CATERPILLAR INC.")).toBe(false);
  });

  it("counts an entity found under two spellings once", async () => {
    const both = { total: 1, records: [record("L1", "Ford Motor Company")] };
    const { zetaris } = fakeZetaris({ "Ford Motor Co": both, "Ford Motor Company": both });

    const resolution = await openResolver(zetaris).resolve(evidence("Ford Motor Co", "US"));

    expect(resolution).toMatchObject({ identity: "clear", entity: { lei: "L1" } });
    expect(resolution.candidates).toHaveLength(1);
  });

  it("leaves a brand name without a legal form ambiguous", async () => {
    const { zetaris } = fakeZetaris({ Ericsson: { total: 1, records: [record("L1", "Ericsson AB")] } });

    const resolution = await openResolver(zetaris).resolve(evidence("Ericsson", "SE"));

    expect(resolution).toMatchObject({
      identity: "ambiguous",
      candidates: [{ entity: { lei: "L1" }, similarity: 1 }],
      notes: ['"Ericsson" has no legal form, so it names a brand rather than one legal entity'],
    });
  });

  it("leaves several matches, or only a close one, ambiguous", async () => {
    const { zetaris } = fakeZetaris({
      "Acme Foods GmbH": {
        total: 2,
        records: [record("L1", "Acme Food GmbH"), record("L2", "ACME FOODS GmbH")],
      },
      "Northwind Traders Ltd": { total: 1, records: [record("L3", "Northwind Tradaaa Limited")] },
    });
    const { resolve } = openResolver(zetaris);

    expect(await resolve(evidence("Acme Foods GmbH", "DE"))).toMatchObject({
      identity: "ambiguous",
      candidates: [
        { entity: { lei: "L2" }, similarity: 1 },
        { entity: { lei: "L1" }, similarity: 0.9 },
      ],
      notes: ['no candidate is a clear match for "Acme Foods GmbH": 2 scored, the closest 1.00'],
    });
    expect(await resolve(evidence("Northwind Traders Ltd", "GB"))).toMatchObject({
      identity: "ambiguous",
      candidates: [{ entity: { lei: "L3" } }],
      notes: ['no candidate is a clear match for "Northwind Traders Ltd": 1 scored, the closest 0.82'],
    });
  });

  it("reports a supplier GLEIF cannot match", async () => {
    const { zetaris, execute } = fakeZetaris();
    const { resolve } = openResolver(zetaris);

    expect(await resolve(evidence("Douala Cold Chain Sarl", "CM"))).toMatchObject({
      identity: "unmatched",
      candidates: [],
      notes: ['GLEIF has no active entity named like "Douala Cold Chain Sarl" in CM'],
    });
    const unsearchable: [string | null, string | null][] = [
      [null, "CM"],
      ["Douala Cold Chain SARL", null],
      ["Douala Cold Chain SARL", "Cameroon"],
    ];
    for (const [name, country] of unsearchable) {
      expect(await resolve(evidence(name, country))).toMatchObject({
        identity: "unmatched",
        notes: ["the ERP lacks the name or two-letter country a GLEIF search needs"],
      });
    }
    expect(await resolve(evidence("Acme GmbH", null, { lei: "L1", legalName: "Acme GmbH" }))).toMatchObject({
      identity: "unmatched",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("settles nothing from an incomplete search", async () => {
    const incomplete = "the search was incomplete, so it can neither settle on one entity nor rule all out";
    const { zetaris } = fakeZetaris({
      "Kribi Logistics SARL": "unreachable",
      "Acme Ltd": { total: 1, records: [record("L1", "Acme Ltd")] },
      "Acme Limited": "unreachable",
      "Acme Corporation": { total: 250, records: [record("L2", "Acme Corporation")] },
    });
    const { resolve } = openResolver(zetaris);

    expect(await resolve(evidence("Kribi Logistics SARL", "CM"))).toEqual({
      identity: "ambiguous",
      candidates: [],
      compared: 0,
      notes: ['GLEIF could not be searched for "Kribi Logistics SARL"', incomplete],
    });
    expect(await resolve(evidence("Acme Ltd", "GB"))).toMatchObject({
      identity: "ambiguous",
      candidates: [{ entity: { lei: "L1" } }],
      notes: ['GLEIF could not be searched for "Acme Limited"', incomplete],
    });
    expect(await resolve(evidence("Acme Corp", "US"))).toMatchObject({
      identity: "ambiguous",
      candidates: [{ entity: { lei: "L2" } }],
      notes: ['a GLEIF search for "Acme Corporation" matched 250 entities; only 1 were compared', incomplete],
    });
  });

  it("rejects search results it cannot read", async () => {
    const malformed: [unknown, string][] = [
      [[{ attributes: { lei: "L1" } }], "GLEIF search returned a record without an LEI or legal name"],
      [[null], "GLEIF search returned a record without an LEI or legal name"],
      ["L1", "GLEIF search returned no record list"],
    ];
    for (const [records, message] of malformed) {
      const { zetaris } = fakeZetaris({ "Acme GmbH": { total: 1, records } });
      expect((await failure(openResolver(zetaris).resolve(evidence("Acme GmbH", "DE")))).message).toBe(
        message,
      );
    }
  });
});
