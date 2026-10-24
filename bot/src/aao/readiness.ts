import { logger } from "../utils/logger.js";

export interface ReadinessDeps {
  /** GET a JSON document from the OpenCode V2 API. */
  getJson: (path: string, query?: Record<string, string>) => Promise<unknown>;
  getToolsListCount: () => number;
  /** Resolves true once the memory MCP server has answered more than `after` tools/list calls. */
  waitForToolsList: (after: number, timeoutMs: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  marginMs: number;
}

function readDirectory(body: unknown): string | null {
  const data = (body as { data?: { location?: { directory?: unknown } } } | null)?.data;
  const directory = data?.location?.directory;
  return typeof directory === "string" ? directory : null;
}

function readLoadedDirectories(body: unknown): string[] {
  const list = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((item) => (item as { directory?: unknown } | null)?.directory)
    .filter((directory): directory is string => typeof directory === "string");
}

/**
 * Gate run before every prompt. OpenCode V2.1.2 reports the memory MCP server as `connected`
 * before its tools are in the Code Mode catalog, so the first prompt of a freshly loaded
 * location can get "Unknown tool". Locations load lazily; loading one makes OpenCode call
 * tools/list on our server, after which the catalog needs a short moment (PRD K15).
 *
 * Already loaded location: no wait. Otherwise: load it, wait for tools/list, then a margin.
 */
export function createReadinessGate(deps: ReadinessDeps): (sessionId: string) => Promise<void> {
  const sessionDirectories = new Map<string, string>();

  return async (sessionId) => {
    let directory = sessionDirectories.get(sessionId);
    if (!directory) {
      const found = readDirectory(await deps.getJson(`/api/session/${encodeURIComponent(sessionId)}`));
      if (!found) {
        logger.debug(`[AAO] Readiness: no directory for session=${sessionId}`);
        return;
      }
      directory = found;
      sessionDirectories.set(sessionId, directory);
    }

    const loaded = readLoadedDirectories(await deps.getJson("/api/debug/location"));
    if (loaded.includes(directory)) {
      return;
    }

    const before = deps.getToolsListCount();
    await deps.getJson("/api/mcp", { directory });
    const listed = await deps.waitForToolsList(before, deps.timeoutMs);
    if (!listed) {
      logger.warn(`[AAO] Memory tools not listed within ${deps.timeoutMs}ms: directory=${directory}`);
      return;
    }
    await deps.sleep(deps.marginMs);
    logger.info(`[AAO] Memory tools ready for location: directory=${directory}`);
  };
}
