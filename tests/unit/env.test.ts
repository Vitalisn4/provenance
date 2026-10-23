import { describe, expect, it } from "vitest";
import { readEnv } from "../../app/config/env.ts";

const valid = {
  ZETARIS_REST_URL: "http://localhost:8888/api/v1.0/",
  ZETARIS_ORG_ID: "1",
  ZETARIS_API_KEY: "key",
  SEC_USER_AGENT: "Provenance you@example.com",
  ERP_DB_PASSWORD: "pw",
};

describe("readEnv", () => {
  it("reads and normalises valid settings", () => {
    expect(readEnv(valid)).toEqual({
      zetaris: { restUrl: "http://localhost:8888/api/v1.0", orgId: "1", apiKey: "key" },
      secUserAgent: "Provenance you@example.com",
      erpDbPassword: "pw",
    });
  });

  it("names the missing setting", () => {
    expect(() => readEnv({ ...valid, ZETARIS_API_KEY: " " })).toThrow("ZETARIS_API_KEY is not set");
  });

  it("rejects a malformed URL or organisation id", () => {
    expect(() => readEnv({ ...valid, ZETARIS_REST_URL: "localhost:8888" })).toThrow(
      "not a valid http(s) URL",
    );
    expect(() => readEnv({ ...valid, ZETARIS_ORG_ID: "org-1" })).toThrow("ZETARIS_ORG_ID must be numeric");
  });
});
