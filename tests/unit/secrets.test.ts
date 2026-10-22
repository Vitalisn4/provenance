import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

// Real credentials mix letters and digits; placeholders such as "your-nightshift-runtime-token" do not.
const CREDENTIAL = String.raw`(?=[\w.~+/-]*\d)(?=[\w.~+/-]*[A-Za-z])[\w.~+/-]{24,}`;

const KEY_PATTERNS: RegExp[] = [
  /nvapi-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  new RegExp(String.raw`Bearer\s+${CREDENTIAL}`),
  new RegExp(String.raw`(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?${CREDENTIAL}`, "i"),
];

function findSecrets(text: string): string[] {
  return KEY_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

function filesToScan(): string[] {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf-8",
  })
    .split("\n")
    .filter(Boolean);
  const logsDir = path.join(ROOT, "logs");
  const logs = existsSync(logsDir)
    ? readdirSync(logsDir)
        .filter((name) => name.endsWith(".jsonl") || name.endsWith(".log"))
        .map((name) => path.join("logs", name))
    : [];
  return [...listed, ...logs].filter((file) => existsSync(path.join(ROOT, file)));
}

describe("secret scan", () => {
  it("detects a key-shaped string (the scan can fail)", () => {
    expect(findSecrets(`METERLESS_RUNTIME_TOKEN=${"a1B2".repeat(8)}`)).not.toEqual([]);
    expect(findSecrets(`Authorization: Bearer ${"x9Y8".repeat(8)}`)).not.toEqual([]);
    expect(findSecrets(`nvapi-${"Q7w-".repeat(8)}`)).not.toEqual([]);
  });

  it("finds no secrets in files git would commit or in logs", () => {
    const files = filesToScan();
    expect(files).toContain(".env.example");
    const hits = files.flatMap((file) =>
      findSecrets(readFileSync(path.join(ROOT, file), "utf-8")).map((pattern) => `${file}: ${pattern}`),
    );
    expect(hits).toEqual([]);
  });
});
