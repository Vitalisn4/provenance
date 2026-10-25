// Gathers registry evidence for the given suppliers, or every supplier, and prints it as JSON.
import { createZetarisClient } from "../adapters/zetaris.ts";
import { openScout } from "../agents/scout.ts";
import { secUserAgent, zetarisConfig } from "../config/env.ts";
import { runCli } from "./runCli.ts";

await runCli(async (vendorIds) => {
  const { suppliers, gather } = await openScout(createZetarisClient(zetarisConfig()), secUserAgent());
  const unknown = vendorIds.filter((id) => !suppliers.some((supplier) => supplier.vendorId === id));
  if (unknown.length > 0) {
    console.error(`Not in the ERP: ${unknown.join(", ")}. Usage: npm run scout -- [vendor IDs]`);
    process.exitCode = 2;
    return;
  }
  for (const supplier of suppliers) {
    if (vendorIds.length === 0 || vendorIds.includes(supplier.vendorId)) {
      console.log(JSON.stringify(await gather(supplier), null, 2));
    }
  }
});
