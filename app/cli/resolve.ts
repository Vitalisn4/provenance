// Resolves the given suppliers, or every supplier, to legal entities and prints the results as one JSON array.
import { createZetarisClient } from "../adapters/zetaris.ts";
import { openResolver } from "../agents/resolver.ts";
import { openScout } from "../agents/scout.ts";
import { secUserAgent, zetarisConfig } from "../config/env.ts";
import { selectSuppliers } from "../pipeline/verify.ts";
import { runCli } from "./runCli.ts";

await runCli(async (requested) => {
  const zetaris = createZetarisClient(zetarisConfig());
  const { vendorIds, gather } = await openScout(zetaris, secUserAgent());
  const { resolve } = openResolver(zetaris);
  const results = [];
  for (const vendorId of selectSuppliers(requested, vendorIds))
    results.push({ vendorId, resolution: await resolve(await gather(vendorId)) });
  console.log(JSON.stringify(results, null, 2));
});
