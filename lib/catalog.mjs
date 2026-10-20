#!/usr/bin/env node
// Reads OpenCode's own provider/model catalog for the install wizard.
//
//   node catalog.mjs <opencode-bin> providers          -> id \t name \t env1,env2 \t models \t free
//   node catalog.mjs <opencode-bin> models <provider>  -> id \t name \t free(0|1) \t default(0|1)
//
// Starts a throw-away OpenCode server on loopback with a temporary HOME, asks it for
// GET /provider, prints tab-separated rows and shuts the server down. Provider API keys
// in the environment (e.g. OPENCODE_API_KEY) let OpenCode list models that need a key.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [bin, cmd, providerId] = process.argv.slice(2);
if (!bin || !["providers", "models"].includes(cmd) || (cmd === "models" && !providerId)) {
  console.error("usage: catalog.mjs <opencode-bin> providers | models <provider>");
  process.exit(2);
}

const port = 20000 + Math.floor(Math.random() * 20000);
const password = randomBytes(16).toString("hex");
const home = mkdtempSync(join(tmpdir(), "otb-catalog-"));
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"),
  XDG_STATE_HOME: join(home, "state"),
  OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  // The built-in plugins do network work at startup that sometimes stalls GET /provider;
  // the catalog does not need them (measured: 6/10 -> 10/10 successful reads).
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
};
const server = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  env,
  cwd: home,
  stdio: "ignore",
});
const authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
const clean = (s) => String(s ?? "").replace(/[\t\r\n]+/g, " ").trim();
const isFree = (m) => m?.cost && Number(m.cost.input) === 0 && Number(m.cost.output) === 0;

// Overall budget: OpenCode may refresh its catalog from the network; never hang the wizard.
const deadline = Date.now() + Number(process.env.OTB_CATALOG_TIMEOUT_MS || 45000);

async function getJson(path) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { authorization },
        // Short per-request timeout: a request sent while OpenCode is still starting can
        // hang forever, so give up on it and ask again instead of waiting out the budget.
        signal: AbortSignal.timeout(Math.max(1000, Math.min(5000, deadline - Date.now()))),
      });
      if (res.ok) return await res.json();
    } catch {
      // server not up yet, or the request ran out of time
    }
    if (server.exitCode !== null) throw new Error("opencode exited early");
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("timed out waiting for opencode");
}

let status = 0;
try {
  const data = await getJson("/provider");
  const all = Array.isArray(data.all) ? data.all : [];
  const defaults = data.default ?? {};
  if (cmd === "providers") {
    for (const p of all) {
      const models = Object.values(p.models ?? {});
      const free = models.filter(isFree).length;
      console.log([p.id, clean(p.name), (p.env ?? []).join(","), models.length, free].join("\t"));
    }
  } else {
    const p = all.find((x) => x.id === providerId);
    if (!p) {
      status = 3;
    } else {
      const def = defaults[providerId];
      const rows = Object.entries(p.models ?? {})
        .map(([id, m]) => ({ id, name: clean(m.name || id), free: isFree(m) ? 1 : 0, def: id === def ? 1 : 0 }))
        .sort((a, b) => b.def - a.def || a.free - b.free || a.name.localeCompare(b.name));
      for (const r of rows) console.log([r.id, r.name, r.free, r.def].join("\t"));
    }
  }
} catch (err) {
  console.error(`catalog: ${err.message}`);
  status = 1;
} finally {
  server.kill("SIGTERM");
  rmSync(home, { recursive: true, force: true });
}
process.exit(status);
