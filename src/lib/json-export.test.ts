import { describe, expect, it } from "vitest";
import {
  DATABASE_JSON_SCHEMA_VERSION,
  REDACTED,
  exportDatabaseJson,
  isSupportedSchemaVersion,
  parseDatabaseJson,
} from "./json-export";
import { SECRET_KEY_LIST } from "./redaction";

/**
 * B91 follow-up — Database JSON export.
 *
 * `DATABASE_EXPORT_FORMATS` already accepts `json`, but the database export
 * route only ever emitted CSV. This pins the pure builder/parser that closes
 * the gap: a deterministic JSON document (fixed top-level order, alphabetically
 * sorted nested keys, rows ordered by `position`, secrets/internal fields
 * redacted) and its validating mirror image, so a bad import fails closed.
 * Round-trip is pinned at the bottom.
 *
 * Red-first: this file failed to import before `json-export.ts` existed.
 */

const input = {
  name: "Roadmap",
  properties: [
    { id: "p2", name: "Status", type: "select", config: { options: [{ id: "o1", name: "Done" }] } },
    { id: "p1", name: "Name", type: "title", config: { primary: true } },
  ],
  rows: [
    { id: "r2", title: "B", position: 2, propertyValues: [{ propertyId: "p1", value: "B" }] },
    { id: "r1", title: "A", position: 1, propertyValues: [{ propertyId: "p1", value: "A" }] },
  ],
  views: [{ id: "v1", name: "Table", config: { filters: [] } }],
};

const parsedExport = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

