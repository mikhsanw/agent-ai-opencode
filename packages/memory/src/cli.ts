#!/usr/bin/env node
/**
 * Runner mandiri: `aao-memory serve --db <path> --snapshot <path> [--host 127.0.0.1] [--port 18090]`
 * Token dibaca dari env AAO_MEMORY_TOKEN atau file di --token-file (tidak pernah dari argumen,
 * supaya tidak terlihat di `ps`).
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openMemoryService } from "./service.js";
import { startMcpHttpServer } from "./mcp.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    snapshot: { type: "string" },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "18090" },
    "token-file": { type: "string" },
  },
});

if (positionals[0] !== "serve" || !values.db) {
  console.error("pemakaian: aao-memory serve --db <path> [--snapshot <path>] [--host 127.0.0.1] [--port 18090] [--token-file <path>]");
  process.exit(2);
}

const token = values["token-file"] ? readFileSync(values["token-file"], "utf8").trim() : (process.env.AAO_MEMORY_TOKEN ?? "");
if (token.length < 16) {
  console.error("token MCP minimal 16 karakter (AAO_MEMORY_TOKEN atau --token-file)");
  process.exit(2);
}

const svc = openMemoryService({ dbPath: values.db, snapshotPath: values.snapshot });
const { server, url } = await startMcpHttpServer(svc, { token, host: values.host, port: Number(values.port) });
console.log(`memory MCP listening on ${url}`);

const shutdown = () => {
  server.close();
  svc.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
