import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineKeyboard, type Context } from "grammy";
import { AaoRuntime } from "../../src/aao/runtime.js";
import type { AaoConfig } from "../../src/aao/config.js";
import {
  createConfigMenu,
  isValidKeyShape,
  looksLikeLoneSecret,
  type ConfigMenuDeps,
  type Integration,
  type OpencodeConfigApi,
} from "../../src/aao/config-menu.js";
import { logger } from "../../src/utils/logger.js";
import { resetRuntimeLocale, setRuntimeLocale } from "../../src/i18n/index.js";

const KEY = "sk-TESTKEY-1234567890abcdefXYZ";
const CHAT = 42;
const MENU_MESSAGE = 900;

let runtime: AaoRuntime;
let dataDir: string;

beforeEach(() => {
  setRuntimeLocale("id");
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aao-cfg-"));
  const config: AaoConfig = {
    enabled: true,
    dataDir,
    dbPath: path.join(dataDir, "memory.db"),
    snapshotPath: path.join(dataDir, "export", "MEMORY.md"),
    mcpHost: "127.0.0.1",
    mcpPort: 0,
    mcpToken: null,
    captureEnabled: true,
    captureDailyLimit: 30,
    captureCooldownMs: 60_000,
    digestHour: null,
    readinessTimeoutMs: 1000,
    readinessMarginMs: 0,
  };
  runtime = new AaoRuntime(config);
});

afterEach(() => {
  runtime.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  resetRuntimeLocale();
  vi.restoreAllMocks();
});

function integrations(): Integration[] {
  return [
    { id: "opencode", name: "OpenCode Console", methods: [{ type: "key" }], connections: [] },
    {
      id: "deepseek",
      name: "DeepSeek",
      methods: [{ type: "key" }, { type: "env" }],
      connections: [{ type: "credential", id: "cred_abc", label: "telegram", method: "key" }],
    },
    { id: "mistral", name: "Mistral", methods: [{ type: "key" }], connections: [] },
    { id: "copilot", name: "GitHub Copilot", methods: [{ type: "oauth" }], connections: [{ type: "env", name: "GITHUB_TOKEN" }] },
  ];
}

function fakeApi(): OpencodeConfigApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    version: vi.fn(async () => "2.2.6"),
    listIntegrations: vi.fn(async () => integrations()),
    countModels: vi.fn(async () => new Map([["deepseek", 2], ["opencode", 10]])),
    connectKey: vi.fn(async (id: string) => void calls.push(`connect:${id}`)),
    deleteCredential: vi.fn(async (id: string) => void calls.push(`delete:${id}`)),
  };
}

function setup(over: Partial<ConfigMenuDeps> = {}) {
  const api = fakeApi();
  const snapshot = { kind: "inline", metadata: { menuKind: "settings", messageId: MENU_MESSAGE } };
  const deps: ConfigMenuDeps = {
    interactionManager: { getSnapshot: vi.fn(() => snapshot as never) },
    opencode: api,
    getRuntime: () => runtime,
    getCurrentModel: () => ({ providerID: "deepseek", modelID: "deepseek-flash" }),
    refreshModelCatalog: vi.fn(),
    showModelMenu: vi.fn(async () => undefined),
    buildSettingsView: () => ({ text: "Settings", keyboard: new InlineKeyboard().text("x", "settings:x") }),
    sleep: async () => undefined,
    ...over,
  };
  return { menu: createConfigMenu(deps), api, deps };
}

function callbackCtx(data: string, messageId = MENU_MESSAGE) {
  return {
    chat: { id: CHAT },
    from: { id: 7 },
    callbackQuery: { data, message: { message_id: messageId, chat: { id: CHAT } } },
    answerCallbackQuery: vi.fn(async () => true),
    editMessageText: vi.fn(async () => true),
    api: { editMessageText: vi.fn(async () => true), sendMessage: vi.fn(async () => ({})) },
  } as unknown as Context & {
    answerCallbackQuery: ReturnType<typeof vi.fn>;
    editMessageText: ReturnType<typeof vi.fn>;
  };
}

function textCtx(text: string) {
  return {
    chat: { id: CHAT },
    from: { id: 7 },
    message: { message_id: 1000, text },
    deleteMessage: vi.fn(async () => true),
    reply: vi.fn(async () => ({})),
    api: { editMessageText: vi.fn(async () => true), sendMessage: vi.fn(async () => ({})) },
  } as unknown as Context & {
    deleteMessage: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    api: { editMessageText: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> };
  };
}

