import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

// Real credentials mix letters and digits; placeholders such as "your-zetaris-api-key" do not.
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

// The real secret values in the local .env catch a leak whatever its shape; failures name the variable only.
function localSecrets(): [name: string, value: string][] {
  const file = path.join(ROOT, ".env");
  if (!existsSync(file)) return [];
  return Object.entries(parseEnv(readFileSync(file, "utf-8"))).flatMap(([name, value]) =>
    /KEY|TOKEN|PASSWORD|SECRET/i.test(name) && value && value.length >= 8 ? [[name, value]] : [],
  );
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" });
}

function lines(output: string): string[] {
  return output.split("\n").filter(Boolean);
}

// What a commit could contain: every working copy, plus the staged version of files whose working copy differs.
function contentsToScan(): [file: string, text: string][] {
  const working = lines(git("ls-files", "--cached", "--others", "--exclude-standard"))
    .filter((file) => existsSync(path.join(ROOT, file)))
    .map((file): [string, string] => [file, readFileSync(path.join(ROOT, file), "utf-8")]);
  const staged = lines(git("diff", "--name-only")).map((file): [string, string] => [
    `${file} (staged)`,
    git("show", `:${file}`),
  ]);
  return [...working, ...staged];
}

describe("secret scan", () => {
  it("detects a key-shaped string (the scan can fail)", () => {
    expect(findSecrets(`METERLESS_RUNTIME_TOKEN=${"a1B2".repeat(8)}`)).not.toEqual([]);
    expect(findSecrets(`Authorization: Bearer ${"x9Y8".repeat(8)}`)).not.toEqual([]);
    expect(findSecrets(`nvapi-${"Q7w-".repeat(8)}`)).not.toEqual([]);
  });

  it("finds no secrets in files git would commit", () => {
    const contents = contentsToScan();
    expect(contents.map(([file]) => file)).toContain(".env.example");
    const secrets = localSecrets();
    const hits = contents.flatMap(([file, text]) => {
      const leaked = secrets.filter(([, value]) => text.includes(value)).map(([name]) => name);
      return [...findSecrets(text), ...leaked].map((found) => `${file}: ${found}`);
    });
    expect(hits).toEqual([]);
  });
});
