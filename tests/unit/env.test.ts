import { describe, expect, it } from "vitest";
import { meterlessConfig, port, sampleMode, setupValues, zetarisConfig } from "../../app/config/env.ts";

const zetaris = {
  ZETARIS_REST_URL: "http://localhost:8888/api/v1.0/",
  ZETARIS_ORG_ID: "1",
  ZETARIS_API_KEY: "key",
};

describe("settings", () => {
  it("reads and normalises the Zetaris settings", () => {
    expect(zetarisConfig(zetaris)).toEqual({
      restUrl: "http://localhost:8888/api/v1.0",
      orgId: "1",
      apiKey: "key",
    });
  });

  it("names the missing setting", () => {
    expect(() => zetarisConfig({ ...zetaris, ZETARIS_API_KEY: " " })).toThrow("ZETARIS_API_KEY is not set");
    expect(() => setupValues({ SEC_USER_AGENT: "Provenance you@example.com" })).toThrow(
      "ERP_DB_PASSWORD is not set",
    );
  });

  it("rejects a malformed URL or organisation id", () => {
    for (const url of [
      "not a url",
      "localhost:8888",
      "http://secret@localhost:8888",
      "http://:secret@localhost:8888",
      "http://localhost:8888?token=x",
      "http://localhost:8888/?",
      "http://localhost:8888/#",
    ]) {
      expect(() => zetarisConfig({ ...zetaris, ZETARIS_REST_URL: url })).toThrow(
        "ZETARIS_REST_URL must be a plain http(s) URL",
      );
    }
    expect(() => zetarisConfig({ ...zetaris, ZETARIS_ORG_ID: "org-1" })).toThrow(
      "ZETARIS_ORG_ID must be numeric",
    );
  });

  it("reads Nightshift's settings, defaulting and normalising the URL as the provider contract says", () => {
    const token = { METERLESS_RUNTIME_TOKEN: "runtime-token" };

    expect(meterlessConfig(token)).toEqual({
      baseUrl: "http://127.0.0.1:8088/v1",
      runtimeToken: "runtime-token",
    });
    for (const pasted of [
      "192.168.1.20:8088",
      "http://192.168.1.20:8088/",
      "http://192.168.1.20:8088/v1",
      "http://192.168.1.20:8088/v1/v1/",
      "http://192.168.1.20:8088/V1",
      "http://192.168.1.20:8088/v1/chat/completions",
      "http://192.168.1.20:8088/v1/models",
      "http://192.168.1.20:8088/healthz",
    ]) {
      expect(meterlessConfig({ ...token, METERLESS_BASE_URL: pasted }).baseUrl).toBe(
        "http://192.168.1.20:8088/v1",
      );
    }
  });

  it("refuses a connect link without echoing its key", () => {
    const link = "http://127.0.0.1:8088/connect#k=secret-key";
    expect(() =>
      meterlessConfig({ METERLESS_RUNTIME_TOKEN: "runtime-token", METERLESS_BASE_URL: link }),
    ).toThrow(/^METERLESS_BASE_URL must be a plain http\(s\) URL: no credentials, query or fragment$/);
  });

  it("refuses a missing or placeholder runtime token", () => {
    expect(() => meterlessConfig({})).toThrow("METERLESS_RUNTIME_TOKEN is not set");
    expect(() => meterlessConfig({ METERLESS_RUNTIME_TOKEN: "rt-local" })).toThrow("is a placeholder");
  });

  it("turns sample mode on only when SAMPLE_MODE is true", () => {
    expect(
      [" TRUE ", "true", "false", "1", undefined].map((value) => sampleMode({ SAMPLE_MODE: value })),
    ).toEqual([true, true, false, false, false]);
  });

  it("serves on PORT, 8000 by default, and refuses a port that cannot exist", () => {
    expect([undefined, " ", "8080", "65535", "1"].map((value) => port({ PORT: value }))).toEqual([
      8000, 8000, 8080, 65535, 1,
    ]);
    for (const value of ["0", "65536", "80.5", "eighty"]) {
      expect(() => port({ PORT: value })).toThrow("PORT must be a whole number from 1 to 65535");
    }
  });
});
