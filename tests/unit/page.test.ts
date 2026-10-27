import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Browser,
  type HTMLButtonElement,
  type HTMLElement,
  type HTMLInputElement,
  type HTMLSelectElement,
  type HTMLTextAreaElement,
} from "happy-dom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app/api/server.ts";
import { createUi } from "../../app/ui/server.ts";

// Runs the page's own script, served by the page's own server; nothing else is ever loaded.
const browser = new Browser({
  settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
});
const servers: Server[] = [];
const scratch: string[] = [];
const out = { write: () => true };

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startUi({
  token = null,
  examples,
}: { token?: string | null; examples?: string } = {}): Promise<string> {
  const api = await listen(createApp({ sampleDefault: true, out, token }));
  return listen(createUi({ api, token, examples }));
}

// An API that records each request it is sent and, after `delay` ms, gives `answer` to every one, with
// `trace` as the steps logged under trace-stub.
function stubUi(answer: object, { trace = [], delay = 0 }: { trace?: object[]; delay?: number } = {}) {
  const logs = mkdtempSync(join(tmpdir(), "page-test-"));
  scratch.push(logs);
  writeFileSync(join(logs, "trace-stub.jsonl"), trace.map((step) => JSON.stringify(step)).join("\n"));
  const requests: unknown[] = [];
  const api = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(answer));
      }, delay);
    });
  });
  return { requests, ui: listen(api).then((url) => listen(createUi({ api: url, logs }))) };
}

const sampleUi = startUi();

async function open(base: Promise<string> = sampleUi) {
  const page = browser.newPage();
  await page.goto(`${await base}/`);
  await page.waitUntilComplete();
  const { document, window } = page.mainFrame;
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const request = byId("request") as HTMLTextAreaElement;
  const runButton = byId("run") as HTMLButtonElement;
  return {
    document,
    window,
    byId,
    request,
    status: byId("status"),
    visible: (selector: string) =>
      ([...document.querySelectorAll(selector)] as HTMLElement[]).filter((node) => !node.hidden),
    setRequest: (body: object) => {
      request.value = JSON.stringify(body);
    },
    verify: async () => {
      runButton.click();
      expect(runButton.disabled).toBe(true);
      expect(byId("status").textContent).toMatch(/^Verifying… 0 s\. A live run takes about a minute/);
      await vi.waitFor(
        () => {
          expect(runButton.disabled).toBe(false);
        },
        { timeout: 10_000 },
      );
    },
    click: (selector: string, text: string) => {
      const button = [...document.querySelectorAll(selector)].find((node) => node.textContent === text);
      (button as HTMLButtonElement).click();
    },
  };
}

