import { restTables } from "../adapters/restTables.ts";
import { quotable } from "../adapters/sqlScript.ts";
import type { ZetarisClient } from "../adapters/zetaris.ts";
import { AppError } from "../domain/errors.ts";
import { isValidLei } from "../domain/lei.ts";

// Each field's SQL expression in the evidence query. `sicListDescription` is the company_dns description of the
// record's SIC code, null when the list lacks the code.
const erpFields = {
  vendorId: "e.vendor_id",
  name: "e.vendor_name",
  country: "e.country",
  lei: "e.claimed_lei",
  cik: "e.claimed_cik",
  sic: "e.claimed_sic",
  sicListDescription: "l.codes[e.claimed_sic]",
};
const gleifFields = {
  lei: "g.data.attributes.lei",
  legalName: "g.data.attributes.entity.legalName.name",
  country: "g.data.attributes.entity.legalAddress.country",
  jurisdiction: "g.data.attributes.entity.jurisdiction",
  registrationStatus: "g.data.attributes.registration.status",
  entityStatus: "g.data.attributes.entity.status",
};
const edgarFields = {
  cik: "s.cik",
  name: "s.name",
  sic: "s.sic",
  sicDescription: "s.sicDescription",
  stateOfIncorporation: "s.stateOfIncorporation",
  city: "s.addresses.business.city",
  sicListDescription: "l.codes[s.sic]",
};

// The SIC list as one code-to-description map: Spark cannot join the prov.sic_codes view twice in a query, and
// the claimed and EDGAR codes both need looking up.
const sicList =
  "LEFT JOIN (SELECT map_from_entries(collect_list(struct(sic_code, description))) AS codes FROM prov.sic_codes) l ON true";

type Fields<T> = Record<keyof T, string | null>;

// What the registries say about one supplier's claimed identifiers, read in one query. A null registry record
// means there is none to show: the ERP has no identifier for that registry, or `gaps` says why.
export interface Evidence {
  erp: Fields<typeof erpFields>;
  gleif: Fields<typeof gleifFields> | null;
  edgar: Fields<typeof edgarFields> | null;
  gaps: string[];
}

// A supplier typed into a request rather than read from the ERP, with the ERP's fields.
export interface NewSupplier {
  vendorId: string;
  name: string;
  country: string;
  lei: string | null;
  cik: string | null;
  sic: string | null;
}

export const gleifAccept = ["accept", "application/vnd.api+json"] as const;

// A typed value reaches the SQL base64-encoded, so no character in it can end the literal.
function literal(value: string | null): string {
  return value === null
    ? "CAST(NULL AS STRING)"
    : `CAST(unbase64('${Buffer.from(value).toString("base64")}') AS STRING)`;
}

function select(prefix: string, fields: Record<string, string>): string[] {
  return Object.entries(fields).map(([key, expression]) => `${expression} AS ${prefix}_${key}`);
}

function read<T extends Record<string, string>>(
  prefix: string,
  fields: T,
  cells: Map<string, string | null>,
): Fields<T> {
  return Object.fromEntries(
    Object.keys(fields).map((key) => {
      const value = cells.get(`${prefix}_${key}`);
      if (value === undefined) {
        throw new AppError("zetaris", `Evidence query returned no ${prefix}_${key}`, false);
      }
      return [key, value];
    }),
  ) as Fields<T>;
}

