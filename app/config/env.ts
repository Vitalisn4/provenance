import { existsSync } from "node:fs";
import { AppError } from "../domain/errors.ts";

export interface ZetarisConfig {
  restUrl: string;
  orgId: string;
  apiKey: string;
}

interface Env {
  zetaris: ZetarisConfig;
  secUserAgent: string;
  erpDbPassword: string;
}

type Source = Record<string, string | undefined>;

function required(source: Source, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new AppError("config", `${name} is not set (see .env.example)`, false);
  return value;
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function readEnv(source: Source): Env {
  const restUrl = required(source, "ZETARIS_REST_URL").replace(/\/+$/, "");
  if (!isHttpUrl(restUrl)) throw new AppError("config", "ZETARIS_REST_URL is not a valid http(s) URL", false);
  const orgId = required(source, "ZETARIS_ORG_ID");
  if (!/^\d+$/.test(orgId)) throw new AppError("config", "ZETARIS_ORG_ID must be numeric", false);
  return {
    zetaris: { restUrl, orgId, apiKey: required(source, "ZETARIS_API_KEY") },
    secUserAgent: required(source, "SEC_USER_AGENT"),
    erpDbPassword: required(source, "ERP_DB_PASSWORD"),
  };
}

// Values already in the environment win over .env, so Docker and CI can override the file.
export function env(): Env {
  if (existsSync(".env")) process.loadEnvFile(".env");
  return readEnv(process.env);
}
