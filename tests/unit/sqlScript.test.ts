import { describe, expect, it } from "vitest";
import { splitStatements } from "../../app/adapters/sqlScript.ts";

describe("splitStatements", () => {
  it("splits on line-ending semicolons and drops comment lines", () => {
    const script = [
      "-- header comment",
      'CREATE LIGHTNING DATABASE A DESCRIBE BY "a";',
      "",
      "CREATE SCHEMASTORE VIEW v WITH CONTAINER c AS",
      "SELECT x",
      "  -- inline note",
      "FROM a.t;",
      "SELECT 1",
    ].join("\n");

    expect(splitStatements(script)).toEqual([
      'CREATE LIGHTNING DATABASE A DESCRIBE BY "a"',
      "CREATE SCHEMASTORE VIEW v WITH CONTAINER c AS\nSELECT x\nFROM a.t",
      "SELECT 1",
    ]);
  });

  it("splits files with Windows line endings", () => {
    expect(splitStatements("-- note\r\nSELECT 1;\r\nSELECT 2;\r\n")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("keeps semicolons that do not end a line", () => {
    expect(splitStatements("SELECT 'a;b' AS v;")).toEqual(["SELECT 'a;b' AS v"]);
  });

  it("fills placeholders and refuses unknown ones", () => {
    expect(splitStatements('HEADER (user-agent "{{UA}}");', { UA: "Provenance x@y.z" })).toEqual([
      'HEADER (user-agent "Provenance x@y.z")',
    ]);
    expect(() => splitStatements("{{MISSING}};")).toThrow("No value for placeholder {{MISSING}}");
    expect(splitStatements("-- mentions {{MISSING}}\nSELECT 1;")).toEqual(["SELECT 1"]);
  });

  it("refuses values that would break out of a SQL string", () => {
    for (const value of ['pa"ss', "pa\\ss", "pa\nss", "pa\rss"]) {
      expect(() => splitStatements('password "{{PW}}";', { PW: value })).toThrow(
        "PW must not contain a double quote, backslash or line break",
      );
    }
  });
});
