import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AaoRuntime } from "../../src/aao/runtime.js";
import type { AaoConfig } from "../../src/aao/config.js";

const runtimes: AaoRuntime[] = [];
const dirs: string[] = [];

afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.stop());
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

export function testAaoConfig(overrides: Partial<AaoConfig> = {}): AaoConfig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aao-bot-"));
  dirs.push(dataDir);
  return {
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
    digestHour: 20,
    readinessTimeoutMs: 1000,
    readinessMarginMs: 0,
    ...overrides,
  };
}

async function connect(url: string, token: string) {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  // The SDK's transport type predates exactOptionalPropertyTypes (sessionId?: string).
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
  return client;
}

describe("aao/runtime", () => {
  it("generates a persistent 0600 token and writes the OpenCode config snippet", async () => {
    const config = testAaoConfig();
    const runtime = new AaoRuntime(config);
    runtimes.push(runtime);
    await runtime.listen();

    const tokenPath = path.join(config.dataDir, "mcp-token");
    const token = fs.readFileSync(tokenPath, "utf8");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);

    const snippetPath = path.join(config.dataDir, "opencode-memory.json");
    expect(fs.statSync(snippetPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(snippetPath, "utf8"))).toEqual({
      instructions: [config.snapshotPath],
      permissions: [{ action: "skill", resource: "*", effect: "deny" }],
      mcp: { servers: { memory: { type: "remote", url: runtime.url, headers: { Authorization: `Bearer ${token}` } } } },
    });
    expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    runtime.stop();
    runtimes.pop();
    const again = new AaoRuntime(config);
    runtimes.push(again);
    await again.listen();
    expect(fs.readFileSync(tokenPath, "utf8")).toBe(token);
  });

  it("counts tools/list calls and wakes readiness waiters", async () => {
    const runtime = new AaoRuntime(testAaoConfig({ mcpToken: "t".repeat(32) }));
    runtimes.push(runtime);
    await runtime.listen();
    const before = runtime.getToolsListCount();
    const waiting = runtime.waitForToolsList(before, 5000);
    const client = await connect(runtime.url!, "t".repeat(32));
    await client.listTools();
    await expect(waiting).resolves.toBe(true);
    expect(runtime.getToolsListCount()).toBe(before + 1);
    await expect(runtime.waitForToolsList(runtime.getToolsListCount(), 50)).resolves.toBe(false);
    await client.close();
  });

  it("rejects MCP requests without the token", async () => {
    const runtime = new AaoRuntime(testAaoConfig({ mcpToken: "t".repeat(32) }));
    runtimes.push(runtime);
    await runtime.listen();
    expect((await fetch(runtime.url!, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("notifies once per new skill proposal, not on unrelated changes", async () => {
    const runtime = new AaoRuntime(testAaoConfig({ mcpToken: "t".repeat(32) }));
    runtimes.push(runtime);
    await runtime.listen();
    const proposed: string[] = [];
    runtime.onSkillProposed((skill) => proposed.push(skill.id));

    const client = await connect(runtime.url!, "t".repeat(32));
    await client.callTool({
      name: "skill_propose",
      arguments: { id: "cek-log", name: "Cek log", description: "Membaca log.", body: "1. Buka storage/logs." },
    });
    await client.callTool({ name: "memory_write", arguments: { text: "Pengguna memakai Laravel 11." } });
    await client.close();

    expect(proposed).toEqual(["cek-log"]);
    expect(runtime.service.memories.list()).toHaveLength(1);
    expect(fs.readFileSync(runtime.config.snapshotPath, "utf8")).toContain("- [1] Pengguna memakai Laravel 11.");
  });

  it("does not re-notify proposals that were already pending at startup", async () => {
    const config = testAaoConfig();
    const first = new AaoRuntime(config);
    first.service.skills.propose({ id: "lama", name: "Lama", description: "d", body: "b", actor: "tool" });
    first.stop();

    const runtime = new AaoRuntime(config);
    runtimes.push(runtime);
    const proposed: string[] = [];
    runtime.onSkillProposed((skill) => proposed.push(skill.id));
    runtime.service.memories.write({ text: "Pengguna memakai Vim.", actor: "tool" });
    expect(proposed).toEqual([]);
  });
});
