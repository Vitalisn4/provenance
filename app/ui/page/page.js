// @ts-check
// Every value from a run is inserted as text, never as HTML.

/**
 * @typedef {{ field: string, status: string }} Fact
 * @typedef {{ vendorId: string, decision: string, facts: Fact[], reasons: Record<string, string>,
 *   model: string | null, rules: string[] }} Verified
 * @typedef {Verified | { vendorId: string, error: string }} Supplier
 * @typedef {{ id: string, description: string, sql: string, status: string, support: number,
 *   reason: string }} Rule
 * @typedef {{ timestamp: string, vendor_id: string | null, agent_name: string, action: string,
 *   input_summary: string | null, output_summary: string, target_agent: string | null,
 *   model: string | null, status: string }} Step
 * @typedef {{ sample_mode: boolean, summary: string, recommendations: string[], suppliers: Supplier[],
 *   evaluation: Record<string, { correct: number, total: number }>,
 *   learning: { rules: Rule[], suppliers_judged_by_model: number, suppliers_settled_by_rules: number } }} Output
 * @typedef {{ status: string, run_id: string | null, execution_time_seconds: number,
 *   error?: { type: string, message: string }, trace_id?: string, log_file?: string,
 *   agents?: { name: string, role: string }[], output?: Output }} RunResponse
 * @typedef {Node | string | null | undefined | false} Child
 */

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {{ new (): T }} type
 * @returns {T}
 */
function byId(id, type) {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`The page has no #${id}`);
  return node;
}

const form = byId("run-form", HTMLFormElement);
const examples = byId("examples", HTMLDivElement);
const requestField = byId("request", HTMLTextAreaElement);
const modeField = byId("mode", HTMLSelectElement);
const tokenField = byId("token", HTMLInputElement);
const runButton = byId("run", HTMLButtonElement);
const statusLine = byId("status", HTMLParagraphElement);
const results = byId("results", HTMLDivElement);
const traceFilter = byId("trace-filter", HTMLSelectElement);

const decisionNames = { failed: "Failed", escalate: "Escalate", fix: "Fix", ready: "Ready" };
const decisionOrder = Object.keys(decisionNames);

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} className
 * @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]}
 */
function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

/** @param {string} status @param {string} [text] */
const chip = (status, text = status) => el("span", `chip ${status}`, text);

/** @returns {Record<string, string>} */
function authHeaders() {
  const token = tokenField.value.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** @param {Supplier} supplier */
const decisionOf = (supplier) => ("error" in supplier ? "failed" : supplier.decision);

/** @param {string} text @param {string} [className] */
function showStatus(text, className = "") {
  statusLine.textContent = text;
  statusLine.className = className;
}

/** @param {HTMLElement} group @param {HTMLButtonElement} pressed */
function press(group, pressed) {
  for (const button of group.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button === pressed));
  }
}

