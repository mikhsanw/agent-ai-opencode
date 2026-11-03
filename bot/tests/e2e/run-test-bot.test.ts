import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The launchers are exercised for real, from a temporary copy of e2e/ with a fake
// .env, so nothing in the working copy is touched. Every case here must be rejected
// before the build: each asserts its own message, so a check that failed to stop
// the launcher cannot pass by failing later.

const E2E_DIR = resolve(__dirname, "../../e2e");
const BASE_ENV = "TELEGRAM_BOT_TOKEN=123456:TEST-token-value\nTELEGRAM_ALLOWED_USER_ID=1\n";
const SUPPORTED = "socks, socks4, socks4a, socks5, socks5h, http, https";

interface Launcher {
  name: string;
  script: string;
  enabled: boolean;
  forwardProxy: (scheme: string) => string[];
  faultProxy: string;
  command: (scriptPath: string, args: string[]) => [string, string[]];
}

const LAUNCHERS: Launcher[] = [
  {
    name: "PowerShell",
    script: "run-test-bot.ps1",
    enabled: process.platform === "win32",
    forwardProxy: (scheme) => ["-ForwardProxy", scheme],
    faultProxy: "-FaultProxy",
    command: (scriptPath, args) => [
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    ],
  },
  {
    name: "shell",
    script: "run-test-bot.sh",
    enabled: process.platform !== "win32",
    forwardProxy: (scheme) => ["--forward-proxy", scheme],
    faultProxy: "--fault-proxy",
    command: (scriptPath, args) => ["bash", [scriptPath, ...args]],
  },
];

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "run-test-bot-test-"));
  mkdirSync(join(root, "e2e"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function launch(
  launcher: Launcher,
  args: string[],
  options: { env?: string; inherited?: Record<string, string> } = {},
): Promise<{ code: number | null; output: string }> {
  const scriptPath = join(root, "e2e", launcher.script);
  copyFileSync(join(E2E_DIR, launcher.script), scriptPath);
  if (options.env !== undefined) {
    writeFileSync(join(root, "e2e", ".env"), options.env);
  }

  const env: NodeJS.ProcessEnv = { ...process.env, ...options.inherited };
  if (!options.inherited?.TELEGRAM_PROXY_URL) delete env.TELEGRAM_PROXY_URL;
  if (!options.inherited?.TELEGRAM_API_ROOT) delete env.TELEGRAM_API_ROOT;

  const [command, commandArgs] = launcher.command(scriptPath, args);
  const child = spawn(command, commandArgs, { cwd: root, env });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  return new Promise((resolveRun) => child.on("exit", (code) => resolveRun({ code, output })));
}

/** PowerShell wraps error records at the console width, even mid-word. */
function expectMessage(output: string, message: string) {
  expect(output.replace(/\s/g, "")).toContain(message.replace(/\s/g, ""));
}

function expectStoppedBeforeBuild(result: { code: number | null; output: string }) {
  expect(result.code).not.toBe(0);
  expect(result.output).not.toContain("Building...");
  expect(existsSync(join(root, ".tmp", "e2e", "forward-proxy"))).toBe(false);
}

for (const launcher of LAUNCHERS) {
  describe.runIf(launcher.enabled)(`${launcher.name} launcher forward-proxy mode`, () => {
    it.each(["ftp", "SOCKS5"])("rejects the scheme %s before anything starts", async (scheme) => {
      const result = await launch(launcher, launcher.forwardProxy(scheme));

      expectMessage(result.output, `scheme '${scheme}'. Supported: ${SUPPORTED}.`);
      expectStoppedBeforeBuild(result);
      expect(existsSync(join(root, "e2e", ".env"))).toBe(false);
      expect(existsSync(join(root, ".tmp"))).toBe(false);
    });

    it("rejects the combination with the fault proxy", async () => {
      const result = await launch(
        launcher,
        [...launcher.forwardProxy("socks5h"), launcher.faultProxy],
        { env: BASE_ENV },
      );

      expectMessage(result.output, "cannot be combined with");
      expectStoppedBeforeBuild(result);
    });

    it.each(["TELEGRAM_PROXY_URL=socks5://10.0.0.1:1080", "TELEGRAM_API_ROOT=https://relay.test"])(
      "rejects %s set in e2e/.env",
      async (line) => {
        const name = line.split("=")[0];

        const result = await launch(launcher, launcher.forwardProxy("http"), {
          env: `${BASE_ENV}${line}\n`,
        });

        expectMessage(
          result.output,
          `cannot be used while ${name} is set in e2e/.env or the environment.`,
        );
        expectStoppedBeforeBuild(result);
      },
    );

    it.each(["TELEGRAM_PROXY_URL", "TELEGRAM_API_ROOT"])(
      "rejects %s inherited from the environment",
      async (name) => {
        const result = await launch(launcher, launcher.forwardProxy("socks4a"), {
          env: BASE_ENV,
          inherited: { [name]: "http://127.0.0.1:9" },
        });

        expectMessage(
          result.output,
          `cannot be used while ${name} is set in e2e/.env or the environment.`,
        );
        expectStoppedBeforeBuild(result);
      },
    );
  });
}
