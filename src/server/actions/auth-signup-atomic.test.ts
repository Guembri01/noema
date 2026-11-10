import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P3-T04 — the sign-up provisions the whole account (user row, workspace with
 * its OWNER member, "Getting started" page) inside one `$transaction`, and a
 * workspace slug a concurrent sign-up for the same name took between the
 * uniqueness check and the insert is regenerated — not failed (the raw P2002
 * used to surface as a 500).
 *
 * The database edge is a tiny in-memory store with the two properties the
 * defect lives on: slug uniqueness is enforced at INSERT time (the Postgres
 * index), and `$transaction` is real (writes stage and only commit when the
 * callback resolves — a mid-provision failure or a rollback leaves nothing
 * behind). Concurrency is modelled by a number of deliberately stale slug
 * reads (`h.lies`): each is a check that run before the concurrent commit
 * landed, exactly the window a check-then-insert generator cannot see.
 */

const h = vi.hoisted(() => {
  type User = { id: string; email: string; emailVerified: boolean };
  type Workspace = { id: string; slug: string; ownerId: string };
  type Member = { workspaceId: string; userId: string; role: string };
  type Page = { id: string; workspaceId: string; title: string };

  return {
    userFindUnique: vi.fn(),
    userCreate: vi.fn(),
    workspaceFindUnique: vi.fn(),
    workspaceCreate: vi.fn(),
    pageCreate: vi.fn(),
    createSession: vi.fn(),
    hashPassword: vi.fn(async (password: string) => `hashed:${password}`),
    transaction: vi.fn(),

    /** The committed store. */
    users: new Map<string, User>(),
    /** Workspace id per slug — the slug index. */
    workspaces: new Map<string, Workspace>(),
    members: [] as Member[],
    pages: [] as Page[],

    /** True while a `$transaction` callback is running. */
    open: false,
    /** Deferred commits, released only when the transaction resolves. */
    staged: [] as Array<() => void>,
    /**
     * Stale slug reads still owed: each is a `uniqueWorkspaceSlug` check that
     * ran before the concurrent commit was visible.
     */
    lies: 0,
    next: { user: 0, workspace: 0, page: 0 },

    reset(): void {
      this.users.clear();
      this.workspaces.clear();
      this.members.length = 0;
      this.pages.length = 0;
      this.open = false;
      this.staged.length = 0;
      this.lies = 0;
      this.next = { user: 0, workspace: 0, page: 0 };
    },

    /** Stage a commit while a transaction is open, run it at once otherwise. */
    enqueue(commit: () => void): void {
      if (this.open) this.staged.push(commit);
      else commit();
    },
  };
});

