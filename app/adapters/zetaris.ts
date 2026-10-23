import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { policy } from "../config/policy.ts";
import type { ZetarisConfig } from "../config/env.ts";
import { AppError } from "../domain/errors.ts";

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

interface Dependencies {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

async function send(config: ZetarisConfig, sql: string, deps: Dependencies): Promise<QueryResult> {
  let response: Response;
  try {
    response = await deps.fetch(`${config.restUrl}/sql-editor/sqls/run`, {
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
      signal: AbortSignal.timeout(policy.zetaris.timeoutMs),
    });
  } catch (cause) {
    throw new AppError("zetaris", `Zetaris is unreachable at ${config.restUrl}`, true, { cause });
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (response.status === 401) throw new AppError("zetaris", "Zetaris rejected the API key (401)", false);
    const message = (body as { msg?: unknown } | undefined)?.msg;
    const detail =
      typeof message === "string" ? (message.split("\n", 1)[0] ?? "") : `HTTP ${response.status}`;
    throw new AppError("zetaris", `Zetaris: ${detail}`, response.status >= 500);
  }

  const { headers, data } = (body ?? {}) as { headers?: unknown; data?: unknown };
  if (!Array.isArray(headers) || !Array.isArray(data)) {
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
  deps: Dependencies = { fetch, sleep },
): ZetarisClient {
  async function run(sql: string, maxRetries: number): Promise<QueryResult> {
    // Zetaris runs one statement per call and rejects a trailing semicolon.
    const statement = sql.trim().replace(/;+$/, "").trim();
    for (let attempt = 0; ; attempt++) {
      try {
        return await send(config, statement, deps);
      } catch (error) {
        if (!(error instanceof AppError) || !error.recoverable || attempt >= maxRetries) throw error;
        await deps.sleep(policy.zetaris.retryBaseDelayMs * 2 ** attempt);
      }
    }
  }

  return {
    query: (sql) => run(sql, policy.zetaris.maxRetries),
    execute: (sql) => run(sql, 0),
  };
}
