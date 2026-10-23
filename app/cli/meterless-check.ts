// Test connection: Nightshift's status and models, then one short request per lane, printing the model that
// answered each.
import { createMeterlessClient, TOKEN_HINT } from "../adapters/meterless.ts";
import { meterlessConfig } from "../config/env.ts";
import { policy } from "../config/policy.ts";
import { AppError } from "../domain/errors.ts";
import { runCli } from "./runCli.ts";

await runCli(async () => {
  const config = meterlessConfig();
  const meterless = createMeterlessClient(config);

  const { status, models } = await meterless.status();
  if (status === "unauthorized") {
    throw new AppError("meterless", `Nightshift rejected the runtime token. ${TOKEN_HINT}`, false);
  }
  if (status === "offline") {
    throw new AppError(
      "meterless",
      `Nightshift is offline at ${config.baseUrl}: no reply from /models listing meterless/* modes`,
      false,
    );
  }
  console.log(`online  ${config.baseUrl}`);
  console.log(`models  ${models.join(", ")}`);

  for (const route of ["fast", "deep"] as const) {
    const reply = await meterless.chat(route, [{ role: "user", content: "Reply with one word: ready" }]);
    console.log(
      `${route}    ${policy.meterless.routes[route]} answered by ${reply.model}: ${reply.content.trim()}`,
    );
  }
});
