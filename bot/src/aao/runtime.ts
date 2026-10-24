import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  captureFromSession,
  createMcpHttpHandler,
  createOpencodeGenerateClient,
  openMemoryService,
  type MemoryService,
  type Skill,
} from "@aao/memory";
import { config } from "../config.js";
import { getRuntimePaths } from "../runtime/paths.js";
import { logger } from "../utils/logger.js";
import { createCaptureScheduler, type CaptureStats } from "./capture.js";
import { loadAaoConfig, type AaoConfig } from "./config.js";
import { setAaoIdleListener, setAaoPromptGate } from "./hooks.js";
import { getOpencodeJson } from "./opencode-http.js";
import { createReadinessGate, readLoadedDirectories } from "./readiness.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MAX_TRACKED_EVENTS = 500;

function pushBounded(list: number[], value: number): void {
  list.push(value);
  if (list.length > MAX_TRACKED_EVENTS) list.splice(0, list.length - MAX_TRACKED_EVENTS);
}

/**
 * Memory runtime living inside the bot process (OS user of the bot, never the agent):
 * the SQLite store, the MCP HTTP endpoint OpenCode connects to, the readiness gate and
 * auto-capture. Telegram handlers reach it through getAaoRuntime().
 */
export class AaoRuntime {
  readonly service: MemoryService;
  private server: http.Server | null = null;
  private toolsListCount = 0;
  private lastToolsListAt = 0;
  /** Recent MCP request timestamps, used by the readiness gate (bounded). */
  private readonly toolsListTimes: number[] = [];
  private readonly initializeTimes: number[] = [];
  private readonly toolsListWaiters = new Set<() => void>();
  startedAt = 0;
  private knownPending: Set<string>;
  private skillProposedListener: ((skill: Skill) => void) | null = null;
  private captureStatsSource: (() => CaptureStats) | null = null;
  url: string | null = null;

  constructor(readonly config: AaoConfig) {
    this.service = openMemoryService({ dbPath: config.dbPath, snapshotPath: config.snapshotPath });
    this.knownPending = new Set(this.service.skills.listPending().map((skill) => skill.id));
    this.service.onChange(() => this.checkNewProposals());
  }

