import { InlineKeyboard, type Context, type NextFunction } from "grammy";
import { findSecrets } from "@aao/memory";
import type { InteractionManager } from "../app/managers/interaction-manager.js";
import { appendInlineMenuCancelButton } from "../bot/menus/inline-menu.js";
import { logger } from "../utils/logger.js";
import { at } from "./i18n.js";
import { getOpencodeJson, sendOpencode } from "./opencode-http.js";
import type { AaoRuntime } from "./runtime.js";

/**
 * OpenCode configuration inside /settings: provider keys, model, learned skills, status.
 *
 * API keys: the message holding a key is consumed by a middleware that runs before the
 * interaction guard, the message merger and the prompt queue, so it can never reach the agent
 * (no session history, no auto-capture, no memory). It is deleted from the chat, passed to
 * OpenCode once, and never logged. The bot never reads keys back: it lists connections through
 * /api/integration, which carries labels only.
 */

const PREFIX = "aao:cfg:";
const INPUT_TTL_MS = 5 * 60 * 1000;
const CREDENTIAL_LABEL = "telegram";
const MAX_CALLBACK_BYTES = 64;
const SEARCH_LIMIT = 8;
const SKILLS_SHOWN = 10;
const MODEL_POLL_ATTEMPTS = 4;
const MODEL_POLL_DELAY_MS = 750;

/** Providers offered first, in this order; the rest are reachable through search. */
export const PRESET_INTEGRATIONS = ["opencode", "deepseek", "openrouter", "anthropic", "openai", "google", "groq"];
const DISPLAY_NAMES: Record<string, string> = { opencode: "OpenCode Zen" };

export type Connection =
  | { type: "credential"; id: string; label?: string; method?: string }
  | { type: "env"; name: string }
  | { type: string; [key: string]: unknown };

export interface Integration {
  id: string;
  name: string;
  methods: Array<{ type: string; label?: string }>;
  connections: Connection[];
}

export interface OpencodeConfigApi {
  version(): Promise<string>;
  listIntegrations(): Promise<Integration[]>;
  /** Number of models per integration id. */
  countModels(): Promise<Map<string, number>>;
  connectKey(integrationId: string, key: string): Promise<void>;
  deleteCredential(credentialId: string): Promise<void>;
}

function dataOf<T>(value: unknown): T {
  return (value && typeof value === "object" && "data" in value ? (value as { data: T }).data : value) as T;
}

export function createOpencodeConfigApi(): OpencodeConfigApi {
  return {
    async version() {
      const info = (await getOpencodeJson("/api/info")) as { version?: string };
      return info.version ?? "?";
    },
    async listIntegrations() {
      return dataOf<Integration[]>(await getOpencodeJson("/api/integration"));
    },
    async countModels() {
      const providers = dataOf<Array<{ id: string; integrationID?: string }>>(await getOpencodeJson("/api/provider"));
      const models = dataOf<Array<{ providerID: string; enabled?: boolean }>>(await getOpencodeJson("/api/model"));
      const integrationOf = new Map(providers.map((provider) => [provider.id, provider.integrationID ?? provider.id]));
      const counts = new Map<string, number>();
      for (const model of models) {
        if (model.enabled === false) continue;
        const integration = integrationOf.get(model.providerID) ?? model.providerID;
        counts.set(integration, (counts.get(integration) ?? 0) + 1);
      }
      return counts;
    },
    async connectKey(integrationId, key) {
      await sendOpencode("POST", `/api/integration/${encodeURIComponent(integrationId)}/connect/key`, {
        key,
        label: CREDENTIAL_LABEL,
      });
    },
    async deleteCredential(credentialId) {
      await sendOpencode("DELETE", `/api/credential/${encodeURIComponent(credentialId)}`);
    },
  };
}

