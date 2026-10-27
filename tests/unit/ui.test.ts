import { readdirSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app/api/server.ts";
import { createUi } from "../../app/ui/server.ts";

const servers: Server[] = [];
const traces: string[] = [];
const out = { write: () => true };

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startUi(
  token: string | null = null,
  options: { examples?: string; logs?: string } = {},
): Promise<string> {
  const api = await listen(createApp({ sampleDefault: true, out, token }));
  return listen(createUi({ api, token, ...options }));
}

const ui = startUi();

async function call(
  path: string,
  {
    base = ui,
    body,
    headers = {},
  }: { base?: Promise<string>; body?: string; headers?: Record<string, string> } = {},
) {
  const response = await fetch(`${await base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body,
  });
  const json =
    response.headers.get("content-type") === "application/json"
      ? ((await response.json()) as Record<string, unknown>)
      : null;
  if (typeof json?.log_file === "string") traces.push(json.log_file);
  return { response, json };
}

const run = (runId: string, base?: Promise<string>, headers?: Record<string, string>) =>
  call("/run", { base, headers, body: JSON.stringify({ run_id: runId, input: { vendor_ids: ["V-1010"] } }) });

afterEach(() => {
  for (const file of traces.splice(0)) {
    rmSync(file, { force: true });
    rmSync(file.replace(/\.jsonl$/, "-hmem"), { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const server of servers) server.close();
});

describe("analyst page", () => {
  it("serves the page, its script and its styles under a policy that allows nothing from elsewhere", async () => {
    const files = [
      ["/", "index.html", "text/html; charset=utf-8"],
      ["/page.js", "page.js", "text/javascript; charset=utf-8"],
      ["/page.css", "page.css", "text/css; charset=utf-8"],
    ];

    for (const [path = "", file = "", type] of files) {
      const { response } = await call(path);
      expect(response.status).toBe(200);
      expect(Object.fromEntries(response.headers)).toMatchObject({
        "content-type": type,
        "content-security-policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
          "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      expect(await response.text()).toBe(readFileSync(`app/ui/page/${file}`, "utf8"));
    }
    expect((await call("/page.js", { body: "" })).response.status).toBe(404);
  });

  it("serves the input examples by name", async () => {
    const { json } = await call("/examples");

    const names = readdirSync("input_examples").sort();
    expect(Object.keys(json ?? {})).toEqual(names.map((name) => name.replace(/\.json$/, "")));
    expect(json?.example_1).toEqual(JSON.parse(readFileSync("input_examples/example_1.json", "utf8")));
  });

  it("passes a run to the API and serves the run's trace", async () => {
    const { response, json } = await run("test-ui-1");

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ run_id: "test-ui-1", status: "success" });
    const trace = await call(`/traces/${String(json?.trace_id)}`);
    expect(trace.response.status).toBe(200);
    expect(trace.json).toEqual(
      readFileSync(String(json?.log_file), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
    );
  });

  it("passes the API's answer to a bad request on, and refuses a body over 64 KB itself", async () => {
    const malformed = await call("/run", { body: "{" });
    const oversize = await call("/run", { body: `{"run_id":"${"x".repeat(64 * 1024)}"}` });

    expect([malformed.response.status, malformed.json?.error]).toEqual([
      400,
      { type: "input", message: "The request body is not JSON", recoverable: false },
    ]);
    expect([oversize.response.status, oversize.json?.error]).toEqual([
      400,
      { type: "input", message: "The request body is over 64 KB", recoverable: false },
    ]);
    expect([malformed, oversize].map(({ response }) => response.headers.get("connection"))).toEqual([
      "keep-alive",
      "close",
    ]);
  });

  it("holds runs and traces to the API token when one is set", async () => {
    const guarded = startUi("secret");
    const bearer = { authorization: "Bearer secret" };

    const refused = await run("test-ui-2", guarded);
    const accepted = await run("test-ui-2", guarded, bearer);
    const path = `/traces/${String(accepted.json?.trace_id)}`;

    expect(refused.response.status).toBe(401);
    expect(accepted.response.status).toBe(200);
    expect((await call(path, { base: guarded })).json).toEqual({
      status: "error",
      error: {
        type: "unauthorized",
        message: "Traces need the header Authorization: Bearer <API_TOKEN>",
        recoverable: false,
      },
    });
    expect((await call(path, { base: guarded, headers: bearer })).response.status).toBe(200);
  });

  it("serves only trace files by their ID, says when there is none, and serves nothing else", async () => {
    const missing = await call("/traces/trace-none");
    const others = await Promise.all([
      call("/traces/..%2F.env"),
      call("/run"),
      call("/traces/trace-none", { body: "" }),
      call("/examples", { body: "" }),
    ]);

    expect([missing.response.status, missing.json?.error]).toEqual([
      404,
      { type: "input", message: "No trace trace-none", recoverable: false },
    ]);
    for (const { response, json } of others) {
      expect([response.status, json?.error]).toEqual([
        404,
        { type: "input", message: "Not found", recoverable: false },
      ]);
    }
  });

  it("answers 502 when the API is down and 500 on an unexpected failure", async () => {
    const closed = createApp({ sampleDefault: true, out });
    const api = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    const orphan = listen(createUi({ api }));
    const broken = startUi(null, { examples: "no-such-directory", logs: "README.md" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const down = await run("test-ui-3", orphan);
    const failed = await call("/examples", { base: broken });
    const unreadable = await call("/traces/trace-any", { base: broken });

    expect([down.response.status, down.json?.error]).toEqual([
      502,
      { type: "internal", message: "The API did not answer; see the server log", recoverable: false },
    ]);
    for (const { response, json } of [failed, unreadable]) {
      expect([response.status, json?.error]).toEqual([
        500,
        { type: "internal", message: "Unexpected failure; see the server log", recoverable: false },
      ]);
    }
    expect(logged).toHaveBeenCalledTimes(3);
    logged.mockRestore();
  });
});
