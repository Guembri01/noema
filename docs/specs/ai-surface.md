# Spec — AI surface parity (chat, skills, autofill, transcription)

> **Status: spec complete, implementation pending.** Document-only: no
> production code changed. Every claim about the current
> code cites file + line. Requirement IDs (`R25.x`) are the traceability anchors:
> §11 lists tasks 1:1 against them, tests must cite the IDs they cover, and §13
> maps them to the `docs/FEATURE_MATRIX.md` §14 rows this spec exists to close.

---

## 1. Problem statement

Noema already ships a working AI surface family: a docked chat panel with a
streaming answer path, seven editor skills, an Ask AI block, per-workspace
provider configuration with an encrypted key, an ask/summarize/autofill proxy,
and speech-to-text. But the surface is uneven in ways a Notion user notices
immediately:

- **only the chat panel streams.** The editor skills, the Ask AI block and the
  database autofill all block on a single-shot `chatComplete` while the answer
  is generated — a spinner where Notion shows text arriving;
- **the model is a server-side secret of the settings screen.** It appears in
  the chat composer as a read-only chip; no member can see or choose a model;
- **AI in databases is one button per cell** with no prompt configuration UI,
  no bulk fill, and no handling of typed (select/status/number) cells;
- **there is no cost story at all** — no token capture, no budget, no usage
  dashboard, so one runaway autofill loop can burn a provider key unobserved;
- **failure paths lose user input** — a dropped network while sending a chat
  message discards the draft, and regeneration deletes the previous answer
  *before* the replacement exists.

This spec fixes those gaps incrementally on top of the existing foundation
(single provider client, one prompt/runtime module, one skill registry), and
defines the requirements (`R25.x`) that close the §14 matrix rows honestly.

## 2. Current state audit (evidence)

### 2.1 Surface map