export interface ConfigMenuDeps {
  interactionManager: Pick<InteractionManager, "getSnapshot">;
  opencode: OpencodeConfigApi;
  getRuntime: () => AaoRuntime | null;
  /** "provider/model" of the model new prompts use. */
  getCurrentModel: () => { providerID: string; modelID: string };
  /** Drops the bot's cached model list so the model picker shows the new provider. */
  refreshModelCatalog: () => void;
  showModelMenu: (ctx: Context) => Promise<void>;
  buildSettingsView: () => { text: string; keyboard: InlineKeyboard };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface View {
  text: string;
  keyboard: InlineKeyboard;
}

type PendingInput =
  | { kind: "key"; integrationId: string; name: string; chatId: number; messageId: number; expiresAt: number }
  | { kind: "search"; chatId: number; messageId: number; expiresAt: number };

export function displayName(integration: Pick<Integration, "id" | "name">): string {
  return DISPLAY_NAMES[integration.id] ?? integration.name;
}

function acceptsKey(integration: Integration): boolean {
  return integration.methods.some((method) => method.type === "key");
}

function fitsCallback(prefix: string, value: string): boolean {
  return Buffer.byteLength(prefix + value) <= MAX_CALLBACK_BYTES;
}

function modelLabel(model: { providerID: string; modelID: string }): string {
  return model.providerID && model.modelID ? `${model.providerID}/${model.modelID}` : at("cfg.none");
}

function connected(integrations: Integration[]): Integration[] {
  return integrations.filter((integration) => integration.connections.length > 0);
}

function connectedNames(integrations: Integration[]): string {
  const names = connected(integrations).map(displayName);
  return names.length > 0 ? names.join(", ") : at("cfg.none");
}

function credentialsOf(integration: Integration): Array<{ id: string; label: string }> {
  return integration.connections
    .filter((connection): connection is { type: "credential"; id: string; label?: string } => connection.type === "credential")
    .map((connection) => ({ id: connection.id, label: connection.label ?? "key" }));
}

function backRow(keyboard: InlineKeyboard, target = `${PREFIX}root`): InlineKeyboard {
  // Telegram rejects empty button rows, so only start a new row after a filled one.
  if ((keyboard.inline_keyboard.at(-1)?.length ?? 0) > 0) keyboard.row();
  return keyboard.text(at("cfg.button_back"), target);
}

/**
 * A single token that the memory secret scanner flags. Pattern hits (sk-…, AIza…, ghp_…) always
 * count; the generic high-entropy and long-hex hits count only for a bare token, not for a URL
 * or path, so a pasted link still reaches the agent.
 */
export function looksLikeLoneSecret(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 20 || /\s/.test(trimmed)) return false;
  const findings = findSecrets(trimmed);
  if (findings.some((finding) => finding.kind !== "high_entropy" && finding.kind !== "long_hex")) return true;
  return findings.length > 0 && !/[/.:@]/.test(trimmed);
}

export function isValidKeyShape(text: string): boolean {
  return /^\S{8,512}$/.test(text);
}

