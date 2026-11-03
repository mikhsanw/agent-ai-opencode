import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { Agent } from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTelegramBotOptions } from "../../src/bot/telegram-client-options.js";

const PROJECT_ROOT = resolve(__dirname, "../..");
const PROXY_SCRIPT = join(PROJECT_ROOT, "e2e/forward-proxy.mjs");
const TEST_CERT = join(PROJECT_ROOT, "e2e/forward-proxy-test-only.crt");
const AGENT_FACTORY = join(PROJECT_ROOT, "src/bot/telegram-client-options.ts");
const TOKEN = "123456:TEST-token-value";
const SECRET_BODY = "secret-payload-value";

interface LogEntry {
  id: number;
  event: string;
  reason?: string;
  protocol?: string;
  destination?: string;
  expected?: string;
  detected?: string;
  method?: string;
}

interface RunningProxy {
  port: number;
  child: ChildProcessWithoutNullStreams;
}

let upstream: http.Server;
let upstreamPort = 0;
let stateDir = "";
const proxies: RunningProxy[] = [];

beforeAll(async () => {
  // Dual-stack, so one upstream answers IPv4, IPv6 and "localhost" destinations.
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("upstream ok");
    });
  });
  await new Promise<void>((resolveListen) =>
    upstream.listen({ port: 0, host: "::", ipv6Only: false }, resolveListen),
  );
  upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
});

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "forward-proxy-test-"));
});

afterEach(async () => {
  for (const proxy of proxies.splice(0)) {
    if (proxy.child.exitCode === null) {
      const exited = new Promise((resolveExit) => proxy.child.once("exit", resolveExit));
      proxy.child.kill();
      await exited;
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
});

async function startProxy(scheme: string): Promise<number> {
  const child = spawn(process.execPath, [
    PROXY_SCRIPT,
    "--scheme",
    scheme,
    "--port",
    "0",
    "--state-dir",
    stateDir,
  ]);
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/listening on \S+:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolvePort(Number(match[1]));
    });
    child.stderr.on("data", (chunk: Buffer) => rejectPort(new Error(chunk.toString("utf8"))));
    child.on("exit", (code) => rejectPort(new Error(`proxy exited with ${code}`)));
  });
  proxies.push({ port, child });
  return port;
}

function runProxyToExit(args: string[]): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [PROXY_SCRIPT, ...args, "--state-dir", stateDir]);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  return new Promise((resolveRun) => child.on("exit", (code) => resolveRun({ code, stderr })));
}

function botAgent(proxyUrl: string): Agent {
  const options = createTelegramBotOptions({
    apiRoot: "",
    proxySecret: "",
    proxyUrl,
    forceIpv4: false,
  });
  return options.client?.baseFetchConfig?.agent as Agent;
}