| Surface | Evidence | State |
| --- | --- | --- |
| Docked chat panel | `src/components/chat-panel.tsx:92-95` (dock description), `:96-538` component, composer `:498-535`, streaming bubble `:470-485`, optimistic bubble `:463-469` | Works; **no Stop control, no `AbortController` anywhere in `src/` AI code** (only hit: `src/app/api/link-preview/route.ts:44`) |
| Chat send path | `chat-panel.tsx:155-227` — `setDraft("")` at `:159`, optimistic append `:160`, `POST /api/chat/stream` `:188-192`, reader loop `:207-215`, `[stream-error]` string sniff `:216-218`, catch `:221-225` | Draft was restored **only** in the create-thread bail path; a stream failure toasts and refreshes but the draft is gone. **Fixed (B58, R25.17):** the draft is restored on every failure that happened *before* the route answered 200 (transport death, rejected single-shot fallback), never after (a 200 means the route persisted the question); quick-prompt sends no longer touch a draft being typed |
| Non-streaming fallback | `chat-panel.tsx:194-204` → `postChatMessageAction` (`src/server/actions/chat.ts:108-159`) | Fires when the response is not OK (AI off, 4xx/5xx) |
| Answer persistence | `src/app/api/chat/stream/route.ts:56-67` (user message first), `:100-119` (assistant message + `meta.model/provider` after stream) | Deliberate: no half-written row on drop (`:16-18`) |
| Regenerate | `src/server/actions/chat.ts:283-318` — **deletes the last answer at `:309`, then** re-answers `:311-315`, non-streaming | If the re-answer fails the thread has lost its answer; no streaming, no diff. **Fixed (B58, R25.4):** the replacement is persisted first and the old answer deleted only after success (idempotent `deleteMany`); still non-streaming |
| Shared runtime | `src/lib/chat-runtime.ts:10-17` system prompt, `buildChatRequest :27-43` → `gatherChatIntel` (`src/lib/chat-context.ts:1-31`, deterministic keyword `INTENT_RULES :28+`) | Used by both transports (contract note `chat-runtime.ts:1-5`) |
| Chat transports | `src/app/api/chat/route.ts:16-72` (GET threads, POST create/post/rename/delete), server actions in `chat.ts` | Server actions carry **no rate limit**; routes do |
| Streaming transport impl | `src/lib/ai-provider.ts:128-185` `chatCompleteStream` (`stream: true` `:152`, 60 s timeout `:155`, SSE parse `:169-183`) | The frame parser that every future stream should reuse |
| Ask / summarize / autofill proxy | `src/app/api/ai/route.ts:17-89` — rate 30/min `:18`, mode select `:30-35`, caps (prompt 4000 `:36`, context 8000 `:37`), grounding `:50-61`, autofill `temperature 0.1` + `maxTokens 60` `:80-81`, `503 AI_NOT_CONFIGURED` `:70-73` | **Single-shot** (`chatComplete` `:75-84`) |
| Skills | `src/lib/ai-skills.ts:8-15` 7 ids, `:26-83` prompts, `replacesSelection` flag `:23`; route `src/app/api/ai/skills/route.ts:19-61` (30/min `:20`, text cap 8000 `:36`, transform-only system prompt `:9-10`) | **Single-shot**; `translate` hardcodes English (`ai-skills.ts:76-82`) |
| Skills UI | selection bubble `src/components/editor/bubble-toolbar.tsx:284,301`, block menu `src/components/editor/block-context-menu.tsx:428-431`, client helper `src/lib/ai-client.ts:38-70` (`runAiSkill`) | `runAiText` (`ai-client.ts:11-30`) posts **without `workspaceId`** → resolves env config only (`ai-provider.ts:50-72`) |
| Ask AI block | `src/components/editor/extensions/ask-ai.tsx:25-65` node, `ask :78-102`, `summarize :104-127`, `insertAnswer :129-141`; slash entry `src/components/editor/slash-menu.tsx:77`; registered `page-editor.tsx:252` | **Single-shot**; matrix row "AI block 🧭" is stale against this code |
| Autofill in database cells | cell button `src/components/database/view-parts.tsx:713-724` (`AI_AUTOFILL`), runner `src/components/database/database-view.tsx:263-299` (row context JSON `:265-272`, `mode:"autofill"` `:279`, per-property `config.prompt` `:282-283`, write-back `:292`), enum `prisma/schema.prisma:54` | Per-cell, text-only write (`{ text: … }`); matrix row "AI autofill property 🧭" is stale |
| Transcription | `src/app/api/ai/transcribe/route.ts:13-63` — env-only provider `AI_TRANSCRIBE_*` `:7-10` (deliberate separation comment `:20-21`), 10/min `:14`, 120 s timeout `:46`; UI `src/components/sidebar/importers.tsx:136-166` → transcript page via `importMarkdownAction`, button `:264-268` | Working but config is **not workspace-scoped** |
| Provider settings (admin) | `src/components/ai-settings.tsx:24+` mounted at `src/app/w/[slug]/settings/page.tsx:274`; actions `src/server/actions/ai-settings.ts` — admin gate `:34-41`, summary `:44-91`, save `:94-156` (**key required to enable** `:126-128`, model required `:129-131`), clear `:159-165`, live model list + catalog fallback `:172-212`, connection test `:219-265` | The ✅ "AI connectors config" row |
| Provider resolution & transport | `src/lib/ai-provider.ts:32-43` env fallback, `resolveAiConfig :50-72` (workspace → env), `chatComplete :75-125` (30 s), `listProviderModels :188-212`; catalog `src/lib/ai-providers.ts:14-45`, `normalizeBaseUrl :88-92` | No usage/token handling in either transport |
| Secrets envelope | `src/lib/secrets.ts:4` (AES-256-GCM), `encryptSecret :21-27`, `decryptSecret :29-44` (versioned `v:iv:tag:payload`), `maskSecret :46-51` | Keys are encrypted at rest and never returned |
| Persistence | `prisma/schema.prisma:544-557` `AiProviderConfig`, `:796-811` `ChatThread`, `:813-826` `ChatMessage` (`meta Json` — carries `model`/`provider`) | **No usage/budget/prompt-library tables** |
| Rate limits | `rateLimit()` per route: `/api/ai` 30/min (`route.ts:18`), `/api/ai/skills` 30/min (`skills/route.ts:20`), `/api/chat/stream` 20/min (`stream/route.ts:23`), `/api/ai/transcribe` 10/min (`transcribe/route.ts:14`), chat read/write 120/60 (`chat/route.ts:17,34`) | Chat server actions (`chat.ts`) are unlimited |
| Model visibility | composer chip `chat-panel.tsx:517-519` + streaming header `:474` from `modelLabel` (`workspace-shell.tsx:151`, resolved in `src/app/w/[slug]/layout.tsx:61`) | Read-only; members cannot list or pick models (`listAiModelsAction` is admin-gated `ai-settings.ts:178-179`) |
| Evidence harness | `scripts/check-ai.mjs` (ask/grounded/summarize/autofill + all skills + transcribe), `scripts/check-chat-stream.mjs` (stream + single persistence), `scripts/check-ai-providers.mjs` (two providers + transcription) | Live-provider checks; e2e touches AI at `e2e/noema.spec.ts:79` (Ask AI) and `:242` (send message) |

### 2.2 What the product class (Notion) does

1. **Everything streams** — Q&A, autofill previews and block AI emit tokens as
   they are produced, with a Stop control on every long operation.
2. **Model choice is a first-class control** next to the composer, showing what
   will answer and letting members switch within the workspace's plan.
3. **AI in databases**: property-level prompt configuration, "autofill column",
   and typed-value parsing — AI is a column behavior, not a per-cell button.
4. **Usage visibility**: admins see spend/tokens; workspaces have guardrails.
5. **Graceful degradation**: unconfigured/offline states explain themselves and
   never eat what the user typed.

### 2.3 Gap register (section-14 rows → gaps)

