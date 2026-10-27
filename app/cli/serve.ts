// Serves POST /run on PORT and the analyst page on UI_PORT, on every interface so a container's port mapping
// reaches them. Each step is logged to stdout and to logs/trace-<run_id>.jsonl.
import { createApp } from "../api/server.ts";
import { apiToken, port, sampleMode, uiPort } from "../config/env.ts";
import { AppError } from "../domain/errors.ts";
import { createUi } from "../ui/server.ts";
import { runCli } from "./runCli.ts";

// Docker stops a container 10 s after asking, so runs in progress are given just under that to finish.
const drainMs = 9_000;

await runCli(() => {
  const listening = port();
  const page = uiPort();
  if (page === listening) throw new AppError("config", "UI_PORT must differ from PORT", false);
  const sample = sampleMode();
  const token = apiToken();
  const api = createApp({ sampleDefault: sample, out: process.stdout, token });
  const ui = createUi({ api: `http://127.0.0.1:${listening}`, token });
  api.listen(listening, "0.0.0.0", () => {
    const notes = [sample && "in sample mode", token && "with a bearer token"].filter(Boolean);
    console.log(`Provenance on http://0.0.0.0:${listening}/run${notes.map((note) => `, ${note}`).join("")}`);
  });
  ui.listen(page, "0.0.0.0", () => {
    console.log(`Analyst page on http://localhost:${page}/`);
  });
  const servers = [api, ui];
  // As a container's PID 1, Node ignores SIGINT and SIGTERM unless it handles them.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      let open = servers.length;
      for (const server of servers) {
        server.close(() => {
          if (--open === 0) process.exit(0);
        });
        server.closeIdleConnections();
      }
      setTimeout(() => process.exit(1), drainMs).unref();
    });
  }
});
