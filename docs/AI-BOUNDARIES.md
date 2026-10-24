# AI data boundaries

> Status: implemented policy (R25.8, R25.15). This document describes what Noema
> does with workspace content when AI is configured, and points at the code
> that enforces each guarantee. Marketing language is not the source of truth
> here — the tests in `src/lib/ai-boundary.test.ts` and the traffic paths in
> `src/lib/ai-provider.ts` are.

## 1. The short version

- Noema is **bring-your-own-provider**. A workspace stores its own endpoint,
  model and (for remote providers) key. The server calls that endpoint
  directly; Noema has no inference proxy in the middle.
- **Prompts and completions are not written to application logs by default.**
  The AI logging sink accepts diagnostic metadata only and drops payload-shaped
  fields before they reach `console`.
- **Noema adds no training and no telemetry forwarding** to the AI transport.
  There is no analytics SDK call beside a model call, and no code path sends a
  prompt anywhere except the workspace's configured endpoint.
- **Local endpoints are local-only.** When the effective base URL is loopback or
  an RFC1918/`.local` private host, prompts and completions cannot leave the
  operator's machine or private network. This is derived from the endpoint, not
  from a UI badge that could drift from the transport.
- **Keys are encrypted at rest** with AES-256-GCM and are never returned to the
  browser. A remote provider still requires a key; a local provider may be
  keyless.
- **Transcription audio is processed and discarded.** Only the resulting
  transcript page persists.

## 2. What each surface sends

| Surface | Code | Content sent | Stored by Noema |
| --- | --- | --- | --- |
| Chat (stream) | `src/app/api/chat/stream/route.ts`, `src/lib/chat-runtime.ts` | System prompt, the user turn (≤ 4,000 chars), and grounded workspace context assembled by `src/lib/chat-context.ts` / `src/lib/retrieval.ts` | `ChatMessage` rows (the conversation itself), with `meta.model`/`meta.provider` |
| Ask / summarize / autofill | `src/app/api/ai/route.ts` | System instruction, question/prompt (≤ 4,000 chars), optional context (≤ 8,000 chars) | Nothing beyond the values the user's action already stores; autofill writes the cell |
| Editor skills | `src/app/api/ai/skills/route.ts`, `src/lib/ai-skills.ts` | The selected text (≤ 8,000 chars) and the skill instruction | Nothing new — the transformed text replaces the selection only if the user applies it |
| Ask AI block | `src/components/editor/extensions/ask-ai.tsx` | The block question and its page context through `/api/ai` | The block content the user inserts |
| Transcription | `src/app/api/ai/transcribe/route.ts` | The audio file (≤ 25 MB) and the model name | Only the transcript page created by the user flow; the audio is not persisted by the route |

Context caps are enforced in the routes cited above. The request never includes
another workspace's content: routes resolve the workspace from the authenticated
user's access, and `resolveAiConfigForUser` refuses a foreign workspace provider
row (`src/lib/ai-provider.ts`).

## 3. Logging

**Guarantee:** no prompt, completion, message array, audio or transcript is
written to application logs by default.

**Enforcement:**

- `src/lib/ai-boundary.ts` owns the only AI logging primitive,
  `logAiDiagnostic(event, fields)`.
- Before writing, `sanitizeAiDiagnostic` removes every payload-shaped field
  (`prompt`, `messages`, `body`, `answer`, `completion`, `response`, `text`,
  `content`, `input`, `output`, `audio`, `transcript`) and every non-primitive
  value. Diagnostics such as `status`, `code`, `workspaceId`, `provider`,
  `model` and `durationMs` are kept.
- Provider failure logs (`logProviderFailure`, `transportFailure` in
  `src/lib/ai-provider.ts`) use that sink. They carry the upstream status, a
  stable code and the call attribution — never the provider body, never the
  endpoint and never the key.
- Prompt/response logging requires the explicit `AI_LOG_PROMPTS=true` operator
  opt-in. The transport itself does not pass payloads even when that flag is
  set.
- `src/lib/ai-boundary.test.ts` is a static gate: it fails the build if an AI
  source file starts calling `console.log`, passes a payload-shaped value to a
  console/logger call, or mentions a known analytics host.

Operational logs from the web framework, reverse proxy or hosting platform are
outside this repository; operators who need end-to-end no-log guarantees should
disable request-body logging at that layer as well.

## 4. Training and telemetry

**Guarantee:** Noema does not train on workspace content and does not forward it
to analytics or telemetry. The only outbound AI calls are the model calls the
user's action triggered.

**Enforcement:**

- `AI_BOUNDARY_POLICY.providerTraining` and `.telemetryForwarding` are `false`
  (`src/lib/ai-boundary.ts`).
- There is no analytics import or call in the AI transport: `chatComplete`,
  `chatCompleteStream` and `listProviderModels` call the configured `baseUrl`
  (and its catalogue URL) and nothing else.
