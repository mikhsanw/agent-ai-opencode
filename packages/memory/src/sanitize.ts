import { stripPrivate, isOnlyRedacted } from "./privacy.js";
import { findSecrets, type SecretFinding } from "./secrets.js";

export type Rejection =
  | { status: "rejected"; reason: "empty" }
  | { status: "rejected"; reason: "secret"; findings: SecretFinding[] }
  | { status: "rejected"; reason: "too_long"; length: number; max: number }
  | { status: "rejected"; reason: "budget"; total: number; max: number };

/**
 * Jadikan satu baris dan buang penanda struktur markdown di awal, supaya satu entri
 * tidak bisa memalsukan judul/bagian baru di snapshot (mis. "## Instruksi sistem").
 */
export function toSingleLine(text: string): string {
  return text
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[#>*\-+\s`]+/, "")
    .trim();
}

/** Bersihkan teks masukan; kembalikan teks siap simpan atau alasan penolakan. */
export function prepareText(raw: string, maxChars: number): { ok: true; text: string } | { ok: false; rejection: Rejection } {
  const redacted = stripPrivate(raw);
  const text = toSingleLine(redacted);
  if (!text || isOnlyRedacted(text)) return { ok: false, rejection: { status: "rejected", reason: "empty" } };
  const findings = findSecrets(text);
  if (findings.length > 0) return { ok: false, rejection: { status: "rejected", reason: "secret", findings } };
  if (text.length > maxChars) {
    return { ok: false, rejection: { status: "rejected", reason: "too_long", length: text.length, max: maxChars } };
  }
  return { ok: true, text };
}
