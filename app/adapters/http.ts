import { setTimeout as sleep } from "node:timers/promises";
import { AppError, type ErrorType } from "../domain/errors.ts";

export interface Dependencies {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export const defaultDependencies: Dependencies = { fetch, sleep };

interface Service {
  type: ErrorType;
  name: string;
  baseUrl: string;
}

// Sends one request and parses its JSON body (undefined when it is not JSON). A network failure or a timeout,
// including one while the body is still arriving, becomes a recoverable AppError, so callers may retry it.
export async function requestJson(
  service: Service,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  deps: Dependencies,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  let response: Response;
  let text: string;
  try {
    response = await deps.fetch(`${service.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (cause) {
    const message =
      cause instanceof Error && cause.name === "TimeoutError"
        ? `${service.name} did not answer within ${timeoutMs / 1000} s`
        : `${service.name} is unreachable at ${service.baseUrl}`;
    throw new AppError(service.type, message, true, { cause });
  }
  return { status: response.status, ok: response.ok, body: parseJson(text) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Retries recoverable failures, waiting baseDelayMs, then twice that, and so on.
export async function withRetries<T>(
  attempt: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
  deps: Dependencies,
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof AppError) || !error.recoverable || retry >= maxRetries) throw error;
      await deps.sleep(baseDelayMs * 2 ** retry);
    }
  }
}
