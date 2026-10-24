import type { CaptureResult } from "@aao/memory";
import { logger } from "../utils/logger.js";

export interface CaptureStats {
  saved: number;
  skipped: number;
  failed: number;
}

export interface CaptureSchedulerDeps {
  runCapture: (sessionId: string) => Promise<CaptureResult>;
  dailyLimit: number;
  /** Minimum gap between two captures of the same session. */
  cooldownMs: number;
  now: () => number;
  onResult?: (result: CaptureResult) => void;
}

function dayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * Turns session-idle events into auto-capture runs: skips interrupted runs, keeps one capture
 * per session in flight, applies a per-session cooldown and a daily cap (token cost).
 */
export function createCaptureScheduler(deps: CaptureSchedulerDeps) {
  const inFlight = new Set<string>();
  const lastStartedAt = new Map<string, number>();
  let day = dayKey(deps.now());
  let todayCount = 0;
  const stats: CaptureStats = { saved: 0, skipped: 0, failed: 0 };

  const onIdle = (sessionId: string, interrupted: boolean): Promise<void> | undefined => {
    if (interrupted || inFlight.has(sessionId)) {
      return undefined;
    }
    const now = deps.now();
    const last = lastStartedAt.get(sessionId);
    if (last !== undefined && now - last < deps.cooldownMs) {
      return undefined;
    }
    const currentDay = dayKey(now);
    if (currentDay !== day) {
      day = currentDay;
      todayCount = 0;
    }
    if (todayCount >= deps.dailyLimit) {
      logger.debug(`[AAO] Capture daily limit reached (${deps.dailyLimit}); session=${sessionId}`);
      return undefined;
    }

    todayCount++;
    inFlight.add(sessionId);
    lastStartedAt.set(sessionId, now);
    return deps
      .runCapture(sessionId)
      .then((result) => {
        if (result.ok) {
          stats.saved += result.saved.length;
          stats.skipped += result.skipped.length;
        } else {
          stats.failed++;
          logger.warn(`[AAO] Capture failed: session=${sessionId}, error=${result.error ?? "unknown"}`);
        }
        if (result.saved.length > 0) {
          logger.info(`[AAO] Capture saved ${result.saved.length} fact(s): session=${sessionId}`);
        }
        deps.onResult?.(result);
      })
      .catch((error: unknown) => {
        stats.failed++;
        logger.warn(`[AAO] Capture crashed: session=${sessionId}`, error);
      })
      .finally(() => {
        inFlight.delete(sessionId);
      });
  };

  /** Returns and resets the counters (used by the daily digest). */
  const takeStats = (): CaptureStats => {
    const snapshot = { ...stats };
    stats.saved = 0;
    stats.skipped = 0;
    stats.failed = 0;
    return snapshot;
  };

  return { onIdle, takeStats };
}
