import { describe, it, expect } from "vitest";
import { findSecrets } from "../src/secrets.js";

// Token uji dirakit saat runtime agar pola mirip-rahasia tidak muncul utuh di source
// (mencegah alarm palsu pemindai rahasia GitHub). Semuanya palsu.
const rep = (c: string, n: number) => c.repeat(n);
const mixed = (n: number) => Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z"[i % 31]).join("");

const SECRETS: [string, string][] = [
  ["github_token", `Token saya ${"gh" + "p_"}${mixed(36)}`],
  ["anthropic_key", `kunci ${"sk-" + "ant-"}${mixed(40)}`],
  ["openai_key", `pakai ${"sk-" + "proj-"}${mixed(40)}`],
  ["google_api_key", `key ${"AI" + "za"}${mixed(35)}`],
  ["aws_access_key", `aws ${"AK" + "IA"}${rep("Q", 16)}`],
  ["telegram_bot_token", `bot ${"123456789"}:${mixed(35)}`],
  ["jwt", `jwt ${"ey" + "J"}${mixed(20)}.${mixed(20)}.${mixed(20)}`],
  ["private_key", `-----BEGIN ${"OPENSSH PRIVATE"} KEY-----`],
  ["url_credentials", "db mysql://root:rahasia123@localhost/app"],
  ["password_assignment", "password: SuperRahasia99"],
  ["password_assignment", "kata sandi adalah kucing123"],
  ["long_hex", `token ${rep("a1b2", 10)}`],
];

const BENIGN = [
  "Pengguna memakai Ubuntu 24.04 di server produksi.",
  "Repo utama pengguna github.com/mikhsanw/agent-ai-opencode.",
  "Branch kerja pengguna v2-rewrite.",
  "Stack pengguna: Laravel 11, PHP 8.3, MySQL 8.0, Flutter 3.",
  "VPS pengguna punya RAM 1.9 GiB dan swap 1.9 GiB.",
  "Model default pengguna opencode/big-pickle.",
  "Pengguna dosen D4 Keamanan Sistem Informasi di Politeknik Negeri Bengkalis.",
  "OpenCode berjalan di port 49374.",
  "Proyek Dry24 ada di /srv/workspace/dry24.",
  "Pengguna menyimpan token bot di /etc/aao/bot.env, bukan di repo.",
  "Pengguna lebih suka commit message dalam bahasa Inggris dengan format conventional commits.",
];

describe("findSecrets", () => {
  it.each(SECRETS)("mendeteksi %s", (kind, text) => {
    const kinds = findSecrets(text).map((f) => f.kind);
    expect(kinds).toContain(kind);
  });

  it.each(BENIGN)("tidak salah menandai fakta biasa: %s", (text) => {
    expect(findSecrets(text)).toEqual([]);
  });

  it("preview tidak pernah berisi rahasia utuh", () => {
    const secret = `${"gh" + "p_"}${mixed(36)}`;
    for (const f of findSecrets(`token ${secret}`)) expect(f.preview).not.toContain(secret);
  });
});
