import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAaoConfig } from "../../src/aao/config.js";
import { AAO_DICTIONARIES, at } from "../../src/aao/i18n.js";
import { getAaoCommandDefinitions } from "../../src/aao/commands.js";
import { BOT_COMMANDS, BUILT_IN_COMMAND_NAMES } from "../../src/bot/commands/definitions.js";
import { resetRuntimeLocale, setRuntimeLocale } from "../../src/i18n/index.js";

afterEach(() => resetRuntimeLocale());

describe("aao/config", () => {
  it("uses safe defaults under the bot home", () => {
    const config = loadAaoConfig({}, "/home/bot/.config/opencode-telegram-bot");
    expect(config).toMatchObject({
      enabled: true,
      dataDir: path.join("/home/bot/.config/opencode-telegram-bot", "aao"),
      mcpHost: "127.0.0.1",
      mcpPort: 18090,
      mcpToken: null,
      captureEnabled: true,
      captureDailyLimit: 30,
      digestHour: 20,
      readinessMarginMs: 1000,
    });
    expect(config.snapshotPath).toBe(path.join(config.dataDir, "export", "MEMORY.md"));
  });

  it("reads overrides and clamps invalid values", () => {
    const config = loadAaoConfig(
      {
        AAO_MEMORY_ENABLED: "false",
        AAO_CAPTURE_ENABLED: "0",
        AAO_MCP_PORT: "99999",
        AAO_DIGEST_HOUR: "-1",
        AAO_MCP_TOKEN: "pendek",
        AAO_SNAPSHOT_PATH: "/var/lib/aao/MEMORY.md",
      },
      "/x",
    );
    expect(config).toMatchObject({
      enabled: false,
      captureEnabled: false,
      mcpPort: 65535,
      digestHour: null,
      mcpToken: null,
      snapshotPath: "/var/lib/aao/MEMORY.md",
    });
    expect(loadAaoConfig({ AAO_MCP_TOKEN: "x".repeat(16) }, "/x").mcpToken).toBe("x".repeat(16));
  });
});

describe("aao/i18n and commands", () => {
  it("Indonesian dictionary uses the same placeholders as English", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, value] of Object.entries(AAO_DICTIONARIES.en)) {
      expect(placeholders(AAO_DICTIONARIES.id[key as keyof typeof AAO_DICTIONARIES.en]), key).toEqual(placeholders(value));
    }
  });

  it("follows the bot locale and falls back to English", () => {
    setRuntimeLocale("id");
    expect(at("memory.heading", { count: 2, used: 40, max: 4000 })).toBe("🧠 Memori (2 entri, 40/4000 karakter)");
    setRuntimeLocale("de");
    expect(at("undo.nothing")).toBe("Nothing to undo.");
  });

  it("registers the aao commands in the central command list", () => {
    expect(getAaoCommandDefinitions().map((c) => c.command)).toEqual(["memory", "undo", "skills_pending"]);
    for (const name of ["memory", "undo", "skills_pending"]) {
      expect(BUILT_IN_COMMAND_NAMES).toContain(name);
      expect(BOT_COMMANDS.map((c) => c.command)).toContain(name);
    }
  });
});
