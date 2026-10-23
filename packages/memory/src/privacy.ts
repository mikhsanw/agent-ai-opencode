const REDACTED = "[REDACTED]";
const TAG = /<(\/?)private\s*>/gi;

/**
 * Ganti setiap wilayah `<private>…</private>` dengan `[REDACTED]`.
 * Tag yang tidak ditutup menyamarkan sampai akhir teks (gagal tertutup);
 * tag bersarang ditutup pada tag terluar; tag penutup tanpa pembuka dibuang.
 */
export function stripPrivate(text: string): string {
  if (!text.includes("<")) return text;
  let out = "";
  let depth = 0;
  let cursor = 0;
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(text)) !== null) {
    const closing = m[1] === "/";
    if (!closing) {
      if (depth === 0) out += text.slice(cursor, m.index);
      depth++;
    } else if (depth === 0) {
      out += text.slice(cursor, m.index);
    } else {
      depth--;
      if (depth === 0) out += REDACTED;
    }
    cursor = TAG.lastIndex;
  }
  if (depth > 0) return out + REDACTED;
  return out + text.slice(cursor);
}

/** Apakah teks tinggal penanda redaksi saja (tidak ada isi bermakna untuk disimpan). */
export function isOnlyRedacted(text: string): boolean {
  return text.replaceAll(REDACTED, "").replace(/[\s\p{P}]/gu, "") === "";
}
