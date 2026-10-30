import type { Prisma } from "@prisma/client";
import { initializeRowValues } from "@/lib/property-defaults";
import { formatUniqueId, nextNumbers, type UniqueIdConfig } from "@/lib/unique-id";

/**
 * Does a stored property config carry an authored `default`? `initializeRowValues`
 * also yields empty container shapes for CHECKBOX, MULTI_SELECT, PEOPLE and FILES
 * even when no default was configured; a new row should only be seeded when
 * someone actually authored one, so this gates that call. Mirrors `readDefault`
 * in `property-options-editor.tsx` (`"default" in config`).
 */
function hasConfiguredDefault(config: Prisma.JsonValue | null): boolean {
  return (
    !!config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    "default" in config
  );
}

/** The `config.uniqueId` block of a property, or `{}` when absent/malformed. */
function readUniqueIdConfig(
  config: Prisma.JsonValue | null,
): Partial<UniqueIdConfig> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const uniqueId = (config as { uniqueId?: unknown }).uniqueId;
  if (!uniqueId || typeof uniqueId !== "object" || Array.isArray(uniqueId)) return {};
  return uniqueId as Partial<UniqueIdConfig>;
}

/**
 * Every id-shaped string a stored UNIQUE_ID cell contributes to `nextNumbers`.
 * Mirrors `uniqueIdNumber` in `view-parts.tsx`: the counter may live under any
 * of these keys, as a number or a digits-only string. Unparseable entries are
 * handed on unchanged — `nextNumbers` ignores them rather than throwing.
 */
function existingUniqueIds(
  values: (Prisma.JsonValue | null)[],
  config: UniqueIdConfig,
): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      out.push(value);
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    for (const key of ["number", "value", "text", "id"] as const) {
      const candidate = record[key];
      if (typeof candidate === "string") {
        out.push(candidate);
      } else if (
        typeof candidate === "number" &&
        Number.isInteger(candidate) &&
        candidate >= 1
      ) {
        out.push(formatUniqueId(config, candidate));
      }
    }
  }
  return out;
}

/**
 * Allocate the next Unique ID for one property inside a row-create transaction.
 *
 * P2-T04: allocation draws from a persistent per-property counter
 * (`Property.uniqueIdCounter`) with an atomic `increment: 1`, so concurrent
 * row creates serialize on the row lock and can never mint the same id — the
 * old read-then-max scan at read-committed isolation handed duplicates out
 * under load. The counter also survives hard purges (values cascade away,
 * the counter does not), so a purged row never re-issues an id that exports
 * or backlinks already treat as identity.
 *
 * Legacy properties migrate lazily: while the counter still sits at its
 * default 0, one high-water-mark scan of the ids already stored stamps the
 * counter into the never-issued region before the first increment. Two
 * concurrent allocations compute the same max (benign) and the
 * `uniqueIdCounter: 0` guard means only a stamp onto a virgin counter can
 * win; a loser simply increments from the stamped value.
 */
