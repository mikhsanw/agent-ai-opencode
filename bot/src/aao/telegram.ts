import fs from "node:fs";
import path from "node:path";
import { InlineKeyboard, type Api, type Bot, type Context } from "grammy";
import type { AuditEntry, Skill } from "@aao/memory";
import { logger } from "../utils/logger.js";
import { at, type AaoI18nKey } from "./i18n.js";
import { getAaoRuntime, type AaoRuntime } from "./runtime.js";

const MESSAGE_BUDGET = 3500;
const SKILL_PREVIEW_CHARS = 1200;
const SKILL_CHUNK_CHARS = 3800;
const DIGEST_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DIGEST_ITEMS_PER_GROUP = 15;

export interface TelegramView {
  text: string;
  keyboard?: InlineKeyboard;
}

export function buildMemoryView(runtime: AaoRuntime): TelegramView {
  const memories = runtime.service.memories;
  const items = memories.list();
  const keyboard = new InlineKeyboard();
  if (items.length === 0) {
    keyboard.text(at("memory.button_undo"), "aao:mem:undo");
    return { text: at("memory.empty"), keyboard };
  }

  const lines = [
    at("memory.heading", { count: items.length, used: memories.totalChars(), max: memories.limits.maxTotalChars }),
    "",
  ];
  let length = lines.join("\n").length;
  const shown: number[] = [];
  for (const item of items) {
    const line = `[${item.id}] ${item.text}`;
    if (length + line.length + 1 > MESSAGE_BUDGET) break;
    lines.push(line);
    length += line.length + 1;
    shown.push(item.id);
  }
  if (shown.length < items.length) lines.push(at("memory.more", { count: items.length - shown.length }));
  lines.push("", at("memory.hint"));

  shown.forEach((id, index) => {
    keyboard.text(`🗑 ${id}`, `aao:mem:del:${id}`);
    if ((index + 1) % 4 === 0) keyboard.row();
  });
  keyboard.row().text(at("memory.button_undo"), "aao:mem:undo").text(at("memory.button_refresh"), "aao:mem:list");
  return { text: lines.join("\n"), keyboard };
}

export function describeUndo(runtime: AaoRuntime): string {
  const result = runtime.service.memories.undo("telegram");
  if (result.status === "nothing") return at("undo.nothing");
  const { entry } = result;
  return at("undo.done", {
    action: at(`action.${entry.action}` as AaoI18nKey),
    id: entry.memoryId,
    text: entry.afterText ?? entry.beforeText ?? "",
  });
}

export function buildSkillCard(skill: Skill, isNew: boolean): TelegramView {
  const risk = skill.risk.length > 0 ? skill.risk.map((flag) => at(`risk.${flag}` as AaoI18nKey)).join(", ") : at("skills.risk_none");
  const preview =
    skill.body.length > SKILL_PREVIEW_CHARS ? `${skill.body.slice(0, SKILL_PREVIEW_CHARS)}\n${at("skills.truncated")}` : skill.body;
  const card = at("skills.card", { name: skill.name, id: skill.id, description: skill.description, risk, preview });
  const keyboard = new InlineKeyboard()
    .text(at("skills.button_view"), `aao:sk:view:${skill.id}`)
    .row()
    .text(at("skills.button_approve"), `aao:sk:ok:${skill.id}`)
    .text(at("skills.button_reject"), `aao:sk:no:${skill.id}`);
  return { text: isNew ? `${at("skills.new")}\n\n${card}` : card, keyboard };
}

export function buildDigest(entries: AuditEntry[], stats: { skipped: number; failed: number }, pendingCount: number): string | null {
  const groups: Record<"insert" | "update" | "delete", string[]> = { insert: [], update: [], delete: [] };
  for (const entry of entries) {
    if (entry.action === "undo" || entry.undone) continue;
    groups[entry.action].push(`- [${entry.memoryId}] ${entry.afterText ?? entry.beforeText ?? ""} (${entry.actor})`);
  }
  const sections: string[] = [];
  const add = (key: AaoI18nKey, lines: string[]) => {
    if (lines.length === 0) return;
    const shown = lines.slice(0, DIGEST_ITEMS_PER_GROUP);
    if (lines.length > shown.length) shown.push(at("memory.more", { count: lines.length - shown.length }));
    sections.push([at(key, { count: lines.length }), ...shown].join("\n"));
  };
  add("digest.added", groups.insert);
  add("digest.changed", groups.update);
  add("digest.deleted", groups.delete);
  if (stats.skipped > 0) sections.push(at("digest.skipped", { count: stats.skipped }));
  if (stats.failed > 0) sections.push(at("digest.failed", { count: stats.failed }));
  if (pendingCount > 0) sections.push(at("digest.pending", { count: pendingCount }));
  if (sections.length === 0) return null;
  return [at("digest.heading"), ...sections].join("\n\n");
}

async function sendView(api: Api, chatId: number, view: TelegramView): Promise<void> {
  await api.sendMessage(chatId, view.text, view.keyboard ? { reply_markup: view.keyboard } : {});
}

async function sendLongText(api: Api, chatId: number, text: string): Promise<void> {
  for (let offset = 0; offset < text.length; offset += SKILL_CHUNK_CHARS) {
    await api.sendMessage(chatId, text.slice(offset, offset + SKILL_CHUNK_CHARS));
  }
}

