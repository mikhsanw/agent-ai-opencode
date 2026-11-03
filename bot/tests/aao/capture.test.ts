import { describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "@aao/memory";
import { createCaptureScheduler } from "../../src/aao/capture.js";

const ok = (sessionId: string, saved: string[] = [], skipped = 0): CaptureResult => ({
  sessionId,
  ok: true,
  saved,
  skipped: Array.from({ length: skipped }, (_, i) => ({ text: `x${i}`, reason: "similar" })),
});

function setup(overrides: { dailyLimit?: number; result?: (id: string) => Promise<CaptureResult> } = {}) {
  let clock = new Date(2026, 9, 24, 10, 0, 0).getTime();
  const runCapture = vi.fn(overrides.result ?? (async (id: string) => ok(id, ["fakta"])));
  const scheduler = createCaptureScheduler({
    runCapture,
    dailyLimit: overrides.dailyLimit ?? 30,
    cooldownMs: 60_000,
    now: () => clock,
  });
  return { scheduler, runCapture, advance: (ms: number) => (clock += ms) };
}

describe("aao/capture scheduler", () => {
  it("captures finished runs but not interrupted ones", async () => {
    const { scheduler, runCapture } = setup();
    expect(scheduler.onIdle("s1", true)).toBeUndefined();
    await scheduler.onIdle("s1", false);
    expect(runCapture).toHaveBeenCalledTimes(1);
    expect(runCapture).toHaveBeenCalledWith("s1");
  });

  it("keeps one capture per session in flight and applies the cooldown", async () => {
    let release!: () => void;
    const { scheduler, runCapture, advance } = setup({
      result: (id) => new Promise((resolve) => (release = () => resolve(ok(id)))),
    });
    const first = scheduler.onIdle("s1", false);
    expect(scheduler.onIdle("s1", false)).toBeUndefined();
    release();
    await first;
    advance(30_000);
    expect(scheduler.onIdle("s1", false)).toBeUndefined();
    advance(31_000);
    const third = scheduler.onIdle("s1", false);
    release();
    await third;
    expect(runCapture).toHaveBeenCalledTimes(2);
  });

  it("enforces the daily limit and resets it the next day", async () => {
    const { scheduler, runCapture, advance } = setup({ dailyLimit: 2 });
    await scheduler.onIdle("a", false);
    await scheduler.onIdle("b", false);
    expect(scheduler.onIdle("c", false)).toBeUndefined();
    advance(24 * 60 * 60 * 1000);
    await scheduler.onIdle("c", false);
    expect(runCapture).toHaveBeenCalledTimes(3);
  });

  it("collects stats (saved, skipped, failed) and resets them when taken", async () => {
    const results = [ok("a", ["f1", "f2"], 1), { ...ok("b"), ok: false, error: "respons kosong" }];
    const { scheduler } = setup({ result: async () => results.shift()! });
    await scheduler.onIdle("a", false);
    await scheduler.onIdle("b", false);
    const crashing = setup({ result: async () => Promise.reject(new Error("ECONNREFUSED")) });
    await crashing.scheduler.onIdle("c", false);

    expect(scheduler.takeStats()).toEqual({ saved: 2, skipped: 1, failed: 1 });
    expect(scheduler.takeStats()).toEqual({ saved: 0, skipped: 0, failed: 0 });
    expect(crashing.scheduler.takeStats()).toEqual({ saved: 0, skipped: 0, failed: 1 });
  });
});