function get(
  host: string,
  agent: Agent,
  port = upstreamPort,
): Promise<{ status: number; body: string }> {
  return new Promise((resolveGet, rejectGet) => {
    const req = http.request(
      { host, port, path: `/bot${TOKEN}/getMe`, method: "POST", agent },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolveGet({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", rejectGet);
    req.end(SECRET_BODY);
  });
}

function readLogText(): string {
  return readdirSync(stateDir)
    .filter((name) => name.startsWith("connections-"))
    .map((name) => readFileSync(join(stateDir, name), "utf8"))
    .join("");
}

async function readLog(): Promise<LogEntry[]> {
  // Records are appended as the proxy handles each event; give the last one a moment.
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  return readLogText()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

/** Runs one request through the bot's own agent in a process that trusts the test cert. */
function requestInChild(
  proxyUrl: string,
  trustTestCert: boolean,
): Promise<{ code: number | null; output: string }> {
  const script = `
    const http = await import("node:http");
    const { createTelegramBotOptions } = await import(${JSON.stringify(pathToFileURL(AGENT_FACTORY).href)});
    const agent = createTelegramBotOptions({ apiRoot: "", proxySecret: "", proxyUrl: ${JSON.stringify(proxyUrl)}, forceIpv4: false }).client.baseFetchConfig.agent;
    const req = http.request({ host: "127.0.0.1", port: ${upstreamPort}, path: "/", agent }, (res) => {
      res.resume();
      res.on("end", () => { console.log("STATUS " + res.statusCode); process.exit(0); });
    });
    req.on("error", (error) => { console.log("ERROR " + (error.code ?? error.message)); process.exit(1); });
    req.end();
  `;
  const env = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS;
  if (trustTestCert) env.NODE_EXTRA_CA_CERTS = TEST_CERT;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { cwd: PROJECT_ROOT, env },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  return new Promise((resolveRun) => child.on("exit", (code) => resolveRun({ code, output })));
}

describe("forward proxy tunnels through the bot's own agents", () => {
  const cases: Array<{ scheme: string; hosts: string[] }> = [
    { scheme: "socks", hosts: ["127.0.0.1", "localhost", "::1"] },
    { scheme: "socks4", hosts: ["127.0.0.1"] },
    { scheme: "socks4a", hosts: ["127.0.0.1", "localhost"] },
    { scheme: "socks5", hosts: ["127.0.0.1", "::1"] },
    { scheme: "socks5h", hosts: ["127.0.0.1", "localhost", "::1"] },
    { scheme: "http", hosts: ["127.0.0.1", "localhost", "::1"] },
  ];

  for (const { scheme, hosts } of cases) {
    for (const host of hosts) {
      it(`${scheme} carries a request to ${host}`, async () => {
        const port = await startProxy(scheme);

        const response = await get(host, botAgent(`${scheme}://127.0.0.1:${port}`));

        expect(response).toEqual({ status: 200, body: "upstream ok" });
        const opened = (await readLog()).filter((entry) => entry.event === "tunnel-opened");
        const expectedHost = host.includes(":") ? `[${host}]` : host;
        expect(opened).toEqual([
          expect.objectContaining({ destination: `${expectedHost}:${upstreamPort}` }),
        ]);
      });
    }
  }

  it("https carries a request when the process trusts the test certificate", async () => {
    const port = await startProxy("https");

    const result = await requestInChild(`https://127.0.0.1:${port}`, true);

    expect(result.output).toContain("STATUS 200");
    expect(result.code).toBe(0);
    const log = await readLog();
    expect(log.map((entry) => entry.event)).toContain("tunnel-opened");
    expect(log.find((entry) => entry.event === "tunnel-opened")?.protocol).toBe("https");
  });

  it("https is refused by a process that does not trust the test certificate", async () => {
    const port = await startProxy("https");

    const result = await requestInChild(`https://127.0.0.1:${port}`, false);

    expect(result.code).toBe(1);
    expect(result.output).toContain("SELF_SIGNED");
    const log = await readLog();
    expect(log.map((entry) => entry.event)).not.toContain("tunnel-opened");
    expect(log.map((entry) => entry.reason)).toContain("tls-handshake-failed");
  });

  it("records the tunnel without the request path or body", async () => {
    const port = await startProxy("http");

    await get("127.0.0.1", botAgent(`http://127.0.0.1:${port}`));

    const log = await readLog();
    expect(log.map((entry) => entry.event)).toEqual(["tunnel-opened", "tunnel-closed"]);
    const text = readLogText();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SECRET_BODY);
  });
});

describe("forward proxy rejects the wrong protocol as a mismatch", () => {
  for (const scheme of ["socks", "socks4", "socks4a", "socks5", "socks5h"]) {
    it(`${scheme} rejects the HTTP CONNECT agent that incoming-file downloads use`, async () => {
      const port = await startProxy(scheme);

      await expect(
        get("127.0.0.1", new HttpsProxyAgent(`${scheme}://127.0.0.1:${port}`)),
      ).rejects.toThrow();

      const expected = scheme.startsWith("socks4") ? "socks4" : "socks5";
      expect(await readLog()).toEqual([
        expect.objectContaining({
          event: "rejected",
          reason: "protocol-mismatch",
          expected,
          detected: "http",
        }),
      ]);
    });
  }

  it("http rejects a SOCKS agent", async () => {
    const port = await startProxy("http");

    await expect(
      get("127.0.0.1", new SocksProxyAgent(`socks5h://127.0.0.1:${port}`)),
    ).rejects.toThrow();

    expect(await readLog()).toEqual([
      expect.objectContaining({
        reason: "protocol-mismatch",
        expected: "http",
        detected: "socks5",
      }),
    ]);
  });

  it("https rejects a plain-text HTTP CONNECT agent", async () => {
    const port = await startProxy("https");

    await expect(
      get("127.0.0.1", new HttpsProxyAgent(`http://127.0.0.1:${port}`)),
    ).rejects.toThrow();

    expect(await readLog()).toEqual([
      expect.objectContaining({ reason: "protocol-mismatch", expected: "tls", detected: "http" }),
    ]);
  });

  it("socks5 rejects a destination name the client should have resolved", async () => {
    const port = await startProxy("socks5");

    await expect(
      get("localhost", new SocksProxyAgent(`socks5h://127.0.0.1:${port}`)),
    ).rejects.toThrow();

    expect(await readLog()).toEqual([
      expect.objectContaining({
        reason: "protocol-mismatch",
        expected: "socks5",
        detected: "socks5h",
      }),
    ]);
  });

  it("socks4 rejects a SOCKS4a destination name", async () => {
    const port = await startProxy("socks4");

    await expect(
      get("localhost", new SocksProxyAgent(`socks4a://127.0.0.1:${port}`)),
    ).rejects.toThrow();

    expect(await readLog()).toEqual([
      expect.objectContaining({
        reason: "protocol-mismatch",
        expected: "socks4",
        detected: "socks4a",
      }),
    ]);
  });

  it("http refuses a non-CONNECT request and records only its method", async () => {
    const port = await startProxy("http");

    const answer = await new Promise<string>((resolveAnswer, rejectAnswer) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(`GET http://127.0.0.1:${upstreamPort}/bot${TOKEN}/getMe HTTP/1.1\r\n\r\n`);
      });
      let text = "";
      socket.on("data", (chunk: Buffer) => (text += chunk.toString("latin1")));
      socket.on("end", () => resolveAnswer(text));
      socket.on("error", rejectAnswer);
    });

    expect(answer).toMatch(/^HTTP\/1\.1 405/);
    expect(await readLog()).toEqual([
      expect.objectContaining({ reason: "unsupported-method", method: "GET" }),
    ]);
    expect(readLogText()).not.toContain(TOKEN);
  });
});