| Gap | Rows (`FEATURE_MATRIX.md:529-544`) | Evidence of the gap |
| --- | --- | --- |
| **G1 streaming parity** | AI writing assist 🟡, Summarization 🧭, Continue writing 🧭, Explain/Simplify 🧭 | Only `chatCompleteStream` (`ai-provider.ts:128`) has a stream consumer (`stream/route.ts:80`); `/api/ai` `:75-84` and `/api/ai/skills` `:44-51` are single-shot |
| **G2 regenerate/stop UX** | AI writing assist 🟡 | `chat.ts:309` deletes before re-answering; no Stop anywhere (`AbortController` absent from AI code) |
| **G3 model picker** | AI connectors config ✅ (basis), Local model support 🧭, AI writing assist 🟡 | Static chip `chat-panel.tsx:517-519`; picker + model list are admin-only (`ai-settings.ts:178-179`) |
| **G4 AI in database cells** | AI autofill property 🧭 (glyph stale — code exists), AI block 🧭 (glyph stale — block exists) | Per-cell button only (`view-parts.tsx:713-724`); no prompt editor UI for `config.prompt` (read at `database-view.tsx:264,282`); text-only write-back `:292`; `maxTokens: 60` (`/api/ai` `:81`) |
| **G5 cost/token controls** | AI cost controls 🧭 | Zero token capture: no `usage`/`prompt_tokens` handling in `ai-provider.ts`, no `AiUsage`/`AiBudget` models in `prisma/schema.prisma` |
| **G6 offline fallback** | AI writing assist 🟡, Q&A over workspace ✅ (degrades with it) | Draft lost on send failure (`chat-panel.tsx:159` vs restore only at `:166-171`); unconfigured state is a toast string (`AI_NOT_CONFIGURED`, `ai-provider.ts:15-16`), not a surfaced disabled state |
| **G7 content-skill parity** | Translation 🧭, Explain/Simplify 🧭, Summarization 🧭, Continue writing 🧭 | `translate` hardcodes English (`ai-skills.ts:76-82`); registry has `explain` but no `simplify`/`continue` (`ai-skills.ts:8-15`) |
| **G8 prompt library** | Prompt library 🟡 (built-ins only) | Registry is code (`ai-skills.ts:26-83`); no user-defined prompt model |
| **G9 local model support** | Local model support 🧭 | `saveAiProviderAction` requires a key to enable (`ai-settings.ts:126-128`) → keyless Ollama/vLLM cannot be enabled; catalog already lists those endpoints (`ai-providers.ts:12-15`) |
| **G10 data boundaries** | AI data boundaries 🧭 | No written policy anywhere in `docs/`; no explicit no-logging rule for prompts |
| **G11 transcription config** | Transcription 🟡 | Env-only provider (`transcribe/route.ts:7-10`), workspace settings can't configure it; no upload size cap (route accepts any `File`, `:31-35`) |

## 3. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | **One transport choke point.** Every model call — chat, stream, ask, skills, autofill, test — goes through `src/lib/ai-provider.ts` (`chatComplete`/`chatCompleteStream`), extended with usage capture + budget guard. | Routes and actions already import it (`/api/ai:6`, `skills:5`, `stream:6`, `chat.ts:11`, `ai-settings.ts:9`); enforcement there cannot be bypassed by a new route forgetting it. |
| D2 | **Streaming protocol = SSE frames over `fetch` POST** (`text/event-stream`, events `delta` / `error` / `done` / `usage`), parsed by the same line parser shape as `ai-provider.ts:169-183`. Replaces today's `text/plain` + in-band `[stream-error]` sniffing (`stream/route.ts:96`, `chat-panel.tsx:216-218`). | Structured errors and usage need frames; POST body is required for chat payloads so `EventSource` is not usable anyway. |
| D3 | **Model resolution order: request override (per-thread) → workspace config → env**, all inside `resolveAiConfig`. | Matches the existing chain (`ai-provider.ts:50-72`) with one added, testable precedence step. |
| D4 | **Budget enforcement server-side before dispatch** (over-budget ⇒ `503 AI_BUDGET_EXCEEDED`), warn state surfaced in settings. | Client-side gating is advisory only; every surface already handles a 503 from `resolveAiConfig` (`/api/ai:70-73`, `stream:50-53`, `skills:39-42`). |
| D5 | **e2e/CI uses a mock OpenAI-compatible provider** (deterministic deltas + usage frames on a local port); live-provider verification stays in `scripts/check-ai*.mjs`. | Keeps the suite free, deterministic and off the rate limits; the check scripts remain the live proof. |

## 4. Requirements (numbered, testable, with acceptance)

### A — Answer-path parity: streaming, stop, regenerate, errors (M1)

- **R25.1 — Shared streaming contract.** All answer routes speak the D2 frame
  protocol: `delta` (text chunk), `error` (structured `{code, message}`),
  `done` (final answer), `usage` (tokens). The chat panel stops string-sniffing
  `[stream-error]`.
  *Acceptance:* red-first unit for the frame parser (all four events, partial
  frames, unknown events ignored, malformed JSON → `error` frame);
  `scripts/check-chat-stream.mjs` stays green; `grep -r "stream-error" src/`
  returns nothing.
- **R25.2 — Streaming parity for the selection surfaces.** `POST /api/ai/skills`
  and `POST /api/ai` (`ask` + `summarize` modes) stream token-by-token through
  `chatCompleteStream`; the editor skills apply progressively into a pending
  overlay, the Ask AI block fills progressively. `autofill` stays single-shot
  (`maxTokens: 60` — streaming buys nothing), which is an explicit non-goal.
  *Acceptance:* integration test against the mock provider with 50 ms-delta
  delays asserts the first byte arrives before the last (red: current
  single-shot fails); existing e2e `noema.spec.ts:79` stays green.