- A provider that an operator declares as training on submitted content
  (`AI_PROVIDER_TRAINS_ON_DATA=true`) is refused by
  `assertAiDataBoundary` unless the operator also sets
  `AI_ALLOW_PROVIDER_TRAINING=true`. The guard runs before request bodies are
  serialised in both transports.
- A static test rejects analytics/telemetry hosts in the AI source paths.

What a third-party provider does with a request *after* it receives it is
governed by that provider's terms, not by Noema. Choosing a provider — and its
data-processing terms — is the workspace admin's decision. This is exactly why
the local option exists.

## 5. Local-only processing

**Guarantee:** when the effective endpoint is `localhost`, `127.0.0.1`, `::1`,
`*.local`, `host.docker.internal` or an RFC1918 private address, every prompt
and completion stays on the operator's own machine or private network.

**Enforcement:**

- `classifyAiBaseUrl` (`src/lib/ai-providers.ts`) is the single endpoint
  classifier. It reports `local: true` only for loopback/private hosts.
- `resolveAiConfig` accepts a workspace provider with no key only when the
  endpoint is local. Remote providers still require a key.
- `aiProcessingScope` / `localOnlyProcessingGuaranteed`
  (`src/lib/ai-boundary.ts`) derive the scope from the effective base URL.
- The settings screen shows “Local-only processing” from that same classifier
  and explains whether the key is optional.
- The request is issued by the Noema server directly to the workspace's
  endpoint. There is no Noema-hosted relay, so “local endpoint” means the bytes
  do not leave the operator's network.

A persisted workspace-level “local-only” *switch* (as opposed to the
endpoint-derived guarantee above) is **not implemented**: the current schema has
no policy column on `Workspace` or `AiProviderConfig`, and adding one requires a
Prisma schema change. Until that field exists, the guarantee is enforced by the
endpoint itself — a workspace cannot claim local-only while pointing at a remote
host, and the UI reports the real scope. A future switch should be a typed
column on `AiProviderConfig` (it is already one row per workspace) such as
`localOnly Boolean @default(false)`, with the transport refusing a non-local
`baseUrl` when it is set.

## 6. Keys

- Remote providers require an API key; enabling a remote provider without one is
  refused by `saveAiProviderAction` and by `testAiProviderAction`.
- Local providers may be keyless. No placeholder key is invented: the transport
  omits the `Authorization` header entirely (`providerRequestHeaders`).
- Keys are encrypted with AES-256-GCM (`src/lib/secrets.ts`) before storage and
  are never returned to the browser. The settings summary exposes only
  `hasKey` / a mask.
- A stored key is preserved for the same provider on the same side of the
  local/remote boundary. Switching provider, or moving between local and remote,
  drops the old key rather than sending it to a different endpoint.
- Endpoint URLs are validated before storage: only absolute `http(s)`, no
  embedded username/password, no key/token in the query string, and plain
  `http:` only for loopback/private hosts.

## 7. Retention

- Conversation messages persist because they are the user's workspace data; an
  admin can delete them through the normal workspace data controls.
- AI diagnostics are process logs (metadata only) and follow the deployment's
  log retention.
- Provider failure bodies are not retained at all — they are reduced to a status
  and a code.
- Transcription audio is held in the request only for the duration of the
  upstream call and is not written to storage by the route.
- Noema adds no prompt library, cache or vector store that duplicates workspace
  content for model use; retrieval stays lexical over the workspace's own
  pages.

## 8. Verification

Run the targeted suite:

```bash
npx vitest run \
  src/lib/ai-boundary.test.ts \
  src/lib/ai-provider.boundary.test.ts \
  src/lib/ai-providers.endpoint.test.ts \
  src/lib/ai-provider.local.test.ts \
  src/server/actions/ai-settings.local.test.ts
```

The tests cover:

- keyless local save, test and enable;
- the remote key requirement;
- endpoint scheme/credential/plain-http validation;
- workspace → env precedence for local and remote readiness;
- payload-field stripping, training refusal and the static no-logging /
  no-telemetry gate.

`npm run typecheck` covers the compile-time surface.

## 9. Known limits

1. **No persisted local-only switch.** See §5: this needs a schema column; the
   current guarantee is derived from the endpoint.
2. **Third-party provider retention/training terms are outside Noema.** Use a
   local endpoint when the content cannot leave the network.
3. **Operator infrastructure logs** (proxy, platform, APM) can still capture
   request metadata unless the operator configures them. Noema does not add
   body logging, but it cannot remove someone else's.
4. **Usage/budget accounting is in-process** (`src/lib/ai-cost.ts`) until a
   durable usage table lands; that is a cost control, not a data-boundary
   control.
5. **BYO-key means the workspace supplies the credential.** Noema never ships a
   shared inference key, so a provider cannot attribute traffic to a Noema
   account.
