#!/usr/bin/env node
/**
 * Local forward proxy for e2e checks of TELEGRAM_PROXY_URL.
 *
 * Speaks exactly one proxy protocol per launch, chosen by the scheme the bot will
 * use: SOCKS4/4a/5/5h no-auth CONNECT, or HTTP CONNECT over plain TCP or TLS. A
 * client speaking any other protocol is rejected at its first byte and recorded as
 * a protocol mismatch, so a wrong proxy agent in the bot fails deterministically.
 * Accepted tunnels are spliced unchanged; Bot API traffic inside them stays TLS
 * between the bot and Telegram, so the token and payloads are never visible here.
 *
 * Every tunnel and rejection is appended to a per-launch JSON-lines log. Listens on
 * 127.0.0.1 only: it is an unauthenticated proxy.
 *
 * Usage:
 *   node e2e/forward-proxy.mjs --scheme <scheme> [--port 8766]
 *                              [--state-dir .tmp/e2e/forward-proxy]
 *
 * See e2e/README.md for the scheme matrix and the test certificate used by https.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);
const MAX_HANDSHAKE_FIELD = 255;
const MAX_HTTP_HEAD = 16 * 1024;

// What each scheme's listener expects from the client. SOCKS schemes that resolve
// names at the proxy accept a destination name; the others expect the client to
// have resolved it already and reject a name as a mismatch.
const SCHEMES = {
  socks: { protocol: "socks5", resolvesNames: true },
  socks4: { protocol: "socks4", resolvesNames: false },
  socks4a: { protocol: "socks4", resolvesNames: true },
  socks5: { protocol: "socks5", resolvesNames: false },
  socks5h: { protocol: "socks5", resolvesNames: true },
  http: { protocol: "http", tls: false },
  https: { protocol: "http", tls: true },
};
const SUPPORTED_SCHEMES = Object.keys(SCHEMES);

function parseArgs(argv) {
  const options = {
    scheme: "",
    port: 8766,
    stateDir: join(projectRoot, ".tmp", "e2e", "forward-proxy"),
  };

  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${name}`);
    }
    index++;

    if (name === "--scheme") {
      options.scheme = value;
    } else if (name === "--port") {
      options.port = Number(value);
    } else if (name === "--state-dir") {
      options.stateDir = resolve(value);
    } else {
      throw new Error(`Unknown option: ${name}`);
    }
  }

  if (!Object.hasOwn(SCHEMES, options.scheme)) {
    throw new Error(
      `Unknown scheme "${options.scheme}". Supported: ${SUPPORTED_SCHEMES.join(", ")}`,
    );
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  return options;
}

function timestampForFileName(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

// --- Wire helpers -----------------------------------------------------------

/** Names the protocol a client speaks from the first byte it sent. */
function detectProtocol(firstByte) {
  if (firstByte === 0x04) return "socks4";
  if (firstByte === 0x05) return "socks5";
  if (firstByte === 0x16) return "tls";
  if (firstByte >= 0x41 && firstByte <= 0x5a) return "http";
  return "unknown";
}

class ClientClosedError extends Error {}
class HandshakeError extends Error {}

/**
 * Buffers a handshake off a stream: waits for a byte count or a delimiter, and hands
 * over whatever arrived past the handshake when the tunnel takes the stream over.
 */
function createReader(stream) {
  let buffer = Buffer.alloc(0);
  let waiter = null;
  let closed = false;

  function settle() {
    if (!waiter) return;
    const size = waiter.size();
    if (size === -1) {
      const { reject } = waiter;
      waiter = null;
      reject(new HandshakeError("handshake field too long"));
    } else if (size !== null) {
      const { resolve: resolveRead } = waiter;
      waiter = null;
      const chunk = buffer.subarray(0, size);
      buffer = buffer.subarray(size);
      resolveRead(chunk);
    } else if (closed) {
      const { reject } = waiter;
      waiter = null;
      reject(new ClientClosedError("client closed during handshake"));
    }
  }

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    settle();
  };
  const onClose = () => {
    closed = true;
    settle();
  };
  stream.on("data", onData);
  stream.on("end", onClose);
  stream.on("close", onClose);
  stream.resume();

  const wait = (size) =>
    new Promise((resolveRead, reject) => {
      waiter = { size, resolve: resolveRead, reject };
      settle();
    });

  return {
    read: (count) => wait(() => (buffer.length >= count ? count : null)),
    readUntil: (delimiter, limit) =>
      wait(() => {
        const index = buffer.indexOf(delimiter);
        if (index >= 0) return index + delimiter.length;
        return buffer.length > limit ? -1 : null;
      }),
    detach() {
      stream.off("data", onData);
      stream.off("end", onClose);
      stream.off("close", onClose);
      stream.pause();
      const rest = buffer;
      buffer = Buffer.alloc(0);
      return rest;
    },
  };
}

