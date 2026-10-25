// Gathers registry evidence for the given suppliers, or every supplier, and prints it as one JSON array.
import { createZetarisClient } from "../adapters/zetaris.ts";
import { openScout } from "../agents/scout.ts";
import { secUserAgent, zetarisConfig } from "../config/env.ts";
import { runCli } from "./runCli.ts";

await runCli(async (requested) => {
  const { vendorIds, gather } = await openScout(createZetarisClient(zetarisConfig()), secUserAgent());
  const unknown = requested.filter((id) => !vendorIds.includes(id));
  if (unknown.length > 0) {
    console.error(`Not in the ERP: ${unknown.join(", ")}. Usage: npm run scout -- [vendor IDs]`);
    process.exitCode = 2;
    return;
  }
  // One supplier at a time, so two suppliers sharing an identifier never race to create its table.
  const evidence = [];
  for (const id of vendorIds) {
    if (requested.length === 0 || requested.includes(id)) evidence.push(await gather(id));
  }
  console.log(JSON.stringify(evidence, null, 2));
});