afterEach(() => {
  for (const name of readdirSync("logs").filter((file) => file.startsWith("trace-test-page"))) {
    rmSync(`logs/${name}`, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await browser.close();
  for (const server of servers) server.close();
  for (const dir of scratch) rmSync(dir, { recursive: true });
});

describe("analyst page script", () => {
  it("lists the input examples and opens the first", async () => {
    const { document, request } = await open();

    const buttons = [...document.querySelectorAll("#examples button")];
    expect(buttons.map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([
      ["example 1", "true"],
      ["example 2", "false"],
      ["example 3", "false"],
      ["example 4", "false"],
    ]);
    expect(JSON.parse(request.value)).toEqual(
      JSON.parse(readFileSync("input_examples/example_1.json", "utf8")),
    );
  });

  it("shows example 3's run, inbox, learned rules and trace, with working filters", async () => {
    const { document, window, byId, request, status, visible, setRequest, verify, click } = await open();
    click("#examples button", "example 3");
    setRequest({ ...(JSON.parse(request.value) as object), run_id: "test-page-3" });

    await verify();

    expect(status.textContent).toMatch(/^Done in [\d.]+ s\.$/);
    expect(byId("results").hidden).toBe(false);
    const summary = byId("summary").textContent;
    expect(summary).toContain("Suppliers verified: 31 (11 escalate, 16 fix, 4 ready)");
    expect(summary).toContain(
      "20 suppliers judged by the model; 5 settled in part or whole by learned rules",
    );
    expect(summary).toContain("learning batch 18 of 18 right; held-out batch 13 of 13 right");
    expect(document.querySelectorAll("#agents li")).toHaveLength(5);

    const filters = [...document.querySelectorAll("#filters button")] as HTMLButtonElement[];
    expect(filters.map(({ textContent, disabled }) => [textContent, disabled])).toEqual([
      ["All (31)", false],
      ["Failed (0)", true],
      ["Escalate (11)", false],
      ["Fix (16)", false],
      ["Ready (4)", false],
    ]);
    const cards = visible("#inbox article");
    expect(cards.map((card) => card.getAttribute("data-decision"))).toEqual([
      ...Array<string>(11).fill("escalate"),
      ...Array<string>(16).fill("fix"),
      ...Array<string>(4).fill("ready"),
    ]);
    const ibm = cards.find((card) => card.textContent.includes("V-1001"))?.textContent;
    expect(ibm).toContain('ERP "International Business Machines Corp" (US)');
    expect(ibm).toContain('correct lei to "VGRQXHF3J8VDLUA7XE92" from GLEIF');
    expect(ibm).toContain("escalate: the sources disagree on sic");
    expect(ibm).toContain("judged by nvidia/nemotron-3-ultra-550b-a55b");
    const settled = cards.find((card) => card.textContent.includes("V-1003"));
    expect(settled?.textContent).toContain(
      "settled by learned rules: name_is_gleif_legal_name, lei_is_claimed_record",
    );
    expect(settled?.textContent).not.toContain("judged by");
    expect([settled?.querySelectorAll("ul").length, settled?.querySelectorAll("details").length]).toEqual([
      1, 0,
    ]);
    expect(filters[0]?.getAttribute("aria-pressed")).toBe("true");

    click("#filters button", "Fix (16)");
    expect(visible("#inbox article").map((card) => card.getAttribute("data-decision"))).toEqual(
      Array<string>(16).fill("fix"),
    );
    expect(filters.map((filter) => filter.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
      "false",
      "true",
      "false",
    ]);

    const rules = [...document.querySelectorAll("#rules tr")].map((row) => [
      row.querySelector("strong")?.textContent,
      ...[...row.querySelectorAll("td")].slice(1).map((cell) => cell.textContent),
    ]);
    expect(rules.map(([id, status]) => `${id}: ${status}`)).toEqual([
      "name_is_gleif_legal_name: promoted",
      "name_shares_first_word: rejected",
      "lei_is_claimed_record: promoted",
      "sic_is_listed_edgar_code: promoted",
      "sic_missing_from_list: promoted",
    ]);
    expect(rules[1]).toEqual([
      "name_shares_first_word",
      "rejected",
      "8",
      "the Judge contradicted it on V-1019",
    ]);

    const steps = readFileSync(byId("trace-file").textContent, "utf8").trim().split("\n");
    const rows = [...document.querySelectorAll("#trace tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(rows).toHaveLength(steps.length);
    expect(rows[0]?.slice(0, 4)).toEqual(["+0.0 s", "run", "Pipeline", "sample_mode"]);
    expect(rows).toContainEqual(expect.arrayContaining(["Scout → Resolver", "gather_evidence"]));
    expect(rows).toContainEqual(expect.arrayContaining(["nightshift_chatnvidia/nemotron-3-ultra-550b-a55b"]));
    expect(document.querySelectorAll("#trace details").length).toBeGreaterThan(0);
    const traceFilter = byId("trace-filter") as HTMLSelectElement;
    traceFilter.value = "V-1019";
    traceFilter.dispatchEvent(new window.Event("change"));
    const honeywell = visible("#trace tr");
    expect(honeywell).toHaveLength(steps.filter((line) => line.includes('"vendor_id":"V-1019"')).length);
    expect(honeywell.map((row) => row.textContent).join(" ")).toContain(
      'fix; correct name to "HONEYWELL INTERNATIONAL INC." from GLEIF',
    );
  });

  it("sends the mode chosen, keeping the request's other options, and none for the server default", async () => {
    const stub = stubUi({
      run_id: null,
      status: "error",
      error: { type: "input", message: "stub" },
      trace_id: "trace-none",
      execution_time_seconds: 0,
    });
    const { byId, setRequest, verify } = await open(stub.ui);

    for (const mode of ["default", "sample", "live"]) {
      (byId("mode") as HTMLSelectElement).value = mode;
      setRequest({ run_id: "stub", options: { note: "kept" } });
      await verify();
    }

    expect(stub.requests).toEqual([
      { run_id: "stub", options: { note: "kept" } },
      { run_id: "stub", options: { note: "kept", sample_mode: true } },
      { run_id: "stub", options: { note: "kept", sample_mode: false } },
    ]);
    expect(byId("status").textContent).toBe("The run failed: stub");
    expect(byId("summary").textContent).toContain("Runnone");
    expect([byId("trace-section").hidden, byId("trace-file").textContent]).toEqual([true, ""]);
  });

  it("shows each part of a slow live run: a failed supplier, every card shape, and a timed trace", async () => {
    const step = { input_summary: null, target_agent: null, model: null, status: "success" };
    const stub = stubUi(
      {
        run_id: "stub",
        status: "partial",
        output: {
          sample_mode: false,
          summary: "Suppliers verified: 3 (1 failed, 1 fix, 1 ready)",
          recommendations: ["V-1003: correct lei", "V-1030: keep"],
          suppliers: [
            {
              vendorId: "V-1002",
              decision: "ready",
              facts: [{ field: "name", status: "stated" }],
              reasons: {},
              model: null,
              rules: [],
            },
            { vendorId: "V-1001", error: "zetaris error: timed out" },
            {
              vendorId: "V-1003",
              decision: "fix",
              facts: [{ field: "lei", status: "contradicted" }],
              reasons: { lei: "GLEIF names another" },
              model: "m",
              rules: ["r"],
            },
          ],
          evaluation: {},
          learning: { rules: [], suppliers_judged_by_model: 1, suppliers_settled_by_rules: 1 },
        },
        agents: [{ name: "Scout", role: "Reads the records" }],
        trace_id: "trace-stub",
        log_file: "logs/trace-stub.jsonl",
        execution_time_seconds: 1.5,
      },
      {
        delay: 1200,
        trace: [
          {
            ...step,
            timestamp: "2026-10-27T10:00:00.000Z",
            vendor_id: null,
            agent_name: "Pipeline",
            action: "start",
            output_summary: "3 suppliers",
            target_agent: "Scout",
          },
          {
            ...step,
            timestamp: "2026-10-27T10:00:02.500Z",
            vendor_id: "V-1003",
            agent_name: "Scout",
            action: "gather_evidence",
            input_summary: "SELECT 1",
            output_summary: 'ERP "Acme"',
            target_agent: "Resolver",
          },
          {
            ...step,
            timestamp: "2026-10-27T10:00:12.340Z",
            vendor_id: "V-1003",
            agent_name: "Judge",
            action: "nightshift_chat",
            output_summary: "lei contradicted",
            model: "m",
            status: "retry",
          },
        ],
      },
    );
    const { document, window, byId, status, verify, visible } = await open(stub.ui);

    const running = verify();
    await vi.waitFor(
      () => {
        expect(status.textContent).toMatch(/^Verifying… 1 s\./);
      },
      { timeout: 2000 },
    );
    await running;

    expect([status.textContent, status.className]).toEqual(["Done in 1.5 s.", ""]);
    expect(byId("summary").querySelector(".chip")?.className).toBe("chip partial");
    const summary = byId("summary").textContent;
    expect(summary).toContain("Modelive");
    expect(summary).toContain("Trace filelogs/trace-stub.jsonl (3 steps)");
    expect(summary).not.toContain("Against the answer key");
    expect(byId("agents").textContent).toBe("ScoutReads the records");
    const cards = [...document.querySelectorAll("#inbox article")];
    expect(cards.map((card) => [...card.children].map((child) => child.tagName.toLowerCase()))).toEqual([
      ["div", "p"],
      ["div", "ul", "ul", "details", "p"],
      ["div", "ul"],
    ]);
    expect(cards.map((card) => card.textContent)).toEqual([
      "FailedV-1001zetaris error: timed out",
      'FixV-1003ERP "Acme"lei: contradictedcorrect leiThe Judge\'s reasonslei: GLEIF names another' +
        "judged by m; settled by learned rules: r",
      "ReadyV-1002name: stated",
    ]);
    expect([...document.querySelectorAll("#inbox .chip")].map((chip) => chip.className)).toEqual([
      "chip failed",
      "chip fix",
      "chip contradicted",
      "chip ready",
      "chip stated",
    ]);
    expect(
      ([...document.querySelectorAll("#filters button")] as HTMLButtonElement[]).map(
        ({ textContent, disabled }) => `${textContent}${disabled ? " disabled" : ""}`,
      ),
    ).toEqual(["All (3)", "Failed (1)", "Escalate (0) disabled", "Fix (1)", "Ready (1)"]);
    expect(byId("rules-section").hidden).toBe(true);

    expect(
      [...document.querySelectorAll("#trace tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["+0.0 s", "run", "Pipeline → Scout", "start", "3 suppliers", "success"],
      ["+2.5 s", "V-1003", "Scout → Resolver", "gather_evidence", 'ERP "Acme"SELECT 1', "success"],
      ["+12.3 s", "V-1003", "Judge", "nightshift_chatm", "lei contradicted", "retry"],
    ]);
    const traceFilter = byId("trace-filter") as HTMLSelectElement;
    expect([...traceFilter.options].map((option) => option.textContent)).toEqual(["All", "run", "V-1003"]);
    for (const [vendor, shown] of [
      ["V-1003", 2],
      ["All", 3],
    ] as const) {
      traceFilter.value = vendor;
      traceFilter.dispatchEvent(new window.Event("change"));
      expect(visible("#trace tr")).toHaveLength(shown);
    }

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(status.textContent).toBe("Done in 1.5 s.");
  });

  it("asks for the API token when the server needs one, then sends it", async () => {
    const { document, byId, status, setRequest, verify, visible } = await open(
      startUi({ token: "page-test" }),
    );
    setRequest({ run_id: "test-page-token", input: { vendor_ids: ["V-1010"] } });

    await verify();

    expect([status.textContent, status.className]).toEqual([
      "POST /run needs the header Authorization: Bearer <API_TOKEN>",
      "error",
    ]);
    expect(document.activeElement).toBe(byId("token"));
    expect(byId("results").hidden).toBe(true);

    (byId("token") as HTMLInputElement).value = " page-test ";
    await verify();

    expect(status.textContent).toMatch(/^Done/);
    expect(visible("#trace tr").length).toBeGreaterThan(0);
  });

  it("reports a request that is not JSON without sending it", async () => {
    const { byId, request, status } = await open();
    request.value = "{oops";

    (byId("run") as HTMLButtonElement).click();

    expect([status.textContent, status.className]).toEqual(["The request is not valid JSON.", "error"]);
    expect(byId("results").hidden).toBe(true);
  });

  it("shows a failed run's error and trace, and hides the empty sections", async () => {
    const { byId, status, setRequest, verify, visible } = await open();
    setRequest({ run_id: "test-page-error", input: { vendor_ids: ["V-9999"] } });

    await verify();

    expect([status.textContent, status.className]).toEqual([
      "The run failed: Not in the ERP: V-9999",
      "error",
    ]);
    expect(byId("summary").textContent).toContain("Errorinput: Not in the ERP: V-9999");
    expect([byId("inbox-section").hidden, byId("rules-section").hidden]).toEqual([true, true]);
    expect(visible("#trace tr").length).toBeGreaterThan(0);
  });

  it("shows text from a run as text, never as markup", async () => {
    const { document, byId, setRequest, verify } = await open();
    const markup = '<img src="x" onerror="document.title = \'run\'">';
    setRequest({ run_id: "test-page-markup", input: { vendor_ids: [markup] } });

    await verify();

    expect(byId("status").textContent).toContain(markup);
    expect(byId("summary").textContent).toContain(markup);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(document.title).toBe("Provenance: supplier verification");
  });

  it("says when the server stops answering, and when the examples cannot be loaded", async () => {
    const base = startUi();
    const { status, setRequest, verify } = await open(base);
    for (const server of servers.splice(-2)) {
      server.close();
      server.closeAllConnections();
    }
    setRequest({ run_id: "test-page-gone" });

    await verify();

    expect([status.textContent, status.className]).toEqual([
      "The server did not answer. Is it still running?",
      "error",
    ]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = await open(startUi({ examples: "no-such-directory" }));
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
    expect([broken.status.textContent, broken.status.className]).toEqual([
      "Could not load the examples.",
      "error",
    ]);
  });
});