describe("forward proxy reports an unreachable destination", () => {
  async function closedPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    return port;
  }

  it.each([
    { scheme: "socks4", failure: /rejected connection/i },
    { scheme: "socks5", failure: /ConnectionRefused/ },
    { scheme: "http", failure: /502/ },
  ])("$scheme answers with its protocol's failure reply", async ({ scheme, failure }) => {
    const port = await startProxy(scheme);
    const deadPort = await closedPort();

    const outcome = await get(
      "127.0.0.1",
      botAgent(`${scheme}://127.0.0.1:${port}`),
      deadPort,
    ).then(
      (response) => `status ${response.status}`,
      (error: Error) => error.message,
    );

    expect(outcome).toMatch(failure);
    expect(await readLog()).toEqual([
      expect.objectContaining({
        event: "rejected",
        reason: "upstream-error",
        destination: `127.0.0.1:${deadPort}`,
        error: "ECONNREFUSED",
      }),
    ]);
  });
});

describe("forward proxy startup", () => {
  it.each(["ftp", "SOCKS5", ""])(
    "rejects the scheme %j and lists the supported ones",
    async (scheme) => {
      const result = await runProxyToExit(["--scheme", scheme, "--port", "0"]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "Supported: socks, socks4, socks4a, socks5, socks5h, http, https",
      );
    },
  );
});
