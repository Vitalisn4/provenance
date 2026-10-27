// Gathers registry evidence for the given suppliers, or every supplier, and prints it as one JSON array.
import { createZetarisClient } from "../adapters/zetaris.ts";
import { openScout } from "../agents/scout.ts";
import { secUserAgent, zetarisConfig } from "../config/env.ts";
import { selectSuppliers } from "../pipeline/verify.ts";
import { runCli } from "./runCli.ts";

await runCli(async (requested) => {
  const { vendorIds, gather } = await openScout(createZetarisClient(zetarisConfig()), secUserAgent());
  const evidence = [];
  for (const id of selectSuppliers(requested, vendorIds)) evidence.push(await gather(id));
  console.log(JSON.stringify(evidence, null, 2));
});
