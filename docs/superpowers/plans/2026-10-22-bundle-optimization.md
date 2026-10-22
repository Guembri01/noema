# Bundle Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the route payload for `/w/[slug]/[pageId]` by splitting the editor and database surfaces, deferring optional page chrome, and setting a CI bundle budget — without changing permissions, guest scope, editor behaviour, or database behaviour.

**Architecture:** The route stays a Server Component. It dynamically imports exactly one of `PageEditor` or `DatabaseView` per request, so editor chunks never travel with a database page (and vice versa). Optional panels move behind client-only `next/dynamic` boundaries that mount on viewport/open. Editor collaboration and database-only views load only when configured or selected. A gzip budget gate reads `.next/app-build-manifest.json` and fails CI on regression.

**Tech Stack:** Next.js 15.5 App Router, React 19, TypeScript, TipTap, Yjs/y-websocket, Vitest, Node `zlib`.

---

**Spec:** `docs/PRODUCT_AUDIT_2026-10.md` (§ Phase 4, local production baseline and the "editor bundle is the next budget to set" finding) and `docs/FRONTEND_PLAN.md` (§20.1 route-level code splitting, §20.7 bundle budget in CI).

## Baseline (measured 2026-10-22, local production build)

| Measurement | Baseline |
|---|---:|
| `next build` route size | 233 kB |
| `next build` First Load JS | 919 kB |
| Route manifest, all chunks | 3,037,705 raw / **922,531 gzip** / 35 chunks |
| Route page chunk | 618,293 raw / 173,982 gzip |
| Editor transfer (audit) | 611 KB |
| Editor TTFB / LCP / CLS | 47 ms / 312 ms / 0 |
| Tiptap + Yjs + ProseMirror chunk `7914` | 477,821 raw / 146,143 gzip |
| KaTeX chunk `d3ac728e` | 263,979 raw / 76,556 gzip |
| Yjs chunk `6be7e44c` | 66,858 raw / 19,269 gzip |

The budget number is the **gzipped sum of the route's files in `.next/app-build-manifest.json`**, not browser transfer. It is intentionally conservative because the manifest lists the whole route graph. The first budget is **930,000 bytes gzip** (7,469 bytes of headroom over the 922,531 baseline). The final target is **780,000 bytes gzip** (15.5% below baseline). Also record the browser transfer in the audit when a seeded database is available; the target there is **≤ 500 KB editor transfer**.

## Non-goals

- No new runtime dependency and no database/schema change.
- No redesign of the editor or database UI.
- No change to permission checks, guest scope, query shapes, or the props handed to client components.
- No lazy math/KaTeX split in this plan. KaTeX is 76.5 kB gzip and safely removing it needs editor schema reinitialisation; record it as the next measured follow-up.
- Do not touch `.agents/`, `.opencode/`, or `skills-lock.json`.

## Global constraints

- The route file stays a Server Component. `ssr: false` is only used inside `"use client"` modules.
- Dynamic imports must not import Node built-ins into client code. Run `npm run check:client` after every task.
- Preserve `immediatelyRender: false` and all existing editor hydration behaviour.
- Preserve the exact props passed to `PageEditor`, `DatabaseView`, `PageTitle`, `CommentPanel`, `Backlinks`, and `VersionHistory`; only the module boundary changes.
- Use `node:zlib` for the budget script. Do not add `@next/bundle-analyzer`.
- Every task ends with the listed targeted tests plus `npm run typecheck`, `npm run lint`, and a production build. On Windows PowerShell, use `npm.cmd run ...` because `npm.ps1` is blocked by the execution policy. The repo currently has unrelated uncommitted remediation work: stage only the files named by the task.
- If a task cannot reduce the measured budget without changing behaviour, stop and report the measurement instead of weakening the budget.

## Review Focus

These are the five inputs most likely to bite. Each is covered by a test in its owning task.

1. **Guest scope and payload stay identical after the route split** — `page-route.guest-scope.test.ts`, `page-route.test.ts`, and `page.test.ts` must pass without weakening assertions (Task 2).
2. **Server rendering never pulls below-fold panels** — `DeferredMount` renders only its fallback during SSR, and the comment/backlinks mock factories are not entered (Task 3).
3. **Version history is inert until opened** — closed markup has the trigger only, and the extracted panel still renders rows and diffs when rendered directly (Task 4).
4. **Default builds do not import Yjs/WebSocket** — `loadCollaborationSession("")` returns `null` without importing `yjs` or `y-websocket`; configured failure shows retry, not silent local-only editing (Task 6).
5. **Database table view stays eager; optional views are lazy** — table markup still renders synchronously, while chart/timeline/calendar/form and the property options editor are absent from the initial module graph and show skeletons (Task 7).

## File Structure

| File | Responsibility |
|---|---|
| `scripts/bundle-budget.mjs` | Read `.next/app-build-manifest.json`, gzip each chunk, print a sorted table, enforce the budget. |
| `scripts/bundle-budget.test.mjs` | Pure tests for dedupe/sum/evaluate. |
| `scripts/bundle-budget.json` | Route budgets; starts at 930,000 and ratchets down to 780,000. |
| `src/app/w/[slug]/[pageId]/page.tsx` | Dynamically import the one surface this request needs. |
| `src/components/deferred-mount.tsx` | Client viewport gate with a stable SSR fallback. |
| `src/components/deferred-comment-panel.tsx` | Lazy `CommentPanel` behind `DeferredMount`. |
| `src/components/deferred-backlinks.tsx` | Lazy `Backlinks` behind `DeferredMount`. |
| `src/lib/editor-events.ts` | Light event constants/types (`COMMENT_EVENT`, `EQUATION_EVENT`, `EquationRequest`) so panels/editors are not imported just for a string. |
| `src/components/version-history.tsx` | Light trigger; keeps `planVersionHistoryTab` and `VersionRow` exports. |
| `src/components/version-history-panel.tsx` | Heavy panel: diff, restore, focus trap. |
| `src/components/page-title.tsx` | Lazy share/import/access dialogs, loaded on first open. |
| `src/components/editor/collaboration-session.ts` | Dynamic Yjs/WebSocket loader; returns `null` when collaboration is off. |
| `src/components/editor/page-editor.tsx` | Wrapper + existing body; body receives an optional collaboration session. |
| `src/components/database/database-view.tsx` | Lazy calendar/timeline/chart/form/property editor. |
| `src/components/database/view-renderers.tsx` | Remove the `CalendarView` re-export that eagerly pulls the chart module. |
| `src/components/database/gallery-view.tsx` | Remove the duplicate `CalendarView` re-export. |
| `docs/FRONTEND_PLAN.md` | Mark §20.7 done; annotate §20.1 with what remains. |
| `docs/PRODUCT_AUDIT_2026-10.md` | Record the new bundle baseline and the CI gate. |

