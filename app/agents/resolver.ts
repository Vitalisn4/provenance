import { createHash } from "node:crypto";
import { decide, nameSimilarity, normalizeName } from "#world-model";
import { restTables } from "../adapters/restTables.ts";
import type { ZetarisClient } from "../adapters/zetaris.ts";
import { AppError } from "../domain/errors.ts";
import type { Evidence } from "./scout.ts";

// Legal forms recognised as a name's last word, with their spellings. GLEIF keeps whichever spelling the
// registrant used and its name filter matches whole words, so a search tries every spelling.
const legalForms: Record<string, string[]> = {
  ab: ["AB", "Aktiebolag"],
  ag: ["AG", "Aktiengesellschaft"],
  as: ["A/S", "Aktieselskab"],
  co: ["Co", "Company"],
  corp: ["Corp", "Corporation"],
  gmbh: ["GmbH"],
  inc: ["Inc", "Incorporated"],
  llc: ["LLC"],
  ltd: ["Ltd", "Limited"],
  nv: ["N.V."],
  oyj: ["Oyj"],
  plc: ["PLC"],
  sa: ["S.A."],
  sarl: ["SARL"],
  se: ["SE"],
};

// Normalised words, with the punctuation inside abbreviations such as "A/S" and "N.V." dropped.
function words(name: string): string[] {
  return normalizeName(name)
    .replace(/[./]/g, "")
    .split(/[^\p{L}\p{N}&]+/u)
    .filter(Boolean);
}

const formOf = new Map(
  Object.entries(legalForms).flatMap(([form, spellings]) =>
    spellings.map((spelling) => [words(spelling).join(""), form] as const),
  ),
);

// A name split into the words before its legal form and the form itself, so "Siemens AG" and "Siemens
// Aktiengesellschaft" compare as the same name and form.
function parse(name: string): { base: string; form: string | null } {
  const all = words(name);
  const form = formOf.get(all.at(-1) ?? "");
  return form ? { base: all.slice(0, -1).join(" "), form } : { base: all.join(" "), form: null };
}

// Two legal forms that differ name two different entities, however alike the rest of the names.
function similarity(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)];
  return x.form && y.form && x.form !== y.form ? 0 : nameSimilarity(x.base, y.base);
}

interface Entity {
  lei: string;
  legalName: string;
  country: string | null;
  registrationStatus: string | null;
  entityStatus: string | null;
}

interface Candidate {
  entity: Entity;
  similarity: number;
}

// Which legal entity a supplier is: the one its claimed LEI names when that entity is active and in the
// supplier's country, or else the one a complete GLEIF search for its name in that country finds. `candidates` are
// the search's matches at or above the World Model's review band, best first, and `sql` is the query that read them.
type Resolution = { candidates: Candidate[]; notes: string[]; sql: string | null } & (
  { identity: "clear"; entity: Entity } | { identity: "ambiguous" | "unmatched" }
);

// GLEIF's largest page; a search matching more entities is reported as cut short.
const pageSize = 200;

function searchUrl(name: string, country: string): string {
  return (
    "https://api.gleif.org/api/v1/lei-records" +
    `?filter%5Bentity.legalName%5D=${encodeURIComponent(name)}` +
    `&filter%5Bentity.legalAddress.country%5D=${country}&page%5Bsize%5D=${pageSize}`
  );
}