describe("exportDatabaseJson", () => {
  it("emits a JSON document with the fixed top-level key order", () => {
    const parsed = parsedExport(exportDatabaseJson(input));
    expect(Object.keys(parsed)).toEqual([
      "schemaVersion",
      "name",
      "properties",
      "rows",
      "views",
    ]);
    expect(parsed.schemaVersion).toBe(DATABASE_JSON_SCHEMA_VERSION);
    expect(parsed.name).toBe("Roadmap");
  });

  it("includes exportedAt between name and properties when supplied", () => {
    const parsed = parsedExport(
      exportDatabaseJson(input, { exportedAt: new Date("2026-01-02T03:04:05.000Z") }),
    );
    expect(Object.keys(parsed)).toEqual([
      "schemaVersion",
      "name",
      "exportedAt",
      "properties",
      "rows",
      "views",
    ]);
    expect(parsed.exportedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(parsedExport(exportDatabaseJson(input, { exportedAt: "2026-05-06T00:00:00.000Z" })).exportedAt).toBe(
      "2026-05-06T00:00:00.000Z",
    );
  });

  it("writes the requested schema version, defaulting to the current one", () => {
    expect(parsedExport(exportDatabaseJson(input, { version: 7 })).schemaVersion).toBe(7);
    expect(parsedExport(exportDatabaseJson(input)).schemaVersion).toBe(DATABASE_JSON_SCHEMA_VERSION);
  });

  it("orders rows by position and keeps missing positions in input order", () => {
    const parsed = parsedExport(exportDatabaseJson(input));
    expect((parsed.rows as { id: string }[]).map((row) => row.id)).toEqual(["r1", "r2"]);

    const tied = parsedExport(
      exportDatabaseJson({
        name: "T",
        properties: [],
        rows: [{ id: "c" }, { id: "a", position: 1 }, { id: "b" }],
        views: [],
      }),
    );
    expect((tied.rows as { id: string }[]).map((row) => row.id)).toEqual(["a", "c", "b"]);
  });

  it("is key-order independent — the canonical form is deterministic", () => {
    const reordered = {
      views: input.views,
      rows: input.rows,
      properties: input.properties,
      name: input.name,
    };
    expect(exportDatabaseJson(reordered)).toBe(exportDatabaseJson(input));
  });

  it("sorts nested keys alphabetically for a stable document", () => {
    const parsed = parsedExport(exportDatabaseJson(input));
    const property = (parsed.properties as Record<string, unknown>[])[0];
    expect(Object.keys(property)).toEqual(["config", "id", "name", "type"]);
    const option = (property.config as { options: Record<string, unknown>[] }).options[0];
    expect(Object.keys(option)).toEqual(["id", "name"]);
  });

  it("redacts secret and internal fields at any depth", () => {
    const parsed = parsedExport(
      exportDatabaseJson({
        name: "Secrets",
        properties: [{ id: "p1", name: "Key", apiKey: "sk-live", config: { token: "t0k" } }],
        rows: [
          {
            id: "r1",
            password: "hunter2",
            _internal: "bookkeeping",
            __typename: "Page",
            propertyValues: [{ propertyId: "p1", value: { secret: "s", keep: "ok" } }],
          },
        ],
        views: [{ id: "v1", authorization: "Bearer x", name: "Safe" }],
      }),
    );
    const property = (parsed.properties as Record<string, unknown>[])[0];
    expect(property.apiKey).toBe(REDACTED);
    expect((property.config as Record<string, unknown>).token).toBe(REDACTED);
    const row = (parsed.rows as Record<string, unknown>[])[0];
    expect(row.password).toBe(REDACTED);
    expect(row._internal).toBe(REDACTED);
    expect(row.__typename).toBe(REDACTED);
    const value = (row.propertyValues as { value: Record<string, unknown> }[])[0].value;
    expect(value.secret).toBe(REDACTED);
    expect(value.keep).toBe("ok");
    expect((parsed.views as Record<string, unknown>[])[0].authorization).toBe(REDACTED);
    expect((parsed.views as Record<string, unknown>[])[0].name).toBe("Safe");
  });

  it("does not mutate its input", () => {
    const snapshot = JSON.stringify(input);
    exportDatabaseJson(input, { exportedAt: new Date("2026-01-01T00:00:00.000Z") });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("pretty-prints on request and stays compact otherwise", () => {
    expect(exportDatabaseJson(input, { pretty: true })).toContain('\n  "name"');
    expect(exportDatabaseJson(input)).not.toContain("\n");
  });
});

/**
 * B119 follow-up — the export redacts the repository's shared secret list.
 *
 * The export used to carry its own key list, which was a strict subset of the
 * shared one: thirteen secret-shaped names — `passwd`, `passcode`, `cookie`,
 * `setCookie`, `sessionId`, `dbUrl`, `databaseUrl`, `connectionString`, `dsn`,
 * `auth`, `pass`, `pwd`, `signature` — passed through the export verbatim,
 * while the same names were masked on other paths. The export now asks the
 * shared list (`src/lib/redaction.ts`), so the two cannot drift apart again.
 */

/** The names the export used to keep; every one of them is a secret. */
const LEAKED_NAMES: readonly string[] = [
  "passwd",
  "passcode",
  "cookie",
  "setCookie",
  "sessionId",
  "dbUrl",
  "databaseUrl",
  "connectionString",
  "dsn",
  "auth",
  "pass",
  "pwd",
  "signature",
];

/** Ordinary fields that must stay readable in an export. */
const BENIGN_KEYS: readonly string[] = [
  "name",
  "title",
  "type",
  "position",
  "config",
  "value",
  "author",
  "authorId",
  "publicKey",
  "passport",
  "bypass",
];

const exportedRow = (row: Record<string, unknown>): Record<string, unknown> => {
  const parsed = parsedExport(
    exportDatabaseJson({ name: "T", properties: [], rows: [row], views: [] }),
  );
  return (parsed.rows as Record<string, unknown>[])[0];
};

describe("the export redacts the shared secret list", () => {
  it("redacts the thirteen names the export used to keep", () => {
    for (const key of LEAKED_NAMES) {
      expect(exportedRow({ [key]: "s3cret" })[key]).toBe(REDACTED);
    }
  });

  it("redacts every name of the shared list", () => {
    const kept = SECRET_KEY_LIST.filter((name) => exportedRow({ [name]: "s3cret" })[name] !== REDACTED);
    expect(kept).toEqual([]);
  });

  it("redacts a name whatever the spelling — the separators are normalised", () => {
    for (const key of ["API KEY", "api-key", "api_key", "apiKey", "Access Token"]) {
      expect(exportedRow({ [key]: "s3cret" })[key]).toBe(REDACTED);
    }
  });

  it("keeps ordinary fields readable", () => {
    for (const key of BENIGN_KEYS) {
      expect(exportedRow({ [key]: "plain" })[key]).toBe("plain");
    }
  });
});

describe("isSupportedSchemaVersion", () => {
  it("accepts the known versions and rejects everything else", () => {
    expect(isSupportedSchemaVersion(DATABASE_JSON_SCHEMA_VERSION)).toBe(true);
    expect(isSupportedSchemaVersion(0)).toBe(false);
    expect(isSupportedSchemaVersion(99)).toBe(false);
    expect(isSupportedSchemaVersion("1")).toBe(false);
    expect(isSupportedSchemaVersion(null)).toBe(false);
  });
});

describe("parseDatabaseJson", () => {
  it("round-trips an export", () => {
    const result = parseDatabaseJson(exportDatabaseJson(input, { exportedAt: "2026-01-02T00:00:00.000Z" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schemaVersion).toBe(DATABASE_JSON_SCHEMA_VERSION);
    expect(result.value.name).toBe("Roadmap");
    expect(result.value.exportedAt).toBe("2026-01-02T00:00:00.000Z");
    expect((result.value.rows as { id: string }[]).map((row) => row.id)).toEqual(["r1", "r2"]);
    expect(result.value.properties).toEqual(JSON.parse(exportDatabaseJson(input)).properties);
  });

  it("rejects text that is not JSON", () => {
    const result = parseDatabaseJson("{ not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/invalid json/i);
  });

  it("rejects a non-object document", () => {
    for (const text of ["[]", '"hi"', "42", "null"]) {
      const result = parseDatabaseJson(text);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a missing or unsupported schema version", () => {
    const missing = parseDatabaseJson(
      JSON.stringify({ name: "x", properties: [], rows: [], views: [] }),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/schemaVersion/);

    const future = parseDatabaseJson(
      JSON.stringify({ schemaVersion: 99, name: "x", properties: [], rows: [], views: [] }),
    );
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error).toMatch(/99/);
  });

  it("rejects a document with the wrong shape", () => {
    const base = { schemaVersion: DATABASE_JSON_SCHEMA_VERSION, name: "x", properties: [], rows: [], views: [] };
    expect(parseDatabaseJson(JSON.stringify({ ...base, name: 1 })).ok).toBe(false);
    expect(parseDatabaseJson(JSON.stringify({ ...base, properties: {} })).ok).toBe(false);
    expect(parseDatabaseJson(JSON.stringify({ ...base, rows: "no" })).ok).toBe(false);
    expect(parseDatabaseJson(JSON.stringify({ ...base, views: null })).ok).toBe(false);
    expect(parseDatabaseJson(JSON.stringify({ ...base, exportedAt: 123 })).ok).toBe(false);
  });

  it("accepts a minimal valid document", () => {
    const result = parseDatabaseJson(
      JSON.stringify({ schemaVersion: DATABASE_JSON_SCHEMA_VERSION, name: "x", properties: [], rows: [], views: [] }),
    );
    expect(result.ok).toBe(true);
  });
});