---

### Task 1: Add the bundle budget gate

**Files:**
- Create: `scripts/bundle-budget.mjs`
- Create: `scripts/bundle-budget.test.mjs`
- Create: `scripts/bundle-budget.json`
- Modify: `package.json`
- Modify: `.github/workflows/site.yml`

**Step 1: Write the failing test**

Create `scripts/bundle-budget.test.mjs`:

```js
import { describe, expect, it } from "vitest";
import { evaluateBudget, summarizeChunks } from "./bundle-budget.mjs";

describe("bundle budget", () => {
  it("dedupes chunk files and sums raw + gzip bytes", () => {
    const summary = summarizeChunks([
      { file: "a.js", raw: 100, gzip: 40 },
      { file: "a.js", raw: 100, gzip: 40 },
      { file: "b.js", raw: 60, gzip: 25 },
    ]);

    expect(summary).toEqual({ files: 2, raw: 160, gzip: 65 });
  });

  it("reports the exact overage and treats equality as passing", () => {
    expect(evaluateBudget(930_001, 930_000)).toEqual({ ok: false, overBy: 1 });
    expect(evaluateBudget(930_000, 930_000)).toEqual({ ok: true, overBy: 0 });
    expect(evaluateBudget(929_999, 930_000)).toEqual({ ok: true, overBy: 0 });
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/bundle-budget.test.mjs`

Expected: FAIL — `Cannot find module './bundle-budget.mjs'`.

**Step 3: Implement the script**

`scripts/bundle-budget.mjs` must export:

```js
export function summarizeChunks(rows)
// rows: Array<{ file: string, raw: number, gzip: number }>
// -> { files: number, raw: number, gzip: number }

export function evaluateBudget(actualGzip, budgetGzip)
// -> { ok: boolean, overBy: number }

export function chunkRows(manifest, routeKey, readSizes)
// manifest: parsed app-build-manifest.json
// routeKey: e.g. "/w/[slug]/[pageId]/page"
// readSizes: (file: string) => { raw: number, gzip: number }
// -> Array<{ file, raw, gzip }>
```

Implementation requirements:

- Read `.next/app-build-manifest.json` with `readFileSync`.
- Deduplicate file paths before summing.
- For each file, read bytes from `.next` and compute gzip with `gzipSync(bytes, { level: 9 })`.
- Find the route key from `process.argv` `--route`, defaulting to `/w/[slug]/[pageId]/page`.
- Read `scripts/bundle-budget.json`.
- Print the top 12 files by gzip descending, in the form `gzip bytes  raw bytes  file`.
- Print `route`, `chunks`, `raw`, `gzip`, `budget`, and `headroom`.
- Exit `2` with a clear message if `.next/app-build-manifest.json` is missing.
- Exit `1` if `evaluateBudget` is not ok.

Create `scripts/bundle-budget.json` with the measured baseline:

```json
{
  "routes": {
    "/w/[slug]/[pageId]/page": {
      "baselineGzipBytes": 922531,
      "budgetGzipBytes": 930000
    }
  }
}
```

Add to `package.json` scripts:

```json
"check:bundle": "node scripts/bundle-budget.mjs"
```

In `.github/workflows/site.yml`, after the step that runs `npm run site:build`, add:

```yaml
      - name: Bundle budget
        run: npm run check:bundle
```

**Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/bundle-budget.test.mjs`

Expected: PASS.

**Step 5: Verify against the real build**

Run: `npm run build`

Run: `npm run check:bundle`

Expected: PASS with `gzip=922531` (allow ±1 kB for a clean rebuild), `budget=930000`. Record the exact number in the terminal output for the next task.

**Step 6: Commit**

Stage only `scripts/bundle-budget.mjs`, `scripts/bundle-budget.test.mjs`, `scripts/bundle-budget.json`, `package.json`, and `.github/workflows/site.yml`.

```bash
git add scripts/bundle-budget.mjs scripts/bundle-budget.test.mjs scripts/bundle-budget.json package.json .github/workflows/site.yml
git commit -m "build: add route bundle budget gate"
```

---

### Task 2: Split the editor and database surfaces at the route

**Files:**
- Modify: `src/app/w/[slug]/[pageId]/page.tsx`
- Create: `src/app/w/[slug]/[pageId]/page-route.lazy-surface.test.ts`
- Run existing: `src/app/w/[slug]/[pageId]/page-route.guest-scope.test.ts`, `page-route.test.ts`, `page.test.ts`

**Step 1: Write the failing test**

Create `src/app/w/[slug]/[pageId]/page-route.lazy-surface.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "src/app/w/[slug]/[pageId]/page.tsx",
  "utf8",
);

