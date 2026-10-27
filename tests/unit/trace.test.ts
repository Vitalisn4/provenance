import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../../app/domain/errors.ts";
import { newRunId, openTrace, tracedChat, tracedZetaris } from "../../app/pipeline/trace.ts";
import { failure } from "./failure.ts";
import { testTrace } from "./testTrace.ts";

const secret = "zk-secret-123";

describe("Trace", () => {
  it("writes each step to the run's JSONL file and one readable line, with secrets masked", () => {
    const { trace, lines, events } = testTrace("run-1", [secret, ""]);

    trace.log({ agent: "Scout", action: "gather", input: `key ${secret}`, output: `got\n${secret}` });

    expect(trace.file).toMatch(/trace-run-1\.jsonl$/);
    expect(events()).toEqual([
      {
        timestamp: expect.any(String) as unknown,
        run_id: "run-1",
        vendor_id: null,
        agent_name: "Scout",
        action: "gather",
        input_summary: "key ...redacted",
        output_summary: "got\n...redacted",
        target_agent: null,
        model: null,
        confidence: null,
        retry_count: 0,
        status: "success",
      },
    ]);
    expect(lines).toEqual(["[INFO] run_id=run-1 Scout gather: got ...redacted\n"]);
  });

  it("attributes each step to the supplier whose work logged it, even when suppliers overlap", async () => {
    const { trace, lines, events } = testTrace();
    const step = (vendorId: string) =>
      trace.forSupplier(vendorId, async () => {
        await Promise.resolve();
        trace.log({ agent: "Judge", action: "judge", output: vendorId, model: "m", status: "error" });
      });

    await Promise.all([step("V-1"), step("V-2")]);

    expect(events().map((event) => [event.vendor_id, event.output_summary])).toEqual([
      ["V-1", "V-1"],
      ["V-2", "V-2"],
    ]);
    expect(lines[0]).toBe("[ERROR] run_id=run-1 vendor=V-1 Judge judge: V-1 (model: m)\n");
  });

  it("refuses a run ID that could leave the logs directory", () => {
    expect(() => testTrace("../escape")).toThrow("run_id must be 1 to 64 letters, digits, _ or -");
    expect(newRunId(new Date("2026-10-27T15:30:12Z"))).toMatch(/^run-20261027153012-[0-9a-f]{8}$/);
  });

  it("gives each run its own file, keeping an earlier run's trace when a run ID is reused", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-"));
    const out = { write: () => true };
    const first = openTrace("example-1", { secrets: [], out, dir });
    first.log({ agent: "Pipeline", action: "first", output: "" });
    const again = openTrace("example-1", { secrets: [], out, dir });

    expect(first.file).toBe(`${dir}/trace-example-1.jsonl`);
    expect(again.runId).toBe("example-1");
    expect(again.file).toMatch(new RegExp(`^${dir}/trace-example-1-[0-9a-f]{8}\\.jsonl$`));
    expect(readFileSync(first.file, "utf8")).toContain('"action":"first"');
    expect(readFileSync(again.file, "utf8")).toBe("");
  });

  it("logs each Zetaris statement with its row count, and a failure before passing it on", async () => {
    const { trace, events } = testTrace();
    const zetaris = tracedZetaris(
      {
        query: () => Promise.resolve({ columns: ["a"], rows: [["1"], ["2"]] }),
        execute: () => Promise.reject(new AppError("zetaris", "Zetaris: REST API call failed", false)),
      },
      trace,
      "Scout",
    );

    await zetaris.query("SELECT a");
    expect((await failure(zetaris.execute("CREATE t"))).message).toBe("Zetaris: REST API call failed");

    expect(
      events().map(({ action, input_summary, output_summary, status }) => [
        action,
        input_summary,
        output_summary,
        status,
      ]),
    ).toEqual([
      ["zetaris_query", "SELECT a", "2 rows", "success"],
      ["zetaris_execute", "CREATE t", "zetaris error: Zetaris: REST API call failed", "error"],
    ]);
  });

  it("shows a step's handoff, confidence and retries on its line", () => {
    const { trace, lines, events } = testTrace();

    trace.log({
      agent: "Judge",
      action: "judge",
      output: "ok",
      target: "Decision",
      confidence: 0.875,
      retries: 1,
    });
    trace.log({ agent: "Judge", action: "critique", output: "again", retries: 2, status: "needs_revision" });

    expect(events()[0]).toMatchObject({ target_agent: "Decision", confidence: 0.875, retry_count: 1 });
    expect(lines).toEqual([
      "[INFO] run_id=run-1 Judge judge -> Decision: ok (confidence 0.88) (after 1 retry)\n",
      "[WARN] run_id=run-1 Judge critique: again (after 2 retries)\n",
    ]);
  });

  it("logs each retry of a request, then its recovery or its failure", async () => {
    const { trace, events } = testTrace();
    const outage = new AppError("zetaris", "Zetaris is unreachable", true);
    const zetaris = tracedZetaris(
      {
        query: (sql, onRetry) => {
          onRetry?.(outage, 500);
          onRetry?.(outage, 1000);
          return sql === "SELECT a" ? Promise.resolve({ columns: [], rows: [] }) : Promise.reject(outage);
        },
        execute: () => Promise.reject(outage),
      },
      trace,
      "Resolver",
    );
    const chat = tracedChat(
      (_route, _messages, onRetry) => {
        onRetry?.(new AppError("meterless", "Nightshift: busy", true), 2000);
        return Promise.resolve({ content: "{}", model: "m" });
      },
      trace,
      "Judge",
    );

    await zetaris.query("SELECT a");
    await failure(zetaris.query("SELECT b"));
    await chat("deep", []);

    expect(
      events().map(({ agent_name, action, input_summary, output_summary, retry_count, status }) => [
        agent_name,
        action,
        action === "retry" ? input_summary : output_summary,
        retry_count,
        status,
      ]),
    ).toEqual([
      ["Resolver", "retry", "zetaris_query", 1, "retrying"],
      ["Resolver", "retry", "zetaris_query", 2, "retrying"],
      ["Resolver", "zetaris_query", "0 rows", 2, "success"],
      ["Resolver", "retry", "zetaris_query", 1, "retrying"],
      ["Resolver", "retry", "zetaris_query", 2, "retrying"],
      ["Resolver", "zetaris_query", "zetaris error: Zetaris is unreachable", 2, "error"],
      ["Judge", "retry", "nightshift_chat", 1, "retrying"],
      ["Judge", "nightshift_chat", expect.stringMatching(/^2 characters/) as unknown, 1, "success"],
    ]);
    expect(events()[0]?.output_summary).toBe("zetaris error: Zetaris is unreachable; retry 1 in 0.5 s");
  });

  it("logs each Nightshift call with the route asked and the model that answered", async () => {
    const { trace, events } = testTrace();
    const chat = tracedChat(() => Promise.resolve({ content: "{}", model: "nvidia/ultra" }), trace, "Judge");

    await chat("deep", [{ role: "user", content: "hi" }]);

    expect(events()).toMatchObject([
      {
        agent_name: "Judge",
        action: "nightshift_chat",
        input_summary: "meterless/deep",
        model: "nvidia/ultra",
      },
    ]);
    expect(events()[0]?.output_summary).toMatch(/^2 characters in \d+\.\d s$/);
  });
});