const buttonsOf = (ctx: { editMessageText: ReturnType<typeof vi.fn> }) => {
  const options = ctx.editMessageText.mock.calls.at(-1)?.[1] as { reply_markup?: InlineKeyboard } | undefined;
  return (options?.reply_markup?.inline_keyboard ?? []).flat().map((b) => ("callback_data" in b ? b.callback_data : ""));
};

function spyLogs() {
  const lines: string[] = [];
  for (const level of ["debug", "info", "warn", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" "));
    });
  }
  return lines;
}

describe("looksLikeLoneSecret", () => {
  it("flags bare provider keys and long random tokens", () => {
    expect(looksLikeLoneSecret(KEY)).toBe(true);
    expect(looksLikeLoneSecret("AIzaSyA1234567890abcdefghijklmnopqrstuv")).toBe(true);
    expect(looksLikeLoneSecret("gsk_9fK2mQ7xL0pR4tV8wZ1bN6cH3jD5sA")).toBe(true);
  });

  it("lets normal prompts and links through", () => {
    expect(looksLikeLoneSecret("tolong perbaiki bug login di controller")).toBe(false);
    expect(looksLikeLoneSecret("https://github.com/mikhsanw/agent-ai-opencode/pull/3")).toBe(false);
    expect(looksLikeLoneSecret("src/app/Http/Controllers/AuthController.php")).toBe(false);
    expect(looksLikeLoneSecret("short")).toBe(false);
  });

  it("checks the key shape", () => {
    expect(isValidKeyShape(KEY)).toBe(true);
    expect(isValidKeyShape("abc")).toBe(false);
    expect(isValidKeyShape("two words here")).toBe(false);
  });
});

