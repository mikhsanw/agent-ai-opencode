/**
 * Lightweight extension points used by the thin patches in upstream files.
 * This module must stay free of heavy imports (no @aao/memory, no grammY): upstream modules and
 * their tests import it, and the memory runtime registers the real handlers at startup.
 */
import { logger } from "../utils/logger.js";

type IdleListener = (sessionId: string, interrupted: boolean) => void;
type PromptGate = (sessionId: string) => Promise<void>;

let idleListener: IdleListener | null = null;
let promptGate: PromptGate | null = null;

export function setAaoIdleListener(listener: IdleListener | null): void {
  idleListener = listener;
}

export function setAaoPromptGate(gate: PromptGate | null): void {
  promptGate = gate;
}

/** Called by the session lifecycle handler on every session idle. Never throws. */
export function notifyAaoSessionIdle(sessionId: string, interrupted: boolean): void {
  if (!idleListener) {
    return;
  }
  try {
    idleListener(sessionId, interrupted);
  } catch (error) {
    logger.warn(`[AAO] Idle listener failed: session=${sessionId}`, error);
  }
}

/** Waits for the memory gate before a prompt; failures are logged and never block the prompt. */
export async function runAaoPromptGate(sessionId: string): Promise<void> {
  if (!promptGate) {
    return;
  }
  try {
    await promptGate(sessionId);
  } catch (error) {
    logger.warn(`[AAO] Prompt gate failed, sending prompt anyway: session=${sessionId}`, error);
  }
}

/**
 * Memory and skill buttons do not touch the running task, so they may pass the busy gate.
 * Skill proposals arrive while the agent is still working; blocking the button would make
 * approval impossible until the run ends.
 */
export function isAaoCallbackData(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith("aao:");
}

type GatedMethod = "prompt" | "promptAsync" | "command";
const GATED_METHODS: readonly GatedMethod[] = ["prompt", "promptAsync", "command"];

/**
 * Wraps the session prompt entry points of an OpenCode client so every prompt (chat, handover,
 * scheduled task, inbox) passes the memory readiness gate first. Mutates and returns the client.
 */
export function withAaoPromptGate<T extends object>(client: T): T {
  const session = Reflect.get(client, "session") as Record<string, unknown> | undefined;
  if (!session) {
    return client;
  }
  for (const name of GATED_METHODS) {
    const original = session[name];
    if (typeof original !== "function") {
      continue;
    }
    session[name] = async (params: { sessionID?: string }, ...rest: unknown[]) => {
      if (params && typeof params.sessionID === "string") {
        await runAaoPromptGate(params.sessionID);
      }
      return (original as (...args: unknown[]) => unknown).call(session, params, ...rest);
    };
  }
  return client;
}
