// Gathers registry evidence for the given suppliers, or every supplier, and prints it as one JSON array.
import { createZetarisClient } from "../adapters/zetaris.ts";
import { openScout } from "../agents/scout.ts";
import { secUserAgent, zetarisConfig } from "../config/env.ts";
import { runCli } from "./runCli.ts";
import { selectSuppliers } from "./suppliers.ts";

await runCli(async (requested) => {
  const { vendorIds, gather } = await openScout(createZetarisClient(zetarisConfig()), secUserAgent());
  const selected = selectSuppliers(requested, vendorIds, "npm run scout -- [vendor IDs]");
  if (!selected) return;
  // One supplier at a time, so two suppliers sharing an identifier never race to create its table.
  const evidence = [];
  for (const id of selected) evidence.push(await gather(id));
  console.log(JSON.stringify(evidence, null, 2));
});
