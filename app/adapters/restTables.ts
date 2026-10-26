import { AppError } from "../domain/errors.ts";
import type { ZetarisClient } from "./zetaris.ts";

// Zetaris fetches a REST table's source when the table is created, so a source without the record (or one that
// cannot be reached) fails the CREATE with this message and no table is left behind.
const fetchFailed = "REST API call failed";

// Creates Zetaris REST tables on demand. Tables persist in Zetaris and each database is listed once, on first
// use, so a source is fetched at creation only once across runs.
export function restTables(zetaris: ZetarisClient): {
  register: (database: string, table: string, ddl: string) => Promise<boolean>;
} {
  const listings = new Map<string, Promise<Set<string>>>();

  async function list(database: string): Promise<Set<string>> {
    const { columns, rows } = await zetaris.query(`SHOW LIGHTNING TABLES ${database}`);
    const name = columns.indexOf("name");
    if (name < 0) {
      throw new AppError("zetaris", `SHOW LIGHTNING TABLES ${database} returned no name column`, false);
    }
    return new Set(rows.map((row) => row[name] ?? ""));
  }

  // Creates the table unless it exists; false when the source has no such record or cannot be reached.
  async function register(database: string, table: string, ddl: string): Promise<boolean> {
    let listing = listings.get(database);
    if (!listing) {
      listing = list(database);
      listings.set(database, listing);
    }
    const tables = await listing;
    if (tables.has(table)) return true;
    try {
      await zetaris.execute(ddl);
    } catch (error) {
      if (error instanceof AppError && error.message.includes(fetchFailed)) return false;
      throw error;
    }
    tables.add(table);
    return true;
  }

  return { register };
}
