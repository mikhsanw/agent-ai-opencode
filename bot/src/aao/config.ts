import path from "node:path";

export interface AaoConfig {
  enabled: boolean;
  dataDir: string;
  dbPath: string;
  snapshotPath: string;
  mcpHost: string;
  mcpPort: number;
  /** Optional fixed token; otherwise one is generated and kept in `<dataDir>/mcp-token`. */
  mcpToken: string | null;
  captureEnabled: boolean;
  captureDailyLimit: number;
  captureCooldownMs: number;
  /** Local hour (0-23) for the daily digest; null disables it. */
  digestHour: number | null;
  readinessTimeoutMs: number;
  readinessMarginMs: number;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function loadAaoConfig(env: NodeJS.ProcessEnv, appHome: string): AaoConfig {
  const dataDir = env.AAO_DATA_DIR?.trim() || path.join(appHome, "aao");
  const digest = integer(env.AAO_DIGEST_HOUR, 20, -1, 23);
  const token = env.AAO_MCP_TOKEN?.trim() ?? "";
  return {
    enabled: flag(env.AAO_MEMORY_ENABLED, true),
    dataDir,
    dbPath: path.join(dataDir, "memory.db"),
    snapshotPath: env.AAO_SNAPSHOT_PATH?.trim() || path.join(dataDir, "export", "MEMORY.md"),
    mcpHost: "127.0.0.1",
    mcpPort: integer(env.AAO_MCP_PORT, 18090, 1, 65535),
    mcpToken: token.length >= 16 ? token : null,
    captureEnabled: flag(env.AAO_CAPTURE_ENABLED, true),
    captureDailyLimit: integer(env.AAO_CAPTURE_DAILY_LIMIT, 30, 0, 1000),
    captureCooldownMs: 60_000,
    digestHour: digest < 0 ? null : digest,
    readinessTimeoutMs: 10_000,
    // Measured on OpenCode 2.1.2: the Code Mode catalog needs <= 250 ms after tools/list (PRD K15).
    readinessMarginMs: integer(env.AAO_READINESS_MARGIN_MS, 1000, 0, 10_000),
  };
}
