import { existsSync } from "node:fs";
import { AppError } from "../domain/errors.ts";

export interface ZetarisConfig {
  restUrl: string;
  orgId: string;
  apiKey: string;
}

export interface MeterlessConfig {
  baseUrl: string;
  runtimeToken: string;
}

type Source = Record<string, string | undefined>;

// Each command reads only the settings it uses, so a missing Nightshift token does not stop Zetaris work.
// Values already in the environment win over .env, so Docker and CI can override the file.
function loadEnv(): Source {
  if (existsSync(".env")) process.loadEnvFile(".env");
  return process.env;
}

function required(source: Source, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new AppError("config", `${name} is not set (see .env.example)`, false);
  return value;
}

// URLs appear in error messages, so one carrying credentials, a query or a fragment (where a connect link
// puts its token) is refused rather than echoed. The delimiters are checked in the text itself, since URL
// reports an empty "?" or "#" as no query or fragment, yet a path appended after one would not be sent.
function isPlainHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !/[?#]/.test(value)
    );
  } catch {
    return false;
  }
}

function httpUrl(name: string, value: string): string {
  const url = value.replace(/\/+$/, "");
  if (!isPlainHttpUrl(url)) {
    throw new AppError(
      "config",
      `${name} must be a plain http(s) URL: no credentials, query or fragment`,
      false,
    );
  }
  return url;
}

export function zetarisConfig(source: Source = loadEnv()): ZetarisConfig {
  const orgId = required(source, "ZETARIS_ORG_ID");
  if (!/^\d+$/.test(orgId)) throw new AppError("config", "ZETARIS_ORG_ID must be numeric", false);
  return {
    restUrl: httpUrl("ZETARIS_REST_URL", required(source, "ZETARIS_REST_URL")),
    orgId,
    apiKey: required(source, "ZETARIS_API_KEY"),
  };
}

// Provider contract (Runtime 1.4): the base URL defaults to Nightshift's local port; a pasted URL may lack the
// scheme or end in /v1, /v1/chat/completions, /v1/models or /healthz, and becomes <host>/v1. The token is the
// Runtime token from Nightshift's Console, never the "rt-local" placeholder.
export function meterlessConfig(source: Source = loadEnv()): MeterlessConfig {
  const pasted = source.METERLESS_BASE_URL?.trim() || "http://127.0.0.1:8088";
  const host = httpUrl("METERLESS_BASE_URL", pasted.includes("://") ? pasted : `http://${pasted}`).replace(
    /(\/(v1(\/chat\/completions|\/models)?|healthz))+$/i,
    "",
  );
  const runtimeToken = required(source, "METERLESS_RUNTIME_TOKEN");
  if (runtimeToken === "rt-local") {
    throw new AppError(
      "config",
      "METERLESS_RUNTIME_TOKEN is a placeholder; copy it from Nightshift's Console",
      false,
    );
  }
  return { baseUrl: `${host}/v1`, runtimeToken };
}

// SEC fair access requires every EDGAR request to name the app and a contact email.
export function secUserAgent(source: Source = loadEnv()): string {
  return required(source, "SEC_USER_AGENT");
}

// Keyed by the {{PLACEHOLDER}} names in zetaris/setup/*.sql.
export function setupValues(source: Source = loadEnv()): { SEC_USER_AGENT: string; ERP_DB_PASSWORD: string } {
  return {
    SEC_USER_AGENT: secUserAgent(source),
    ERP_DB_PASSWORD: required(source, "ERP_DB_PASSWORD"),
  };
}
