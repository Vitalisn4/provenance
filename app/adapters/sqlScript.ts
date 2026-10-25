import { AppError } from "../domain/errors.ts";

// Checks a value bound for a double-quoted SQL string, where a quote, backslash or line break would break or
// alter the statement, and returns it.
export function quotable(name: string, value: string): string {
  if (/["\\\r\n]/.test(value)) {
    throw new AppError("config", `${name} must not contain a double quote, backslash or line break`, false);
  }
  return value;
}

// Splits a SQL file into single statements: full-line "--" comments are dropped and a statement ends at a
// semicolon that closes a line. Placeholders such as {{SEC_USER_AGENT}} sit inside double-quoted SQL strings
// and are filled from `values`.
export function splitStatements(script: string, values: Record<string, string> = {}): string[] {
  return script
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      const value = values[name];
      if (value === undefined) throw new AppError("config", `No value for placeholder {{${name}}}`, false);
      return quotable(name, value);
    })
    .split(/;[ \t]*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}