// Registers the REST tables a supplier's claimed identifiers need, then reads the supplier's ERP row, or the
// typed-in row standing for it, and its registry records in one query. `vendorIds` are the ERP's.
export async function openScout(
  zetaris: ZetarisClient,
  secUserAgent: string,
  typed: readonly NewSupplier[] = [],
): Promise<{ vendorIds: string[]; gather: (vendorId: string) => Promise<Evidence> }> {
  // Checked up front, so a bad setting stops the run before any supplier rather than failing each one.
  const userAgent = quotable("SEC_USER_AGENT", secUserAgent);
  const { register } = restTables(zetaris);
  const erp = await zetaris.query(
    "SELECT vendor_id, claimed_lei, claimed_cik FROM prov_erp.vendor_master ORDER BY vendor_id",
  );

  // A vendor ID goes into the evidence query as a string literal, so only characters that need no escaping
  // are accepted; Spark reads a backslash in a literal as an escape.
  const suppliers = new Map<
    string,
    { lei: string | null; cik: string | null; from: string; where: string | null }
  >(
    erp.rows.map(([vendorId, lei = null, cik = null]) => {
      if (!vendorId || !/^[\w-]+$/.test(vendorId)) {
        throw new AppError(
          "zetaris",
          `ERP vendor_id ${JSON.stringify(vendorId)} cannot be queried safely`,
          false,
        );
      }
      return [
        vendorId,
        { lei, cik, from: "prov_erp.vendor_master e", where: `WHERE e.vendor_id = '${vendorId}'` },
      ];
    }),
  );
  const vendorIds = [...suppliers.keys()];
  for (const { vendorId, name, country, lei, cik, sic } of typed) {
    if (suppliers.has(vendorId)) throw new AppError("input", `${vendorId} is already a vendor ID`, false);
    const row = {
      vendor_id: vendorId,
      vendor_name: name,
      country,
      claimed_lei: lei,
      claimed_cik: cik,
      claimed_sic: sic,
    };
    const columns = Object.entries(row).map(([column, value]) => `${literal(value)} AS ${column}`);
    suppliers.set(vendorId, { lei, cik, from: `(SELECT ${columns.join(", ")}) e`, where: null });
  }

  async function gleifTable(lei: string | null, gaps: string[]): Promise<string | null> {
    if (lei === null) return null;
    if (!isValidLei(lei)) {
      gaps.push(`claimed LEI ${lei} is not a valid ISO 17442 LEI, so GLEIF was not queried`);
      return null;
    }
    const table = await register({
      source: "PROV_GLEIF",
      table: `lei_${lei.toLowerCase()}`,
      endpoint: `https://api.gleif.org/api/v1/lei-records/${lei}`,
      header: gleifAccept,
    });
    if (!table) gaps.push(`GLEIF has no record of LEI ${lei}, or could not be reached`);
    return table;
  }

  async function edgarTable(cik: string | null, gaps: string[]): Promise<string | null> {
    if (cik === null) return null;
    if (!/^\d{1,10}$/.test(cik)) {
      gaps.push(`claimed CIK ${cik} is not a CIK number, so EDGAR was not queried`);
      return null;
    }
    const padded = cik.padStart(10, "0");
    const table = await register({
      source: "PROV_SEC",
      table: `edgar_${padded}`,
      endpoint: `https://data.sec.gov/submissions/CIK${padded}.json`,
      header: ["user-agent", userAgent],
    });
    if (!table) gaps.push(`EDGAR has no filer with CIK ${cik}, or could not be reached`);
    return table;
  }

  // Takes only a vendor ID, so the identifiers looked up and the row in the SQL always belong together.
  async function gather(vendorId: string): Promise<Evidence> {
    const supplier = suppliers.get(vendorId);
    if (!supplier) throw new AppError("zetaris", `Supplier ${vendorId} is not in the ERP`, false);
    const { lei, cik, from, where } = supplier;
    const gaps: string[] = [];
    const gleif = await gleifTable(lei, gaps);
    const edgar = await edgarTable(cik, gaps);
    const sql = [
      `SELECT ${[
        ...select("erp", erpFields),
        ...(gleif ? select("gleif", gleifFields) : []),
        ...(edgar ? select("edgar", edgarFields) : []),
      ].join(", ")}`,
      `FROM ${from}`,
      sicList,
      ...(gleif ? [`LEFT JOIN ${gleif} g ON true`] : []),
      ...(edgar ? [`LEFT JOIN ${edgar} s ON true`] : []),
      ...(where ? [where] : []),
    ].join("\n");

    const { columns, rows } = await zetaris.query(sql);
    const [row, ...extra] = rows;
    if (!row || extra.length > 0) {
      throw new AppError(
        "zetaris",
        `Evidence query for ${vendorId} returned ${rows.length} rows, not 1`,
        false,
      );
    }
    const cells = new Map(columns.map((name, i) => [name, row[i] ?? null]));
    return {
      erp: read("erp", erpFields, cells),
      gleif: gleif ? read("gleif", gleifFields, cells) : null,
      edgar: edgar ? read("edgar", edgarFields, cells) : null,
      gaps,
    };
  }

  return { vendorIds, gather };
}