- **R25.3 — Stop control.** While any answer streams, the consumer shows Stop
  (chat composer, skills overlay, Ask AI block): chat aborts the fetch,
  persists the partial text as the assistant message with
  `meta.stopped: true`; skills/Ask AI abort and leave the selection/block
  unchanged.
  *Acceptance:* red-first unit on the partial-answer persist decision
  (empty partial ⇒ no row, non-empty ⇒ row + `stopped` meta); e2e clicks Stop
  mid-stream and asserts a `ChatMessage` with `meta.stopped` exists.
- **R25.4 — Lossless regenerate.** `regenerateChatAnswerAction` streams the
  replacement and deletes the previous answer **only after** the new answer is
  fully persisted; a failed or aborted regenerate leaves the old answer intact;
  two rapid regenerate clicks are idempotent (second is a no-op with a toast).
  *Acceptance:* red-first unit proving the delete-after-success ordering (today
  `chat.ts:309` fails it) + failure path restores/keeps the old row; e2e:
  kill the provider mid-regenerate → previous answer still present.
  *Status:* ordering + failure-keeps-old shipped by B58
  (`src/server/actions/chat.test.ts`, delete-after-success with a mocked
  provider); provider-kill e2e and the rapid-double-click guard still owed.
- **R25.5 — Error taxonomy.** Every AI surface classifies failures into
  `{network, auth, forbidden, rateLimited, notConfigured, budget, provider,
  aborted}` with distinct localized messages + a Retry affordance for
  retryable classes; `429` responses surface the retry-after hint from
  `rateLimit` (`src/lib/api-guard.ts`).
  *Acceptance:* red-first unit mapping HTTP status/throw → class (table-driven);
  e2e with mock provider returning 503 shows the localized "not configured"
  message and Retry, not a generic toast.

### B — Model & provider control (M2)

- **R25.6 — In-chat model picker.** The composer chip (`chat-panel.tsx:517-519`)
  becomes a picker listing the workspace's available models (new read-only
  `getModelSummary(workspaceId)` action, permitted for any member). Selecting a
  model persists `ChatThread.modelOverride`; `resolveAiConfig(workspaceId,
  { modelOverride })` honors it (D3), and the answer's `meta.model` shows the
  model actually used (`stream/route.ts:113`).
  *Acceptance:* red-first unit for the precedence chain
  (override → workspace → env → none); e2e picks a model → next assistant
  message has that `meta.model`; leaving the picker on default keeps
  `modelOverride = null`.
- **R25.7 — No secret exposure.** Member-readable AI info returns only
  `{providerLabel, models[], model, source, enabled}` — never `apiKey`, never
  `keyMask` (admin-only, as today `ai-settings.ts:78`), never decrypted
  material.
  *Acceptance:* unit asserts the response shape has no key fields; e2e as a
  member (non-admin) opens the picker and sees models, not key state.
- **R25.8 — Keyless local models.** `saveAiProviderAction` allows enabling
  `provider = "custom"` **without** an API key when `baseUrl` host is
  loopback/private (`localhost`, `127.0.0.1`, `*.local`, RFC1918) — the Ollama/
  vLLM story in `ai-providers.ts:12-15`; public custom endpoints still require
  a key; `testAiProviderAction` succeeds keyless for local endpoints.
  *Acceptance:* red-first validation-matrix unit
  (openai+no key ⇒ error, custom+public+no key ⇒ error, custom+local+no key ⇒
  ok, custom+non-http URL ⇒ error) — today the first/third cases fail at
  `ai-settings.ts:126-128`.

### C — AI in database cells (M2)

> Ownership note: `src/components/database/**` is covered by the B15/B17 feature
> work; these requirements are implemented alongside that area, and only the
> server-side pieces (`/api/ai`, actions) are free-standing.

- **R25.9 — Autofill property prompt UI.** The property editor for
  `AI_AUTOFILL` edits `config.prompt` (currently only *read*:
  `database-view.tsx:264,282`), validates length (≤ 500 chars), offers the
  current default as placeholder, and shows the last error inline.
  *Acceptance:* e2e sets a custom prompt → runs Autofill → cell value reflects
  it; red-first unit on default-prompt construction (keeps today's wording at
  `database-view.tsx:281-283`).
- **R25.10 — Typed cell values.** Autofill parses model output for
  `select`/`multi_select`/`status`/`number`/`date` cells (option names matched
  case-insensitively against existing options, numbers normalized to the
  property format), with **one** repair retry; on failure the cell is left
  untouched and the toast explains why (today only `{ text }` is ever written —
  `database-view.tsx:292`).
  *Acceptance:* red-first parser unit per type (valid, near-miss case,
  garbage → null); e2e autofills a `select` cell from an existing option.
- **R25.11 — Fill-the-column.** "Fill empty cells" on a column runs autofill
  for at most **20** empty cells per invocation with progress + cancel,
  **never** overwriting a non-empty cell; every result stays user-editable.
  *Acceptance:* red-first unit for cell selection + cap; e2e bulk-fill leaves
  populated cells byte-identical and fills ≤ cap empties; a cancel stops the
  remaining requests.

### D — Cost/token controls & data boundaries (M2)

