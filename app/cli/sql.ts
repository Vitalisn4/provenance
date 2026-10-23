// Runs one Lightning SQL statement and prints the result as tab-separated text.
import { createZetarisClient } from "../adapters/zetaris.ts";
import { zetarisConfig } from "../config/env.ts";
import { runCli } from "./runCli.ts";

await runCli(async (args) => {
  // Exactly one argument: running only the first of several could drop a WHERE clause.
  const [statement] = args;
  if (args.length !== 1 || !statement) {
    console.error('Usage: npm run sql -- "<one SQL statement>"');
    process.exitCode = 2;
    return;
  }
  const { columns, rows } = await createZetarisClient(zetarisConfig()).execute(statement);
  console.log([columns, ...rows].map((row) => row.map((value) => value ?? "NULL").join("\t")).join("\n"));
});
