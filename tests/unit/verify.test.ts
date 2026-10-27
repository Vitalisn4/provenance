import { describe, expect, it } from "vitest";
import { policy } from "../../app/config/policy.ts";
import { AppError } from "../../app/domain/errors.ts";
import { verify } from "../../app/pipeline/verify.ts";
import { failure } from "./failure.ts";
import { testTrace } from "./testTrace.ts";

const vendorIds = ["V-1", "V-2", "V-3", "V-4", "V-5", "V-6"];

// A Zetaris whose suppliers claim no identifiers, so each needs only its evidence query; later suppliers
// answer sooner, and a supplier in `failures` has its query throw that error.
function fakeZetaris(failures: Record<string, Error> = {}) {
  let running = 0;
  const peak = { value: 0 };
  const started: string[] = [];
  async function query(sql: string) {
    if (sql.startsWith("SELECT vendor_id")) {
      return {
        columns: ["vendor_id", "claimed_lei", "claimed_cik"],
        rows: vendorIds.map((id) => [id, null, null]),
      };
    }
    const vendorId = /vendor_id = '([\w-]+)'/.exec(sql)?.[1] ?? "";
    started.push(vendorId);
    running++;
    peak.value = Math.max(peak.value, running);
    await new Promise((resolve) => setTimeout(resolve, 2 * (vendorIds.length - vendorIds.indexOf(vendorId))));
    running--;
    const failure = failures[vendorId];
    if (failure) throw failure;
    const columns = [...sql.matchAll(/ AS (erp_\w+)/g)].map((match) => match[1] ?? "");
    return { columns, rows: [columns.map((column) => (column === "erp_vendorId" ? vendorId : null))] };
  }
  return { zetaris: { query, execute: query }, peak, started };
}

function run(zetaris: ReturnType<typeof fakeZetaris>["zetaris"], requested: string[] = []) {
  const { trace, events } = testTrace();
  const chat = () => Promise.reject(new Error("no fact here needs the model"));
  return {
    results: verify({ zetaris, chat, secUserAgent: "Provenance test@example.com" }, trace, requested),
    events,
  };
}

describe("Pipeline", () => {
  it("verifies suppliers concurrently up to the limit and returns them in ERP order", async () => {
    const { zetaris, peak } = fakeZetaris();
    const { results, events } = run(zetaris);

    expect(
      (await results).map((result) => [result.vendorId, "decision" in result && result.decision]),
    ).toEqual(vendorIds.map((id) => [id, "fix"]));
    expect(peak.value).toBe(policy.pipeline.concurrency);
    const v1 = events()
      .filter((event) => event.vendor_id === "V-1")
      .map((event) => `${event.agent_name} ${event.action}`);
    expect(v1).toEqual([
      "Scout zetaris_query",
      "Scout gather_evidence",
      "Resolver resolve_identity",
      "Judge judge_facts",
      "Decision decide",
    ]);
    expect(events().at(-1)?.output_summary).toBe("6 fix");
  });

  it("reports a failed supplier in its place and keeps the others", async () => {
    const { zetaris } = fakeZetaris({
      "V-2": new AppError("zetaris", "Zetaris did not answer within 60 s", true),
    });
    const { results, events } = run(zetaris, ["V-3", "V-2"]);

    expect(await results).toMatchObject([
      { vendorId: "V-2", error: "zetaris error: Zetaris did not answer within 60 s" },
      { vendorId: "V-3", decision: "fix" },
    ]);
    expect(events().find((event) => event.action === "supplier_failed")).toMatchObject({ vendor_id: "V-2" });
    expect(events().at(-1)?.output_summary).toBe("1 failed, 1 fix");
  });

  it("stops on a failure that is not an AppError, since it is a bug, and starts no further supplier", async () => {
    const { zetaris, started } = fakeZetaris({ "V-4": new TypeError("bug") });

    await expect(run(zetaris).results).rejects.toThrow("bug");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toEqual(vendorIds.slice(0, policy.pipeline.concurrency));
  });

  it("rejects a requested supplier the ERP does not have", async () => {
    const { zetaris } = fakeZetaris();

    const error = await failure(run(zetaris, ["V-1", "V-9"]).results);
    expect([error.type, error.message]).toEqual(["input", "Not in the ERP: V-9"]);
  });
});