- **R25.12 — Usage capture.** Every model call records an `AiUsage` row
  `{workspaceId, userId?, surface, provider, model, promptTokens,
  completionTokens, status, durationMs, createdAt}` from inside the D1
  transport: non-stream responses via `usage`, streams via the final
  `usage` frame (request sent with `stream_options: { include_usage: true }`),
  transcription via input characters (tokens unavailable). Failed calls are
  recorded with `status` and zero tokens.
  *Acceptance:* red-first unit extracting usage from SSE (with and without the
  final frame) and from JSON; integration: one `ask` through the mock provider
  → exactly one `AiUsage` row with non-zero completion tokens.
- **R25.13 — Workspace token budget.** Optional `AiBudget`
  `{workspaceId, monthlyTokenLimit, warnPercent default 80}`: the transport
  refuses to dispatch over the limit (`503 AI_BUDGET_EXCEEDED`), settings warn
  at `warnPercent`, admins can raise/soft-disable it. Window = calendar month,
  UTC.
  *Acceptance:* red-first budget math unit (partial month, rollover, exactly-at-
  limit, warn threshold) + transport guard unit (over limit ⇒ no fetch issued);
  e2e over-budget → the chat composer shows the localized budget message and
  history still renders.
- **R25.14 — Usage dashboard.** Settings → AI (admin) shows this month's
  tokens and call counts grouped by surface + the budget control.
  *Acceptance:* e2e: after one mock answer, dashboard numbers equal a direct
  count of `AiUsage` rows; numbers are locale-formatted via `t()`.
- **R25.15 — Data boundaries, written.** `docs/AI-BOUNDARIES.md` states:
  workspace content is never used for provider training (BYO-key model: the
  provider processes only what the routes send), keys are AES-256-GCM at rest
  (`src/lib/secrets.ts:21-44`) and never returned to clients, prompts and
  completions are **not** written to application logs, transcription audio is
  processed and discarded (only the transcript page persists), and which
  fields each surface sends (context caps from §2.1).
  *Acceptance:* doc exists and is linked from README; a grep gate proves no
  `console.log`/`logger` in `src/` prints `prompt`, `body` or `answer` payloads
  from AI code paths.

### E — Availability & offline fallback (M1)

- **R25.16 — One AI client transport.** `src/lib/ai-client.ts` grows a shared
  `aiFetch` + `aiStream` used by chat, skills, Ask AI block and autofill, all
  returning the R25.5 classes; `runAiText` gains the missing `workspaceId`
  argument (today it omits it, `ai-client.ts:11-30`, so it silently uses env
  config even when the workspace has its own).
  *Acceptance:* red-first classification unit (fetch throw, 401, 403, 429, 503,
  `{error, code}` body); grep shows no bare `fetch("/api/ai` call sites outside
  `ai-client.ts` and the streaming helper.
- **R25.17 — Never eat the draft.** On any send failure (network drop, 403,
  503, budget, abort), the chat composer's draft is restored and the optimistic
  bubble is removed — the exact text the user typed comes back.
  *Acceptance:* red-first unit on the send-state reducer (fail → draft restored,
  success → draft cleared); e2e: block the route / go offline mid-send →
  composer contains the original text, no orphan optimistic bubble.
  *Status:* draft restore + no-orphan-bubble shipped by B58 with failing-first
  targeted e2e (`e2e/ai-quickwins.spec.ts` — route abort and rejected 503);
  the standalone send-state reducer unit is still open.
- **R25.18 — Honest degraded states.** With no provider configured, the
  composer, skills submenu and Ask AI block render a disabled state carrying
  the `AI_NOT_CONFIGURED` reason (`ai-provider.ts:15-16`) instead of
  failing on click; with `navigator.onLine === false` the surfaces show
  "You're offline — AI will be back when you reconnect" immediately (no
  spinner hang) and queue nothing.
  *Acceptance:* unit derives the degraded state from `{online, config}`; e2e
  with env key removed and workspace unconfigured shows the reason text on the
  composer, and an offline emulation shows the offline text.

### F — Content-skill parity (M3)

- **R25.19 — Translate to shipped locales.** The translate skill takes a
  target parameter over the five shipped locales (`en, fr, de, es, ar`,
  `src/lib/i18n.ts`), defaulting to `en` (today hardcoded, `ai-skills.ts:76-82`),
  surfaced in the selection skills submenu and in B11's Actions → Translate
  submenu (coordinate: B11 owns the Actions menu).
  *Acceptance:* red-first prompt-builder unit asserts the target appears in the
  prompt for each locale; e2e translates a selection to French and asserts the
  locale word appears in the result.
- **R25.20 — Explain/Simplify + Continue writing.** Registry gains `simplify`
  (rewrite simpler, `replacesSelection: true`) and a `continue` mode that
  streams the continuation of the current selection/context (appends,
  `replacesSelection: false`); `explain` stays. Slash menu and skills submenu
  gain the entries (i18n via `t()`, no ratchet raise).
  *Acceptance:* red-first registry unit (ids, flags, prompts embed the text);
  e2e "Continue writing" appends streamed text to the block.
- **R25.21 — Summarization everywhere it is promised.** `summarize` streams
  (R25.2) and is reachable from the selection menu as well as the existing
  Ask AI block (`ask-ai.tsx:176`) and chat quick-prompts
  (`chat-panel.tsx:71-76`).
  *Acceptance:* skills submenu shows Summarize on a selection; result streams
  and, for `replacesSelection: false`, appends below the selection.

