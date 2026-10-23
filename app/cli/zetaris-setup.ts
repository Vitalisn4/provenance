// Registers Provenance's static Zetaris sources by running zetaris/setup/*.sql in order.
// Safe to re-run: views use CREATE OR REPLACE, so edits to them apply. Zetaris has no CREATE OR REPLACE for
// databases, REST tables or data sources, so existing ones are skipped; drop one first to apply an edit to it.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { splitStatements } from "../adapters/sqlScript.ts";
import { createZetarisClient } from "../adapters/zetaris.ts";
import { env } from "../config/env.ts";
import { AppError } from "../domain/errors.ts";
import { runCli } from "./runCli.ts";

const SETUP_DIR = path.join("zetaris", "setup");

await runCli(async () => {
  const config = env();
  const zetaris = createZetarisClient(config.zetaris);
  const values = { SEC_USER_AGENT: config.secUserAgent, ERP_DB_PASSWORD: config.erpDbPassword };
  const files = readdirSync(SETUP_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const script = readFileSync(path.join(SETUP_DIR, file), "utf-8");
    for (const statement of splitStatements(script, values)) {
      const label = `${file}: ${statement.split("\n", 1)[0] ?? ""}`;
      try {
        await zetaris.execute(statement);
        console.log(`done    ${label}`);
      } catch (error) {
        if (!(error instanceof AppError && /already exists/i.test(error.message))) throw error;
        console.log(`exists  ${label}`);
      }
    }
  }
});
