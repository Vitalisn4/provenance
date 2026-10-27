import { readdirSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app/api/server.ts";
import { AppError } from "../../app/domain/errors.ts";
import { verify } from "../../app/pipeline/verify.ts";

vi.mock(import("../../app/pipeline/verify.ts"), async (original) => {
  const actual = await original();
  return { ...actual, verify: vi.fn(actual.verify) };
});

const lines: string[] = [];
const out = { write: (line: string) => lines.push(line) };
const servers: Server[] = [];
const traces: string[] = [];

async function start(sampleDefault: boolean, token: string | null = null): Promise<string> {
  const server = createApp({ sampleDefault, out, token });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const sampleServer = start(true);

async function post(
  body: string | object,
  { path = "/run", server = sampleServer, method = "POST", headers = {} } = {},
) {
  const response = await fetch(`${await server}${path}`, {
    method,
    headers,
    ...(method === "POST" && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (typeof json.log_file === "string") traces.push(json.log_file);
  return { status: response.status, body: json };
}

const lastEvent = (file: unknown) =>
  JSON.parse(
    readFileSync(file as string, "utf8")
      .trim()
      .split("\n")
      .at(-1) ?? "",
  ) as Record<string, unknown>;

const inputError = (message: string, runId: string | null = null) => ({
  run_id: runId,
  status: "error",
  error: { type: "input", message, recoverable: false },
  execution_time_seconds: expect.any(Number) as unknown,
});

afterEach(() => {
  for (const file of traces.splice(0)) rmSync(file, { force: true });
  lines.length = 0;
});

afterAll(() => {
  for (const server of servers) server.close();
});

describe("POST /run", () => {
  it("verifies the requested suppliers and answers with the results, the agents and the trace", async () => {
    const { status, body } = await post({
      run_id: "test-server-1",
      input: { vendor_ids: ["V-1010", "V-1003"] },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      run_id: "test-server-1",
      status: "success",
      output: {
        sample_mode: true,
        summary: "Suppliers verified: 2 (1 ready, 1 fix)",
        recommendations: ['V-1010: correct lei to "20S05OYHG0MQM4VUIC57" from GLEIF'],
        suppliers: [
          { vendorId: "V-1003", decision: "ready" },
          { vendorId: "V-1010", decision: "fix" },
        ],
        evaluation: { held_out: { correct: 2, total: 2 } },
      },
      trace_id: "trace-test-server-1",
      log_file: "logs/trace-test-server-1.jsonl",
      execution_time_seconds: expect.any(Number) as unknown,
    });
    expect((body.agents as { name: string }[]).map(({ name }) => name)).toEqual([
      "Scout",
      "Resolver",
      "Judge",
      "Decision",
    ]);
    expect(lastEvent(body.log_file)).toMatchObject({ action: "finish", output_summary: "1 ready, 1 fix" });
    expect(lines.every((line) => line.includes("run_id=test-server-1"))).toBe(true);
  });

  it("verifies every supplier under a new run ID when the body is empty", async () => {
    const { status, body } = await post("");

    expect(status).toBe(200);
    expect(body.run_id).toMatch(/^run-\d{14}-[0-9a-f]{8}$/);
    expect(body).toMatchObject({
      trace_id: `trace-${body.run_id as string}`,
      output: { evaluation: { learning: { correct: 18, total: 18 }, held_out: { correct: 13, total: 13 } } },
    });
  });

  it("names the trace of a run whose ID is reused after its own file", async () => {
    const request = { run_id: "test-server-6", input: { vendor_ids: ["V-1003"] } };
    const first = (await post(request)).body;
    const again = (await post(request)).body;

    expect(again.run_id).toBe("test-server-6");
    expect(again.log_file).not.toBe(first.log_file);
    expect(again.trace_id).toBe(basename(again.log_file as string, ".jsonl"));
  });

  it.each(readdirSync("input_examples"))(
    "replays %s in sample mode with the decisions of its live output",
    async (example) => {
      const decisions = (body: Record<string, unknown>) =>
        (
          body.output as { suppliers: { vendorId: string; decision: string; actions: unknown }[] }
        ).suppliers.map(({ vendorId, decision, actions }) => ({ vendorId, decision, actions }));
      const live = JSON.parse(readFileSync(`output_examples/${example}`, "utf8")) as Record<string, unknown>;

      const { status, body } = await post(readFileSync(`input_examples/${example}`, "utf8"));

      expect(status).toBe(200);
      expect(decisions(body)).toEqual(decisions(live));
    },
  );

  it("follows the request's sample_mode over the server's default", async () => {
    const live = start(false);
    const { status } = await post(
      { input: { vendor_ids: ["V-1003"] }, options: { sample_mode: true } },
      { server: live },
    );

    expect(status).toBe(200);
  });

  it("reads at most 64 KB of body", async () => {
    const padded = (size: number) => {
      const body = JSON.stringify({ input: { vendor_ids: ["V-1003"] }, pad: "" });
      return body.replace('"pad":""', `"pad":"${"x".repeat(size - body.length)}"`);
    };

    expect((await post(padded(64 * 1024))).status).toBe(200);
    expect(await post(padded(64 * 1024 + 1))).toEqual({
      status: 400,
      body: inputError("The request body is over 64 KB"),
    });
  });

  it("refuses an oversized body without waiting for the rest of it, and closes the connection", async () => {
    const { hostname, port } = new URL(await sampleServer);
    const request = httpRequest({ hostname, port, path: "/run", method: "POST" });
    request.on("error", () => undefined);
    const response = new Promise<IncomingMessage>((resolve) => request.once("response", resolve));
    request.write("x".repeat(64 * 1024 + 1));

    const { statusCode, headers } = await response;
    request.destroy();

    expect({ statusCode, connection: headers.connection }).toEqual({ statusCode: 400, connection: "close" });
  });

  it("asks for the bearer token when API_TOKEN is set", async () => {
    const guarded = start(true, "s3cret");
    const unauthorized = {
      status: 401,
      body: {
        status: "error",
        error: {
          type: "unauthorized",
          message: "POST /run needs the header Authorization: Bearer <API_TOKEN>",
          recoverable: false,
        },
      },
    };
    const request = { input: { vendor_ids: ["V-1003"] } };

    expect(await post(request, { server: guarded })).toEqual(unauthorized);
    for (const authorization of ["Bearer s3crex", "Bearer s3cret2", "s3cret"]) {
      expect(await post(request, { server: guarded, headers: { authorization } })).toEqual(unauthorized);
    }
    expect(
      (await post(request, { server: guarded, headers: { authorization: "Bearer s3cret" } })).status,
    ).toBe(200);
  });

  it.each([
    ["{", "The request body is not JSON"],
    ["[]", "The request body must be a JSON object"],
    [{ run_id: 1 }, "run_id must be a string"],
    [{ input: [] }, "input must be an object"],
    [{ input: { vendor_ids: "V-1003" } }, "input.vendor_ids must be a list of ERP vendor IDs"],
    [{ input: { vendor_ids: [1003] } }, "input.vendor_ids must be a list of ERP vendor IDs"],
    [{ options: "sample" }, "options must be an object"],
    [{ options: { sample_mode: "true" } }, "options.sample_mode must be true or false"],
  ])("refuses the malformed request %j", async (body, message) => {
    expect(await post(body)).toEqual({ status: 400, body: inputError(message) });
  });

  it.each([
    [{ input: { suppliers: "Acme" } }, "input.suppliers must be a list of at most 10 suppliers"],
    [
      { input: { suppliers: Array(11).fill({ name: "Acme", country: "GB" }) } },
      "input.suppliers must be a list of at most 10 suppliers",
    ],
    [{ input: { suppliers: ["Acme"] } }, "input.suppliers[0] must be an object"],
    [{ input: { suppliers: [{ name: " ", country: "GB" }] } }, "input.suppliers[0].name is required"],
    [
      { input: { suppliers: [{ name: "x".repeat(201), country: "GB" }] } },
      "input.suppliers[0].name must be text of at most 200 characters",
    ],
    [
      { input: { suppliers: [{ name: "Acme", country: "GBR" }] } },
      "input.suppliers[0].country must be text of at most 2 characters",
    ],
    [
      { input: { suppliers: [{ name: "Acme", country: "G1" }] } },
      "input.suppliers[0].country must be a two-letter ISO country code",
    ],
    [
      { input: { suppliers: [{ name: "Acme" }] } },
      "input.suppliers[0].country must be a two-letter ISO country code",
    ],
    [
      { input: { suppliers: [{ name: "Acme", country: "GB", lei: 7 }] } },
      "input.suppliers[0].lei must be text of at most 40 characters",
    ],
  ])("refuses the malformed typed-in supplier %j", async (body, message) => {
    expect(await post(body)).toEqual({ status: 400, body: inputError(message) });
  });

  it("verifies typed-in suppliers, trimmed and labelled in order, with any requested ERP suppliers", async () => {
    vi.mocked(verify).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const ten = Array.from({ length: 10 }, () => ({ name: "Acme", country: "GB" }));
    expect((await post({ input: { suppliers: ten } })).status).toBe(200);

    await post({
      input: {
        vendor_ids: ["V-1003"],
        suppliers: [
          { name: "Acme", country: "GB" },
          { name: " Acme Ltd ", country: "gb", lei: "", cik: " 123 ", sic: null },
        ],
      },
    });

    expect(vi.mocked(verify).mock.lastCall?.slice(2)).toEqual([
      ["V-1003"],
      [
        { vendorId: "input:1", name: "Acme", country: "GB", lei: null, cik: null, sic: null },
        { vendorId: "input:2", name: "Acme Ltd", country: "GB", lei: null, cik: "123", sic: null },
      ],
    ]);
  });

  it("reports a typed-in supplier in sample mode as not recorded, and scores only the ERP's", async () => {
    const { status, body } = await post({
      input: { vendor_ids: ["V-1003"], suppliers: [{ name: "Acme Ltd", country: "GB" }] },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "partial",
      output: {
        suppliers: [
          { vendorId: "V-1003", decision: "ready" },
          {
            vendorId: "input:1",
            error:
              "input error: Sample mode replays the recorded demo suppliers only, and this request was not recorded",
          },
        ],
        evaluation: { held_out: { correct: 1, total: 1 } },
      },
    });
  });

  it("refuses a run ID that cannot name a trace file, before any trace is opened", async () => {
    expect(await post({ run_id: "../escape" })).toEqual({
      status: 400,
      body: inputError("run_id must be 1 to 64 letters, digits, _ or -", "../escape"),
    });
  });

  it("refuses a supplier the ERP lacks and records the failure in the trace", async () => {
    const { status, body } = await post({ run_id: "test-server-2", input: { vendor_ids: ["V-9999"] } });

    expect({ status, body }).toEqual({
      status: 400,
      body: {
        ...inputError("Not in the ERP: V-9999", "test-server-2"),
        trace_id: "trace-test-server-2",
        log_file: "logs/trace-test-server-2.jsonl",
      },
    });
    expect(lastEvent(body.log_file)).toMatchObject({
      action: "run_failed",
      output_summary: "input error: Not in the ERP: V-9999",
      status: "error",
    });
  });

  it.each([
    ["zetaris", 502],
    ["meterless", 502],
    ["config", 503],
  ] as const)("answers a %s failure with HTTP %i and says whether a retry can help", async (type, code) => {
    vi.mocked(verify).mockRejectedValueOnce(new AppError(type, "unreachable", true));

    const { status, body } = await post({ run_id: "test-server-3" });

    expect(status).toBe(code);
    expect(body).toMatchObject({
      status: "error",
      error: { type, message: "unreachable", recoverable: true },
    });
  });

  it("reports a run with a failed supplier as partial", async () => {
    vi.mocked(verify).mockResolvedValueOnce([{ vendorId: "V-1003", error: "zetaris error: unreachable" }]);

    const { body } = await post({ run_id: "test-server-4" });

    expect(body).toMatchObject({
      status: "partial",
      output: { summary: "Suppliers verified: 1 (1 failed)", recommendations: [] },
    });
  });

  it("hides the details of a failure that is a bug", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bug = new TypeError("bug");
    vi.mocked(verify).mockRejectedValueOnce(bug);

    expect(await post({ run_id: "test-server-5" })).toEqual({
      status: 500,
      body: {
        status: "error",
        error: { type: "internal", message: "Unexpected failure; see the server log", recoverable: false },
      },
    });
    expect(logged).toHaveBeenCalledWith(bug);
    rmSync("logs/trace-test-server-5.jsonl");
  });

  it.each([
    ["GET", "/run"],
    ["POST", "/"],
  ])("serves nothing at %s %s", async (method, path) => {
    expect(await post({}, { method, path })).toEqual({
      status: 404,
      body: {
        status: "error",
        error: { type: "input", message: "Only POST /run is served", recoverable: false },
      },
    });
  });
});
