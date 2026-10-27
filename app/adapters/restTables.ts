import { AppError } from "../domain/errors.ts";
import { quotable } from "./sqlScript.ts";
import type { ZetarisClient } from "./zetaris.ts";

// Zetaris fetches a REST table's source when the table is created, so a source without the record (or one that
// cannot be reached) fails the CREATE with this message and no table is left behind.
const fetchFailed = "REST API call failed";

// A table reading one GET endpoint as JSON, created from the Zetaris data source `source`, whose database
// takes the source's name in lower case.
interface RestTable {
  source: string;
  table: string;
  endpoint: string;
  header: readonly [name: string, value: string];
}

// Creates Zetaris REST tables on demand. Tables persist in Zetaris and each database is listed once, on first
// use, so a source is fetched at creation only once across runs.
export function restTables(zetaris: ZetarisClient): {
  register: (table: RestTable) => Promise<string | null>;
} {
  const listings = new Map<string, Promise<Set<string>>>();
  // Concurrent callers may need the same table, so a second request joins the first CREATE instead of failing
  // with "already exists".
  const creating = new Map<string, Promise<string | null>>();

  async function list(database: string): Promise<Set<string>> {
    const { columns, rows } = await zetaris.query(`SHOW LIGHTNING TABLES ${database}`);
    const name = columns.indexOf("name");
    if (name < 0) {
      throw new AppError("zetaris", `SHOW LIGHTNING TABLES ${database} returned no name column`, false);
    }
    return new Set(rows.map((row) => row[name] ?? ""));
  }

  async function create(database: string, { source, table, endpoint, header }: RestTable): Promise<boolean> {
    let listing = listings.get(database);
    if (!listing) {
      listing = list(database);
      listings.set(database, listing);
    }
    const tables = await listing;
    if (tables.has(table)) return true;
    const [name, value] = header;
    try {
      await zetaris.execute(
        `CREATE LIGHTNING REST TABLE ${table} FROM ${source} REQUEST(endpoint "${quotable("endpoint", endpoint)}",
          method "get", response_type "json", http_encoding "URLENCODED") HEADER (${name} "${quotable(name, value)}") BODY ()`,
      );
    } catch (error) {
      if (error instanceof AppError && error.message.includes(fetchFailed)) return false;
      throw error;
    }
    tables.add(table);
    return true;
  }

  // The table's qualified name, creating the table unless it exists; null when the source has no such record or
  // cannot be reached.
  function register(request: RestTable): Promise<string | null> {
    const database = request.source.toLowerCase();
    const qualified = `${database}.${request.table}`;
    let created = creating.get(qualified);
    if (!created) {
      created = create(database, request)
        .then((exists) => (exists ? qualified : null))
        .finally(() => creating.delete(qualified));
      creating.set(qualified, created);
    }
    return created;
  }

  return { register };
}