async function allocateUniqueIdValue(
  tx: Prisma.TransactionClient,
  propertyId: string,
  config: Partial<UniqueIdConfig>,
): Promise<Prisma.InputJsonValue> {
  // Resolve defaults exactly like the read-only cell so storage and display
  // never disagree; the engine sanitises any malformed optional field.
  const resolved: UniqueIdConfig = {
    prefix: typeof config.prefix === "string" ? config.prefix : "",
    ...(typeof config.zeroPad === "number" ? { zeroPad: config.zeroPad } : {}),
    ...(typeof config.startAt === "number" ? { startAt: config.startAt } : {}),
    ...(typeof config.separator === "string" ? { separator: config.separator } : {}),
  };

  const current = await tx.property.findUnique({
    where: { id: propertyId },
    select: { uniqueIdCounter: true },
  });
  if (current && current.uniqueIdCounter === 0) {
    // Lazily backfill the counter from the stored values (max of the remaining
    // ids, floored at `startAt - 1` — the exact semantics of `nextNumbers`).
    // The guard means the stamp only lands on a virgin counter; after this
    // once-per-property step every allocation is an O(1) increment.
    const rows = await tx.propertyValue.findMany({
      where: { propertyId },
      select: { value: true },
    });
    const existing = existingUniqueIds(
      rows.map((row) => row.value),
      resolved,
    );
    const highWaterMark = (nextNumbers(resolved, existing, 1)[0] ?? 1) - 1;
    await tx.property.updateMany({
      where: { id: propertyId, uniqueIdCounter: 0 },
      data: { uniqueIdCounter: highWaterMark },
    });
  }

  const allocated = await tx.property.update({
    where: { id: propertyId },
    select: { uniqueIdCounter: true },
    data: { uniqueIdCounter: { increment: 1 } },
  });
  let number = allocated.uniqueIdCounter;
  if (number < (resolved.startAt ?? 1)) {
    // A startAt raised after ids were already issued. Snap up to the new
    // floor and keep the stored counter monotonic — it never moves backwards.
    number = resolved.startAt ?? 1;
    await tx.property.updateMany({
      where: { id: propertyId, uniqueIdCounter: { lt: number } },
      data: { uniqueIdCounter: number },
    });
  }
  return { number, text: formatUniqueId(resolved, number) };
}

/**
 * Seed the cells of a row that was created in the caller's transaction.
 *
 * This is the shared value path for an internal blank row, an internal form
 * submission and a public form submission. The caller owns the guarded page
 * write (`Page.parentId`) and has already authorized the database (or resolved
 * a public share token); this helper only touches that database's own columns.
 * `submitted` answers are overlaid after the primary cell, UNIQUE_ID allocations
 * and authored defaults, so an accepted answer always wins over a seed value
 * while the whole row remains one atomic write.
 */
export async function createRowCellsInTransaction(
  tx: Prisma.TransactionClient,
  databasePageId: string,
  pageId: string,
  title: string,
  submitted?: ReadonlyMap<string, Prisma.InputJsonValue>,
): Promise<void> {
  const properties = await tx.property.findMany({
    where: { databasePageId },
    orderBy: { position: "asc" },
    select: { id: true, type: true, config: true },
  });

  // One cell per property: the primary text cell yields to a Unique ID
  // allocation when the primary column is itself a UNIQUE_ID property, and
  // every UNIQUE_ID column gets a fresh id derived from its own stored
  // values (multiple Unique ID properties number independently).
  const values = new Map<string, Prisma.InputJsonValue>();
  const primary = properties[0];
  if (primary && primary.type !== "UNIQUE_ID") {
    values.set(primary.id, { text: title || "" });
  }
  for (const property of properties) {
    if (property.type !== "UNIQUE_ID") continue;
    values.set(
      property.id,
      await allocateUniqueIdValue(
        tx,
        property.id,
        readUniqueIdConfig(property.config),
      ),
    );
  }

  // An authored `config.default` seeds the fresh row (e.g. a Status, Number or
  // Date starting value), unless the primary text cell or a UNIQUE_ID
  // allocation already owns that column - the same override order the read-only
  // grid uses. `initializeRowValues` validates each stored config and omits
  // computed types, so a malformed config can never break row creation.
  for (const seeded of initializeRowValues(
    properties.filter(
      (property) =>
        !values.has(property.id) && hasConfiguredDefault(property.config),
    ),
  )) {
    values.set(seeded.propertyId, seeded.value as Prisma.InputJsonValue);
  }

  if (submitted) {
    // The action validated every id against this database before opening the
    // transaction; the known-set guard keeps the helper safe for any caller,
    // including a stale property deleted between validation and commit.
    const known = new Set(properties.map((property) => property.id));
    for (const [propertyId, value] of submitted) {
      if (known.has(propertyId)) values.set(propertyId, value);
    }
  }

  if (values.size > 0) {
    await tx.propertyValue.createMany({
      data: [...values].map(([propertyId, value]) => ({
        propertyId,
        pageId,
        value,
      })),
    });
  }
}
