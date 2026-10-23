import { randomUUID } from "node:crypto";
import { policy } from "../config/policy.ts";
import type { ZetarisConfig } from "../config/env.ts";
import { AppError } from "../domain/errors.ts";
import { defaultDependencies, requestJson, withRetries, type Dependencies } from "./http.ts";

interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
}

interface ZetarisClient {
  // Reads are idempotent, so transient failures are retried.
  query(sql: string): Promise<QueryResult>;
  // DDL is never retried: a repeated CREATE fails with "already exists".
  execute(sql: string): Promise<QueryResult>;
}

async function send(config: ZetarisConfig, sql: string, deps: Dependencies): Promise<QueryResult> {
  const { status, ok, body } = await requestJson(
    { type: "zetaris", name: "Zetaris", baseUrl: config.restUrl },
    "/sql-editor/sqls/run",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "X-Org-ID": config.orgId,
        "X-Request-ID": randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        queryId: randomUUID(),
        sql,
        source: "SqlEditor",
        limit: policy.zetaris.resultLimit,
      }),
    },
    policy.zetaris.timeoutMs,
    deps,
  );

  if (!ok) {
    if (status === 401) throw new AppError("zetaris", "Zetaris rejected the API key (401)", false);
    const message = (body as { msg?: unknown } | undefined)?.msg;
    const detail = typeof message === "string" ? (message.split("\n", 1)[0] ?? "") : `HTTP ${status}`;
    throw new AppError("zetaris", `Zetaris: ${detail}`, status >= 500);
  }

  const { headers, data } = (body ?? {}) as { headers?: unknown; data?: unknown };
  if (!Array.isArray(headers) || !Array.isArray(data) || !data.every(Array.isArray)) {
    throw new AppError("zetaris", "Zetaris returned an unexpected response shape", false);
  }
  const { resultLimit } = policy.zetaris;
  if (data.length >= resultLimit) {
    throw new AppError("zetaris", `Result reached the ${resultLimit}-row limit and may be incomplete`, false);
  }
  return { columns: headers as string[], rows: data as (string | null)[][] };
}

export function createZetarisClient(
  config: ZetarisConfig,
  deps: Dependencies = defaultDependencies,
): ZetarisClient {
  function run(sql: string, maxRetries: number): Promise<QueryResult> {
    // Zetaris runs one statement per call and rejects a trailing semicolon.
    const statement = sql.trim().replace(/;+$/, "").trim();
    return withRetries(
      () => send(config, statement, deps),
      maxRetries,
      policy.zetaris.retryBaseDelayMs,
      deps,
    );
  }

  return {
    query: (sql) => run(sql, policy.zetaris.maxRetries),
    execute: (sql) => run(sql, 0),
  };
}
