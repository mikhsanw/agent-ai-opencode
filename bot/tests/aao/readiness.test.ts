import { describe, expect, it, vi } from "vitest";
import { createReadinessGate, readLoadedDirectories, type ReadinessDeps } from "../../src/aao/readiness.js";

const DIR = "/srv/workspace/app";
const STARTED = 1_000_000;

/** Fake OpenCode + MCP event timeline. */
function setup(options: {
  loaded: string[];
  baseline?: string[];
  toolsList?: number[];
  initialize?: number[];
  pid?: number;
  now?: number;
  listOnWait?: boolean;
  directory?: string | null;
}) {
  const calls: string[] = [];
  const state = {
    now: options.now ?? STARTED + 60_000,
    pid: options.pid ?? 100,
    loaded: [...options.loaded],
    toolsList: [...(options.toolsList ?? [])],
    initialize: [...(options.initialize ?? [])],
  };
  const deps: ReadinessDeps = {
    getJson: vi.fn(async (path: string, query?: Record<string, string>) => {
      calls.push(query ? `${path}?directory=${query.directory}` : path);
      if (path === "/api/info") return { data: { pid: state.pid } };
      if (path.startsWith("/api/session/")) {
        return options.directory === null ? { data: {} } : { data: { location: { directory: options.directory ?? DIR } } };
      }
      if (path === "/api/debug/location") return state.loaded.map((directory) => ({ directory }));
      return { data: [] };
    }),
    toolsListSince: (since) => state.toolsList.filter((at) => at >= since).length,
    lastToolsListAt: () => state.toolsList.at(-1) ?? 0,
    firstInitializeAfter: (after) => state.initialize.find((at) => at > after) ?? null,
    waitForToolsListSince: vi.fn(async (since: number, count: number) => {
      calls.push(`wait since=${since - STARTED} count=${count}`);
      if (options.listOnWait === false) return false;
      state.toolsList.push(state.now); // the catalog arrives "now"
      return true;
    }),
    baseline: new Set(options.baseline ?? []),
    startedAt: STARTED,
    sleep: vi.fn(async (ms: number) => void calls.push(`sleep:${ms}`)),
    now: () => state.now,
    timeoutMs: 10_000,
    marginMs: 1000,
  };
  const relevant = () => calls.filter((c) => c !== "/api/info");
  return { gate: createReadinessGate(deps), calls, relevant, state };
}

describe("aao/readiness", () => {
  it("does not wait for a location loaded before the runtime started", async () => {
    const { gate, relevant } = setup({ loaded: [DIR], baseline: [DIR] });
    await gate("ses_1");
    expect(relevant()).toEqual(["/api/session/ses_1", "/api/debug/location"]);
  });

  it("does not wait when every fresh location listed its tools long ago", async () => {
    const { gate, relevant } = setup({ loaded: [DIR], toolsList: [STARTED + 1000] });
    await gate("ses_1");
    expect(relevant()).toEqual(["/api/session/ses_1", "/api/debug/location"]);
  });

  it("race: location just loaded by session creation, its tools/list not seen yet", async () => {
    const { gate, relevant } = setup({ loaded: ["/srv/old", DIR], baseline: ["/srv/old"] });
    await gate("ses_1");
    expect(relevant()).toEqual(["/api/session/ses_1", "/api/debug/location", "wait since=0 count=1", "sleep:1000"]);
  });

  it("project switch: a second fresh location needs its own tools/list", async () => {
    const { gate, relevant } = setup({ loaded: ["/srv/a", DIR], toolsList: [STARTED + 1000] });
    await gate("ses_1");
    expect(relevant()).toContain("wait since=0 count=2");
  });

  it("cold location: loads it, then waits for its tools/list and the margin", async () => {
    const { gate, relevant } = setup({ loaded: [] });
    await gate("ses_1");
    expect(relevant()).toEqual([
      "/api/session/ses_1",
      "/api/debug/location",
      `/api/mcp?directory=${DIR}`,
      "wait since=0 count=1",
      "sleep:1000",
    ]);
  });

  it("waits out the rest of the margin after a recent tools/list", async () => {
    const now = STARTED + 60_000;
    const { gate, relevant } = setup({ loaded: [DIR], toolsList: [now - 300], now });
    await gate("ses_1");
    expect(relevant().at(-1)).toBe("sleep:700");
  });

  it("OpenCode restart (new pid): old tools/list calls no longer count", async () => {
    const { gate, relevant, state } = setup({ loaded: [DIR], toolsList: [STARTED + 1000] });
    await gate("ses_1"); // first call learns pid 100, nothing to wait for
    expect(relevant()).not.toContain("wait since=0 count=1");

    state.pid = 200; // restarted; the new process initialized at +70s, catalog not listed yet
    state.initialize.push(STARTED + 70_000);
    state.now = STARTED + 70_100;
    await gate("ses_1");
    expect(relevant()).toContain("wait since=70000 count=1");
  });

  it("gives up after the timeout (prompt still goes out)", async () => {
    const { gate, relevant } = setup({ loaded: [], listOnWait: false });
    await gate("ses_1");
    expect(relevant().at(-1)).toBe("wait since=0 count=1");
  });

  it("caches the session directory and returns quietly without one", async () => {
    const cached = setup({ loaded: [DIR], baseline: [DIR] });
    await cached.gate("ses_1");
    await cached.gate("ses_1");
    expect(cached.relevant().filter((c) => c.startsWith("/api/session/"))).toHaveLength(1);

    const none = setup({ loaded: [], directory: null });
    await none.gate("ses_1");
    expect(none.relevant()).toEqual(["/api/session/ses_1"]);
  });

  it("reads both plain and wrapped location lists", () => {
    expect(readLoadedDirectories([{ directory: "/a" }, {}])).toEqual(["/a"]);
    expect(readLoadedDirectories({ data: [{ directory: "/b" }] })).toEqual(["/b"]);
    expect(readLoadedDirectories(null)).toEqual([]);
  });
});
