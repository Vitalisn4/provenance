import { describe, expect, it, vi } from "vitest";
import { createZetarisClient } from "../../app/adapters/zetaris.ts";
import { policy } from "../../app/config/policy.ts";
import { AppError } from "../../app/domain/errors.ts";

const config = { restUrl: "http://zetaris.test/api/v1.0", orgId: "1", apiKey: "test-key-not-real" };

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function client(...responses: (Response | Error)[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) {
    if (response instanceof Error) fetch.mockRejectedValueOnce(response);
    else fetch.mockResolvedValueOnce(response);
  }
  const sleep = vi.fn(() => Promise.resolve());
  return { zetaris: createZetarisClient(config, { fetch, sleep }), fetch, sleep };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe("Zetaris client", () => {
  it("sends one statement with the required headers and returns columns and rows", async () => {
    const { zetaris, fetch } = client(reply(200, { headers: ["one"], data: [["1"]] }));

    await expect(zetaris.query("  SELECT 1 AS one;; \n")).resolves.toEqual({
      columns: ["one"],
      rows: [["1"]],
    });

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://zetaris.test/api/v1.0/sql-editor/sqls/run");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-key-not-real");
    expect(headers.get("X-Org-ID")).toBe("1");
    expect(headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(init?.body as string)).toMatchObject({ sql: "SELECT 1 AS one", source: "SqlEditor" });
  });

  it("retries a read after a network failure, backing off", async () => {
    const { zetaris, fetch, sleep } = client(
      new TypeError("fetch failed"),
      reply(200, { headers: ["one"], data: [["1"]] }),
    );

    await expect(zetaris.query("SELECT 1")).resolves.toEqual({ columns: ["one"], rows: [["1"]] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(policy.zetaris.retryBaseDelayMs);
  });

  it("gives up on a read after the retry limit", async () => {
    const outages = Array.from({ length: policy.zetaris.maxRetries + 1 }, () => reply(503, { msg: "busy" }));
    const { zetaris, fetch } = client(...outages);

    const error = await failure(zetaris.query("SELECT 1"));
    expect(error.recoverable).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(policy.zetaris.maxRetries + 1);
  });

  it("never retries DDL", async () => {
    const { zetaris, fetch } = client(new TypeError("fetch failed"));

    await failure(zetaris.execute("CREATE SCHEMASTORE CONTAINER prov"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports the first line of a SQL error as not recoverable", async () => {
    const { zetaris, fetch } = client(
      reply(400, { msg: "[TABLE_OR_VIEW_NOT_FOUND] The table `x`.`y` cannot be found.\n'Project [*]" }),
    );

    const error = await failure(zetaris.query("SELECT * FROM x.y"));
    expect(error.message).toBe("Zetaris: [TABLE_OR_VIEW_NOT_FOUND] The table `x`.`y` cannot be found.");
    expect(error.recoverable).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected key without revealing it", async () => {
    const { zetaris } = client(reply(401, {}));

    const error = await failure(zetaris.query("SELECT 1"));
    expect(error.message).toBe("Zetaris rejected the API key (401)");
  });

  it("refuses a result that reached the row limit, since Zetaris truncates silently", async () => {
    const rows = Array.from({ length: policy.zetaris.resultLimit }, (_, i) => [String(i)]);
    const { zetaris } = client(reply(200, { headers: ["n"], data: rows, total: rows.length }));

    expect((await failure(zetaris.query("SELECT n FROM big"))).message).toMatch(/may be incomplete/);
  });

  it("rejects an unexpected response shape", async () => {
    const { zetaris } = client(reply(200, { rows: [] }));

    expect((await failure(zetaris.query("SELECT 1"))).message).toMatch(/unexpected response shape/);
  });
});
