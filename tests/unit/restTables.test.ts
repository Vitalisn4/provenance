import { describe, expect, it, vi } from "vitest";
import { restTables } from "../../app/adapters/restTables.ts";
import { AppError } from "../../app/domain/errors.ts";
import { failure } from "./failure.ts";

function fakeZetaris(listed: string[], create: () => void = () => undefined) {
  const query = vi.fn<(sql: string) => Promise<{ columns: string[]; rows: string[][] }>>(() =>
    Promise.resolve({ columns: ["name", "table_type"], rows: listed.map((table) => [table, "rest"]) }),
  );
  const execute = vi.fn<(sql: string) => Promise<{ columns: string[]; rows: string[][] }>>(() =>
    Promise.resolve()
      .then(create)
      .then(() => ({ columns: [], rows: [] })),
  );
  return { zetaris: { query, execute }, query, execute };
}

function table(name: string, source = "DB", endpoint = `https://example.test/${name}`) {
  return { source, table: name, endpoint, header: ["accept", "application/json"] as const };
}

describe("REST tables", () => {
  it("creates a missing table once, lists each database once and returns the qualified name", async () => {
    const { zetaris, query, execute } = fakeZetaris(["listed"]);
    const { register } = restTables(zetaris);

    await expect(register(table("listed"))).resolves.toBe("db.listed");
    await expect(register(table("fresh"))).resolves.toBe("db.fresh");
    await expect(register(table("fresh"))).resolves.toBe("db.fresh");
    await expect(register(table("listed", "OTHER"))).resolves.toBe("other.listed");

    expect(query.mock.calls).toEqual([["SHOW LIGHTNING TABLES db"], ["SHOW LIGHTNING TABLES other"]]);
    expect(execute.mock.calls.map(([sql]) => sql.replace(/\s+/g, " "))).toEqual([
      'CREATE LIGHTNING REST TABLE fresh FROM DB REQUEST(endpoint "https://example.test/fresh", method "get", ' +
        'response_type "json", http_encoding "URLENCODED") HEADER (accept "application/json") BODY ()',
    ]);
  });

  it("creates a table once when callers ask for it at the same time", async () => {
    const { zetaris, execute } = fakeZetaris([]);
    const { register } = restTables(zetaris);

    await expect(Promise.all([register(table("t")), register(table("t"))])).resolves.toEqual([
      "db.t",
      "db.t",
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reports a source without the record as null, and never as a table", async () => {
    const { zetaris, execute } = fakeZetaris([], () => {
      throw new AppError("zetaris", "Zetaris: REST API call failed: https://example.test/x", false);
    });
    const { register } = restTables(zetaris);

    await expect(register(table("missing"))).resolves.toBeNull();
    await expect(register(table("missing"))).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("refuses a value that would break out of its quoted SQL string", async () => {
    const { zetaris, execute } = fakeZetaris([]);
    const { register } = restTables(zetaris);

    expect((await failure(register(table("t", "DB", 'https://x.test/" BODY ()')))).message).toMatch(
      /^endpoint /,
    );
    const header = ["user-agent", 'App "x"'] as const;
    expect((await failure(register({ ...table("t"), header }))).message).toMatch(/^user-agent /);
    expect(execute).not.toHaveBeenCalled();
  });

  it("stops on any other failure to create a table", async () => {
    const { zetaris } = fakeZetaris([], () => {
      throw new AppError("zetaris", "Zetaris rejected the API key (401)", false);
    });

    expect((await failure(restTables(zetaris).register(table("t")))).message).toMatch(/401/);
  });

  it("rejects a table listing without table names", async () => {
    const { zetaris, query } = fakeZetaris([]);
    query.mockResolvedValueOnce({ columns: ["table_type"], rows: [["rest"]] });

    expect((await failure(restTables(zetaris).register(table("t")))).message).toBe(
      "SHOW LIGHTNING TABLES db returned no name column",
    );
  });
});