vi.mock("@/lib/db", () => {
  const prisma = {
    user: {
      findUnique: h.userFindUnique,
      create: h.userCreate,
    },
    workspace: {
      findUnique: h.workspaceFindUnique,
      create: h.workspaceCreate,
    },
    page: { create: h.pageCreate },
    $transaction: h.transaction,
  };

  h.userFindUnique.mockImplementation(
    async (args: { where: { email: string } }) =>
      h.users.get(args.where.email) ?? null,
  );

  h.userCreate.mockImplementation(
    async (args: { data: { email: string; emailVerified: boolean } }) => {
      if (h.users.has(args.data.email)) {
        throw { code: "P2002", meta: { target: ["email"] } };
      }
      const user = {
        id: `user-${++h.next.user}`,
        email: args.data.email,
        emailVerified: args.data.emailVerified,
      };
      h.enqueue(() => h.users.set(args.data.email, user));
      return user;
    },
  );

  h.workspaceFindUnique.mockImplementation(
    async (args: { where: { slug: string } }) => {
      // A stale read is the race window: the concurrent commit landed after
      // this check ran, so the candidate still looks free here.
      if (h.lies > 0) {
        h.lies -= 1;
        return null;
      }
      return h.workspaces.has(args.where.slug) ? { id: args.where.slug } : null;
    },
  );

  h.workspaceCreate.mockImplementation(
    async (args: {
      data: {
        slug: string;
        ownerId: string;
        members?: { create: { userId: string; role: string } };
      };
    }) => {
      if (h.workspaces.has(args.data.slug)) {
        // The uniqueness the index enforces at INSERT time — the thing the
        // check-then-insert race loses.
        throw { code: "P2002", meta: { target: ["Workspace_slug_key"] } };
      }
      const workspace = {
        id: `ws-${++h.next.workspace}`,
        slug: args.data.slug,
        ownerId: args.data.ownerId,
      };
      const member = {
        workspaceId: workspace.id,
        userId: args.data.members?.create.userId ?? args.data.ownerId,
        role: args.data.members?.create.role ?? "OWNER",
      };
      h.enqueue(() => {
        h.workspaces.set(args.data.slug, workspace);
        h.members.push(member);
      });
      return workspace;
    },
  );

  h.pageCreate.mockImplementation(
    async (args: { data: { workspaceId: string; title: string } }) => {
      const page = {
        id: `page-${++h.next.page}`,
        workspaceId: args.data.workspaceId,
        title: args.data.title,
      };
      h.enqueue(() => h.pages.push(page));
      return page;
    },
  );

  // Interactive form: writes stage and only land when the callback resolves.
  h.transaction.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) => {
      h.open = true;
      h.staged = [];
      try {
        const result = await callback(prisma);
        for (const commit of h.staged) commit();
        return result;
      } finally {
        h.open = false;
        h.staged = [];
      }
    },
  );

  return { prisma };
});

