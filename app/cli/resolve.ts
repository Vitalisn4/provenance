// Resolves the given suppliers, or every supplier, to legal entities and prints the results as one JSON array.
import { createZetarisClient } from "../adapters/zetaris.ts";
import { openResolver } from "../agents/resolver.ts";
import { openScout } from "../agents/scout.ts";
import { secUserAgent, zetarisConfig } from "../config/env.ts";
import { runCli } from "./runCli.ts";
import { selectSuppliers } from "./suppliers.ts";

await runCli(async (requested) => {
  const zetaris = createZetarisClient(zetarisConfig());
  const { vendorIds, gather } = await openScout(zetaris, secUserAgent());
  const selected = selectSuppliers(requested, vendorIds, "npm run resolve -- [vendor IDs]");
  if (!selected) return;
  const { resolve } = openResolver(zetaris);
  // One supplier at a time, so two suppliers sharing a search never race to create its table.
  const results = [];
  for (const vendorId of selected)
    results.push({ vendorId, resolution: await resolve(await gather(vendorId)) });
  console.log(JSON.stringify(results, null, 2));
});
