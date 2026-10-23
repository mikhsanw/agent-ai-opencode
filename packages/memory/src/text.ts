/**
 * Normalisasi dan kemiripan teks untuk deduplikasi memori.
 *
 * Kemiripan memakai Jaccard atas trigram karakter per kata. Pilihan ini sengaja
 * ringan (tanpa embedding) karena VPS target hanya punya RAM ~2 GB.
 */

/** Huruf kecil, buang aksen, tanda baca jadi spasi, rapikan spasi. Titik di dalam angka (24.04) dipertahankan. */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/(\d)[.,](?=\d)/g, "$1\u0000")
    .replace(/[^\p{L}\p{N}\u0000]+/gu, " ")
    .replace(/\u0000/g, ".")
    .trim()
    .replace(/\s+/g, " ");
}

/** Trigram karakter dari setiap kata (dengan batas kata), sehingga urutan kata tidak terlalu berpengaruh. */
export function trigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const word of normalize(text).split(" ")) {
    if (!word) continue;
    const padded = ` ${word} `;
    if (padded.length < 3) {
      grams.add(padded);
      continue;
    }
    for (let i = 0; i <= padded.length - 3; i++) grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

export function similarity(a: string, b: string): number {
  return jaccard(trigrams(a), trigrams(b));
}

/** Token angka/versi (mis. "11", "24.04"). Dipakai untuk menandai kemungkinan pembaruan fakta. */
export function numbersOf(text: string): string[] {
  return [...new Set(normalize(text).match(/\d+(?:\.\d+)*/g) ?? [])].sort();
}

/** Bentuk query FTS5 yang aman dari input bebas: setiap kata (>= 3 huruf, syarat tokenizer trigram) dikutip, digabung OR. */
export function toFtsQuery(input: string): string | null {
  const words = normalize(input)
    .split(" ")
    .filter((w) => w.length >= 3)
    .slice(0, 12);
  if (words.length === 0) return null;
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
}
