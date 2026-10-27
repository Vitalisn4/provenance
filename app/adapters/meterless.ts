import { policy } from "../config/policy.ts";
import type { MeterlessConfig } from "../config/env.ts";
import { AppError } from "../domain/errors.ts";
import { defaultDependencies, requestJson, withRetries, type Dependencies } from "./http.ts";

// Sent on every call so Nightshift's Console attributes the requests to this app.
const APP_NAME = "provenance";

export const TOKEN_HINT = "Copy the Runtime token from Nightshift's Console into METERLESS_RUNTIME_TOKEN";

type Route = keyof typeof policy.meterless.routes;

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface RuntimeError {
  error?: { message?: unknown; code?: unknown; meterless?: { fix?: unknown } };
  meterless?: { fix?: unknown };
}

// Provider contract ("Tell users the real reason"): the server's message first, then its fix[], and a rejected
// token says where the token comes from. The contract does not pin where the meterless block sits, so both
// places are read. A 429 auth_rate_limited means repeated bad tokens, so it is not retried.
function refusal(status: number, body: unknown): AppError {
  const { error, meterless } = (body ?? {}) as RuntimeError;
  const fix = (error?.meterless ?? meterless)?.fix;
  const parts = [typeof error?.message === "string" ? error.message : `HTTP ${status}`];
  if (Array.isArray(fix)) parts.push(...fix.filter((step) => typeof step === "string"));
  const rejectedToken = status === 401 || status === 403 || error?.code === "auth_rate_limited";
  if (rejectedToken) parts.push(TOKEN_HINT);
  return new AppError(
    "meterless",
    `Nightshift: ${parts.map((part) => part.trim().replace(/\.$/, "")).join(". ")}`,
    !rejectedToken && (status === 429 || status >= 500),
  );
}

export type MeterlessClient = ReturnType<typeof createMeterlessClient>;

export function createMeterlessClient(config: MeterlessConfig, deps: Dependencies = defaultDependencies) {
  const service = { type: "meterless", name: "Nightshift", baseUrl: config.baseUrl } as const;
  const headers = { Authorization: `Bearer ${config.runtimeToken}`, "meterless-app": APP_NAME };

  async function sendChat(route: Route, messages: Message[]): Promise<{ content: string; model: string }> {
    const { status, ok, body } = await requestJson(
      service,
      "/chat/completions",
      {
        method: "POST",
        headers: { ...headers, "meterless-scope": "user", "Content-Type": "application/json" },
        body: JSON.stringify({ model: policy.meterless.routes[route], messages }),
      },
      policy.meterless.chatTimeoutMs,
      deps,
    );

    if (!ok) throw refusal(status, body);

    const { model, choices } = (body ?? {}) as { model?: unknown; choices?: unknown };
    const content = Array.isArray(choices)
      ? (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content
      : undefined;
    if (typeof model !== "string" || typeof content !== "string") {
      throw new AppError("meterless", "Nightshift returned an unexpected response shape", false);
    }
    return { content, model };
  }

  return {
    // Provider contract: 401 or 403 is unauthorized, 200 listing meterless/* ids is online, anything else or no
    // answer is offline. Every listed id is kept, including meterless/* ids we do not use.
    async status(): Promise<{ status: "online" | "unauthorized" | "offline"; models: string[] }> {
      const reply = await requestJson(
        service,
        "/models",
        { headers },
        policy.meterless.statusTimeoutMs,
        deps,
      ).catch(() => undefined);
      if (reply?.status === 401 || reply?.status === 403) return { status: "unauthorized", models: [] };
      if (reply?.status !== 200) return { status: "offline", models: [] };
      const { data } = (reply.body ?? {}) as { data?: unknown };
      const ids = Array.isArray(data) ? data.map((model) => (model as { id?: unknown } | null)?.id) : [];
      const models = ids.filter((id) => typeof id === "string");
      if (!models.some((id) => id.startsWith("meterless/"))) return { status: "offline", models: [] };
      return { status: "online", models };
    },

    // Returns the model that actually answered: meterless/* routes can reach a non-NVIDIA model.
    chat: (route: Route, messages: Message[]) =>
      withRetries(
        () => sendChat(route, messages),
        policy.meterless.maxRetries,
        policy.meterless.retryBaseDelayMs,
        deps,
      ),
  };
}