export async function handleCallback(ctx: Context, runtime: AaoRuntime): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const [, area, action, arg = ""] = data.split(":");
  const actor = `telegram:${ctx.from?.id ?? "unknown"}`;

  if (area === "mem") {
    if (action === "del") {
      const id = Number(arg);
      const result = runtime.service.memories.remove(id, "telegram");
      await ctx.answerCallbackQuery();
      await ctx.api.sendMessage(
        chatId,
        result.status === "deleted" ? at("memory.deleted", { id, text: result.memory.text }) : at("memory.not_found", { id }),
      );
    } else if (action === "undo") {
      await ctx.answerCallbackQuery();
      await ctx.api.sendMessage(chatId, describeUndo(runtime));
    } else {
      await ctx.answerCallbackQuery();
    }
    if (action === "del" || action === "undo" || action === "list") {
      await sendView(ctx.api, chatId, buildMemoryView(runtime));
    }
    return;
  }

  if (area === "sk") {
    const pending = runtime.service.skills.listPending().find((skill) => skill.id === arg);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: at("skills.gone"), show_alert: true });
      return;
    }
    if (action === "view") {
      await ctx.answerCallbackQuery();
      await sendLongText(ctx.api, chatId, `${pending.name} (${pending.id})\n\n${pending.body}`);
      return;
    }
    const decided = action === "ok" ? runtime.service.skills.approve(arg, actor) : runtime.service.skills.reject(arg, actor);
    await ctx.answerCallbackQuery();
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    }
    if (decided) {
      logger.info(`[AAO] Skill ${decided.status}: ${decided.id} by ${actor}`);
      await ctx.api.sendMessage(chatId, at(action === "ok" ? "skills.approved" : "skills.rejected", { id: decided.id }));
    }
    return;
  }

  await ctx.answerCallbackQuery();
}

function digestStatePath(runtime: AaoRuntime): string {
  return path.join(runtime.config.dataDir, "digest-state.json");
}

function readDigestState(runtime: AaoRuntime): { lastDay?: string; lastSentAt?: number } {
  try {
    return JSON.parse(fs.readFileSync(digestStatePath(runtime), "utf8")) as { lastDay?: string; lastSentAt?: number };
  } catch {
    return {};
  }
}

/** Sends the digest once per local day at or after the configured hour, only when there is news. */
export async function runDigestIfDue(runtime: AaoRuntime, api: Api, chatId: number, now = new Date()): Promise<boolean> {
  const hour = runtime.config.digestHour;
  if (hour === null || now.getHours() < hour) return false;
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const state = readDigestState(runtime);
  if (state.lastDay === day) return false;

  const since = Math.max(state.lastSentAt ?? 0, now.getTime() - 24 * 60 * 60 * 1000);
  const digest = buildDigest(
    runtime.service.memories.historySince(since),
    runtime.takeCaptureStats(),
    runtime.service.skills.listPending().length,
  );
  fs.writeFileSync(digestStatePath(runtime), JSON.stringify({ lastDay: day, lastSentAt: now.getTime() }), { mode: 0o600 });
  if (!digest) return false;
  await api.sendMessage(chatId, digest);
  return true;
}

/** Registers /memory, /undo, /skills_pending and the aao: callbacks; wires notifications and the digest. */
export function registerAaoTelegram(bot: Bot<Context>, chatId: number): void {
  const withRuntime = (handler: (ctx: Context, runtime: AaoRuntime) => Promise<void>) => async (ctx: Context) => {
    const runtime = getAaoRuntime();
    if (!runtime) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      await ctx.reply(at("memory.disabled"));
      return;
    }
    try {
      await handler(ctx, runtime);
    } catch (error) {
      logger.error("[AAO] Telegram handler failed", error);
    }
  };

  bot.command(
    "memory",
    withRuntime(async (ctx, runtime) => {
      const view = buildMemoryView(runtime);
      await ctx.reply(view.text, view.keyboard ? { reply_markup: view.keyboard } : {});
    }),
  );
  bot.command("undo", withRuntime(async (ctx, runtime) => void (await ctx.reply(describeUndo(runtime)))));
  bot.command(
    "skills_pending",
    withRuntime(async (ctx, runtime) => {
      const pending = runtime.service.skills.listPending();
      if (pending.length === 0) {
        await ctx.reply(at("skills.none"));
        return;
      }
      for (const skill of pending) await sendView(ctx.api, chatId, buildSkillCard(skill, false));
    }),
  );
  bot.callbackQuery(/^aao:/, withRuntime(handleCallback));

  const runtime = getAaoRuntime();
  if (!runtime) return;
  runtime.onSkillProposed((skill) => {
    void sendView(bot.api, chatId, buildSkillCard(skill, true)).catch((error: unknown) =>
      logger.warn(`[AAO] Failed to send skill proposal: ${skill.id}`, error),
    );
  });
  if (runtime.config.digestHour !== null) {
    const timer = setInterval(() => {
      void runDigestIfDue(runtime, bot.api, chatId).catch((error: unknown) => logger.warn("[AAO] Digest failed", error));
    }, DIGEST_CHECK_INTERVAL_MS);
    timer.unref?.();
  }
}