interface GleifRecord {
  attributes?: {
    lei?: unknown;
    entity?: { legalName?: { name?: unknown }; legalAddress?: { country?: unknown }; status?: unknown };
    registration?: { status?: unknown };
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// Search results arrive through to_json, which also reads a search with no results: Zetaris then infers the
// records as strings, from which no field can be extracted.
function entities(json: string): Entity[] {
  const records: unknown = JSON.parse(json);
  if (!Array.isArray(records)) throw new AppError("zetaris", "GLEIF search returned no record list", false);
  return (records as (GleifRecord | null)[]).map((record) => {
    const { lei, entity, registration } = record?.attributes ?? {};
    const legalName = text(entity?.legalName?.name);
    if (typeof lei !== "string" || !legalName) {
      throw new AppError("zetaris", "GLEIF search returned a record without an LEI or legal name", false);
    }
    return {
      lei,
      legalName,
      country: text(entity?.legalAddress?.country),
      registrationStatus: text(registration?.status),
      entityStatus: text(entity?.status),
    };
  });
}

export function openResolver(zetaris: ZetarisClient): {
  resolve: (evidence: Evidence) => Promise<Resolution>;
} {
  const { register } = restTables(zetaris);

  // Every GLEIF entity registered in `country` under a spelling of `name` and its legal form, once each.
  async function search(name: string, form: string | null, country: string, notes: string[]) {
    // Commas split too, so a form written "Systems,Inc." is replaced alone; GLEIF's name filter ignores commas.
    const stem = name.split(/[\s,]+/).filter(Boolean);
    const spellings = form
      ? (legalForms[form] ?? []).map((spelling) => [...stem.slice(0, -1), spelling].join(" "))
      : [stem.join(" ")];
    const searches = new Map<string, string>();
    for (const spelling of spellings) {
      const url = searchUrl(spelling, country);
      const table = `search_${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
      const ddl = `CREATE LIGHTNING REST TABLE ${table} FROM PROV_GLEIF REQUEST(endpoint "${url}", method "get",
        response_type "json", http_encoding "URLENCODED") HEADER (accept "application/vnd.api+json") BODY ()`;
      if (await register("prov_gleif", table, ddl)) searches.set(table, spelling);
      else notes.push(`GLEIF could not be searched for "${spelling}"`);
    }
    if (searches.size === 0) return { found: [], sql: null, complete: false };

    // Each row names its table, a hex digest and so safe as a literal, because UNION ALL keeps no order.
    const sql = [...searches.keys()]
      .map(
        (table) =>
          `SELECT '${table}' AS search, meta.pagination.total AS total, to_json(data) AS records FROM prov_gleif.${table}`,
      )
      .join("\nUNION ALL\n");
    const found = new Map<string, Entity>();
    let complete = searches.size === spellings.length;
    for (const [table, total, records] of (await zetaris.query(sql)).rows) {
      const page = entities(records ?? "[]");
      if (Number(total) > page.length) {
        complete = false;
        notes.push(
          `a GLEIF search for "${searches.get(table ?? "") ?? name}" matched ${total} entities; only ${page.length} were compared`,
        );
      }
      for (const entity of page) found.set(entity.lei, entity);
    }
    return { found: [...found.values()], sql, complete };
  }

  async function resolve({ erp, gleif }: Evidence): Promise<Resolution> {
    const notes: string[] = [];
    // An inactive entity has ceased to exist, so no supplier can still be it.
    const inactive = gleif?.entityStatus === "INACTIVE";
    if (
      gleif?.lei &&
      gleif.legalName &&
      gleif.country !== null &&
      gleif.country === erp.country &&
      !inactive
    ) {
      const { lei, legalName, country, registrationStatus, entityStatus } = gleif;
      const entity = { lei, legalName, country, registrationStatus, entityStatus };
      return { identity: "clear", entity, candidates: [], notes, sql: null };
    }
    if (gleif?.lei) {
      notes.push(
        `claimed LEI ${gleif.lei} is ${gleif.legalName ?? "an entity"} in ${gleif.country ?? "no country"}` +
          (inactive ? ", which GLEIF records as inactive" : ""),
      );
    }
    const { name, country } = erp;
    if (!name || !country || !/^[A-Z]{2}$/.test(country)) {
      notes.push("the ERP lacks the name or two-letter country a GLEIF search needs");
      return { identity: "unmatched", candidates: [], notes, sql: null };
    }

    const { form } = parse(name);
    const { found, sql, complete } = await search(name, form, country, notes);
    const candidates = found
      .filter((entity) => entity.entityStatus !== "INACTIVE")
      .map((entity) => ({ entity, similarity: similarity(name, entity.legalName) }))
      .filter((candidate) => decide(candidate.similarity) !== "new")
      .sort((a, b) => b.similarity - a.similarity);
    const [best, ...rest] = candidates;

    if (!complete) {
      notes.push("the search was incomplete, so it can neither settle on one entity nor rule all out");
      return { identity: "ambiguous", candidates, notes, sql };
    }
    if (!best) {
      notes.push(`GLEIF has no active entity named like "${name}" in ${country}`);
      return { identity: "unmatched", candidates, notes, sql };
    }
    if (!form) {
      notes.push(`"${name}" has no legal form, so it names a brand rather than one legal entity`);
      return { identity: "ambiguous", candidates, notes, sql };
    }
    if (rest.length === 0 && decide(best.similarity) === "auto-merge") {
      return { identity: "clear", entity: best.entity, candidates, notes, sql };
    }
    notes.push(
      `no candidate is a clear match for "${name}": ${candidates.length} scored, the closest ${best.similarity.toFixed(2)}`,
    );
    return { identity: "ambiguous", candidates, notes, sql };
  }

  return { resolve };
}
