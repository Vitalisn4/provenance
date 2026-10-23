import { AppError } from "../domain/errors.ts";

// Splits a SQL file into single statements: full-line "--" comments are dropped and a statement ends at a
// semicolon that closes a line. Placeholders such as {{SEC_USER_AGENT}} are filled from `values`; they sit
// inside double-quoted SQL strings, where a quote, backslash or line break would break or alter the statement.
export function splitStatements(script: string, values: Record<string, string> = {}): string[] {
  return script
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      const value = values[name];
      if (value === undefined) throw new AppError("config", `No value for placeholder {{${name}}}`, false);
      if (/["\\\r\n]/.test(value)) {
        throw new AppError(
          "config",
          `${name} must not contain a double quote, backslash or line break`,
          false,
        );
      }
      return value;
    })
    .split(/;[ \t]*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}
