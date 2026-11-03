import { config } from "../config.js";

const REQUEST_TIMEOUT_MS = 10_000;

function authHeader(): Record<string, string> {
  if (!config.opencode.password) {
    return {};
  }
  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return { Authorization: `Basic ${Buffer.from(credentials).toString("base64")}` };
}

/** Small GET helper for OpenCode V2 endpoints the bot's client facade does not expose. */
export async function getOpencodeJson(pathname: string, query: Record<string, string> = {}): Promise<unknown> {
  const base = config.opencode.apiUrl.endsWith("/") ? config.opencode.apiUrl : `${config.opencode.apiUrl}/`;
  const url = new URL(pathname.replace(/^\//, ""), base);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, { headers: authHeader(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`OpenCode ${pathname} HTTP ${response.status}`);
  }
  return response.json();
}