### G — Prompt library & transcription (M3)

- **R25.22 — User prompt library.** New `WorkspacePrompt`
  `{id, workspaceId, title, prompt, createdById, shared, createdAt}` with
  create/update/delete actions (workspace-membership authorized, title/prompt
  length caps), a picker in the chat composer (inserts the prompt text into the
  draft) and a manage list in settings; built-in skills stay code-owned
  (`ai-skills.ts`) and are not editable.
  *Acceptance:* red-first authz unit (cross-workspace read/write denied,
  guest denied); e2e save a prompt → it appears in the composer picker →
  inserting it fills the draft.
- **R25.23 — Transcription workspace config.** Workspace-level transcription
  settings (base URL / model / key via the same `secrets.ts` envelope) with the
  existing `AI_TRANSCRIBE_*` env vars as fallback (deliberate separation from
  chat keys preserved, `transcribe/route.ts:20-21`), a **25 MB** upload cap
  with a clear error, and failure messages that name the setting to fix.
  *Acceptance:* red-first resolution-order unit (workspace → env → not
  configured); route rejects > 25 MB with 413-shaped error; unconfigured
  message references workspace settings.

### Non-goals (this spec)

Multi-provider failover/routing, embedding/vector RAG (retrieval stays lexical —
`src/lib/retrieval.ts` via `searchPagesForPrompt`, `src/server/queries.ts:5`),
image/audio generation, MCP or marketplace connectors (section 13 / B24),
per-seat pricing (B26), mobile offline AI, and editing the built-in skill
wording beyond the parity gaps above.

## 5. Data model

```prisma
model AiUsage {
  id               String   @id @default(cuid())
  workspaceId      String
  userId           String?
  surface          String   // chat | chat-stream | ask | summarize | skill | autofill | transcribe | test
  provider         String
  model            String
  promptTokens     Int      @default(0)
  completionTokens Int      @default(0)
  status           String   @default("ok") // ok | error | refused | aborted
  durationMs       Int?
  createdAt        DateTime @default(now())
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@index([workspaceId, createdAt])
}

model AiBudget {
  workspaceId      String @id
  monthlyTokenLimit Int
  warnPercent      Int    @default(80)
  updatedById      String?
  updatedAt        DateTime @updatedAt
}

model WorkspacePrompt {
  id          String   @id @default(cuid())
  workspaceId String
  title       String
  prompt      String
  createdById String
  shared      Boolean  @default(true)
  createdAt   DateTime @default(now())
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  @@index([workspaceId])
}
```

- `ChatThread` gains `modelOverride String?` (R25.6) — additive, no backfill.
- `AiProviderConfig` (`schema.prisma:544-557`) unchanged; keyless local
  providers are represented by `apiKeyEncrypted = null` + `provider = "custom"`
  (today impossible via the action, R25.8).
- `ChatMessage.meta` (`schema.prisma:819`) keeps `model`/`provider` and grows
  `stopped?: boolean` (R25.3) — additive JSON, no migration.

## 6. Transport & contracts

- **Stream frames** (`text/event-stream`, D2): `data: {"t":"delta","v":"…"}`,
  `{"t":"error","code":"provider","message":"…"}`, `{"t":"done"}`,
  `{"t":"usage","prompt":n,"completion":n}`. Server sets
  `cache-control: no-store`, `x-accel-buffering: no` (as today,
  `stream/route.ts:126-128`).
- **Route error shape** (all AI routes): `4xx/5xx` JSON
  `{ error: string, code?: R25.5-class }` so `aiClient` classifies without
  string matching. `AI_NOT_CONFIGURED` (`ai-provider.ts:15-16`) and the new
  `AI_BUDGET_EXCEEDED` carry codes.
- **`resolveAiConfig(workspaceId, opts?: { modelOverride?: string | null })`**
  (D3) — callers pass the thread override; the transport (D1) appends
  `stream_options.include_usage` when streaming and checks the budget (D4).
- **Model summary endpoint**: `getModelSummary(workspaceId)` server action →
  `{providerLabel, model, models[], source, enabled}` (R25.7), model list from
  the existing catalog/live merge (`ai-settings.ts:172-212`, admin live call
  falls back to the curated catalog for members).
- **Rate limits**: unchanged per route (§2.1); the new bulk autofill (R25.11)
  gets its own 5/min budget and reuses the `ai` scope internally.

## 7. UI spec

- **Model picker**: chip in the composer footer (replaces the read-only badge
  at `chat-panel.tsx:517-519`) — dropdown lists `models[]` with the effective
  one check-marked + a "Default (workspace)" first entry; `aria-label="Answer
  model"`; keyboard navigable; small `·` marker when the thread has an
  override.
- **Stop**: while streaming, the Send button becomes Stop (same position,
  `aria-label="Stop generating"`), keeping layout stable; partial answer keeps
  a small `stopped` footnote chip.
- **Budget banner**: settings → AI shows "N / M tokens this month" with a
  progress bar turning amber at `warnPercent`; over-budget adds a red line and
  the composer footnote switches to the budget message.
- **Autofill prompt editor**: property settings panel textarea + "Use default"
  reset + last-error line; column header menu gains "Fill empty cells" with
  progress (i+20 of n) and Cancel.
