import { describe, expect, it, vi } from "vitest";
import { openScout } from "../../app/agents/scout.ts";
import { AppError } from "../../app/domain/errors.ts";
import { failure } from "./failure.ts";

type Result = { columns: string[]; rows: (string | null)[][] };

const lei = "VGRQXHF3J8VDLUA7XE92";
const userAgent = "Provenance test@example.com";

// A fake Zetaris that answers the evidence query by echoing each column alias as its value.
function fakeZetaris({
  erp,
  tables = [],
  create = () => ({ columns: [], rows: [] }),
  evidence = (columns) => ({ columns, rows: [columns] }),
}: {
  erp: (string | null)[][];
  tables?: string[];
  create?: (sql: string) => Result;
  evidence?: (columns: string[]) => Result;
}) {
  const respond = (sql: string): Result => {
    if (sql.startsWith("SELECT vendor_id")) {
      return { columns: ["vendor_id", "claimed_lei", "claimed_cik"], rows: erp };
    }
    const show = /^SHOW LIGHTNING TABLES (\w+)$/.exec(sql);
    if (show) {
      return {
        columns: ["name", "table_type"],
        rows: tables
          .filter((name) => name.startsWith(`${show[1]}.`))
          .map((name) => [name.split(".")[1] ?? "", "rest"]),
      };
    }
    if (sql.startsWith("CREATE")) return create(sql);
    return evidence([...sql.matchAll(/ AS ((?:erp|gleif|edgar)_\w+)/g)].map((match) => match[1] ?? ""));
  };
  const query = vi.fn((sql: string) => Promise.resolve().then(() => respond(sql)));
  const execute = vi.fn((sql: string) => Promise.resolve().then(() => respond(sql)));
  const evidenceSql = () => query.mock.calls.at(-1)?.[0] ?? "";
  return { zetaris: { query, execute }, execute, evidenceSql };
}