vi.mock("@/lib/auth", () => ({
  createSession: h.createSession,
  destroySession: vi.fn(),
  hashPassword: h.hashPassword,
  verifyPassword: vi.fn(async () => false),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import { signupAction } from "./auth";

const VALID_PASSWORD = "Str0ngPassphrase";

/** A form the action can read. */
function signupForm(name: string, email: string): FormData {
  const form = new FormData();
  form.set("name", name);
  form.set("email", email);
  form.set("password", VALID_PASSWORD);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reset();
  h.createSession.mockResolvedValue(undefined);
});

describe("signupAction — P3-T04 atomic provisioning", () => {
  it("regenerates a slug a concurrent sign-up took between the check and the insert", async () => {
    // The concurrent "Ada" sign-up committed its workspace mid-flight: after
    // this one's slug check ran, but before its insert did.
    h.workspaces.set("ada", { id: "ws-other", slug: "ada", ownerId: "other" });
    h.lies = 1;

    await expect(
      signupAction({}, signupForm("Ada", "race@corp.test")),
    ).rejects.toThrow("NEXT_REDIRECT:/w/ada-1");

    // The losing insert failed once; the retry regenerated and completed.
    expect(h.workspaceCreate).toHaveBeenCalledTimes(2);
    // The session is for the user the surviving attempt committed.
    const [sessionUser] = h.createSession.mock.calls[0];
    expect(h.users.get("race@corp.test")?.id).toBe(sessionUser);
    // The concurrent workspace and this one both exist, with distinct slugs.
    expect([...h.workspaces.keys()].sort()).toEqual(["ada", "ada-1"]);
    const workspace = h.workspaces.get("ada-1");
    expect(workspace).toBeDefined();
    // The regenerated workspace seeded its owner as a member.
    expect(workspace ? h.members : []).toEqual([
      {
        workspaceId: workspace ? workspace.id : "",
        userId: sessionUser,
        role: "OWNER",
      },
    ]);
  });

  it("keeps regenerating while every candidate loses its race", async () => {
    h.workspaces.set("ada", { id: "ws-1", slug: "ada", ownerId: "other" });
    h.workspaces.set("ada-1", { id: "ws-2", slug: "ada-1", ownerId: "other" });
    h.workspaces.set("ada-2", { id: "ws-3", slug: "ada-2", ownerId: "other" });
    // Both early checks run before the concurrent commits land.
    h.lies = 2;

    await expect(
      signupAction({}, signupForm("Ada", "deep@corp.test")),
    ).rejects.toThrow("NEXT_REDIRECT:/w/ada-3");

    expect([...h.workspaces.keys()].sort()).toEqual([
      "ada",
      "ada-1",
      "ada-2",
      "ada-3",
    ]);
  });

  it("answers the neutral signup failure when the slug race outlasts every attempt", async () => {
    h.workspaces.set("ada", { id: "ws-1", slug: "ada", ownerId: "other" });
    h.workspaces.set("ada-1", { id: "ws-2", slug: "ada-1", ownerId: "other" });
    h.workspaces.set("ada-2", { id: "ws-3", slug: "ada-2", ownerId: "other" });
    // Enough stale reads for every bounded attempt to lose.
    h.lies = 3;

    const state = await signupAction(
      {},
      signupForm("Ada", "starve@corp.test"),
    );

    expect(state.error).toContain("could not create the account");
    // A rolled-back attempt strands nothing: no session is issued and no
    // half account sits ready for a workspace-less login.
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.users.size).toBe(0);
    expect(h.pages).toHaveLength(0);
  });

  it("lands two same-name sign-ups with distinct slugs", async () => {
    await expect(
      signupAction({}, signupForm("Ada", "ada-first@corp.test")),
    ).rejects.toThrow("NEXT_REDIRECT:/w/ada");
    await expect(
      signupAction({}, signupForm("Ada", "ada-second@corp.test")),
    ).rejects.toThrow("NEXT_REDIRECT:/w/ada-1");

    expect(h.users.size).toBe(2);
    expect([...h.workspaces.keys()].sort()).toEqual(["ada", "ada-1"]);
    expect(h.pages).toHaveLength(2);
  });

  it("leaves no user row behind when provisioning fails halfway", async () => {
    h.pageCreate.mockRejectedValueOnce(new Error("welcome doc overflowed"));

    await expect(
      signupAction({}, signupForm("Grace", "crash@corp.test")),
    ).rejects.toThrow("welcome doc overflowed");

    // The transaction rolled the whole provisioning back: no stranded
    // account retries into SIGNUP_FAILED and no workspace-less login.
    expect(h.users.size).toBe(0);
    expect(h.workspaces.size).toBe(0);
    expect(h.pages).toHaveLength(0);
    expect(h.createSession).not.toHaveBeenCalled();

    // Nothing was stranded, so the very same sign-up succeeds afterwards.
    await expect(
      signupAction({}, signupForm("Grace", "crash@corp.test")),
    ).rejects.toThrow("NEXT_REDIRECT:/w/grace");
    expect(h.users.size).toBe(1);
  });

  it("provisions the account in one transaction and seeds the page", async () => {
    await expect(
      signupAction({}, signupForm("Grace", "once@corp.test")),
    ).rejects.toThrow("NEXT_REDIRECT:/w/grace");

    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.users.size).toBe(1);
    expect([...h.workspaces.keys()]).toEqual(["grace"]);
    expect(h.pages).toEqual([
      expect.objectContaining({ title: "Getting started" }),
    ]);
    expect(h.members).toEqual([
      expect.objectContaining({ userId: "user-1", role: "OWNER" }),
    ]);
  });

  it("reserves the fallback slug for a name that slugifies to nothing", async () => {
    await expect(
      signupAction({}, signupForm("日本語", "fallback-1@corp.test")),
    ).rejects.toThrow("NEXT_REDIRECT:/w/workspace");

    // A second unpronounceable name gets the next free variant.
    await expect(
      signupAction({}, signupForm("→←→", "fallback-2@corp.test")),
    ).rejects.toThrow("NEXT_REDIRECT:/w/workspace-1");

    expect([...h.workspaces.keys()].sort()).toEqual([
      "workspace",
      "workspace-1",
    ]);
  });
});
