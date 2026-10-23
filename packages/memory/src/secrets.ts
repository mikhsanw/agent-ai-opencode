/**
 * Pemindai rahasia sebelum apa pun disimpan ke memori atau skill.
 * Prinsip: gagal tertutup. Lebih baik menolak fakta yang aman daripada menyimpan token.
 */

export interface SecretFinding {
  kind: string;
  /** Potongan tersamar, aman untuk ditampilkan/log (tidak pernah berisi rahasia utuh). */
  preview: string;
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "github_token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "openai_key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/ },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "telegram_bot_token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: "url_credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  {
    kind: "password_assignment",
    re: /\b(?:password|passwd|pwd|kata\s*sandi|sandi|passphrase|secret|token|api[_\s-]?key|apikey)\b\s*(?:[:=]|adalah|nya)\s*["']?[^\s"']{4,}/i,
  },
  { kind: "long_hex", re: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{32,}\b/i },
];

function shannon(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function mask(s: string): string {
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}…(${s.length} karakter)`;
}

/** Token acak panjang (huruf + angka campur, entropi tinggi) yang tidak tertangkap pola spesifik. */
function highEntropyTokens(text: string): string[] {
  const out: string[] = [];
  for (const token of text.match(/[A-Za-z0-9+/=_-]{24,}/g) ?? []) {
    if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) continue;
    if (/^[a-z]+(?:[-_][a-z]+)*$/i.test(token)) continue;
    if (shannon(token) >= 4.0) out.push(token);
  }
  return out;
}

export function findSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { kind, re } of PATTERNS) {
    const m = text.match(re);
    if (m) findings.push({ kind, preview: mask(m[0]) });
  }
  for (const token of highEntropyTokens(text)) {
    if (!findings.some((f) => f.preview === mask(token))) findings.push({ kind: "high_entropy", preview: mask(token) });
  }
  return findings;
}
