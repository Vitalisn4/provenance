import { describe, expect, it, vi } from "vitest";
import { restTables } from "../../app/adapters/restTables.ts";
import { AppError } from "../../app/domain/errors.ts";
import { failure } from "./failure.ts";

function fakeZetaris(listed: string[], create: () => void = () => undefined) {
  const query = vi.fn<(sql: string) => Promise<{ columns: string[]; rows: string[][] }>>(() =>
    Promise.resolve({ columns: ["name", "table_type"], rows: listed.map((table) => [table, "rest"]) }),
  );
  const execute = vi.fn(() =>
    Promise.resolve()
      .then(create)
      .then(() => ({ columns: [], rows: [] })),
  );
  return { zetaris: { query, execute }, query, execute };
}

describe("REST tables", () => {
  it("creates a missing table once and lists each database once", async () => {
    const { zetaris, query, execute } = fakeZetaris(["listed"]);
    const { register } = restTables(zetaris);

    await expect(register("db", "listed", "CREATE listed")).resolves.toBe(true);
    await expect(register("db", "fresh", "CREATE fresh")).resolves.toBe(true);
    await expect(register("db", "fresh", "CREATE fresh")).resolves.toBe(true);
    await expect(register("other", "listed", "CREATE other.listed")).resolves.toBe(true);

    expect(query.mock.calls).toEqual([["SHOW LIGHTNING TABLES db"], ["SHOW LIGHTNING TABLES other"]]);
    expect(execute.mock.calls).toEqual([["CREATE fresh"]]);
  });

  it("reports a source without the record as false, and never as a table", async () => {
    const { zetaris, execute } = fakeZetaris([], () => {
      throw new AppError("zetaris", "Zetaris: REST API call failed: https://example.test/x", false);
    });
    const { register } = restTables(zetaris);

    await expect(register("db", "missing", "CREATE missing")).resolves.toBe(false);
    await expect(register("db", "missing", "CREATE missing")).resolves.toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("stops on any other failure to create a table", async () => {
    const { zetaris } = fakeZetaris([], () => {
      throw new AppError("zetaris", "Zetaris rejected the API key (401)", false);
    });

    expect((await failure(restTables(zetaris).register("db", "t", "CREATE t"))).message).toMatch(/401/);
  });

  it("rejects a table listing without table names", async () => {
    const { zetaris, query } = fakeZetaris([]);
    query.mockResolvedValueOnce({ columns: ["table_type"], rows: [["rest"]] });

    expect((await failure(restTables(zetaris).register("db", "t", "CREATE t"))).message).toBe(
      "SHOW LIGHTNING TABLES db returned no name column",
    );
  });
});