export function createConfigMenu(deps: ConfigMenuDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let pending: PendingInput | null = null;

  const activePending = (): PendingInput | null => {
    if (pending && pending.expiresAt <= now()) pending = null;
    return pending;
  };

  async function rootView(): Promise<View> {
    const keyboard = new InlineKeyboard()
      .text(at("cfg.button_providers"), `${PREFIX}prov`)
      .text(at("cfg.button_add"), `${PREFIX}add`)
      .row()
      .text(at("cfg.button_model"), `${PREFIX}model`)
      .row()
      .text(at("cfg.button_skills"), `${PREFIX}sk`)
      .text(at("cfg.button_status"), `${PREFIX}status`);
    backRow(keyboard, `${PREFIX}back`);
    let providers: string;
    try {
      providers = connectedNames(await deps.opencode.listIntegrations());
    } catch (error) {
      logger.warn("[AAO] Config menu: listing integrations failed", error);
      providers = at("cfg.unreachable");
    }
    return { text: at("cfg.root", { model: modelLabel(deps.getCurrentModel()), providers }), keyboard };
  }

  async function providersView(): Promise<View> {
    const [integrations, counts] = await Promise.all([deps.opencode.listIntegrations(), deps.opencode.countModels()]);
    const keyboard = new InlineKeyboard();
    const list = connected(integrations);
    if (list.length === 0) {
      keyboard.text(at("cfg.button_add"), `${PREFIX}add`);
      return { text: `${at("cfg.providers_heading")}\n\n${at("cfg.providers_empty")}`, keyboard: backRow(keyboard) };
    }
    const lines = [at("cfg.providers_heading"), ""];
    for (const integration of list) {
      for (const connection of integration.connections) {
        const source =
          connection.type === "credential"
            ? at("cfg.source_key", { label: String(connection.label ?? "key") })
            : at("cfg.source_env", { name: String((connection as { name?: string }).name ?? "?") });
        lines.push(at("cfg.provider_line", { name: displayName(integration), source, count: counts.get(integration.id) ?? 0 }));
      }
      for (const credential of credentialsOf(integration)) {
        if (!fitsCallback(`${PREFIX}pdel:`, credential.id)) continue;
        keyboard
          .text(at("cfg.button_delete", { name: displayName(integration), label: credential.label }), `${PREFIX}pdel:${credential.id}`)
          .row();
      }
    }
    lines.push("", at("cfg.providers_hint"));
    keyboard.text(at("cfg.button_add"), `${PREFIX}add`);
    return { text: lines.join("\n"), keyboard: backRow(keyboard) };
  }

  async function findCredential(credentialId: string): Promise<{ integration: Integration; label: string } | null> {
    for (const integration of await deps.opencode.listIntegrations()) {
      const credential = credentialsOf(integration).find((item) => item.id === credentialId);
      if (credential) return { integration, label: credential.label };
    }
    return null;
  }

  async function deleteConfirmView(credentialId: string): Promise<View | null> {
    const found = await findCredential(credentialId);
    if (!found) return null;
    const lines = [at("cfg.delete_confirm", { name: displayName(found.integration), label: found.label })];
    const model = deps.getCurrentModel();
    // For the key providers OpenCode ships, the provider id equals the integration id.
    if (model.providerID === found.integration.id) {
      lines.push("", at("cfg.delete_active_warning", { model: modelLabel(model) }));
    }
    const keyboard = new InlineKeyboard()
      .text(at("cfg.button_confirm_delete"), `${PREFIX}pdelok:${credentialId}`)
      .text(at("cfg.button_cancel"), `${PREFIX}prov`);
    return { text: lines.join("\n"), keyboard };
  }

  async function addView(): Promise<View> {
    const integrations = await deps.opencode.listIntegrations();
    const byId = new Map(integrations.map((integration) => [integration.id, integration]));
    const keyboard = new InlineKeyboard();
    let inRow = 0;
    for (const id of PRESET_INTEGRATIONS) {
      const integration = byId.get(id);
      if (!integration || !acceptsKey(integration)) continue;
      keyboard.text(displayName(integration), `${PREFIX}addk:${id}`);
      if (++inRow % 2 === 0) keyboard.row();
    }
    if (inRow % 2 !== 0) keyboard.row();
    keyboard.text(at("cfg.button_search"), `${PREFIX}search`);
    return { text: at("cfg.add_heading"), keyboard: backRow(keyboard) };
  }

  function searchResultsView(integrations: Integration[], query: string): View {
    const needle = query.trim().toLowerCase();
    const matches = integrations
      .filter((integration) => acceptsKey(integration) && fitsCallback(`${PREFIX}addk:`, integration.id))
      .filter((integration) => integration.id.includes(needle) || integration.name.toLowerCase().includes(needle))
      .slice(0, SEARCH_LIMIT);
    const keyboard = new InlineKeyboard();
    for (const integration of matches) keyboard.text(displayName(integration), `${PREFIX}addk:${integration.id}`).row();
    keyboard.text(at("cfg.button_search_again"), `${PREFIX}search`);
    backRow(keyboard, `${PREFIX}add`);
    const text = matches.length > 0 ? at("cfg.search_results", { query: query.trim() }) : at("cfg.search_none", { query: query.trim() });
    return { text, keyboard };
  }

  function skillsView(): View {
    const runtime = deps.getRuntime();
    const keyboard = new InlineKeyboard();
    if (!runtime) return { text: at("memory.disabled"), keyboard: backRow(keyboard) };
    const approved = runtime.service.skills.listApproved();
    const waiting = runtime.service.skills.listPending();
    if (approved.length === 0 && waiting.length === 0) {
      return { text: `${at("cfg.skills_heading")}\n\n${at("cfg.skills_empty")}`, keyboard: backRow(keyboard) };
    }
    const lines = [at("cfg.skills_heading"), ""];
    if (approved.length > 0) {
      lines.push(at("cfg.skills_active", { count: approved.length }));
      for (const skill of approved) lines.push(`• ${skill.name} (${skill.id})`);
      for (const skill of approved.slice(0, SKILLS_SHOWN)) {
        keyboard.text(`👁 ${skill.id}`, `aao:sk:view:${skill.id}`).text(`⛔ ${skill.id}`, `${PREFIX}skrv:${skill.id}`).row();
      }
    }
    if (waiting.length > 0) {
      if (approved.length > 0) lines.push("");
      lines.push(at("cfg.skills_pending", { count: waiting.length }));
      for (const skill of waiting) lines.push(`• ${skill.name} (${skill.id})`);
      for (const skill of waiting.slice(0, SKILLS_SHOWN)) {
        keyboard
          .text(`👁 ${skill.id}`, `aao:sk:view:${skill.id}`)
          .text("✅", `${PREFIX}skok:${skill.id}`)
          .text("❌", `${PREFIX}skno:${skill.id}`)
          .row();
      }
    }
    lines.push("", at("cfg.skills_hint"));
    return { text: lines.join("\n"), keyboard: backRow(keyboard) };
  }

  function revokeConfirmView(skillId: string): View | null {
    const skill = deps.getRuntime()?.service.skills.getApproved(skillId);
    if (!skill) return null;
    const keyboard = new InlineKeyboard()
      .text(at("cfg.button_confirm_revoke"), `${PREFIX}skrvok:${skill.id}`)
      .text(at("cfg.button_cancel"), `${PREFIX}sk`);
    return { text: at("cfg.revoke_confirm", { name: skill.name, id: skill.id }), keyboard };
  }

  async function statusView(): Promise<View> {
    const runtime = deps.getRuntime();
    let version: string;
    let providers: string;
    try {
      [version, providers] = await Promise.all([
        deps.opencode.version(),
        deps.opencode.listIntegrations().then(connectedNames),
      ]);
    } catch (error) {
      logger.warn("[AAO] Config menu: status lookup failed", error);
      version = at("cfg.unreachable");
      providers = "?";
    }
    const memory = runtime
      ? at("cfg.status_memory", {
          count: runtime.service.memories.list().length,
          used: runtime.service.memories.totalChars(),
          max: runtime.service.memories.limits.maxTotalChars,
        })
      : at("cfg.status_off");
    const skills = runtime
      ? at("cfg.status_skills", {
          approved: runtime.service.skills.listApproved().length,
          pending: runtime.service.skills.listPending().length,
        })
      : at("cfg.status_off");
    const text = at("cfg.status", { version, model: modelLabel(deps.getCurrentModel()), providers, memory, skills });
    return { text, keyboard: backRow(new InlineKeyboard()) };
  }

  async function show(ctx: Context, view: View): Promise<void> {
    await ctx
      .editMessageText(view.text, { reply_markup: appendInlineMenuCancelButton(view.keyboard, "settings") })
      .catch((error: unknown) => logger.debug("[AAO] Config menu edit skipped", error));
  }

  async function showAt(ctx: Context, target: { chatId: number; messageId: number }, view: View): Promise<void> {
    await ctx.api
      .editMessageText(target.chatId, target.messageId, view.text, {
        reply_markup: appendInlineMenuCancelButton(view.keyboard, "settings"),
      })
      .catch(async () => {
        await ctx.api.sendMessage(target.chatId, view.text, {
          reply_markup: appendInlineMenuCancelButton(view.keyboard, "settings"),
        });
      });
  }

  /** True when the callback was pressed on the /settings message that is still the active menu. */
  function isActiveSettingsMessage(ctx: Context): boolean {
    const state = deps.interactionManager.getSnapshot();
    const messageId = ctx.callbackQuery?.message?.message_id;
    return (
      state?.kind === "inline" &&
      state.metadata.menuKind === "settings" &&
      typeof messageId === "number" &&
      state.metadata.messageId === messageId
    );
  }

  async function handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const rest = data.slice(PREFIX.length);
    const colon = rest.indexOf(":");
    const action = colon === -1 ? rest : rest.slice(0, colon);
    const arg = colon === -1 ? "" : rest.slice(colon + 1);
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
    const messageId = ctx.callbackQuery?.message?.message_id;

    if (!isActiveSettingsMessage(ctx) || chatId === undefined || messageId === undefined) {
      await ctx.answerCallbackQuery({ text: at("skills.gone"), show_alert: true }).catch(() => undefined);
      return;
    }
    // Any button press ends a pending key or search prompt; the ones that start one set it again.
    pending = null;

    try {
      switch (action) {
        case "root":
          await ctx.answerCallbackQuery();
          await show(ctx, await rootView());
          return;
        case "back": {
          await ctx.answerCallbackQuery();
          const settings = deps.buildSettingsView();
          await show(ctx, settings);
          return;
        }
        case "prov":
          await ctx.answerCallbackQuery();
          await show(ctx, await providersView());
          return;
        case "pdel": {
          const view = await deleteConfirmView(arg);
          if (!view) {
            await ctx.answerCallbackQuery({ text: at("cfg.gone"), show_alert: true });
            await show(ctx, await providersView());
            return;
          }
          await ctx.answerCallbackQuery();
          await show(ctx, view);
          return;
        }
        case "pdelok": {
          const found = await findCredential(arg);
          if (!found) {
            await ctx.answerCallbackQuery({ text: at("cfg.gone"), show_alert: true });
            await show(ctx, await providersView());
            return;
          }
          await deps.opencode.deleteCredential(arg);
          deps.refreshModelCatalog();
          logger.info(`[AAO] Provider credential removed: integration=${found.integration.id} label=${found.label}`);
          await ctx.answerCallbackQuery({
            text: at("cfg.deleted", { name: displayName(found.integration), label: found.label }),
          });
          await show(ctx, await providersView());
          return;
        }
        case "add":
          await ctx.answerCallbackQuery();
          await show(ctx, await addView());
          return;
        case "addk": {
          const integration = (await deps.opencode.listIntegrations()).find((item) => item.id === arg);
          if (!integration || !acceptsKey(integration)) {
            await ctx.answerCallbackQuery({ text: at("cfg.gone"), show_alert: true });
            return;
          }
          const name = displayName(integration);
          pending = { kind: "key", integrationId: integration.id, name, chatId, messageId, expiresAt: now() + INPUT_TTL_MS };
          await ctx.answerCallbackQuery();
          await show(ctx, {
            text: at("cfg.key_prompt", { name }),
            keyboard: new InlineKeyboard().text(at("cfg.button_cancel"), `${PREFIX}add`),
          });
          return;
        }
        case "search":
          pending = { kind: "search", chatId, messageId, expiresAt: now() + INPUT_TTL_MS };
          await ctx.answerCallbackQuery();
          await show(ctx, {
            text: at("cfg.search_prompt"),
            keyboard: new InlineKeyboard().text(at("cfg.button_cancel"), `${PREFIX}add`),
          });
          return;
        case "model":
          await ctx.answerCallbackQuery();
          await ctx.editMessageText(at("cfg.model_opening")).catch(() => undefined);
          await deps.showModelMenu(ctx);
          return;
        case "sk":
          await ctx.answerCallbackQuery();
          await show(ctx, skillsView());
          return;
        case "skrv": {
          const view = revokeConfirmView(arg);
          if (!view) {
            await ctx.answerCallbackQuery({ text: at("skills.gone"), show_alert: true });
            await show(ctx, skillsView());
            return;
          }
          await ctx.answerCallbackQuery();
          await show(ctx, view);
          return;
        }
        case "skrvok":
        case "skok":
        case "skno": {
          const runtime = deps.getRuntime();
          const actor = `telegram:${ctx.from?.id ?? "unknown"}`;
          const skills = runtime?.service.skills;
          const decided =
            action === "skrvok" ? skills?.revoke(arg, actor) : action === "skok" ? skills?.approve(arg, actor) : skills?.reject(arg, actor);
          if (!decided) {
            await ctx.answerCallbackQuery({ text: at("skills.gone"), show_alert: true });
          } else {
            logger.info(`[AAO] Skill ${action === "skrvok" ? "revoked" : decided.status}: ${decided.id} by ${actor}`);
            const key = action === "skrvok" ? "cfg.revoked" : action === "skok" ? "skills.approved" : "skills.rejected";
            await ctx.answerCallbackQuery({ text: at(key, { id: decided.id }) });
          }
          await show(ctx, skillsView());
          return;
        }
        case "status":
          await ctx.answerCallbackQuery();
          await show(ctx, await statusView());
          return;
        default:
          await ctx.answerCallbackQuery();
      }
    } catch (error) {
      logger.warn(`[AAO] Config menu action failed: ${action}`, error);
      const message = error instanceof Error ? error.message : String(error);
      await ctx.answerCallbackQuery({ text: at("cfg.failed", { error: message }), show_alert: true }).catch(() => undefined);
    }
  }

  async function acceptKey(ctx: Context, input: Extract<PendingInput, { kind: "key" }>, text: string): Promise<void> {
    const deleted = await ctx
      .deleteMessage()
      .then(() => true)
      .catch(() => false);
    const notes = deleted ? [] : [at("cfg.key_not_deleted")];
    const key = text.trim();
    const retry = new InlineKeyboard().text(at("cfg.button_add"), `${PREFIX}add`);

    if (!isValidKeyShape(key)) {
      await showAt(ctx, input, { text: [at("cfg.key_invalid"), ...notes].join("\n\n"), keyboard: backRow(retry) });
      return;
    }
    try {
      await deps.opencode.connectKey(input.integrationId, key);
    } catch (error) {
      // The error names only the method, path and status.
      const message = error instanceof Error ? error.message : "error";
      logger.warn(`[AAO] Connecting provider key failed: integration=${input.integrationId}: ${message}`);
      await showAt(ctx, input, { text: [at("cfg.failed", { error: message }), ...notes].join("\n\n"), keyboard: backRow(retry) });
      return;
    }
    logger.info(`[AAO] Provider key connected: integration=${input.integrationId}`);
    deps.refreshModelCatalog();

    let count = 0;
    for (let attempt = 0; attempt < MODEL_POLL_ATTEMPTS; attempt++) {
      count = (await deps.opencode.countModels().catch(() => new Map<string, number>())).get(input.integrationId) ?? 0;
      if (count > 0) break;
      await sleep(MODEL_POLL_DELAY_MS);
    }
    const summary = count > 0 ? at("cfg.key_saved", { name: input.name, count }) : at("cfg.key_saved_no_models", { name: input.name });
    const keyboard = new InlineKeyboard().text(at("cfg.button_model"), `${PREFIX}model`).row().text(at("cfg.button_providers"), `${PREFIX}prov`);
    await showAt(ctx, input, { text: [summary, ...notes].join("\n\n"), keyboard: backRow(keyboard) });
  }

  async function acceptSearch(ctx: Context, input: Extract<PendingInput, { kind: "search" }>, text: string): Promise<void> {
    const integrations = await deps.opencode.listIntegrations();
    await showAt(ctx, input, searchResultsView(integrations, text));
  }

  /**
   * Runs right after the auth middleware, before anything that could forward text to the agent.
   * Consumes a pending key or search reply, and blocks a lone message that looks like a secret.
   */
  async function textMiddleware(ctx: Context, next: NextFunction): Promise<void> {
    const text = ctx.message?.text;
    if (typeof text !== "string") {
      await next();
      return;
    }
    const input = activePending();
    if (input && ctx.chat?.id === input.chatId) {
      pending = null;
      if (text.trim().startsWith("/")) {
        await next();
        return;
      }
      try {
        if (input.kind === "key") await acceptKey(ctx, input, text);
        else await acceptSearch(ctx, input, text);
      } catch (error) {
        logger.warn(`[AAO] Config input failed: ${input.kind}`, error instanceof Error ? error.message : "error");
      }
      return;
    }
    if (looksLikeLoneSecret(text)) {
      const deleted = await ctx
        .deleteMessage()
        .then(() => true)
        .catch(() => false);
      logger.warn("[AAO] Blocked a message that looks like a secret; it was not sent to the agent");
      await ctx.reply(deleted ? at("cfg.secret_blocked") : `${at("cfg.secret_blocked")}\n\n${at("cfg.key_not_deleted")}`);
      return;
    }
    await next();
  }

  return { handleCallback, textMiddleware, hasPendingInput: () => activePending() !== null };
}

export type ConfigMenu = ReturnType<typeof createConfigMenu>;
