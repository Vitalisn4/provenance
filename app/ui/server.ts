import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import {
  createServer,
  request as forward,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { basename, join } from "node:path";
import { pipeline } from "node:stream";
import { bearerCheck, errorBody, readBody, send } from "../api/server.ts";
import { AppError } from "../domain/errors.ts";

const asset = (name: string, type: string) => ({
  body: readFileSync(new URL(`page/${name}`, import.meta.url), "utf8"),
  type: `${type}; charset=utf-8`,
});
const assets = new Map([
  ["/", asset("index.html", "text/html")],
  ["/page.js", asset("page.js", "text/javascript")],
  ["/page.css", asset("page.css", "text/css")],
]);
const assetHeaders = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const tracePath = /^\/traces\/(trace-[\w-]{1,80})$/;

// Takes the body in under the API's own limit, since the API closing mid-upload would hide its answer, then
// passes it on with no client timeout, which would cut off a whole-ERP live run.
async function proxyRun(api: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request);
  const { authorization } = request.headers;
  const upstream = forward(
    `${api}/run`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization && { authorization }) },
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, { "content-type": "application/json" });
      // The browser may leave, or the API stop, mid-answer; either way nothing more can be sent.
      pipeline(answer, response, () => undefined);
    },
  );
  upstream.on("error", (error) => {
    console.error(error);
    send(response, 502, errorBody("internal", "The API did not answer; see the server log"));
  });
  upstream.end(body);
}

// Technical Execution Guide, section 2: the analyst page runs on a port of its own, apart from the API at
// `api`. It serves the page, the input examples and a run's trace; `token` guards the traces as it does the API.
export function createUi({
  api,
  token = null,
  logs = "logs",
  examples = "input_examples",
}: {
  api: string;
  token?: string | null;
  logs?: string;
  examples?: string;
}): Server {
  const authorized = bearerCheck(token);

  async function readExamples(): Promise<Record<string, unknown>> {
    const names = (await readdir(examples)).sort();
    const parsed = await Promise.all(
      names.map(async (name): Promise<[string, unknown]> => [
        basename(name, ".json"),
        JSON.parse(await readFile(join(examples, name), "utf8")),
      ]),
    );
    return Object.fromEntries(parsed);
  }

  async function readTrace(id: string): Promise<unknown[] | null> {
    const events = await readFile(join(logs, `${id}.jsonl`), "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    return events?.split("\n").flatMap((line) => (line ? [JSON.parse(line) as unknown] : [])) ?? null;
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { method, url = "" } = request;
    const traceId = tracePath.exec(url)?.[1];
    const file = method === "GET" ? assets.get(url) : undefined;
    if (method === "POST" && url === "/run") {
      await proxyRun(api, request, response);
    } else if (file) {
      response.writeHead(200, { ...assetHeaders, "content-type": file.type });
      response.end(file.body);
    } else if (method === "GET" && url === "/examples") {
      send(response, 200, await readExamples());
    } else if (method === "GET" && traceId) {
      if (!authorized(request)) {
        send(
          response,
          401,
          errorBody("unauthorized", "Traces need the header Authorization: Bearer <API_TOKEN>"),
        );
        return;
      }
      const events = await readTrace(traceId);
      if (events) send(response, 200, events);
      else send(response, 404, errorBody("input", `No trace ${traceId}`));
    } else {
      send(response, 404, errorBody("input", "Not found"));
    }
  }

  return createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (error instanceof AppError) {
        send(response, 400, errorBody(error.type, error.message));
        return;
      }
      console.error(error);
      send(response, 500, errorBody("internal", "Unexpected failure; see the server log"));
    });
  });
}
