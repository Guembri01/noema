/**
 * The model the assistant answers with: what is effective, what may be chosen,
 * and where a choice is remembered.
 *
 * The chat panel printed the effective model as a read-only tag, and the only
 * place to change it was Settings → AI — which is why "why can't I change the
 * model in the chatbot?" had no answer *inside* the assistant. The tag is now the
 * control, and the choice is **per conversation**, like the assistant it is
 * modelled on:
 *
 * - the configured model stays the default and the fallback;
 * - a choice replaces the *model id only* — provider, endpoint and API key always
 *   come from the resolved workspace/deployment configuration, so a crafted
 *   request cannot redirect the call at another host;
 * - nothing is written to the database, so a member without admin rights can
 *   still choose a model for their own question.
 */
import { providerDefinition, providerForBaseUrl } from "@/lib/ai-providers";

/** One selectable model. */
export type ChatModelOption = { id: string; label: string };

/** Where the effective AI configuration comes from. */
export type ChatModelSource = "workspace" | "env" | "none";

/** The effective AI configuration plus the choices the picker may offer. */
export type ChatModelInfo = {
  /** The configured model — the default and the fallback ("" when unconfigured). */
  model: string;
  /**
   * The provider whose catalogue describes this configuration, e.g. `deepseek`.
   * Not always the resolved provider id: see {@link catalogProvider}.
   */
  provider: string;
  /** The provider's human label, e.g. `DeepSeek`. */
  providerLabel: string;
  /** `workspace` when the workspace saved a provider, `env` when the deployment
   *  supplies one, `none` when nothing is configured at all. */
  source: ChatModelSource;
  /**
   * The models the picker offers: the provider's curated catalogue, plus the
   * current model when the catalogue does not list it (custom endpoints, or a
   * model added upstream after this build).
   */
  options: readonly ChatModelOption[];
};

/**
 * The provider whose catalogue describes a resolved configuration.
 *
 * Normally the resolved provider id, and for the `custom` provider the host of the
 * base URL instead: a deployment that supplies only `AI_BASE_URL` resolves to
 * `custom`, and taking that at face value would offer a picker with nothing in it.
 */
export function catalogProvider(
  provider: string | null | undefined,
  baseUrl?: string | null,
): string {
  const declared = (provider ?? "").trim();
  if (declared && declared !== "custom" && providerDefinition(declared)) return declared;
  return providerForBaseUrl(baseUrl) ?? declared;
}

/** The picker's label for a model id: the catalogue label, else the id itself. */
export function chatModelLabel(provider: string, model: string): string {
  const id = model.trim();
  if (!id) return "";
  const known = providerDefinition(provider)?.models.find((entry) => entry.id === id);
  return known?.label ?? id;
}

/**
 * The models to offer for `provider`, always including `current`.
 *
 * A workspace can point at a custom endpoint or at a model the catalogue has
 * never heard of; the picker must still show what is in effect, or the control
 * would claim a model is configured *and* offer no match for it.
 */
export function chatModelOptions(provider: string, current: string): ChatModelOption[] {
  const catalog = (providerDefinition(provider)?.models ?? []).map((entry) => ({
    id: entry.id,
    label: entry.label,
  }));
  const id = current.trim();
  if (!id || catalog.some((entry) => entry.id === id)) return catalog;
  return [{ id, label: id }, ...catalog];
}

/** Assemble the info object the panel receives, from a resolved runtime config. */
export function chatModelInfo(input: {
  provider: string | null | undefined;
  model: string | null | undefined;
  source: ChatModelSource;
  /** The endpoint the provider is reached at, when one is resolved. */
  baseUrl?: string | null;
}): ChatModelInfo {
  const provider = catalogProvider(input.provider, input.baseUrl);
  const model = input.model ?? "";
  return {
    model,
    provider,
    providerLabel: providerDefinition(provider)?.label ?? provider,
    source: input.source,
    options: chatModelOptions(provider, model),
  };
}

/**
 * The note shown under the model list: why nothing can be chosen, or where the
 * model comes from. `null` when the picker needs no explanation.
 */
export function chatModelNote(
  info: Pick<ChatModelInfo, "source" | "options">,
): "chatModelNotConfigured" | "chatModelFromEnv" | null {
  if (info.options.length === 0) return "chatModelNotConfigured";
  if (info.source === "env") return "chatModelFromEnv";
  return null;
}

/*
 * The wire contract
 * ----------------
 * A model id is the one part of the AI configuration a browser may influence, so
 * it is validated on both sides of the wire by the same function: the client
 * refuses to send nonsense, and the route refuses to trust it.
 */

/**
 * Model ids in every provider we talk to: `[A-Za-z0-9._:/-]`, and never empty.
 *
 * `:` and `/` are in the set because real ids need them (`deepseek/deepseek-chat:free`
 * through a router, `accounts/fireworks/models/llama-v3`), which is exactly why
 * the scheme separator has to be refused separately below.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

/** A model id that is safe to send or accept; `null` for anything else. */
export function chatModelOverride(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!MODEL_ID.test(id)) return null;
  // `//` would turn the id into something a URL parser recognises as a host:
  // `https://evil.example` satisfies the character set above. A model id may
  // contain `/`, but never the `//` that starts an authority.
  if (id.includes("//")) return null;
  return id;
}

/**
 * The model a request will actually use: the chosen one when it is well-formed,
 * otherwise the configured default. Pure, so the panel and the route agree.
 */
export function effectiveChatModel(configured: string, requested: unknown): string {
  return chatModelOverride(requested) ?? configured.trim();
}

/*
 * Remembering the choice
 * ----------------------
 * Per workspace, in `localStorage`: it is a per-person, per-conversation
 * preference, not workspace state — storing it on the server would make one
 * member's choice everyone's.
 */

/** Prefix of the storage key holding the chosen model. */
export const CHAT_MODEL_PREFERENCE_PREFIX = "noema:chat-model:";

/** Storage key holding the model chosen for this workspace's conversations. */
export function chatModelPreferenceKey(workspaceId: string): string {
  return `${CHAT_MODEL_PREFERENCE_PREFIX}${workspaceId}`;
}

/**
 * The remembered choice, or `null` when there is none.
 *
 * Storage can be unavailable and can throw (Safari private mode); a missing
 * preference is not an error worth surfacing, so both cases read as "none".
 */
export function readChatModelPreference(
  storage: Pick<Storage, "getItem"> | null | undefined,
  workspaceId: string,
): string | null {
  try {
    return chatModelOverride(storage?.getItem(chatModelPreferenceKey(workspaceId)));
  } catch {
    return null;
  }
}

/** Remember the choice; an unusable id or a full quota is ignored. */
export function writeChatModelPreference(
  storage: Pick<Storage, "setItem"> | null | undefined,
  workspaceId: string,
  model: string,
): void {
  const id = chatModelOverride(model);
  if (!id) return;
  try {
    storage?.setItem(chatModelPreferenceKey(workspaceId), id);
  } catch {
    /* Quota or private mode: the choice still applies to this conversation. */
  }
}
