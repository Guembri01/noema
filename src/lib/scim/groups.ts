/** SCIM 2.0 Group helpers (teamspaces are the group resource). */

export type ScimGroupResource = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"];
  id: string;
  displayName: string;
  members: { value: string; display?: string }[];
  meta: { resourceType: "Group" };
};

export type GroupPatch =
  | { op: "add" | "remove" | "replace"; userIds: string[] };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Extract member ids from `value: [{ value: id }]` or a SCIM path filter. */
function memberIds(value: unknown, path: string): string[] {
  const ids = new Set<string>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      const id = string(record(entry)?.value);
      if (id) ids.add(id);
    }
  }
  const direct = string(record(value)?.value);
  if (direct) ids.add(direct);
  const filter = /members\s*\[\s*value\s+eq\s+"([^"]+)"\s*\]/i.exec(path);
  if (filter?.[1]) ids.add(filter[1]);
  return [...ids];
}

/** Parse POST /Groups: displayName plus optional members. */
export function parseScimGroup(body: unknown): { displayName: string; userIds: string[] } | null {
  const input = record(body);
  if (!input) return null;
  const displayName = string(input.displayName) || string(input.name);
  if (!displayName) return null;
  return { displayName: displayName.slice(0, 80), userIds: memberIds(input.members, "") };
}

/** Parse PATCH /Groups operations into add/remove/replace member sets. */
export function parseScimGroupPatch(body: unknown): GroupPatch[] | null {
  const input = record(body);
  if (!input || !Array.isArray(input.Operations)) return null;
  const patches: GroupPatch[] = [];
  for (const operation of input.Operations) {
    const node = record(operation);
    if (!node) continue;
    const rawOp = string(node.op).toLowerCase();
    if (rawOp !== "add" && rawOp !== "remove" && rawOp !== "replace") continue;
    const path = string(node.path);
    if (path && !/^members\b/i.test(path)) continue;
    const ids = memberIds(node.value, path);
    if (ids.length === 0 && rawOp !== "replace") continue;
    patches.push({ op: rawOp, userIds: ids });
  }
  return patches.length > 0 ? patches : null;
}

export function scimGroupResource(input: {
  id: string;
  displayName: string;
  members: { id: string; email: string }[];
}): ScimGroupResource {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    id: input.id,
    displayName: input.displayName,
    members: input.members.map((member) => ({
      value: member.id,
      display: member.email,
    })),
    meta: { resourceType: "Group" },
  };
}