function formatDestination(host, port) {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function socks5ReplyCode(error) {
  switch (error.code) {
    case "ECONNREFUSED":
      return 0x05;
    case "ENETUNREACH":
      return 0x03;
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "EHOSTUNREACH":
    case "ETIMEDOUT":
      return 0x04;
    default:
      return 0x01;
  }
}

// --- Proxy ------------------------------------------------------------------

async function startForwardProxy(options) {
  const scheme = SCHEMES[options.scheme];
  mkdirSync(options.stateDir, { recursive: true });
  const logFile = join(options.stateDir, `connections-${timestampForFileName(new Date())}.jsonl`);
  const pidFile = join(options.stateDir, "proxy.pid");
  const tlsOptions = scheme.tls
    ? {
        key: readFileSync(join(scriptDir, "forward-proxy-test-only.key")),
        cert: readFileSync(join(scriptDir, "forward-proxy-test-only.crt")),
      }
    : null;
  let nextConnectionId = 1;

  function record(entry) {
    appendFileSync(logFile, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
  }

  function recordRejection(id, reason, details = {}) {
    record({ id, event: "rejected", reason, ...details });
  }

  function recordMismatch(id, expected, detected) {
    recordRejection(id, "protocol-mismatch", { expected, detected });
  }

  /**
   * Connects to the destination, then answers the client through `reply` and
   * splices both directions. `reply(null)` means success, `reply(error)` failure.
   */
  function openTunnel(id, client, reader, protocol, host, port, reply) {
    const destination = formatDestination(host, port);
    const upstream = net.connect({ host, port });
    let tunnelled = false;

    upstream.once("error", (error) => {
      if (tunnelled) return;
      recordRejection(id, "upstream-error", {
        protocol,
        destination,
        error: error.code ?? error.message,
      });
      reply(error);
      client.end();
    });

    upstream.once("connect", () => {
      tunnelled = true;
      const openedAt = Date.now();
      let bytesUp = 0;
      let bytesDown = 0;
      record({ id, event: "tunnel-opened", protocol, destination });
      reply(null);

      const rest = reader.detach();
      if (rest.length > 0) {
        bytesUp += rest.length;
        upstream.write(rest);
      }
      client.on("data", (chunk) => {
        bytesUp += chunk.length;
      });
      upstream.on("data", (chunk) => {
        bytesDown += chunk.length;
      });
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();

      let closed = false;
      const close = (error) => {
        if (closed) return;
        closed = true;
        client.destroy();
        upstream.destroy();
        record({
          id,
          event: "tunnel-closed",
          destination,
          bytesUp,
          bytesDown,
          durationMs: Date.now() - openedAt,
          ...(error?.code ? { error: error.code } : {}),
        });
      };
      client.on("error", close);
      upstream.on("error", close);
      client.on("close", () => close());
      upstream.on("close", () => close());
    });
  }

  async function handleSocks4(id, client, reader) {
    const reply = (code) => client.write(Buffer.from([0x00, code, 0, 0, 0, 0, 0, 0]));
    const header = await reader.read(8);
    const command = header[1];
    const port = header.readUInt16BE(2);
    const address = header.subarray(4, 8);
    await reader.readUntil(Buffer.from([0x00]), MAX_HANDSHAKE_FIELD);

    // SOCKS4a marks a name that follows the user id with the address 0.0.0.x, x > 0.
    const carriesName =
      address[0] === 0 && address[1] === 0 && address[2] === 0 && address[3] !== 0;
    let host = Array.from(address).join(".");
    if (carriesName) {
      host = (await reader.readUntil(Buffer.from([0x00]), MAX_HANDSHAKE_FIELD))
        .subarray(0, -1)
        .toString("latin1");
    }

    if (command !== 0x01) {
      recordRejection(id, "unsupported-command", { protocol: "socks4", command });
      reply(0x5b);
      client.end();
      return;
    }
    if (carriesName && !scheme.resolvesNames) {
      recordMismatch(id, "socks4", "socks4a");
      reply(0x5b);
      client.end();
      return;
    }

    const protocol = carriesName ? "socks4a" : "socks4";
    openTunnel(id, client, reader, protocol, host, port, (error) => reply(error ? 0x5b : 0x5a));
  }

  async function handleSocks5(id, client, reader) {
    const reply = (code) => client.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    const greeting = await reader.read(2);
    const methods = await reader.read(greeting[1]);
    if (!methods.includes(0x00)) {
      recordRejection(id, "unsupported-auth", { protocol: "socks5" });
      client.end(Buffer.from([0x05, 0xff]));
      return;
    }
    client.write(Buffer.from([0x05, 0x00]));

    const request = await reader.read(4);
    const command = request[1];
    const addressType = request[3];
    let host;
    if (addressType === 0x01) {
      host = Array.from(await reader.read(4)).join(".");
    } else if (addressType === 0x03) {
      const length = (await reader.read(1))[0];
      host = (await reader.read(length)).toString("latin1");
    } else if (addressType === 0x04) {
      const bytes = await reader.read(16);
      const groups = [];
      for (let offset = 0; offset < 16; offset += 2) {
        groups.push(bytes.readUInt16BE(offset).toString(16));
      }
      // The URL parser compresses the address to its canonical form, e.g. ::1.
      host = new URL(`http://[${groups.join(":")}]`).hostname.slice(1, -1);
    } else {
      recordRejection(id, "unsupported-address-type", { protocol: "socks5", addressType });
      reply(0x08);
      client.end();
      return;
    }
    const port = (await reader.read(2)).readUInt16BE(0);

    if (command !== 0x01) {
      recordRejection(id, "unsupported-command", { protocol: "socks5", command });
      reply(0x07);
      client.end();
      return;
    }
    if (addressType === 0x03 && !scheme.resolvesNames) {
      recordMismatch(id, "socks5", "socks5h");
      reply(0x08);
      client.end();
      return;
    }

    const protocol = addressType === 0x03 ? "socks5h" : "socks5";
    openTunnel(id, client, reader, protocol, host, port, (error) =>
      reply(error ? socks5ReplyCode(error) : 0x00),
    );
  }

  async function handleHttpConnect(id, client, reader) {
    const protocol = scheme.tls ? "https" : "http";
    const head = await reader.readUntil(Buffer.from("\r\n\r\n"), MAX_HTTP_HEAD);
    const [method = "", target = ""] = head.toString("latin1").split("\r\n")[0].split(" ");

    if (method !== "CONNECT") {
      // Only the method: a forward request line carries the full URL, token included.
      recordRejection(id, "unsupported-method", { protocol, method });
      client.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
      return;
    }
    const match = target.match(/^\[([^\]]+)\]:(\d+)$/) ?? target.match(/^([^:[\]]+):(\d+)$/);
    const port = match ? Number(match[2]) : 0;
    if (!match || port < 1 || port > 65535) {
      recordRejection(id, "bad-request", { protocol });
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }

    openTunnel(id, client, reader, protocol, match[1], port, (error) =>
      client.write(
        error
          ? "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"
          : "HTTP/1.1 200 Connection Established\r\n\r\n",
      ),
    );
  }

  const HANDLERS = { socks4: handleSocks4, socks5: handleSocks5, http: handleHttpConnect };

  /** Checks the first byte against the expected protocol, then runs its handshake. */
  function accept(id, client, expected, onProtocol) {
    client.once("data", (chunk) => {
      client.pause();
      client.unshift(chunk);
      const detected = detectProtocol(chunk[0]);
      if (detected !== expected) {
        recordMismatch(id, expected, detected);
        client.destroy();
        return;
      }
      onProtocol();
    });
  }

  function runHandshake(id, client) {
    const reader = createReader(client);
    HANDLERS[scheme.protocol](id, client, reader).catch((error) => {
      if (error instanceof HandshakeError) {
        recordRejection(id, "bad-request", { error: error.message });
      } else if (!(error instanceof ClientClosedError)) {
        recordRejection(id, "proxy-error", { error: error.message });
      }
      client.destroy();
    });
  }

  const server = net.createServer((socket) => {
    const id = nextConnectionId++;
    socket.on("error", () => {});

    if (!scheme.tls) {
      accept(id, socket, scheme.protocol, () => runHandshake(id, socket));
      return;
    }

    // The TLS layer starts only once the first byte shows a handshake, so a plain
    // client is recorded as a mismatch instead of failing inside TLS unnoticed.
    accept(id, socket, "tls", () => {
      const secure = new tls.TLSSocket(socket, { isServer: true, ...tlsOptions });
      // A client that refuses the certificate may just send an alert and close,
      // so a close before the handshake completes counts as a failed handshake too.
      let settled = false;
      const handshakeFailed = (error) => {
        if (settled) return;
        settled = true;
        recordRejection(id, "tls-handshake-failed", { error });
      };
      secure.on("error", (error) => {
        handshakeFailed(error.code ?? error.message);
        secure.destroy();
      });
      secure.once("close", () => handshakeFailed("client closed"));
      secure.once("secure", () => {
        settled = true;
        accept(id, secure, "http", () => runHandshake(id, secure));
      });
    });
  });

  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(options.port, "127.0.0.1", () => {
      const port = server.address().port;
      writeFileSync(pidFile, String(process.pid));
      resolveStart({ server, port, logFile, pidFile });
    });
  });
}

// --- Entry point ------------------------------------------------------------

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  let started;
  try {
    started = await startForwardProxy(options);
  } catch (error) {
    process.stderr.write(`Forward proxy failed to start: ${error.message}\n`);
    process.exit(1);
  }

  const removePidFile = () => {
    if (
      existsSync(started.pidFile) &&
      readFileSync(started.pidFile, "utf8").trim() === String(process.pid)
    ) {
      rmSync(started.pidFile, { force: true });
    }
  };
  process.on("exit", removePidFile);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  process.stdout.write(
    `Forward proxy (${options.scheme}) listening on ${options.scheme}://127.0.0.1:${started.port}\n`,
  );
  process.stdout.write(`Connection log: ${started.logFile}\n`);
}

main();