/** @param {string} text @param {() => void} onClick */
function button(text, onClick) {
  const node = el("button", "", text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

/**
 * @template T
 * @param {Response} response
 * @returns {Promise<T>}
 */
async function readJson(response) {
  /** @type {unknown} */
  const value = await response.json();
  return /** @type {T} */ (value);
}

async function loadExamples() {
  const response = await fetch("examples");
  if (!response.ok) throw new Error(`GET /examples answered ${response.status}`);
  /** @type {Record<string, unknown>} */
  const loaded = await readJson(response);
  for (const [name, request] of Object.entries(loaded)) {
    const choice = button(name.replace("_", " "), () => {
      requestField.value = JSON.stringify(request, null, 2);
      press(examples, choice);
    });
    examples.append(choice);
  }
  examples.querySelector("button")?.click();
}

/** @param {RunResponse} body @param {Step[]} trace */
function renderSummary(body, trace) {
  /** @type {[string, Child][]} */
  const rows = [
    ["Status", chip(body.status)],
    ["Run", body.run_id ?? "none"],
    ["Time", `${body.execution_time_seconds} s`],
  ];
  if (body.error) rows.push(["Error", `${body.error.type}: ${body.error.message}`]);
  const output = body.output;
  if (output) {
    const { learning, evaluation } = output;
    rows.push(
      ["Mode", output.sample_mode ? "sample: recorded Zetaris and Nightshift answers" : "live"],
      ["Verified", output.summary],
      [
        "Model calls",
        `${learning.suppliers_judged_by_model} suppliers judged by the model; ` +
          `${learning.suppliers_settled_by_rules} settled in part or whole by learned rules`,
      ],
    );
    const scored = Object.entries(evaluation).map(
      ([batch, { correct, total }]) => `${batch.replace("_", "-")} batch ${correct} of ${total} right`,
    );
    if (scored.length > 0) rows.push(["Against the answer key", scored.join("; ")]);
  }
  if (body.log_file) rows.push(["Trace file", `${body.log_file} (${trace.length} steps)`]);
  byId("summary", HTMLElement).replaceChildren(
    ...rows.flatMap(([term, value]) => [el("dt", "", term), el("dd", "", value)]),
  );
  byId("agents", HTMLOListElement).replaceChildren(
    ...(body.agents ?? []).map(({ name, role }) => el("li", "", el("strong", "", name), el("div", "", role))),
  );
}

/** @param {Supplier} supplier @param {string[]} actions @param {string | undefined} evidence */
function renderSupplier(supplier, actions, evidence) {
  const decision = decisionOf(supplier);
  const header = el(
    "div",
    "row",
    chip(decision, decisionNames[/** @type {keyof typeof decisionNames} */ (decision)]),
    el("strong", "", supplier.vendorId),
    evidence && el("span", "muted", evidence),
  );
  if ("error" in supplier) return el("article", "", header, el("p", "", supplier.error));
  const reasons = Object.entries(supplier.reasons);
  const settledBy = [
    supplier.model && `judged by ${supplier.model}`,
    supplier.rules.length > 0 && `settled by learned rules: ${supplier.rules.join(", ")}`,
  ].filter((part) => typeof part === "string");
  return el(
    "article",
    "",
    header,
    el(
      "ul",
      "facts",
      ...supplier.facts.map(({ field, status }) => el("li", "", chip(status, `${field}: ${status}`))),
    ),
    actions.length > 0 && el("ul", "", ...actions.map((text) => el("li", "", text))),
    reasons.length > 0 &&
      el(
        "details",
        "",
        el("summary", "", "The Judge's reasons"),
        el(
          "ul",
          "",
          ...reasons.map(([field, reason]) => el("li", "", el("strong", "", `${field}: `), reason)),
        ),
      ),
    settledBy.length > 0 && el("p", "muted", settledBy.join("; ")),
  );
}

/** @param {Supplier[]} suppliers @param {string[]} recommendations @param {Step[]} trace */
function renderInbox(suppliers, recommendations, trace) {
  byId("inbox-section", HTMLElement).hidden = suppliers.length === 0;
  const evidence = new Map(
    trace
      .filter(({ action }) => action === "gather_evidence")
      .map((step) => [step.vendor_id, step.output_summary]),
  );
  const cards = [...suppliers]
    .sort((a, b) => decisionOrder.indexOf(decisionOf(a)) - decisionOrder.indexOf(decisionOf(b)))
    .map((supplier) => {
      const prefix = `${supplier.vendorId}: `;
      const actions = recommendations
        .filter((text) => text.startsWith(prefix))
        .map((text) => text.slice(prefix.length));
      const card = renderSupplier(supplier, actions, evidence.get(supplier.vendorId));
      card.dataset.decision = decisionOf(supplier);
      return card;
    });
  byId("inbox", HTMLDivElement).replaceChildren(...cards);
  const filters = byId("filters", HTMLDivElement);
  const choices = [["all", "All"], ...Object.entries(decisionNames)].map(([decision, name]) => {
    const shown = cards.filter((card) => decision === "all" || card.dataset.decision === decision);
    const choice = button(`${name} (${shown.length})`, () => {
      for (const card of cards) card.hidden = !shown.includes(card);
      press(filters, choice);
    });
    choice.disabled = shown.length === 0;
    return choice;
  });
  filters.replaceChildren(...choices);
  choices[0]?.click();
}

/** @param {Rule[]} rules */
function renderRules(rules) {
  byId("rules-section", HTMLElement).hidden = rules.length === 0;
  byId("rules", HTMLTableSectionElement).replaceChildren(
    ...rules.map((rule) =>
      el(
        "tr",
        "",
        el(
          "td",
          "",
          el("strong", "", rule.id),
          el("div", "", rule.description),
          el("details", "", el("summary", "", "SQL"), el("code", "", rule.sql)),
        ),
        el("td", "", chip(rule.status)),
        el("td", "", String(rule.support)),
        el("td", "", rule.reason),
      ),
    ),
  );
}

/** @param {Step[]} trace @param {string | undefined} logFile */
function renderTrace(trace, logFile) {
  byId("trace-section", HTMLElement).hidden = trace.length === 0;
  byId("trace-file", HTMLSpanElement).textContent = logFile ?? "";
  const start = Date.parse(trace[0]?.timestamp ?? "");
  const rows = trace.map((step) => {
    const result = step.input_summary
      ? el("details", "", el("summary", "", step.output_summary), el("pre", "", step.input_summary))
      : step.output_summary;
    const row = el(
      "tr",
      "",
      el("td", "", `+${((Date.parse(step.timestamp) - start) / 1000).toFixed(1)} s`),
      el("td", "", step.vendor_id ?? "run"),
      el("td", "", step.target_agent ? `${step.agent_name} → ${step.target_agent}` : step.agent_name),
      el("td", "", step.action, step.model && el("div", "muted", step.model)),
      el("td", "", result),
      el("td", "", chip(step.status)),
    );
    row.dataset.vendor = step.vendor_id ?? "run";
    return row;
  });
  byId("trace", HTMLTableSectionElement).replaceChildren(...rows);
  const vendors = [...new Set(rows.map((row) => row.dataset.vendor ?? ""))];
  traceFilter.replaceChildren(el("option", "", "All"), ...vendors.map((vendor) => el("option", "", vendor)));
  traceFilter.onchange = () => {
    for (const row of rows)
      row.hidden = traceFilter.value !== "All" && row.dataset.vendor !== traceFilter.value;
  };
}

/** @param {string | undefined} traceId @returns {Promise<Step[]>} */
async function readTrace(traceId) {
  if (!traceId) return [];
  const response = await fetch(`traces/${encodeURIComponent(traceId)}`, { headers: authHeaders() });
  return response.ok ? readJson(response) : [];
}

/** @returns {unknown} */
function readRequest() {
  const request = /** @type {unknown} */ (JSON.parse(requestField.value || "{}"));
  if (modeField.value === "default" || typeof request !== "object" || request === null) return request;
  const { options } = /** @type {{ options?: unknown }} */ (request);
  return {
    ...request,
    options: { ...(typeof options === "object" ? options : {}), sample_mode: modeField.value === "sample" },
  };
}

async function run() {
  let request;
  try {
    request = readRequest();
  } catch {
    showStatus("The request is not valid JSON.", "error");
    return;
  }
  runButton.disabled = true;
  const started = Date.now();
  const tick = () => {
    showStatus(
      `Verifying… ${Math.round((Date.now() - started) / 1000)} s. A live run takes about a minute for ` +
        "three suppliers and about eight for the whole ERP.",
    );
  };
  tick();
  const clock = setInterval(tick, 1000);
  try {
    const response = await fetch("run", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(request),
    });
    /** @type {RunResponse} */
    const body = await readJson(response);
    if (response.status === 401) {
      showStatus(body.error?.message ?? "This server needs its API token.", "error");
      tokenField.focus();
      return;
    }
    const trace = await readTrace(body.trace_id);
    renderSummary(body, trace);
    renderInbox(body.output?.suppliers ?? [], body.output?.recommendations ?? [], trace);
    renderRules(body.output?.learning.rules ?? []);
    renderTrace(trace, body.log_file);
    results.hidden = false;
    if (body.error) showStatus(`The run failed: ${body.error.message}`, "error");
    else showStatus(`Done in ${body.execution_time_seconds} s.`);
  } catch {
    showStatus("The server did not answer. Is it still running?", "error");
  } finally {
    clearInterval(clock);
    runButton.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void run();
});

loadExamples().catch(() => {
  showStatus("Could not load the examples.", "error");
});
