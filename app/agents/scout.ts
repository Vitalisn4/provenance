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

// What the registries say about one supplier's claimed identifiers, read by the one query in `sql`. A null
// registry record means there is none to show: the ERP has no identifier for that registry, or `gaps` says why.
interface Evidence {
  erp: Fields<typeof erpFields>;
  gleif: Fields<typeof gleifFields> | null;
  edgar: Fields<typeof edgarFields> | null;
  gaps: string[];
  sql: string;
}

// Zetaris fetches a REST table's source when the table is created, so a registry without the record (or one
// that cannot be reached) fails the CREATE with this message and no table is left behind.
const fetchFailed = "REST API call failed";

function gleifDdl(table: string, lei: string): string {
  return `CREATE LIGHTNING REST TABLE ${table} FROM PROV_GLEIF REQUEST(
    endpoint "https://api.gleif.org/api/v1/lei-records/${lei}", method "get", response_type "json",
    http_encoding "URLENCODED") HEADER (accept "application/vnd.api+json") BODY ()`;
}

function edgarDdl(table: string, cik: string, userAgent: string): string {
  return `CREATE LIGHTNING REST TABLE ${table} FROM PROV_SEC REQUEST(
    endpoint "https://data.sec.gov/submissions/CIK${cik}.json", method "get", response_type "json",
    http_encoding "URLENCODED") HEADER (user-agent "${userAgent}") BODY ()`;
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

async function tableNames(zetaris: ZetarisClient, database: string): Promise<string[]> {
  const { columns, rows } = await zetaris.query(`SHOW LIGHTNING TABLES ${database}`);
  const name = columns.indexOf("name");
  if (name < 0) {
    throw new AppError("zetaris", `SHOW LIGHTNING TABLES ${database} returned no name column`, false);
  }
  return rows.map((row) => `${database}.${row[name] ?? ""}`);
}

// Registers the REST tables a supplier's claimed identifiers need, then reads the supplier's ERP row and
// registry records in one query. Tables persist in Zetaris, so each identifier is fetched once across runs.
export async function openScout(
  zetaris: ZetarisClient,
  secUserAgent: string,
): Promise<{ vendorIds: string[]; gather: (vendorId: string) => Promise<Evidence> }> {
  const userAgent = quotable("SEC_USER_AGENT", secUserAgent);
  const [erp, gleifTables, edgarTables] = await Promise.all([
    zetaris.query(
      "SELECT vendor_id, claimed_lei, claimed_cik FROM prov_erp.vendor_master ORDER BY vendor_id",
    ),
    tableNames(zetaris, "prov_gleif"),
    tableNames(zetaris, "prov_sec"),
  ]);
  const tables = new Set([...gleifTables, ...edgarTables]);

  // A vendor ID goes into the evidence query as a string literal, so only characters that need no escaping
  // are accepted; Spark reads a backslash in a literal as an escape.
  const suppliers = new Map(
    erp.rows.map(([vendorId, lei = null, cik = null]) => {
      if (!vendorId || !/^[\w-]+$/.test(vendorId)) {
        throw new AppError(
          "zetaris",
          `ERP vendor_id ${JSON.stringify(vendorId)} cannot be queried safely`,
          false,
        );
      }
      return [vendorId, { lei, cik }];
    }),
  );

  // Creates the table unless it exists; false when the registry has no such record or cannot be reached.
  async function register(name: string, ddl: string): Promise<boolean> {
    if (tables.has(name)) return true;
    try {
      await zetaris.execute(ddl);
    } catch (error) {
      if (error instanceof AppError && error.message.includes(fetchFailed)) return false;
      throw error;
    }
    tables.add(name);
    return true;
  }

  async function gleifTable(lei: string | null, gaps: string[]): Promise<string | null> {
    if (lei === null) return null;
    if (!isValidLei(lei)) {
      gaps.push(`claimed LEI ${lei} is not a valid ISO 17442 LEI, so GLEIF was not queried`);
      return null;
    }
    const table = `lei_${lei.toLowerCase()}`;
    if (await register(`prov_gleif.${table}`, gleifDdl(table, lei))) return `prov_gleif.${table}`;
    gaps.push(`GLEIF has no record of LEI ${lei}, or could not be reached`);
    return null;
  }

  async function edgarTable(cik: string | null, gaps: string[]): Promise<string | null> {
    if (cik === null) return null;
    if (!/^\d{1,10}$/.test(cik)) {
      gaps.push(`claimed CIK ${cik} is not a CIK number, so EDGAR was not queried`);
      return null;
    }
    const padded = cik.padStart(10, "0");
    const table = `edgar_${padded}`;
    if (await register(`prov_sec.${table}`, edgarDdl(table, padded, userAgent))) return `prov_sec.${table}`;
    gaps.push(`EDGAR has no filer with CIK ${cik}, or could not be reached`);
    return null;
  }

  // Takes only a vendor ID, so the identifiers looked up and the ID in the SQL are always the ERP's own.
  async function gather(vendorId: string): Promise<Evidence> {
    const supplier = suppliers.get(vendorId);
    if (!supplier) throw new AppError("zetaris", `Supplier ${vendorId} is not in the ERP`, false);
    const { lei, cik } = supplier;
    const gaps: string[] = [];
    const gleif = await gleifTable(lei, gaps);
    const edgar = await edgarTable(cik, gaps);
    const sql = [
      `SELECT ${[
        ...select("erp", erpFields),
        ...(gleif ? select("gleif", gleifFields) : []),
        ...(edgar ? select("edgar", edgarFields) : []),
      ].join(", ")}`,
      "FROM prov_erp.vendor_master e",
      sicList,
      ...(gleif ? [`LEFT JOIN ${gleif} g ON true`] : []),
      ...(edgar ? [`LEFT JOIN ${edgar} s ON true`] : []),
      `WHERE e.vendor_id = '${vendorId}'`,
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
      sql,
    };
  }

  return { vendorIds: [...suppliers.keys()], gather };
}
