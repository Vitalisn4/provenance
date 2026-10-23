import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Issue {
  pattern: string;
  field?: "lei" | "name" | "sic";
  correct?: string;
  candidates?: string[];
}

interface AnswerKey {
  patterns: Record<string, { origin: string; learnable: boolean; description: string }>;
  suppliers: Record<string, { batch: string; decision: string; issues: Issue[] }>;
}

interface VendorRow {
  id: string;
  name: string;
  country: string;
  lei: string | null;
  cik: string | null;
  sic: string | null;
}

const read = (path: string) => readFileSync(new URL(`../../data/${path}`, import.meta.url), "utf8");
const key = JSON.parse(read("answer-key.json")) as AnswerKey;

function vendorRows(sql: string): VendorRow[] {
  return [...sql.matchAll(/^\s*\((.*)\)[,;]$/gm)].map(([, tuple = ""]) => {
    const values = [...tuple.matchAll(/'((?:[^']|'')*)'|NULL/g)].map(([literal, text]) =>
      literal === "NULL" ? null : (text ?? "").replaceAll("''", "'"),
    );
    const [id, name, country, lei, cik, sic] = values;
    if (values.length !== 6 || !id || !name || !country) throw new Error(`Malformed row: ${tuple}`);
    return { id, name, country, lei: lei ?? null, cik: cik ?? null, sic: sic ?? null };
  });
}

const rows = vendorRows(read("erp/01_vendor_master.sql"));
const suppliers = Object.entries(key.suppliers);

function isValidLei(lei: string): boolean {
  if (!/^[0-9A-Z]{18}[0-9]{2}$/.test(lei)) return false;
  let remainder = 0;
  for (const char of lei) {
    const digits = String(parseInt(char, 36));
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

describe("ERP dataset and answer key", () => {
  it("labels every vendor exactly once", () => {
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(Object.keys(key.suppliers).sort());
  });

  it("holds well-formed vendor fields", () => {
    for (const row of rows) {
      expect(row.country, row.id).toMatch(/^[A-Z]{2}$/);
      if (row.lei !== null) expect(isValidLei(row.lei), `${row.id} LEI`).toBe(true);
      if (row.cik !== null) expect(row.cik, row.id).toMatch(/^[1-9][0-9]{0,9}$/);
      if (row.sic !== null) expect(row.sic, row.id).toMatch(/^[0-9]{4}$/);
    }
  });

  it("uses only known batches, decisions and patterns, and is ready exactly when nothing is wrong", () => {
    for (const [name, pattern] of Object.entries(key.patterns)) {
      expect(["real", "seeded", "synthetic"], name).toContain(pattern.origin);
      expect(pattern.description, name).not.toBe("");
    }
    for (const [id, supplier] of suppliers) {
      expect(["learning", "held_out"], id).toContain(supplier.batch);
      expect(["ready", "fix", "escalate"], id).toContain(supplier.decision);
      expect(supplier.decision === "ready", id).toBe(supplier.issues.length === 0);
      for (const issue of supplier.issues) {
        expect(Object.keys(key.patterns), id).toContain(issue.pattern);
        if (issue.field !== undefined) expect(["lei", "name", "sic"], id).toContain(issue.field);
      }
    }
  });

  it("gives every correction a field, a different value and, for LEIs, a valid code", () => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [id, supplier] of suppliers) {
      for (const { field, correct } of supplier.issues) {
        if (correct === undefined) continue;
        if (field === undefined) throw new Error(`${id}: a correction needs a field`);
        expect(byId.get(id)?.[field], id).not.toBe(correct);
        if (field === "lei") expect(isValidLei(correct), `${id} correct LEI`).toBe(true);
      }
    }
  });

  it("names at least two distinct, valid candidate LEIs for every ambiguous identity, and only there", () => {
    for (const [id, supplier] of suppliers) {
      for (const { pattern, candidates } of supplier.issues) {
        if (pattern !== "ambiguous_identity") {
          expect(candidates, id).toBeUndefined();
          continue;
        }
        const distinct = new Set(candidates).size;
        expect(distinct, id).toBeGreaterThanOrEqual(2);
        expect(distinct, id).toBe(candidates?.length);
        for (const lei of candidates ?? []) expect(isValidLei(lei), `${id} candidate ${lei}`).toBe(true);
      }
    }
  });

  it("has enough cases of each learnable pattern to learn from and to test on", () => {
    for (const [pattern, { learnable }] of Object.entries(key.patterns)) {
      const batches = suppliers
        .filter(([, supplier]) => supplier.issues.some((issue) => issue.pattern === pattern))
        .map(([, supplier]) => supplier.batch);
      expect(batches.length, pattern).toBeGreaterThan(0);
      if (!learnable) continue;
      expect(batches.filter((batch) => batch === "learning").length, pattern).toBeGreaterThanOrEqual(3);
      expect(batches.filter((batch) => batch === "held_out").length, pattern).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("vendorRows", () => {
  it("reads quoted text, doubled quotes and NULL, and refuses a short row", () => {
    expect(vendorRows("    ('V-1', 'O''Brien, Ltd', 'IE', NULL, '1', '1234'),")).toEqual([
      { id: "V-1", name: "O'Brien, Ltd", country: "IE", lei: null, cik: "1", sic: "1234" },
    ]);
    expect(() => vendorRows("    ('V-1', 'O''Brien, Ltd', 'IE', NULL, NULL);")).toThrow("Malformed row");
  });
});

describe("isValidLei", () => {
  it("checks the ISO 17442 check digits", () => {
    expect(isValidLei("VGRQXHF3J8VDLUA7XE92")).toBe(true);
    expect(isValidLei("VGRQXHF3J8VDLUA7XE93")).toBe(false);
    expect(isValidLei("vgrqxhf3j8vdlua7xe92")).toBe(false);
    expect(isValidLei("VGRQXHF3J8VDLUA7XE9")).toBe(false);
  });
});
