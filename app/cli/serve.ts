// Serves POST /run on PORT, on every interface so a container's port mapping reaches it. Each step is
// logged to stdout and to logs/trace-<run_id>.jsonl.
import { createApp } from "../api/server.ts";
import { apiToken, port, sampleMode } from "../config/env.ts";
import { runCli } from "./runCli.ts";

// Docker stops a container 10 s after asking, so runs in progress are given just under that to finish.
const drainMs = 9_000;

await runCli(() => {
  const listening = port();
  const sample = sampleMode();
  const token = apiToken();
  const server = createApp({ sampleDefault: sample, out: process.stdout, token });
  server.listen(listening, "0.0.0.0", () => {
    const notes = [sample && "in sample mode", token && "with a bearer token"].filter(Boolean);
    console.log(`Provenance on http://0.0.0.0:${listening}/run${notes.map((note) => `, ${note}`).join("")}`);
  });
  // As a container's PID 1, Node ignores SIGINT and SIGTERM unless it handles them.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => process.exit(1), drainMs).unref();
    });
  }
});
