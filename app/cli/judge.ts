// Judges the given suppliers, or every supplier, and prints each one's decision as one JSON array.
import { createMeterlessClient } from "../adapters/meterless.ts";
import { createZetarisClient } from "../adapters/zetaris.ts";
import { judge } from "../agents/judge.ts";
import { openResolver } from "../agents/resolver.ts";
import { openScout } from "../agents/scout.ts";
import { meterlessConfig, secUserAgent, zetarisConfig } from "../config/env.ts";
import { decide } from "../domain/decide.ts";
import { runCli } from "./runCli.ts";
import { selectSuppliers } from "./suppliers.ts";

await runCli(async (requested) => {
  const zetaris = createZetarisClient(zetarisConfig());
  const { chat } = createMeterlessClient(meterlessConfig());
  const { vendorIds, gather } = await openScout(zetaris, secUserAgent());
  const selected = selectSuppliers(requested, vendorIds, "npm run judge -- [vendor IDs]");
  if (!selected) return;
  const { resolve } = openResolver(zetaris);
  // One supplier at a time, so two suppliers sharing a search never race to create its table.
  const results = [];
  for (const vendorId of selected) {
    const evidence = await gather(vendorId);
    const { check, reasons, model } = await judge(chat, evidence, await resolve(evidence));
    results.push({ vendorId, ...decide(check), reasons, model });
  }
  console.log(JSON.stringify(results, null, 2));
});