describe("page route surface split", () => {
  it("does not statically import the editor or the database view", () => {
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bPageEditor\b[^}]*\}\s*from\s*"@\/components\/editor\/page-editor"/,
    );
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bDatabaseView\b[^}]*\}\s*from\s*"@\/components\/database\/database-view"/,
    );
  });

  it("imports both surfaces with dynamic import calls", () => {
    expect(source).toMatch(/await import\("@\/components\/editor\/page-editor"\)/);
    expect(source).toMatch(/await import\("@\/components\/database\/database-view"\)/);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npx vitest run "src/app/w/[slug]/[pageId]/page-route.lazy-surface.test.ts"`

Expected: FAIL — both static imports are present.

**Step 3: Implement the split**

In `src/app/w/[slug]/[pageId]/page.tsx`:

- Remove the value imports of `PageEditor` and `DatabaseView`.
- Add `type ReactNode` to the React import.
- Build the surface before the return, in exactly one branch:

```tsx
let surface: ReactNode;
if (database) {
  const { DatabaseView } = await import("@/components/database/database-view");
  surface = (
    <DatabaseView
      /* existing database props, unchanged */
    />
  );
} else {
  const { PageEditor } = await import("@/components/editor/page-editor");
  surface = (
    <PageEditor
      /* existing editor props, unchanged */
    />
  );
}
```

- Replace the current `<PageEditor ... />` / `<DatabaseView ... />` JSX with `{surface}`.
- Keep the surrounding `PageTitle`, `CommentPanel`, `Backlinks`, and `VersionHistory` markup unchanged in this task.
- Do not move any data fetching, permission check, or prop construction into the dynamic import callback.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npx vitest run "src/app/w/[slug]/[pageId]/page-route.lazy-surface.test.ts" "src/app/w/[slug]/[pageId]/page-route.guest-scope.test.ts" "src/app/w/[slug]/[pageId]/page-route.test.ts" "src/app/w/[slug]/[pageId]/page.test.ts"
```

Expected: PASS. The guest-scope and payload assertions must be unchanged.

**Step 5: Measure and ratchet**

Run: `npm run build`

Run: `npm run check:bundle`

Record the new gzip total. Set `budgetGzipBytes` to that value rounded **up** to the nearest 5,000 bytes, but never above the previous budget. Do not lower it below the measured value.

Expected: lower than 922,531; if it is not, stop and report because the split did not produce a boundary.

**Step 6: Commit**

```bash
git add "src/app/w/[slug]/[pageId]/page.tsx" "src/app/w/[slug]/[pageId]/page-route.lazy-surface.test.ts" scripts/bundle-budget.json
git commit -m "perf: split editor and database route surfaces"
```

---

### Task 3: Defer below-fold comment and backlink panels

**Files:**
- Create: `src/lib/editor-events.ts`
- Create: `src/components/deferred-mount.tsx`
- Create: `src/components/deferred-comment-panel.tsx`
- Create: `src/components/deferred-backlinks.tsx`
- Create: `src/components/deferred-mount.test.ts`
- Modify: `src/components/comment-panel.tsx`
- Modify: `src/components/editor/bubble-toolbar.tsx`
- Modify: `src/components/editor/block-context-menu.tsx`
- Modify: `src/components/editor/block-context-menu.test.ts`
- Modify: `src/components/editor/bubble-toolbar.test.ts`
- Modify: `src/app/w/[slug]/[pageId]/page.tsx`

**Why the event extraction is part of this task:** `bubble-toolbar.tsx` and `block-context-menu.tsx` currently import `COMMENT_EVENT` from `comment-panel.tsx`. That static import pulls the whole comment panel into the editor chunk even after the route stops importing it. Move the constant and type to a light module first.

**Step 1: Write the failing test**

Create `src/components/deferred-mount.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const imported = vi.hoisted(() => ({ comment: false, backlinks: false }));

vi.mock("@/components/comment-panel", () => {
  imported.comment = true;
  return { CommentPanel: () => createElement("div", null, "comments") };
});

vi.mock("@/components/backlinks", () => {
  imported.backlinks = true;
  return { Backlinks: () => createElement("div", null, "backlinks") };
});

import { DeferredMount } from "@/components/deferred-mount";
import { DeferredCommentPanel } from "@/components/deferred-comment-panel";
import { DeferredBacklinks } from "@/components/deferred-backlinks";

describe("DeferredMount", () => {
  it("renders only the fallback during server rendering", () => {
    const html = renderToStaticMarkup(
      createElement(
        DeferredMount,
        { fallback: createElement("span", null, "waiting") },
        createElement("span", null, "content"),
      ),
    );

    expect(html).toContain("waiting");
    expect(html).not.toContain("content");
  });

  it("does not import the heavy panels when the wrappers are deferred", () => {
    renderToStaticMarkup(
      createElement(DeferredCommentPanel, {
        pageId: "page-1",
        comments: [],
        currentUserId: "user-1",
        canComment: true,
        locale: "en",
      }),
    );
    renderToStaticMarkup(
      createElement(DeferredBacklinks, {
        items: [],
        workspaceSlug: "demo",
        locale: "en",
      }),
    );

    expect(imported.comment).toBe(false);
    expect(imported.backlinks).toBe(false);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/deferred-mount.test.ts`

Expected: FAIL — `deferred-mount.tsx` does not exist.

**Step 3: Implement the event module**

Create `src/lib/editor-events.ts`:

```ts
export const COMMENT_EVENT = "noema:comment";
export const EQUATION_EVENT = "noema:equation";

export type EquationRequest = {
  kind: "inline" | "block";
  latex?: string;
  pos?: number | null;
};
```

Update `comment-panel.tsx`:

- Import `COMMENT_EVENT` from `@/lib/editor-events`.
- Replace the local `export const COMMENT_EVENT = ...` with `export { COMMENT_EVENT };` so old imports keep working.
- Do not import the panel from the light module.

Update `src/components/editor/equation-editor.tsx`:

- Import `EQUATION_EVENT` and `EquationRequest` from `@/lib/editor-events`.
- Replace the local declarations with `export { EQUATION_EVENT };` and `export type { EquationRequest };` so the old path stays compatible.

Update every internal consumer to import the constants from the light module:
`src/components/editor/page-editor.tsx`, `slash-menu.tsx`, `bubble-toolbar.tsx`, and `block-context-menu.tsx` use `EQUATION_EVENT` from `@/lib/editor-events`; `bubble-toolbar.tsx` and `block-context-menu.tsx` use `COMMENT_EVENT` from the same module.

Remove the corresponding `vi.mock("@/components/comment-panel", ...)` and `vi.mock("@/components/editor/equation-editor", ...)` lines from `block-context-menu.test.ts`, `bubble-toolbar.test.ts`, and any editor test that only needed an event constant. If a test genuinely renders the component, keep the component mock and narrow it.

**Step 4: Implement the deferred boundary**

`src/components/deferred-mount.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export function DeferredMount({
  children,
  fallback,
  minHeight = 240,
  rootMargin = "600px 0px",
}: {
  children: ReactNode;
  fallback: ReactNode;
  minHeight?: number;
  rootMargin?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || mounted) return;

    if (typeof IntersectionObserver === "undefined") {
      setMounted(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setMounted(true);
        observer.disconnect();
      },
      { rootMargin },
    );
    observer.observe(node);

    return () => observer.disconnect();
  }, [mounted, rootMargin]);

  return (
    <div ref={ref} style={mounted ? undefined : { minHeight }}>
      {mounted ? children : fallback}
    </div>
  );
}
```

`src/components/deferred-comment-panel.tsx`:

```tsx
"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { DeferredMount } from "@/components/deferred-mount";
import { Skeleton } from "@/components/ui/skeleton";

type CommentPanelProps = ComponentProps<
  typeof import("@/components/comment-panel").CommentPanel
>;

const CommentPanel = dynamic(
  () => import("@/components/comment-panel").then((mod) => ({ default: mod.CommentPanel })),
  {
    ssr: false,
    loading: () => (
      <div aria-busy="true" className="space-y-2 p-4">
        <Skeleton variant="block" className="h-5 w-32" />
        <Skeleton variant="block" className="h-16 w-full" />
      </div>
    ),
  },
);

export function DeferredCommentPanel(props: CommentPanelProps) {
  return (
    <DeferredMount
      minHeight={320}
      fallback={
        <div aria-hidden="true" className="space-y-2 p-4">
          <Skeleton variant="block" className="h-5 w-32" />
          <Skeleton variant="block" className="h-16 w-full" />
        </div>
      }
    >
      <CommentPanel {...props} />
    </DeferredMount>
  );
}
```

`src/components/deferred-backlinks.tsx` follows the same shape with `Backlinks`, `minHeight={200}`, and a two-line skeleton.

**Step 5: Use the deferred panels in the route**

In `src/app/w/[slug]/[pageId]/page.tsx`:

- Replace `import { CommentPanel, type CommentNode }` with a type-only import plus `DeferredCommentPanel`.
- Replace the `CommentPanel` JSX with `DeferredCommentPanel`.
- In the references/Suspense panel, replace `Backlinks` with `DeferredBacklinks`.
- Keep the `Suspense` and its fallback; the deferred boundary is inside it.

**Step 6: Run the tests to verify they pass**

```bash
npx vitest run src/components/deferred-mount.test.ts src/components/editor/block-context-menu.test.ts src/components/editor/bubble-toolbar.test.ts "src/app/w/[slug]/[pageId]/page-route.guest-scope.test.ts"
```

Expected: PASS. The comment/backlinks factories must remain unentered after the static imports are removed.

**Step 7: Measure and ratchet**

Run: `npm run build`

Run: `npm run check:bundle`

Expected: a further drop. Ratchet the budget as in Task 2.

**Step 8: Commit**

```bash
git add src/lib/editor-events.ts src/components/deferred-mount.tsx src/components/deferred-comment-panel.tsx src/components/deferred-backlinks.tsx src/components/deferred-mount.test.ts src/components/comment-panel.tsx src/components/editor/equation-editor.tsx src/components/editor/slash-menu.tsx src/components/editor/bubble-toolbar.tsx src/components/editor/block-context-menu.tsx src/components/editor/block-context-menu.test.ts src/components/editor/bubble-toolbar.test.ts "src/app/w/[slug]/[pageId]/page.tsx" scripts/bundle-budget.json
git commit -m "perf: defer below-fold page panels"
```

---

### Task 4: Split the version-history panel from its trigger

**Files:**
- Modify: `src/components/version-history.tsx`
- Create: `src/components/version-history-panel.tsx`
- Create: `src/components/version-history-panel.test.ts`

**Step 1: Write the failing test**

Create `src/components/version-history-panel.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VersionHistory } from "@/components/version-history";
import { VersionHistoryPanel } from "@/components/version-history-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/server/actions/page-versions", () => ({
  restorePageVersionAction: vi.fn(),
}));

const versions = [
  {
    id: "v1",
    title: "First draft",
    content: "Hello",
    summary: null,
    charDelta: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    author: { id: "user-1", name: "Ada", email: "ada@example.com" },
    label: null,
  },
];

const current = {
  title: "Current",
  updatedAt: "2026-10-22T10:00:00.000Z",
  content: "Hello",
};

describe("VersionHistory", () => {
  it("renders only the trigger while closed", () => {
    const html = renderToStaticMarkup(
      createElement(VersionHistory, {
        pageId: "page-1",
        locale: "en",
        current,
        versions,
      }),
    );

    expect(html).toContain("History");
    expect(html).not.toContain("version-history-panel");
  });

  it("renders the extracted panel directly", () => {
    const html = renderToStaticMarkup(
      createElement(VersionHistoryPanel, {
        pageId: "page-1",
        locale: "en",
        current,
        versions,
        onClose: vi.fn(),
        returnFocusRef: { current: null },
      }),
    );

    expect(html).toContain("First draft");
    expect(html).toContain('data-testid="version-history-panel"');
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/version-history-panel.test.ts`

Expected: FAIL — `version-history-panel.tsx` does not exist and the current closed component imports the heavy panel.

**Step 3: Extract the panel**

Move the current panel body, diff rendering, restore action, focus-trap logic, and panel state from `version-history.tsx` into `version-history-panel.tsx`.

- `version-history.tsx` keeps: `VersionRow`, `planVersionHistoryTab`, the trigger button, `open` state, and the invoker ref.
- `version-history.tsx` imports `VersionHistoryPanel` with `next/dynamic` and `ssr: false`.
- Render the dynamic panel only when `open` is true.
- Pass `returnFocusRef` so unmount restores focus to the trigger.
- Add `data-testid="version-history-panel"` to the panel root.
- Keep `planVersionHistoryTab` exported from `version-history.tsx` (the existing `overlay-wiring.test.ts` imports it from that path). If it moves, make the exported function a light re-export, not a value from the heavy panel.

Suggested dynamic boundary:

```tsx
const VersionHistoryPanel = dynamic(
  () => import("@/components/version-history-panel").then((mod) => ({
    default: mod.VersionHistoryPanel,
  })),
  { ssr: false },
);

{open && (
  <VersionHistoryPanel
    pageId={pageId}
    locale={locale}
    current={current}
    versions={versions}
    onClose={() => setOpen(false)}
    returnFocusRef={triggerRef}
  />
)}
```

**Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/components/version-history-panel.test.ts src/components/overlay-wiring.test.ts
```

Expected: PASS. The closed trigger markup has no panel; the direct panel render still shows the row and diff.

**Step 5: Measure and ratchet**

Run: `npm run build`

Run: `npm run check:bundle`

Expected: a further drop. Ratchet the budget.

**Step 6: Commit**

```bash
git add src/components/version-history.tsx src/components/version-history-panel.tsx src/components/version-history-panel.test.ts scripts/bundle-budget.json
git commit -m "perf: split version history panel from trigger"
```

---

### Task 5: Load page-title dialogs on first open

**Files:**
- Modify: `src/components/page-title.tsx`
- Create: `src/components/page-title.lazy-dialogs.test.ts`

**Step 1: Write the failing test**

Create `src/components/page-title.lazy-dialogs.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/page-title.tsx", "utf8");

describe("PageTitle dialog boundaries", () => {
  it("does not statically import dialogs", () => {
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bShareDialog\b[^}]*\}\s*from\s*"@\/components\/share-dialog"/,
    );
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bNotionImportDialog\b[^}]*\}\s*from\s*"@\/components\/notion-import-dialog"/,
    );
    expect(source).not.toMatch(
      /import\s*\{[^}]*\bWhoHasAccess\b[^}]*\}\s*from\s*"@\/components\/who-has-access"/,
    );
  });

  it("loads each dialog through next/dynamic", () => {
    expect(source).toMatch(/dynamic\(\(\)\s*=>\s*import\("@\/components\/share-dialog"\)/);
    expect(source).toMatch(/dynamic\(\(\)\s*=>\s*import\("@\/components\/notion-import-dialog"\)/);
    expect(source).toMatch(/dynamic\(\(\)\s*=>\s*import\("@\/components\/who-has-access"\)/);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/page-title.lazy-dialogs.test.ts`

Expected: FAIL — all three dialogs are static imports.

**Step 3: Implement the lazy dialogs**

In `src/components/page-title.tsx`:

- Remove the static imports of `ShareDialog`, `NotionImportDialog`, and `WhoHasAccess`.
- Add `import dynamic from "next/dynamic"`.
- Create the three dynamic components at module scope:

```tsx
const ShareDialog = dynamic(
  () => import("@/components/share-dialog").then((mod) => ({ default: mod.ShareDialog })),
  { ssr: false },
);
const NotionImportDialog = dynamic(
  () => import("@/components/notion-import-dialog").then((mod) => ({ default: mod.NotionImportDialog })),
  { ssr: false },
);
const WhoHasAccess = dynamic(
  () => import("@/components/who-has-access").then((mod) => ({ default: mod.WhoHasAccess })),
  { ssr: false },
);
```

- Add `shareLoaded` and `importLoaded` state.
- Set the flag before opening:

```tsx
onShare={() => { setShareLoaded(true); setShareOpen(true); }}
onImport={() => { setImportLoaded(true); setImportOpen(true); }}
onShareAccess={() => setAccessOpen(true)}
```

- Render the dialogs only after first use:

```tsx
{accessOpen && <WhoHasAccess ... />}
{shareLoaded && <ShareDialog open={shareOpen} ... />}
{importLoaded && <NotionImportDialog open={importOpen} ... />}
```

The first-open mount is intentional: it gives Radix a mounted dialog for close animation after the first open, while keeping the module out of the initial graph.

**Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/components/page-title.lazy-dialogs.test.ts src/components/page-title.test.ts
```

Expected: PASS.

**Step 5: Measure and ratchet**

Run: `npm run build`

Run: `npm run check:bundle`

Expected: a further drop. Ratchet the budget.

**Step 6: Commit**

```bash
git add src/components/page-title.tsx src/components/page-title.lazy-dialogs.test.ts scripts/bundle-budget.json
git commit -m "perf: load page-title dialogs on first open"
```

---

### Task 6: Load editor collaboration only when configured

**Files:**
- Create: `src/components/editor/collaboration-session.ts`
- Create: `src/components/editor/collaboration-session.test.ts`
- Modify: `src/components/editor/page-editor.tsx`

**Why:** `NEXT_PUBLIC_COLLAB_URL` is absent from `.env`; only `.env.example` documents it. Default builds still ship and load `yjs`, `y-websocket`, `@tiptap/extension-collaboration`, and `@tiptap/extension-collaboration-caret`. The loader must return `null` before importing any of them when the URL is empty.

**Step 1: Write the failing test**

Create `src/components/editor/collaboration-session.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  doc: 0,
  provider: 0,
  awareness: 0,
}));

vi.mock("yjs", () => ({
  Doc: class {
    constructor() { calls.doc += 1; }
  },
}));

vi.mock("y-websocket", () => ({
  WebsocketProvider: class {
    awareness = { setLocalStateField: () => { calls.awareness += 1; } };
    constructor() { calls.provider += 1; }
  },
}));

vi.mock("@tiptap/extension-collaboration", () => ({
  default: { configure: () => ({ name: "collaboration" }) },
}));

vi.mock("@tiptap/extension-collaboration-caret", () => ({
  default: { configure: () => ({ name: "collaborationCaret" }) },
}));

import { loadCollaborationSession } from "@/components/editor/collaboration-session";

describe("loadCollaborationSession", () => {
  beforeEach(() => {
    calls.doc = 0;
    calls.provider = 0;
    calls.awareness = 0;
  });

  it("does nothing when collaboration is off", async () => {
    const session = await loadCollaborationSession("", "page-1", {
      name: "Ada",
      color: "#3b82f6",
    });

    expect(session).toBeNull();
    expect(calls.doc).toBe(0);
    expect(calls.provider).toBe(0);
  });

  it("creates a provider and two extensions when configured", async () => {
    const session = await loadCollaborationSession("ws://collab.test", "page-1", {
      name: "Ada",
      color: "#3b82f6",
    });

    expect(session).not.toBeNull();
    expect(calls.doc).toBe(1);
    expect(calls.provider).toBe(1);
    expect(calls.awareness).toBe(1);
    expect(session?.extensions).toHaveLength(2);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/editor/collaboration-session.test.ts`

Expected: FAIL — module does not exist.

**Step 3: Implement the loader**

`src/components/editor/collaboration-session.ts`:

```ts
import type { Extension } from "@tiptap/core";

export type CollaborationSession = {
  ydoc: import("yjs").Doc;
  provider: import("y-websocket").WebsocketProvider;
  extensions: Extension[];
};

export function collaborationUrl(): string {
  return process.env.NEXT_PUBLIC_COLLAB_URL ?? "";
}

export async function loadCollaborationSession(
  url: string,
  pageId: string,
  user: { name: string; color: string },
): Promise<CollaborationSession | null> {
  if (!url) return null;

  const [
    { Doc },
    { WebsocketProvider },
    { default: Collaboration },
    { default: CollaborationCaret },
  ] = await Promise.all([
    import("yjs"),
    import("y-websocket"),
    import("@tiptap/extension-collaboration"),
    import("@tiptap/extension-collaboration-caret"),
  ]);

  const ydoc = new Doc();
  const provider = new WebsocketProvider(url, pageId, ydoc, { connect: false });
  provider.awareness.setLocalStateField("user", {
    name: user.name,
    color: user.color,
  });

  return {
    ydoc,
    provider,
    extensions: [
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({ provider, user }),
    ],
  };
}
```

**Step 4: Refactor `page-editor.tsx` into a wrapper and a body**

- Remove the static imports of `Y`, `WebsocketProvider`, `Collaboration`, and `CollaborationCaret`.
- Remove the `useMemo` that creates the session.
- Rename the current component body to `PageEditorBody` and add a `collab: CollaborationSession | null` prop.
- Keep the existing `PageEditor` name as the exported wrapper.

Wrapper shape:

```tsx
export type PageEditorProps = {
  pageId: string;
  workspaceId: string;
  workspaceSlug: string;
  breadcrumbTrail?: BreadcrumbCrumb[];
  initialContent: unknown;
  editorPlaceholder?: string;
  locale?: string;
  editable?: boolean;
};

export function PageEditor(props: PageEditorProps) {
  const url = collaborationUrl();
  if (!url) return <PageEditorBody {...props} collab={null} />;
  return <CollaborativePageEditor {...props} url={url} />;
}

function CollaborativePageEditor({ url, ...props }: PageEditorProps & { url: string }) {
  const [session, setSession] = useState<CollaborationSession | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setSession(null);
    loadCollaborationSession(url, props.pageId, {
      name: "You",
      color: presenceCursorColor(),
    })
      .then((next) => { if (!cancelled) setSession(next); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [attempt, props.pageId, url]);

  if (failed) {
    return (
      <div role="alert" className="m-6 rounded border border-border p-4">
        <p>{t(props.locale ?? "en", "somethingWentWrong")}</p>
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          {t(props.locale ?? "en", "retry")}
        </button>
      </div>
    );
  }

  if (!session) return <EditorSkeleton />;

  return <PageEditorBody {...props} collab={session} />;
}
```

- In `PageEditorBody`, remove the inline `Collaboration.configure(...)` / `CollaborationCaret.configure(...)` block from the TipTap extension list and replace it with `...(collab?.extensions ?? [])`.
- Keep `collab` available for the existing provider status/sync effects, the offline flush, the live roster, and the initial seed. Those effects still use `collab.provider` and `collab.ydoc`.
- Do not fall back to a local-only editor when a configured collaboration load fails. A silent local editor can diverge from peers; show the retry state instead.
- Keep `presenceCursorColor` and `restrictMathLatex` exports intact.

**Step 5: Run the tests to verify they pass**

```bash
npx vitest run src/components/editor/collaboration-session.test.ts src/components/editor/page-editor-engines.test.ts src/components/editor/page-editor-blockrefs.test.ts src/components/editor/page-editor-motion.test.ts
```

Expected: PASS. The empty-URL path must not touch the mocked `Doc` or `WebsocketProvider`.

**Step 6: Measure and ratchet**

Run: `npm run build`

Run: `npm run check:bundle`

Expected: the Yjs/WebSocket chunk is no longer in the editor route graph. Ratchet the budget. If the chunk is still present because another module imports it, fix that import before lowering the budget.

**Step 7: Commit**

```bash
git add src/components/editor/collaboration-session.ts src/components/editor/collaboration-session.test.ts src/components/editor/page-editor.tsx scripts/bundle-budget.json
git commit -m "perf: load editor collaboration only when configured"
```

---

### Task 7: Lazy-load database-only views and overlays

**Files:**
- Modify: `src/components/database/database-view.tsx`
- Modify: `src/components/database/view-renderers.tsx`
- Modify: `src/components/database/gallery-view.tsx`
- Create: `src/components/database/database-view.lazy.test.ts`

**Key detail:** `view-renderers.tsx` and `gallery-view.tsx` re-export `CalendarView` from `timeline-chart-views.tsx`. A static re-export pulls the 63 kB chart/timeline/calendar module into the table route. Remove both re-exports; no source file imports `CalendarView` from either path.

**Step 1: Write the failing test**

Create `src/components/database/database-view.lazy.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const view = readFileSync("src/components/database/database-view.tsx", "utf8");
const renderers = readFileSync("src/components/database/view-renderers.tsx", "utf8");
const gallery = readFileSync("src/components/database/gallery-view.tsx", "utf8");

describe("database lazy surfaces", () => {
  it("does not statically import chart, timeline, calendar, form, or property options", () => {
    expect(view).not.toMatch(/import\s*\{[^}]*\b(ChartView|TimelineView|CalendarView|FormView)\b[^}]*\}/);
    expect(view).not.toMatch(/import\s*\{[^}]*\bPropertyOptionsEditor\b[^}]*\}/);
  });

  it("does not re-export CalendarView from the eager renderer modules", () => {
    expect(renderers).not.toMatch(/export\s*\{\s*CalendarView\s*\}/);
    expect(gallery).not.toMatch(/export\s*\{\s*CalendarView\s*\}/);
  });

  it("loads the optional views with next/dynamic", () => {
    expect(view).toMatch(/dynamic\(\(\)\s*=>\s*import\("@\/components\/database\/timeline-chart-views"\)/);
    expect(view).toMatch(/dynamic\(\(\)\s*=>\s*import\("@\/components\/database\/form-view"\)/);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/database/database-view.lazy.test.ts`

Expected: FAIL — static imports and re-exports are present.

**Step 3: Remove the eager re-exports**

- Delete `export { CalendarView } from "./timeline-chart-views";` from `view-renderers.tsx`.
- Delete `export { CalendarView } from "./timeline-chart-views";` from `gallery-view.tsx`.
- Do not change `CalendarView`'s implementation or tests in `timeline-chart-views.test.ts`.

**Step 4: Add lazy boundaries in `database-view.tsx`**

- Remove the static `ChartView`, `TimelineView`, `CalendarView`, `FormView`, and `PropertyOptionsEditor` imports.
- Keep `TableView`, `ListView`, `BoardView`, `GalleryView`, and `DatabasePeek` eager. The common views are the default surface, and the peek module is also re-exported from `database-view.tsx` for existing tests; splitting it would require a second light-parts module for no meaningful win.
- Remove `CalendarView` and `FormView` from the `./view-renderers` import; keep the light helpers (`resolveTableRowHeight`, `skeletonCount`, types).
- Add:

```tsx
import dynamic from "next/dynamic";

const LazyCalendarView = dynamic(
  () => import("@/components/database/timeline-chart-views").then((mod) => ({ default: mod.CalendarView })),
  { ssr: false, loading: () => <ViewFallback /> },
);
const LazyTimelineView = dynamic(
  () => import("@/components/database/timeline-chart-views").then((mod) => ({ default: mod.TimelineView })),
  { ssr: false, loading: () => <ViewFallback /> },
);
const LazyChartView = dynamic(
  () => import("@/components/database/timeline-chart-views").then((mod) => ({ default: mod.ChartView })),
  { ssr: false, loading: () => <ViewFallback /> },
);
const LazyFormView = dynamic(
  () => import("@/components/database/form-view").then((mod) => ({ default: mod.FormView })),
  { ssr: false, loading: () => <ViewFallback /> },
);
const LazyPropertyOptionsEditor = dynamic(
  () => import("@/components/database/property-options-editor").then((mod) => ({ default: mod.PropertyOptionsEditor })),
  { ssr: false },
);
```

- Replace the conditional renderers with the lazy versions.
- Render `LazyPropertyOptionsEditor` only inside the existing options-editor branch.
- `ViewFallback` is a light inline skeleton using the existing `Skeleton` primitive; keep the same height as the view's existing loading state to avoid shift.

**Step 5: Run the tests to verify they pass**

```bash
npx vitest run src/components/database/database-view.lazy.test.ts src/components/database/database-view.dz01.test.ts src/components/database/database-view.test.ts src/components/database/database-view.dw07.test.ts src/components/database/database-view.fix04.test.ts src/components/database/timeline-chart-views.test.ts
```

Expected: PASS. Table view still renders synchronously; direct chart/calendar tests still pass; the lazy test proves the optional modules are no longer in the eager graph.

**Step 6: Measure and ratchet**

Run: `npm run build`

Run: `npm run check:bundle`

Expected: the database route drops the chart/timeline/form/property-editor code; the editor route should be unchanged. Ratchet the budget.

**Step 7: Commit**

```bash
git add src/components/database/database-view.tsx src/components/database/view-renderers.tsx src/components/database/gallery-view.tsx src/components/database/database-view.lazy.test.ts scripts/bundle-budget.json
git commit -m "perf: lazy-load optional database surfaces"
```

---

### Task 8: Split the editor tool surface and close the budget

**Files:**
- Modify: `src/components/editor/page-editor.tsx`
- Create: `src/components/editor/page-editor.lazy-tools.test.ts`
- Modify: `docs/FRONTEND_PLAN.md`
- Modify: `docs/PRODUCT_AUDIT_2026-10.md`
- Modify: `scripts/bundle-budget.json`

**Scope:** Move the editor's optional tool modules (`BubbleToolbar`, `SlashMenu`, `MentionMenu`, `EquationEditor`, `HistoryControls`, `SuggestionsControls`) behind `next/dynamic` with `ssr: false`. Leave `BlockContextMenu` eager because it wraps the editor content and provides the context-menu event boundary. `EQUATION_EVENT` already lives in the light `@/lib/editor-events` module from Task 3, so the dynamic EquationEditor no longer needs to be imported for its constant.

**Step 1: Write the failing test**

Create `src/components/editor/page-editor.lazy-tools.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/editor/page-editor.tsx", "utf8");

describe("editor tool boundaries", () => {
  it("does not statically import the optional tool modules", () => {
    for (const moduleName of [
      "bubble-toolbar",
      "slash-menu",
      "mention-menu",
      "equation-editor",
      "history-controls",
      "suggestions-controls",
    ]) {
      expect(source).not.toMatch(
        new RegExp(`import\\\\s*\\\\{[^}]*\\\\}\\\\s*from\\\\s*"@/components/editor/${moduleName}"`),
      );
    }
  });

  it("loads the tool modules through next/dynamic", () => {
    expect(source).toMatch(/dynamic\\(/);
    expect(source).toMatch(/import\\("@\\/components\\/editor\\/bubble-toolbar"\\)/);
    expect(source).toMatch(/import\\("@\\/components\\/editor\\/slash-menu"\\)/);
    expect(source).toMatch(/import\\("@\\/components\\/editor\\/equation-editor"\\)/);
  });
});
```

**Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/editor/page-editor.lazy-tools.test.ts`

Expected: FAIL — the modules are static imports.

**Step 3: Add the dynamic boundaries**

In `src/components/editor/page-editor.tsx`:

```tsx
const BubbleToolbar = dynamic(
  () => import("@/components/editor/bubble-toolbar").then((mod) => ({ default: mod.BubbleToolbar })),
  { ssr: false },
);
const SlashMenu = dynamic(
  () => import("@/components/editor/slash-menu").then((mod) => ({ default: mod.SlashMenu })),
  { ssr: false },
);
const MentionMenu = dynamic(
  () => import("@/components/editor/mention-menu").then((mod) => ({ default: mod.MentionMenu })),
  { ssr: false },
);
const EquationEditor = dynamic(
  () => import("@/components/editor/equation-editor").then((mod) => ({ default: mod.EquationEditor })),
  { ssr: false },
);
const HistoryControls = dynamic(
  () => import("@/components/editor/history-controls").then((mod) => ({ default: mod.HistoryControls })),
  { ssr: false },
);
const SuggestionsControls = dynamic(
  () => import("@/components/editor/suggestions-controls").then((mod) => ({ default: mod.SuggestionsControls })),
  { ssr: false },
);
```

- Keep the `EQUATION_EVENT` import from `@/lib/editor-events`.
- Remove the static imports replaced above.
- Do not add `loading` UI: these modules render null or small controls, and the editor content must not wait for them.
- Keep `BlockContextMenu` static and wrapping `EditorContent`.

**Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/components/editor/page-editor.lazy-tools.test.ts src/components/editor/bubble-toolbar.test.ts src/components/editor/slash-menu.test.ts src/components/editor/equation-editor.test.ts src/components/editor/page-editor-engines.test.ts
```

Expected: PASS.

**Step 5: Set the final budget**

Run: `npm run build`

Run: `npm run check:bundle`

- If gzip is ≤ 780,000, set `budgetGzipBytes` to 780000.
- If gzip is above 780,000, do not weaken the target silently. Inspect the top chunks, remove only a verified eager import, and re-run. If it remains above after the task, stop and report the top five chunks with the measured values. The measured KaTeX chunk (76.5 kB gzip) is the documented next follow-up, not a reason to accept a budget above target.

**Step 6: Update the docs**

In `docs/FRONTEND_PLAN.md`:

- Change §20.7 from `⬜` to `✅`.
- Keep §20.1 as `🟡` but append: `route split for /w/[slug]/[pageId] landed; hover prefetch remains`.
- Do not mark §20.7 done until the CI step from Task 1 is present and the final budget passes locally.

In `docs/PRODUCT_AUDIT_2026-10.md`, add a short subsection after the local production baseline:

```md
### Bundle budget (2026-10-22)

- Baseline: 922,531 bytes gzip across 35 route chunks (919 kB First Load JS).
- Final: <measured final> bytes gzip; CI gate `npm run check:bundle` enforces 780,000.
- The editor route no longer loads Yjs/WebSocket when `NEXT_PUBLIC_COLLAB_URL` is unset.
- Next measured follow-up: KaTeX (76.5 kB gzip) on pages without math; safe deferral needs editor schema reinitialisation.
```

Record the browser transfer separately when a seeded database is available. If the browser number is above 500 KB, list the top three network chunks in the audit rather than claiming the target was met.

**Step 7: Run the full verification**

```bash
npm run typecheck
npm run lint
npm run test
npm run check:client
npm run check:use-server
npm run check:coherence
npm run build
npm run check:bundle
```

Expected: all pass. Then run the browser checks with a seeded database on the production build:

- Editor page at 1440 and 390: transfer, TTFB, LCP, CLS; open comments, backlinks, version history, share, import, access; confirm focus returns to the trigger and Escape closes.
- Database page at 1440 and 390: table, list, board, gallery render immediately; switch to calendar/timeline/chart/form and confirm the skeleton is replaced without layout shift; open a row peek and property options.
- With `NEXT_PUBLIC_COLLAB_URL` unset: confirm no `yjs`/`y-websocket` chunk in the editor network panel.
- With `NEXT_PUBLIC_COLLAB_URL` set to the collab server: confirm a second browser session shows the caret and the editor recovers via Retry if the collab chunk is blocked.

**Step 8: Commit**

```bash
git add src/components/editor/page-editor.tsx src/components/editor/page-editor.lazy-tools.test.ts docs/FRONTEND_PLAN.md docs/PRODUCT_AUDIT_2026-10.md scripts/bundle-budget.json
git commit -m "perf: split editor tools and enforce bundle budget"
```

---

## Verification checklist

- [ ] `npm run build` succeeds with only the pre-existing lint warnings.
- [ ] `npm run check:bundle` passes at 780,000 bytes gzip.
- [ ] `/w/[slug]/[pageId]` no longer lists Yjs/WebSocket chunks when collaboration is unset.
- [ ] Editor and database pages each load only their own surface on first navigation.
- [ ] Comments, backlinks, version history, share, import, and access dialogs still open, close, and restore focus.
- [ ] Database table/list/board/gallery render synchronously; calendar/timeline/chart/form and property options lazy-load; row peek still opens.
- [ ] Guest scope, permission payloads, and route tests are unchanged.
- [ ] `docs/FRONTEND_PLAN.md` §20.7 is ✅ and §20.1 records what remains.
- [ ] `docs/PRODUCT_AUDIT_2026-10.md` records baseline, final, and the KaTeX follow-up.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-22-bundle-optimization.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute in this session using `superpowers:executing-plans`, with checkpoints for review.

Which approach?
