// Judges the given suppliers, or every supplier, and prints each one's decision as one JSON array.
import { createMeterlessClient } from "../adapters/meterless.ts";
import { createZetarisClient } from "../adapters/zetaris.ts";
import { judge } from "../agents/judge.ts";
import { openResolver } from "../agents/resolver.ts";
import { openScout } from "../agents/scout.ts";
import { meterlessConfig, secUserAgent, zetarisConfig } from "../config/env.ts";
import { decide } from "../domain/decide.ts";
import { AppError } from "../domain/errors.ts";
import { errorText, runCli } from "./runCli.ts";
import { selectSuppliers } from "./suppliers.ts";

await runCli(async (requested) => {
  const zetaris = createZetarisClient(zetarisConfig());
  const { chat } = createMeterlessClient(meterlessConfig());
  const { vendorIds, gather } = await openScout(zetaris, secUserAgent());
  const selected = selectSuppliers(requested, vendorIds, "npm run judge -- [vendor IDs]");
  if (!selected) return;
  const { resolve } = openResolver(zetaris);
  // One supplier at a time, so two suppliers sharing a search never race to create its table. A supplier
  // that fails is reported in its place, so a long run keeps every other result.
  const results = [];
  for (const vendorId of selected) {
    try {
      const evidence = await gather(vendorId);
      const { check, reasons, model } = await judge(chat, evidence, await resolve(evidence));
      results.push({ vendorId, ...decide(check), reasons, model });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      results.push({ vendorId, error: errorText(error) });
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(results, null, 2));
});
