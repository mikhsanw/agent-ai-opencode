import { config } from "../config.js";

const REQUEST_TIMEOUT_MS = 10_000;

function authHeader(): Record<string, string> {
  if (!config.opencode.password) {
    return {};
  }
  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return { Authorization: `Basic ${Buffer.from(credentials).toString("base64")}` };
}

function buildUrl(pathname: string, query: Record<string, string>): URL {
  const base = config.opencode.apiUrl.endsWith("/") ? config.opencode.apiUrl : `${config.opencode.apiUrl}/`;
  const url = new URL(pathname.replace(/^\//, ""), base);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url;
}

/** Small GET helper for OpenCode V2 endpoints the bot's client facade does not expose. */
export async function getOpencodeJson(pathname: string, query: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(buildUrl(pathname, query), {
    headers: authHeader(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OpenCode ${pathname} HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * POST/DELETE helper. Errors carry only the method, path and status, never the body, because
 * the body can hold a provider API key.
 */
export async function sendOpencode(method: "POST" | "DELETE", pathname: string, body?: unknown): Promise<void> {
  let response: Response;
  try {
    response = await fetch(buildUrl(pathname, {}), {
      method,
      headers: { ...authHeader(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`OpenCode ${method} ${pathname} unreachable`);
  }
  // Drain without reading into an error message.
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`OpenCode ${method} ${pathname} HTTP ${response.status}`);
  }
}