  async listen(): Promise<void> {
    const token = this.ensureToken();
    const handler = createMcpHttpHandler(this.service, {
      token,
      onRequest: (methods) => {
        const now = Date.now();
        if (methods.includes("initialize")) {
          pushBounded(this.initializeTimes, now);
        }
        if (methods.includes("tools/list")) {
          this.toolsListCount++;
          this.lastToolsListAt = now;
          pushBounded(this.toolsListTimes, now);
          for (const wake of [...this.toolsListWaiters]) wake();
        }
      },
    });
    this.server = http.createServer((req, res) => {
      handler(req, res).catch((error: unknown) => {
        logger.warn("[AAO] Memory MCP request failed", error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.mcpPort, this.config.mcpHost, () => resolve());
    });
    this.startedAt = Date.now();
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : this.config.mcpPort;
    this.url = `http://${this.config.mcpHost}:${port}/mcp`;
    const snippetPath = this.writeOpencodeConfigSnippet(token);
    logger.info(`[AAO] Memory MCP listening on ${this.url}; OpenCode config snippet: ${snippetPath}`);
  }

  getToolsListCount(): number {
    return this.toolsListCount;
  }

  getLastToolsListAt(): number {
    return this.lastToolsListAt;
  }

  toolsListSince(sinceMs: number): number {
    return this.toolsListTimes.filter((at) => at >= sinceMs).length;
  }

  firstInitializeAfter(afterMs: number): number | null {
    return this.initializeTimes.find((at) => at > afterMs) ?? null;
  }

  waitForToolsList(after: number, timeoutMs: number): Promise<boolean> {
    return this.waitUntil(() => this.toolsListCount > after, timeoutMs);
  }

  waitForToolsListSince(sinceMs: number, count: number, timeoutMs: number): Promise<boolean> {
    return this.waitUntil(() => this.toolsListSince(sinceMs) >= count, timeoutMs);
  }

  private waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    if (condition()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => {
        if (condition()) finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (value: boolean) => {
        clearTimeout(timer);
        this.toolsListWaiters.delete(wake);
        resolve(value);
      };
      this.toolsListWaiters.add(wake);
    });
  }

  onSkillProposed(listener: ((skill: Skill) => void) | null): void {
    this.skillProposedListener = listener;
  }

  setCaptureStatsSource(source: () => CaptureStats): void {
    this.captureStatsSource = source;
  }

  takeCaptureStats(): CaptureStats {
    return this.captureStatsSource?.() ?? { saved: 0, skipped: 0, failed: 0 };
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.service.close();
  }

  private checkNewProposals(): void {
    const pending = this.service.skills.listPending();
    const fresh = pending.filter((skill) => !this.knownPending.has(skill.id));
    this.knownPending = new Set(pending.map((skill) => skill.id));
    for (const skill of fresh) {
      logger.info(`[AAO] Skill proposed: ${skill.id} (risk: ${skill.risk.join(",") || "none"})`);
      try {
        this.skillProposedListener?.(skill);
      } catch (error) {
        logger.warn(`[AAO] Skill notification failed: ${skill.id}`, error);
      }
    }
  }

  private ensureToken(): string {
    if (this.config.mcpToken) return this.config.mcpToken;
    const tokenPath = path.join(this.config.dataDir, "mcp-token");
    try {
      const existing = fs.readFileSync(tokenPath, "utf8").trim();
      if (existing.length >= 16) return existing;
    } catch {
      // generated below
    }
    fs.mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString("hex");
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    return token;
  }

  /** The exact OpenCode config entries this runtime expects (contains the token: 0600). */
  private writeOpencodeConfigSnippet(token: string): string {
    const snippetPath = path.join(this.config.dataDir, "opencode-memory.json");
    const snippet = {
      instructions: [this.config.snapshotPath],
      permissions: [{ action: "skill", resource: "*", effect: "deny" }],
      mcp: { servers: { memory: { type: "remote", url: this.url, headers: { Authorization: `Bearer ${token}` } } } },
    };
    fs.writeFileSync(snippetPath, `${JSON.stringify(snippet, null, 2)}\n`, { mode: 0o600 });
    return snippetPath;
  }
}

let runtime: AaoRuntime | null = null;

export function getAaoRuntime(): AaoRuntime | null {
  return runtime;
}

/** Starts the memory runtime (before the Telegram bot is created). Never throws. */
export async function startAao(env: NodeJS.ProcessEnv = process.env): Promise<AaoRuntime | null> {
  let aaoConfig: AaoConfig;
  try {
    if (config.opencode.serverVersion !== "v2") {
      logger.warn("[AAO] Memory needs OpenCode V2 (OPENCODE_SERVER_VERSION=v2); memory disabled");
      return null;
    }
    aaoConfig = loadAaoConfig(env, getRuntimePaths().appHome);
    if (!aaoConfig.enabled) {
      logger.info("[AAO] Memory disabled (AAO_MEMORY_ENABLED=false)");
      return null;
    }
    const instance = new AaoRuntime(aaoConfig);
    await instance.listen();
    runtime = instance;
  } catch (error) {
    logger.error("[AAO] Failed to start memory runtime; continuing without memory", error);
    return null;
  }

  const active = runtime;
  // Locations OpenCode already loaded before this runtime existed listed their tools earlier.
  const baseline = new Set(
    readLoadedDirectories(await getOpencodeJson("/api/debug/location").catch(() => [])),
  );
  setAaoPromptGate(
    createReadinessGate({
      getJson: getOpencodeJson,
      toolsListSince: (since) => active.toolsListSince(since),
      lastToolsListAt: () => active.getLastToolsListAt(),
      firstInitializeAfter: (after) => active.firstInitializeAfter(after),
      waitForToolsListSince: (since, count, timeoutMs) => active.waitForToolsListSince(since, count, timeoutMs),
      baseline,
      startedAt: active.startedAt,
      sleep,
      now: Date.now,
      timeoutMs: aaoConfig.readinessTimeoutMs,
      marginMs: aaoConfig.readinessMarginMs,
    }),
  );

  if (aaoConfig.captureEnabled && aaoConfig.captureDailyLimit > 0) {
    const client = createOpencodeGenerateClient({
      baseUrl: config.opencode.apiUrl,
      username: config.opencode.username,
      password: config.opencode.password ?? "",
    });
    const scheduler = createCaptureScheduler({
      runCapture: (sessionId) => captureFromSession({ client, sessionId, store: active.service.memories }),
      dailyLimit: aaoConfig.captureDailyLimit,
      cooldownMs: aaoConfig.captureCooldownMs,
      now: Date.now,
    });
    setAaoIdleListener((sessionId, interrupted) => {
      void scheduler.onIdle(sessionId, interrupted);
    });
    active.setCaptureStatsSource(scheduler.takeStats);
  }
  return active;
}

export function stopAao(): void {
  setAaoPromptGate(null);
  setAaoIdleListener(null);
  runtime?.stop();
  runtime = null;
}