describe("config menu: API key input", () => {
  async function armKey(menu: ReturnType<typeof setup>["menu"], integration = "deepseek") {
    const ctx = callbackCtx(`aao:cfg:addk:${integration}`);
    await menu.handleCallback(ctx);
    expect(menu.hasPendingInput()).toBe(true);
    return ctx;
  }

  it("consumes the key: deletes the message, passes it to OpenCode once, never forwards or logs it", async () => {
    const logs = spyLogs();
    const { menu, api, deps } = setup();
    await armKey(menu);

    const ctx = textCtx(`  ${KEY}  `);
    const next = vi.fn();
    await menu.textMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.deleteMessage).toHaveBeenCalledTimes(1);
    expect(api.connectKey).toHaveBeenCalledExactlyOnceWith("deepseek", KEY);
    expect(deps.refreshModelCatalog).toHaveBeenCalled();
    const [chatId, messageId, text] = ctx.api.editMessageText.mock.calls.at(-1) ?? [];
    expect([chatId, messageId]).toEqual([CHAT, MENU_MESSAGE]);
    expect(String(text)).toContain("DeepSeek terhubung: 2 model");
    expect(menu.hasPendingInput()).toBe(false);
    expect(logs.join("\n")).not.toContain(KEY);
    expect(JSON.stringify(ctx.api.editMessageText.mock.calls)).not.toContain(KEY);
  });

  it("a command cancels the prompt and passes through", async () => {
    const { menu, api } = setup();
    await armKey(menu);
    const ctx = textCtx("/settings");
    const next = vi.fn();
    await menu.textMiddleware(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(api.connectKey).not.toHaveBeenCalled();
    expect(menu.hasPendingInput()).toBe(false);
  });

  it("rejects text that is not key-shaped without calling OpenCode", async () => {
    const { menu, api } = setup();
    await armKey(menu);
    const ctx = textCtx("ini bukan key");
    await menu.textMiddleware(ctx, vi.fn());
    expect(ctx.deleteMessage).toHaveBeenCalled();
    expect(api.connectKey).not.toHaveBeenCalled();
    expect(String(ctx.api.editMessageText.mock.calls.at(-1)?.[2])).toContain("tidak terlihat seperti API key");
  });

  it("reports an OpenCode failure without the key", async () => {
    const logs = spyLogs();
    const { menu, api } = setup();
    vi.mocked(api.connectKey).mockRejectedValueOnce(new Error("OpenCode POST /api/integration/deepseek/connect/key HTTP 400"));
    await armKey(menu);
    const ctx = textCtx(KEY);
    await menu.textMiddleware(ctx, vi.fn());
    const shown = String(ctx.api.editMessageText.mock.calls.at(-1)?.[2]);
    expect(shown).toContain("HTTP 400");
    expect(shown).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("warns when the message could not be deleted", async () => {
    const { menu } = setup();
    await armKey(menu);
    const ctx = textCtx(KEY);
    ctx.deleteMessage.mockRejectedValueOnce(new Error("too old"));
    await menu.textMiddleware(ctx, vi.fn());
    expect(String(ctx.api.editMessageText.mock.calls.at(-1)?.[2])).toContain("gagal dihapus");
  });

  it("expires after five minutes; a lone secret is then blocked instead of forwarded", async () => {
    let clock = 1_000;
    const { menu, api } = setup({ now: () => clock });
    await armKey(menu);
    clock += 5 * 60 * 1000;
    expect(menu.hasPendingInput()).toBe(false);

    const ctx = textCtx(KEY);
    const next = vi.fn();
    await menu.textMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(api.connectKey).not.toHaveBeenCalled();
    expect(ctx.deleteMessage).toHaveBeenCalled();
    expect(String(ctx.reply.mock.calls[0]?.[0])).toContain("tidak dikirim ke agen");
  });

  it("ordinary text without a pending prompt goes to the agent", async () => {
    const { menu } = setup();
    const next = vi.fn();
    await menu.textMiddleware(textCtx("buatkan migration tabel orders"), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("any other button press ends the prompt", async () => {
    const { menu } = setup();
    await armKey(menu);
    await menu.handleCallback(callbackCtx("aao:cfg:add"));
    expect(menu.hasPendingInput()).toBe(false);
  });

  it("search lists matching key providers", async () => {
    const { menu } = setup();
    await menu.handleCallback(callbackCtx("aao:cfg:search"));
    const ctx = textCtx("mist");
    await menu.textMiddleware(ctx, vi.fn());
    const options = ctx.api.editMessageText.mock.calls.at(-1)?.[3] as { reply_markup: InlineKeyboard };
    const data = options.reply_markup.inline_keyboard.flat().map((b) => ("callback_data" in b ? b.callback_data : ""));
    expect(data).toContain("aao:cfg:addk:mistral");
    expect(data).not.toContain("aao:cfg:addk:copilot");
  });
});

describe("config menu: views and actions", () => {
  it("ignores buttons on a message that is not the active /settings menu", async () => {
    const { menu, api } = setup();
    const ctx = callbackCtx("aao:cfg:pdelok:cred_abc", 1);
    await menu.handleCallback(ctx);
    expect(api.deleteCredential).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
  });

  it("root shows the active model, connected providers and the sections", async () => {
    const { menu } = setup();
    const ctx = callbackCtx("aao:cfg:root");
    await menu.handleCallback(ctx);
    const text = String(ctx.editMessageText.mock.calls[0]?.[0]);
    expect(text).toContain("deepseek/deepseek-flash");
    expect(text).toContain("DeepSeek, GitHub Copilot");
    expect(buttonsOf(ctx)).toEqual(
      expect.arrayContaining(["aao:cfg:prov", "aao:cfg:add", "aao:cfg:model", "aao:cfg:sk", "aao:cfg:status", "aao:cfg:back", "inline:cancel:settings"]),
    );
  });

  it("lists providers with a delete button for stored keys only", async () => {
    const { menu } = setup();
    const ctx = callbackCtx("aao:cfg:prov");
    await menu.handleCallback(ctx);
    const text = String(ctx.editMessageText.mock.calls[0]?.[0]);
    expect(text).toContain('DeepSeek: key "telegram" · 2 model');
    expect(text).toContain("env GITHUB_TOKEN");
    expect(buttonsOf(ctx)).toContain("aao:cfg:pdel:cred_abc");
    expect(buttonsOf(ctx).filter((d) => d.startsWith("aao:cfg:pdel:"))).toHaveLength(1);
  });

  it("asks before deleting a key and warns when the active model uses it", async () => {
    const { menu, api, deps } = setup();
    const confirm = callbackCtx("aao:cfg:pdel:cred_abc");
    await menu.handleCallback(confirm);
    expect(String(confirm.editMessageText.mock.calls[0]?.[0])).toContain("Model aktif deepseek/deepseek-flash");
    expect(api.deleteCredential).not.toHaveBeenCalled();

    await menu.handleCallback(callbackCtx("aao:cfg:pdelok:cred_abc"));
    expect(api.deleteCredential).toHaveBeenCalledExactlyOnceWith("cred_abc");
    expect(deps.refreshModelCatalog).toHaveBeenCalled();
  });

  it("offers the preset providers that accept a key", async () => {
    const { menu } = setup();
    const ctx = callbackCtx("aao:cfg:add");
    await menu.handleCallback(ctx);
    expect(buttonsOf(ctx)).toEqual(expect.arrayContaining(["aao:cfg:addk:opencode", "aao:cfg:addk:deepseek", "aao:cfg:search"]));
    const labels = (ctx.editMessageText.mock.calls[0]?.[1] as { reply_markup: InlineKeyboard }).reply_markup.inline_keyboard
      .flat()
      .map((b) => b.text);
    expect(labels).toContain("OpenCode Zen");
  });

  it("opens the upstream model picker", async () => {
    const { menu, deps } = setup();
    await menu.handleCallback(callbackCtx("aao:cfg:model"));
    expect(deps.showModelMenu).toHaveBeenCalledTimes(1);
  });

  it("back returns to the upstream settings view", async () => {
    const { menu } = setup();
    const ctx = callbackCtx("aao:cfg:back");
    await menu.handleCallback(ctx);
    expect(ctx.editMessageText.mock.calls[0]?.[0]).toBe("Settings");
    expect(buttonsOf(ctx)).toEqual(["settings:x", "inline:cancel:settings"]);
  });

  it("status shows version, model, providers, memory and skills", async () => {
    runtime.service.memories.write({ text: "Pengguna memakai Laravel.", actor: "telegram" });
    const { menu } = setup();
    const ctx = callbackCtx("aao:cfg:status");
    await menu.handleCallback(ctx);
    const text = String(ctx.editMessageText.mock.calls[0]?.[0]);
    expect(text).toContain("2.2.6");
    expect(text).toContain("deepseek/deepseek-flash");
    expect(text).toContain("1 entri");
    expect(text).toContain("0 aktif, 0 menunggu");
  });

  it("lists learned skills and approves, revokes after confirmation", async () => {
    const skills = runtime.service.skills;
    skills.propose({ id: "deploy-laravel", name: "Deploy Laravel", description: "d", body: "1. test", actor: "tool" });
    skills.propose({ id: "cek-log", name: "Cek log", description: "d", body: "1. tail", actor: "tool" });
    skills.approve("cek-log", "test");
    const { menu } = setup();

    const list = callbackCtx("aao:cfg:sk");
    await menu.handleCallback(list);
    expect(String(list.editMessageText.mock.calls[0]?.[0])).toContain("Aktif (1)");
    expect(buttonsOf(list)).toEqual(
      expect.arrayContaining(["aao:sk:view:cek-log", "aao:cfg:skrv:cek-log", "aao:cfg:skok:deploy-laravel", "aao:cfg:skno:deploy-laravel"]),
    );

    await menu.handleCallback(callbackCtx("aao:cfg:skok:deploy-laravel"));
    expect(skills.listApproved().map((s) => s.id)).toEqual(["cek-log", "deploy-laravel"]);

    const confirm = callbackCtx("aao:cfg:skrv:cek-log");
    await menu.handleCallback(confirm);
    expect(skills.getApproved("cek-log")).toBeDefined();
    expect(buttonsOf(confirm)).toContain("aao:cfg:skrvok:cek-log");

    await menu.handleCallback(callbackCtx("aao:cfg:skrvok:cek-log"));
    expect(skills.getApproved("cek-log")).toBeUndefined();
  });

  it("never sends an empty button row", async () => {
    const { menu } = setup();
    for (const data of ["aao:cfg:root", "aao:cfg:prov", "aao:cfg:add", "aao:cfg:sk", "aao:cfg:status"]) {
      const ctx = callbackCtx(data);
      await menu.handleCallback(ctx);
      const options = ctx.editMessageText.mock.calls[0]?.[1] as { reply_markup: InlineKeyboard };
      expect(options.reply_markup.inline_keyboard.every((row) => row.length > 0), data).toBe(true);
    }
  });

  it("works without memory: skills say memory is off", async () => {
    const { menu } = setup({ getRuntime: () => null });
    const ctx = callbackCtx("aao:cfg:sk");
    await menu.handleCallback(ctx);
    expect(String(ctx.editMessageText.mock.calls[0]?.[0])).toContain("Memori tidak aktif");
  });
});
