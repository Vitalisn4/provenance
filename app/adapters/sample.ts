import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AppError } from "../domain/errors.ts";
import type { MeterlessClient } from "./meterless.ts";
import type { QueryResult, ZetarisClient } from "./zetaris.ts";

type Chat = MeterlessClient["chat"];

// Every Zetaris answer by its SQL, and every Nightshift reply, in the order given, by a digest of its request.
interface Recording {
  zetaris: Record<string, QueryResult>;
  nightshift: Record<string, Awaited<ReturnType<Chat>>[]>;
}

const file = new URL("../../data/sample/recording.json", import.meta.url);

function digest(route: string, messages: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([route, messages]))
    .digest("hex");
}

// Keeps every answer the live clients give. A Nightshift reply already recorded for the same request is kept
// rather than asked for again, so a change to the SQL does not cost a model call. A CREATE statement can carry
// the SEC contact, so recording refuses one: a sample is recorded after a live run has created every table.
export function recorder(
  zetaris: ZetarisClient,
  chat: Chat,
  earlier: Recording["nightshift"] = {},
): { zetaris: ZetarisClient; chat: Chat; recording: Recording } {
  const recording: Recording = { zetaris: {}, nightshift: {} };
  return {
    zetaris: {
      async query(sql, onRetry) {
        const result = await zetaris.query(sql, onRetry);
        recording.zetaris[sql] = result;
        return result;
      },
      execute: () =>
        Promise.reject(
          new AppError(
            "config",
            "A sample is recorded only once every Zetaris table exists: run a live verify first",
            false,
          ),
        ),
    },
    async chat(route, messages, onRetry) {
      const key = digest(route, messages);
      const replies = (recording.nightshift[key] ??= []);
      const reply = earlier[key]?.[replies.length] ?? (await chat(route, messages, onRetry));
      replies.push(reply);
      return reply;
    },
    recording,
  };
}

// Answers from a recording, with no network: a request the recording lacks is refused.
export function replayer(recording: Recording): { zetaris: ZetarisClient; chat: Chat } {
  const missing = () =>
    new AppError(
      "input",
      "Sample mode replays the recorded demo suppliers only, and this request was not recorded",
      false,
    );
  const query = (sql: string) =>
    Object.hasOwn(recording.zetaris, sql)
      ? Promise.resolve(recording.zetaris[sql] as QueryResult)
      : Promise.reject(missing());
  const served = new Map<string, number>();
  return {
    zetaris: { query, execute: query },
    chat(route, messages) {
      const key = digest(route, messages);
      const index = served.get(key) ?? 0;
      const reply = recording.nightshift[key]?.[index];
      if (!reply) return Promise.reject(missing());
      served.set(key, index + 1);
      return Promise.resolve(reply);
    },
  };
}

export function readRecording(): Recording {
  if (!existsSync(file)) {
    throw new AppError(
      "config",
      "No sample recording at data/sample/recording.json: run npm run sample:record",
      false,
    );
  }
  return JSON.parse(readFileSync(file, "utf8")) as Recording;
}

// The Nightshift replies of the current recording, if there is one.
export function recordedReplies(): Recording["nightshift"] {
  return existsSync(file) ? readRecording().nightshift : {};
}

// Keys are sorted by code unit, the same on every machine, so a new recording's diff shows only what changed.
export function writeRecording({ zetaris, nightshift }: Recording): void {
  const sorted = <T>(entries: Record<string, T>) =>
    Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1)));
  mkdirSync(new URL(".", file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ zetaris: sorted(zetaris), nightshift: sorted(nightshift) }, null, 2)}\n`,
  );
}