- **Degraded composer**: when unconfigured/offline (R25.18) the textarea is
  replaced by a bordered reason panel with a "Open AI settings" link (admins)
  or "Ask your admin" note (members).
- **i18n**: every new string via `t()`; keys added to all 5 locales —
  **the `i18nFiles` ratchet (71) must not be raised**
  (`scripts/check-coherence.mjs` BASELINE).

## 8. Edge cases

| Edge | Behavior |
| --- | --- |
| Provider dies mid-stream | `error` frame → partial persisted (chat) with `meta.error`, Retry offered; skills leave selection untouched (R25.1, R25.5). |
| Regenerate clicked twice | Second is idempotent (in-flight guard), no double delete (R25.4). |
| Budget crossed mid-conversation | Current stream finishes (usage already incurred); **next** dispatch refuses with `AI_BUDGET_EXCEEDED` (R25.13). |
| Thread model override set, then admin changes workspace model | Override wins for that thread (D3); clearing the override re-attaches to workspace (R25.6). |
| Keyless local endpoint unreachable | Test action surfaces a provider-class error; save still allowed (R25.8). |
| Autofill returns an option that does not exist | One repair retry with the option list appended; then fail softly, cell unchanged (R25.10). |
| Offline while sending chat | Draft restored, offline message shown, nothing queued (R25.17, R25.18). |
| Member opens model picker | Sees models, no key material, no admin controls (R25.7). |
| Transcription > 25 MB or unconfigured | 413-shaped / `notConfigured` error naming the fix (R25.23). |

## 9. Test plan

**Unit (vitest, red-first — cite the R25.x ids)**

1. Frame parser: delta/error/done/usage, partial frames, malformed JSON (R25.1).
2. Send-state reducer: success/failure/abort → draft restore (R25.17).
3. Error classifier: status/throw → R25.5 class table (R25.5, R25.16).
4. Regenerate ordering: delete-after-success, failure keeps old (R25.4).
5. Model precedence: override → workspace → env → none (R25.6).
6. Keyless-validation matrix for `saveAiProviderAction` (R25.8).
7. Usage extraction from SSE (with/without final frame) + JSON (R25.12).
8. Budget math + transport guard (R25.13).
9. Autofill default prompt + typed parsers (R25.9, R25.10); bulk selection cap
   (R25.11).
10. Translate target prompt builder + registry flags (R25.19, R25.20).
11. Prompt-library authz (cross-workspace deny) (R25.22).
12. Transcribe resolution order + size guard (R25.23).
13. Degraded-state derivation `{online, config}` (R25.18).

**Integration (extend the existing harness — no new framework)**

14. `scripts/check-ai.mjs`: add streaming variants for skills/ask, typed
    autofill, budget refusal; keep live-provider proof.
15. `scripts/check-chat-stream.mjs`: assert frames `delta…done + usage`, Stop
    mid-stream persists `meta.stopped`, regenerate ordering (R25.1-4, R25.12).
16. Mock OpenAI-compatible provider (D5) on a local port: fixed deltas, usage
    frame, injectable 429/503 — used by integration + e2e.

**e2e (new `e2e/ai-surface.spec.ts`, dedicated prisma pages + try/finally)**

17. Skills stream into the selection; Stop leaves selection intact (R25.2,
    R25.3).
18. Chat Stop → `ChatMessage` with `meta.stopped`; regenerate keeps old answer
    on failure (R25.3, R25.4).
19. Model picker: pick → answer `meta.model` changes; member sees no key
    (R25.6, R25.7).
20. Autofill: custom prompt applied, select-cell typed value, bulk-fill skips
    non-empty (R25.9-R25.11).
21. Budget: over-limit → composer message, history intact; dashboard counts
    (R25.13, R25.14).
22. Offline send restores draft (R25.17); unconfigured composer shows reason
    (R25.18).
23. Prompt library save → reuse (R25.22).

*Feasibility note:* everything except the live provider runs against the mock
(D5); live verification stays in `check-ai*.mjs` which already require
`AI_API_KEY`. Existing AI e2e (`noema.spec.ts:79,242`) must stay green — the
old `[stream-error]` behavior it may observe is covered by R25.1's migration.

## 10. Milestones

- **M1 — Answer path & resilience (~2-3 days)**: the shared stream contract,
  streaming parity for skills/ask/summarize, Stop, lossless regenerate, error
  taxonomy, shared client transport + draft preservation + degraded states.
  Requirements: **R25.1-R25.5, R25.16-R25.18**.
- **M2 — Control plane (~3-4 days)**: model picker + read-only model summary +
  keyless local providers; usage capture, budgets, settings dashboard;
  database-cell AI (property prompt UI, typed values, bulk fill); boundaries
  doc. Requirements: **R25.6-R25.15** (database pieces coordinate with the
  B15/B17 area).
- **M3 — Surface expansion (~3-5 days)**: translate locales, explain/simplify,
  continue writing, summarize surface parity, user prompt library,
  transcription workspace config. Requirements: **R25.19-R25.23**.

## 11. Delivery plan (tasks ↔ requirements)

> Red-first: every task's acceptance is a failing test citing its requirement
> IDs before implementation.

**M1**

