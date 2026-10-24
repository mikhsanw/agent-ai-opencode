import { logger } from "../utils/logger.js";

export interface ReadinessDeps {
  /** GET a JSON document from the OpenCode V2 API. */
  getJson: (path: string, query?: Record<string, string>) => Promise<unknown>;
  /** tools/list calls answered by the memory MCP server at or after `sinceMs`. */
  toolsListSince: (sinceMs: number) => number;
  /** Epoch ms of the last tools/list call (0 = never). */
  lastToolsListAt: () => number;
  /** Epoch ms of the first MCP `initialize` received after `afterMs`, or null. */
  firstInitializeAfter: (afterMs: number) => number | null;
  /** Resolves true once toolsListSince(sinceMs) >= count. */
  waitForToolsListSince: (sinceMs: number, count: number, timeoutMs: number) => Promise<boolean>;
  /** Locations already loaded when the memory runtime started; their catalog is assumed ready. */
  baseline: ReadonlySet<string>;
  /** When the memory runtime started listening. */
  startedAt: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
  marginMs: number;
}

function readDirectory(body: unknown): string | null {
  const data = (body as { data?: { location?: { directory?: unknown } } } | null)?.data;
  const directory = data?.location?.directory;
  return typeof directory === "string" ? directory : null;
}

function readPid(body: unknown): number | null {
  const record = body as { pid?: unknown; data?: { pid?: unknown } } | null;
  const pid = record?.data?.pid ?? record?.pid;
  return typeof pid === "number" ? pid : null;
}

export function readLoadedDirectories(body: unknown): string[] {
  const list = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((item) => (item as { directory?: unknown } | null)?.directory)
    .filter((directory): directory is string => typeof directory === "string");
}

/**
 * Gate run before every prompt (PRD K15). OpenCode V2.1.2 reports the memory MCP server as
 * `connected` before its tools are in the Code Mode catalog, so a prompt right after a location
 * loads can get "Unknown tool". Locations load lazily (session creation, event subscription,
 * any API call with that directory); each load makes OpenCode call `initialize` then
 * `tools/list` on our server, and the catalog needs a short moment after that.
 *
 * Invariant: within one OpenCode process ("epoch"), every location loaded since the epoch began
 * produced one tools/list. Fewer tools/list calls than such locations means a catalog is still
 * loading: wait for it. A restart (new pid) starts a new epoch at its first `initialize`.
 * A tools/list less than the margin ago: wait out the rest of the margin.
 *
 * Known gap: a location evicted and reloaded inside one epoch is not detected; the model then
 * sees OpenCode's own "Unknown tool, use search" hint and auto-capture still runs afterwards.
 */
export function createReadinessGate(deps: ReadinessDeps): (sessionId: string) => Promise<void> {
  const sessionDirectories = new Map<string, string>();
  let pid: number | null = null;
  let epochStart = deps.startedAt;
  let baseline: ReadonlySet<string> = deps.baseline;
  let lastCheckAt = deps.startedAt;

  return async (sessionId) => {
    const currentPid = readPid(await deps.getJson("/api/info"));
    if (pid === null) {
      pid = currentPid;
    } else if (currentPid !== null && currentPid !== pid) {
      epochStart = deps.firstInitializeAfter(lastCheckAt) ?? deps.now();
      baseline = new Set();
      logger.info(`[AAO] OpenCode restart detected (pid ${pid} -> ${currentPid}); waiting for fresh tool catalogs`);
      pid = currentPid;
    }
    lastCheckAt = deps.now();

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
    if (!loaded.includes(directory)) {
      await deps.getJson("/api/mcp", { directory });
      loaded.push(directory);
    }

    let waited = false;
    const fresh = loaded.filter((dir) => !baseline.has(dir)).length;
    if (deps.toolsListSince(epochStart) < fresh) {
      const listed = await deps.waitForToolsListSince(epochStart, fresh, deps.timeoutMs);
      if (!listed) {
        logger.warn(`[AAO] Memory tools not listed within ${deps.timeoutMs}ms: directory=${directory}`);
        return;
      }
      waited = true;
    }

    const lastListedAt = deps.lastToolsListAt();
    const sinceLast = deps.now() - lastListedAt;
    if (lastListedAt > 0 && sinceLast < deps.marginMs) {
      await deps.sleep(deps.marginMs - sinceLast);
      waited = true;
    }
    if (waited) {
      logger.info(`[AAO] Memory tools ready for location: directory=${directory}`);
    }
  };
}