describe("Scout", () => {
  it("registers each missing registry table once and reads a supplier's records in one query", async () => {
    const { zetaris, execute, evidenceSql } = fakeZetaris({
      erp: [
        ["V-1", lei, "51143"],
        ["V-2", lei, null],
      ],
    });
    const { vendorIds, gather } = await openScout(zetaris, userAgent);
    expect(vendorIds).toEqual(["V-1", "V-2"]);

    const evidence = await gather("V-1");
    const sql = evidenceSql();
    await gather("V-2");

    expect(execute).toHaveBeenCalledTimes(2);
    const [gleifDdl, edgarDdl] = execute.mock.calls.map(([sql]) => sql);
    expect(gleifDdl).toMatch(/^CREATE LIGHTNING REST TABLE lei_vgrqxhf3j8vdlua7xe92 FROM PROV_GLEIF /);
    expect(gleifDdl).toContain(`"https://api.gleif.org/api/v1/lei-records/${lei}"`);
    expect(gleifDdl).toContain('HEADER (accept "application/vnd.api+json")');
    expect(edgarDdl).toMatch(/^CREATE LIGHTNING REST TABLE edgar_0000051143 FROM PROV_SEC /);
    expect(edgarDdl).toContain('"https://data.sec.gov/submissions/CIK0000051143.json"');
    expect(edgarDdl).toContain(`HEADER (user-agent "${userAgent}")`);

    expect(evidence).toMatchObject({
      erp: { vendorId: "erp_vendorId", sic: "erp_sic", sicListDescription: "erp_sicListDescription" },
      gleif: { legalName: "gleif_legalName", registrationStatus: "gleif_registrationStatus" },
      edgar: { sic: "edgar_sic", city: "edgar_city", sicListDescription: "edgar_sicListDescription" },
      gaps: [],
    });
    expect(sql).toContain("LEFT JOIN prov_gleif.lei_vgrqxhf3j8vdlua7xe92 g ON true");
    expect(sql).toContain("LEFT JOIN prov_sec.edgar_0000051143 s ON true");
    expect(sql).toMatch(/WHERE e\.vendor_id = 'V-1'$/);
  });

  it("reuses the tables Zetaris already has", async () => {
    const { zetaris, execute } = fakeZetaris({
      erp: [["V-1", lei, "51143"]],
      tables: ["prov_gleif.lei_vgrqxhf3j8vdlua7xe92", "prov_sec.edgar_0000051143"],
    });
    const { gather } = await openScout(zetaris, userAgent);

    const evidence = await gather("V-1");
    expect(execute).not.toHaveBeenCalled();
    expect(evidence.gleif).not.toBeNull();
    expect(evidence.edgar).not.toBeNull();
  });

  it("does not query a registry for a malformed identifier", async () => {
    const { zetaris, execute, evidenceSql } = fakeZetaris({
      erp: [["V-1", "VGRQXHF3J8VDLUA7XE93", "51-143"]],
    });
    const { gather } = await openScout(zetaris, userAgent);

    const evidence = await gather("V-1");
    expect(execute).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      gleif: null,
      edgar: null,
      gaps: [
        "claimed LEI VGRQXHF3J8VDLUA7XE93 is not a valid ISO 17442 LEI, so GLEIF was not queried",
        "claimed CIK 51-143 is not a CIK number, so EDGAR was not queried",
      ],
    });
    expect(evidenceSql()).not.toMatch(/prov_gleif|prov_sec/);
  });

  it("records a registry that has no record and leaves it out of the query", async () => {
    const { zetaris, evidenceSql } = fakeZetaris({
      erp: [["V-1", lei, "51143"]],
      create: (sql) => {
        if (sql.includes("PROV_GLEIF")) {
          throw new AppError("zetaris", `Zetaris: REST API call failed: https://api.gleif.org/x`, false);
        }
        return { columns: [], rows: [] };
      },
    });
    const { gather } = await openScout(zetaris, userAgent);

    const evidence = await gather("V-1");
    expect(evidence.gleif).toBeNull();
    expect(evidence.edgar).not.toBeNull();
    expect(evidence.gaps).toEqual([`GLEIF has no record of LEI ${lei}, or could not be reached`]);
    expect(evidenceSql()).not.toContain("prov_gleif");
  });

  it("refuses a user agent or vendor ID that could alter the SQL", async () => {
    const quoted = await failure(openScout(fakeZetaris({ erp: [] }).zetaris, 'Provenance "x'));
    expect(quoted.type).toBe("config");
    expect(quoted.message).toMatch(/^SEC_USER_AGENT must not/);

    for (const vendorId of ["V-1' OR '1'='1", "V-1\\", null]) {
      const error = await failure(
        openScout(fakeZetaris({ erp: [[vendorId, null, null]] }).zetaris, userAgent),
      );
      expect(error.message).toMatch(/cannot be queried safely/);
    }
  });

  it("gathers only suppliers in the ERP", async () => {
    const { zetaris, execute } = fakeZetaris({ erp: [["V-1", lei, null]] });
    const { gather } = await openScout(zetaris, userAgent);

    expect((await failure(gather("V-2' OR '1'='1"))).message).toBe(
      "Supplier V-2' OR '1'='1 is not in the ERP",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an evidence result that is not one complete row", async () => {
    const results: ((columns: string[]) => Result)[] = [
      (columns) => ({ columns, rows: [] }),
      (columns) => ({ columns, rows: [columns, columns] }),
      (columns) => ({ columns: columns.slice(1), rows: [columns.slice(1)] }),
    ];
    for (const evidence of results) {
      const { gather } = await openScout(
        fakeZetaris({ erp: [["V-1", null, null]], evidence }).zetaris,
        userAgent,
      );
      expect((await failure(gather("V-1"))).message).toMatch(
        /^Evidence query (for V-1 returned \d rows, not 1|returned no erp_vendorId)$/,
      );
    }
  });
});
