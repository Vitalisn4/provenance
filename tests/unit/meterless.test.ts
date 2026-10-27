import { describe, expect, it, vi } from "vitest";
import type { RetryListener } from "../../app/adapters/http.ts";
import { createMeterlessClient, TOKEN_HINT } from "../../app/adapters/meterless.ts";
import { policy } from "../../app/config/policy.ts";
import { failure } from "./failure.ts";

// A test double for Nightshift's HTTP API; the product only ever talks to the real runtime.
const config = { baseUrl: "http://127.0.0.1:8088/v1", runtimeToken: "test-token-not-real" };
const question = [{ role: "user" as const, content: "Is this the same company?" }];

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function answer(model: string, content: string): Response {
  return reply(200, { model, choices: [{ message: { role: "assistant", content } }] });
}

function client(...responses: (Response | Error)[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) {
    if (response instanceof Error) fetch.mockRejectedValueOnce(response);
    else fetch.mockResolvedValueOnce(response);
  }
  const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
  return { meterless: createMeterlessClient(config, { fetch, sleep }), fetch, sleep };
}

describe("Meterless client", () => {
  it("sends the contract's headers and lane, and returns the model that answered", async () => {
    const { meterless, fetch } = client(answer("nvidia/nemotron-3-ultra-550b-a55b", "Yes"));

    await expect(meterless.chat("deep", question)).resolves.toEqual({
      content: "Yes",
      model: "nvidia/nemotron-3-ultra-550b-a55b",
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:8088/v1/chat/completions");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token-not-real");
    expect(headers.get("meterless-app")).toBe("provenance");
    expect(headers.get("meterless-scope")).toBe("user");
    expect(JSON.parse(init?.body as string)).toEqual({
      model: policy.meterless.routes.deep,
      messages: question,
    });
  });

  it("retries a busy runtime, but not a rejected token", async () => {
    const busy = client(reply(500, { error: { message: "lane busy" } }), answer("m", "ok"));
    await expect(busy.meterless.chat("fast", question)).resolves.toMatchObject({ content: "ok" });
    expect(busy.fetch).toHaveBeenCalledTimes(2);

    const proxyPage = new Response("<html>Bad Gateway</html>", { status: 502 });
    const proxied = client(proxyPage, answer("m", "ok"));
    await expect(proxied.meterless.chat("fast", question)).resolves.toMatchObject({ content: "ok" });
    expect(proxied.fetch).toHaveBeenCalledTimes(2);

    for (const [response, message] of [
      [reply(401, { error: { message: "invalid token" } }), `Nightshift: invalid token. ${TOKEN_HINT}`],
      [new Response(null, { status: 403 }), `Nightshift: HTTP 403. ${TOKEN_HINT}`],
      [
        reply(429, { error: { message: "too many bad keys", code: "auth_rate_limited" } }),
        `Nightshift: too many bad keys. ${TOKEN_HINT}`,
      ],
    ] as const) {
      const rejected = client(response);
      const error = await failure(rejected.meterless.chat("fast", question));
      expect(error.message).toBe(message);
      expect(rejected.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("retries a rate limit after 2, 4 and 8 s, then surfaces it", async () => {
    const limited = () => reply(429, { error: { message: "rate limited" } });
    const { meterless, fetch, sleep } = client(limited(), limited(), limited(), limited());

    const onRetry = vi.fn<RetryListener>();

    const error = await failure(meterless.chat("fast", question, onRetry));
    expect(error).toMatchObject({ message: "Nightshift: rate limited", recoverable: true });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[2_000], [4_000], [8_000]]);
    expect(onRetry.mock.calls.map(([problem, delayMs]) => [problem.message, delayMs])).toEqual([
      ["Nightshift: rate limited", 2_000],
      ["Nightshift: rate limited", 4_000],
      ["Nightshift: rate limited", 8_000],
    ]);
  });

  it("retries a reply that times out while its body is still arriving", async () => {
    const cutOff = new Response(
      new ReadableStream({
        start(stream) {
          stream.error(new DOMException("The operation timed out.", "TimeoutError"));
        },
      }),
    );
    const { meterless, fetch } = client(cutOff, answer("m", "ok"));

    await expect(meterless.chat("deep", question)).resolves.toMatchObject({ content: "ok" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports the runtime's own message and fix for a refused request", async () => {
    const steps = ["Seat a deep lane in Settings."];
    for (const body of [
      { error: { message: "no lane for meterless/deep", meterless: { fix: steps } } },
      { error: { message: "no lane for meterless/deep" }, meterless: { fix: steps } },
    ]) {
      const error = await failure(client(reply(404, body)).meterless.chat("deep", question));
      expect(error).toMatchObject({
        message: "Nightshift: no lane for meterless/deep. Seat a deep lane in Settings",
        recoverable: false,
      });
    }
  });

  it("rejects a reply without a model or content", async () => {
    for (const response of [
      reply(200, { choices: [{ message: { content: "Yes" } }] }),
      reply(200, { model: "m" }),
      new Response("", { status: 200 }),
    ]) {
      const error = await failure(client(response).meterless.chat("fast", question));
      expect(error.message).toMatch(/unexpected response shape/);
    }
  });

  it("maps the status check as the provider contract says", async () => {
    const online = client(reply(200, { data: [{ id: "meterless/fast" }, { id: "meterless/deep" }, null] }));
    await expect(online.meterless.status()).resolves.toEqual({
      status: "online",
      models: ["meterless/fast", "meterless/deep"],
    });
    expect(new Headers(online.fetch.mock.calls[0]?.[1]?.headers).get("meterless-scope")).toBeNull();

    for (const [response, status] of [
      [reply(401, {}), "unauthorized"],
      [reply(403, {}), "unauthorized"],
      [reply(200, { data: [{ id: "llama3" }] }), "offline"],
      [reply(200, {}), "offline"],
      [new Response("", { status: 200 }), "offline"],
      [reply(500, {}), "offline"],
      [new TypeError("fetch failed"), "offline"],
    ] as const) {
      await expect(client(response).meterless.status()).resolves.toEqual({ status, models: [] });
    }
  });
});