- T25.1 [R25.1, R25.5] frame protocol in `ai-provider` + error codes on all AI
  routes. Red: unit 1, 3.
- T25.2 [R25.2] streaming `/api/ai` + `/api/ai/skills` + client progressive
  render. Red: integration 14.
- T25.3 [R25.3] Stop in composer/skills/Ask AI + `meta.stopped` persist. Red:
  unit 4 + integration 15.
- T25.4 [R25.4] regenerate ordering fix. Red: unit 4 (regenerate case).
- T25.5 [R25.16, R25.17, R25.18] `aiClient`/`aiStream`, draft restore, degraded
  states. Red: units 2, 3, 13.

**M2**

- T25.6 [R25.6, R25.7] `ChatThread.modelOverride` + `getModelSummary` +
  composer picker. Red: unit 5 + e2e 19.
- T25.7 [R25.8] keyless local validation + test path. Red: unit 6.
- T25.8 [R25.12, R25.13] `AiUsage`/`AiBudget` schema (full build: `db push`
  under build serialization) + transport capture/guard. Red: units 7, 8.
- T25.9 [R25.14] settings dashboard. Red: e2e 21.
- T25.10 [R25.15] `docs/AI-BOUNDARIES.md` + no-prompt-logging grep gate. Red:
  gate script fails without the doc.
- T25.11 [R25.9-R25.11] autofill prompt UI, typed parsers, bulk fill (database
  area). Red: units 9 + e2e 20.

**M3**

- T25.12 [R25.19-R25.21] skill registry expansion + submenu entries. Red:
  units 10 + e2e 17.
- T25.13 [R25.22] `WorkspacePrompt` schema + actions + composer picker. Red:
  unit 11 + e2e 23.
- T25.14 [R25.23] transcription workspace config + size cap. Red: unit 12.

## 12. Risks & open questions (honest)

**Risks**

1. **Budget enforcement drift (highest).** Any future code path that builds its
   own `fetch` to a provider bypasses cost control. Mitigation: D1 choke point
   + a coherence-style grep gate for `chat/completions` outside
   `ai-provider.ts`.
2. **Streaming e2e flakiness** on the `workers:1` shared suite. Mitigation: D5
   mock provider with deterministic deltas + generous polling; live proof stays
   in `check-ai*.mjs`.
3. **Schema additions need a full build** (`AiUsage`, `AiBudget`,
   `WorkspacePrompt`, `ChatThread.modelOverride`) — `prisma db push` needs
   build serialization + the server restart protocol.
4. **Overlap with other areas**: database components (B15/B17), Actions menu
   (B11), chat-runtime/ai-skills unit tests (B35). This spec deliberately owns
   none — implementations must coordinate on these areas first.
5. **i18n ratchet** — every string is added to all locales; raising
   `i18nFiles` to make gates pass is forbidden.

**Open questions**

- O25.1: Per-thread model override (spec default) vs per-conversation only vs
  per-user preference? Thread-level keeps the choice visible next to the
  history — chosen pending user feedback.
- O25.2: Providers that omit `usage` even with `include_usage` — estimate
  (`tokens ≈ chars/4`) and mark `estimated: true`, or record zero? Spec leans
  estimate-with-flag.
- O25.3: Budget refusal for admins (bypass for the test action?) — spec: the
  admin connection test stays allowed but is itself recorded.
- O25.4: Ollama base URLs need `/v1` (`normalizeBaseUrl`, `ai-providers.ts:88-92`
  does not append it) — settings help text or auto-append for known local
  providers?
- O25.5: Should `meta.stopped` partial answers be distinguishable in the UI
  beyond a footnote chip (Notion shows nothing) — footnote chip now.

## 13. Traceability — section-14 rows ↔ requirements

| Matrix row (`docs/FEATURE_MATRIX.md`) | Status (unchanged by this spec) | Requirements |
| --- | --- | --- |
| AI writing assist (`:529`) | 🟡 | R25.1-R25.7, R25.16-R25.18 |
| Q&A over workspace (`:530`) | ✅ | R25.12 (usage), R25.18 (degradation) |
| AI autofill property (`:531`) | 🧭 | R25.9-R25.11 |
| AI block (`:532`) | 🧭 | R25.2, R25.3 |
| Summarization (`:533`) | 🧭 | R25.2, R25.21 |
| Translation (`:534`) | 🧭 | R25.19 |
| Transcription (`:535`) | 🟡 | R25.23 |
| Meeting notes (`:536`) | ✅ | — |
| Improve/Shorten/Expand (`:537`) | ✅ | R25.2 (streaming parity) |
| Continue writing (`:538`) | 🧭 | R25.2, R25.20 |
| Explain/Simplify (`:539`) | 🧭 | R25.20 |
| AI connectors config (`:540`) | ✅ | R25.6-R25.8 |
| Local model support (`:541`) | 🧭 | R25.8 |
| Prompt library (`:542`) | 🟡 | R25.22 |
| AI cost controls (`:543`) | 🧭 | R25.12-R25.14 |
| AI data boundaries (`:544`) | 🧭 | R25.15 |

Matrix edits for this change are **Notes-only** (spec path appended); no glyph
is changed — stale-vs-code rows are called out in §2.3 for the maintainers'
next `docs:gaps` regeneration.
