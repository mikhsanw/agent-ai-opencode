import { getLocale } from "../i18n/index.js";

/**
 * Strings for the agent-ai-opencode additions. Kept outside the upstream dictionaries so that
 * upstream updates do not conflict with them. Indonesian and English; other locales fall back
 * to English.
 */
const en = {
  "cmd.memory": "Long-term memory",
  "cmd.undo": "Undo the last memory change",
  "cmd.skills_pending": "Skills waiting for approval",
  "memory.disabled": "Memory is not active.",
  "memory.empty": "📭 Memory is empty.",
  "memory.heading": "🧠 Memory ({count} entries, {used}/{max} characters)",
  "memory.more": "…and {count} more",
  "memory.hint": "Tap 🗑 to delete an entry.",
  "memory.deleted": "🗑 Entry [{id}] deleted: {text}",
  "memory.not_found": "Entry [{id}] not found.",
  "memory.button_undo": "↩️ Undo last",
  "memory.button_refresh": "🔄 Refresh",
  "undo.done": "↩️ Undone: {action} [{id}] {text}",
  "undo.nothing": "Nothing to undo.",
  "action.insert": "added",
  "action.update": "changed",
  "action.delete": "deleted",
  "action.undo": "undo",
  "skills.none": "No skills are waiting for approval.",
  "skills.new": "🔔 The agent proposed a new skill:",
  "skills.card": "🧩 {name} ({id})\n{description}\n\nRisk flags: {risk}\n\n{preview}",
  "skills.risk_none": "none",
  "skills.truncated": "… (truncated, tap 👁 to see all)",
  "skills.button_view": "👁 View all",
  "skills.button_approve": "✅ Activate",
  "skills.button_reject": "❌ Reject",
  "skills.approved": "✅ Skill {id} is active. New sessions will see it.",
  "skills.rejected": "❌ Skill {id} rejected.",
  "skills.gone": "This proposal is no longer available (already decided or expired).",
  "risk.shell": "shell commands",
  "risk.url": "URLs",
  "risk.sensitive_path": "sensitive paths",
  "risk.override": "tries to override instructions",
  "risk.encoded": "encoded data",
  "digest.heading": "🗓 Memory summary, last 24 hours",
  "digest.added": "Added ({count}):",
  "digest.changed": "Changed ({count}):",
  "digest.deleted": "Deleted ({count}):",
  "digest.skipped": "Auto-capture skipped {count} fact(s) (similar, duplicate or secret).",
  "digest.failed": "Auto-capture failed {count} time(s); see the bot log.",
  "digest.pending": "{count} skill(s) waiting for approval: /skills_pending",
} as const;

export type AaoI18nKey = keyof typeof en;

const id: Record<AaoI18nKey, string> = {
  "cmd.memory": "Memori jangka panjang",
  "cmd.undo": "Batalkan perubahan memori terakhir",
  "cmd.skills_pending": "Skill yang menunggu persetujuan",
  "memory.disabled": "Memori tidak aktif.",
  "memory.empty": "📭 Memori masih kosong.",
  "memory.heading": "🧠 Memori ({count} entri, {used}/{max} karakter)",
  "memory.more": "…dan {count} entri lain",
  "memory.hint": "Ketuk 🗑 untuk menghapus entri.",
  "memory.deleted": "🗑 Entri [{id}] dihapus: {text}",
  "memory.not_found": "Entri [{id}] tidak ditemukan.",
  "memory.button_undo": "↩️ Batalkan terakhir",
  "memory.button_refresh": "🔄 Muat ulang",
  "undo.done": "↩️ Dibatalkan: {action} [{id}] {text}",
  "undo.nothing": "Tidak ada perubahan untuk dibatalkan.",
  "action.insert": "tambah",
  "action.update": "ubah",
  "action.delete": "hapus",
  "action.undo": "batal",
  "skills.none": "Tidak ada skill yang menunggu persetujuan.",
  "skills.new": "🔔 Agen mengusulkan skill baru:",
  "skills.card": "🧩 {name} ({id})\n{description}\n\nPenanda risiko: {risk}\n\n{preview}",
  "skills.risk_none": "tidak ada",
  "skills.truncated": "… (dipotong, ketuk 👁 untuk melihat semua)",
  "skills.button_view": "👁 Lihat penuh",
  "skills.button_approve": "✅ Aktifkan",
  "skills.button_reject": "❌ Tolak",
  "skills.approved": "✅ Skill {id} aktif. Sesi baru akan melihatnya.",
  "skills.rejected": "❌ Skill {id} ditolak.",
  "skills.gone": "Usulan ini sudah tidak tersedia (sudah diputuskan atau kedaluwarsa).",
  "risk.shell": "perintah shell",
  "risk.url": "URL",
  "risk.sensitive_path": "path sensitif",
  "risk.override": "mencoba mengabaikan instruksi",
  "risk.encoded": "data ter-encode",
  "digest.heading": "🗓 Ringkasan memori 24 jam terakhir",
  "digest.added": "Ditambahkan ({count}):",
  "digest.changed": "Diubah ({count}):",
  "digest.deleted": "Dihapus ({count}):",
  "digest.skipped": "Auto-capture melewati {count} fakta (mirip, duplikat, atau rahasia).",
  "digest.failed": "Auto-capture gagal {count} kali; lihat log bot.",
  "digest.pending": "{count} skill menunggu persetujuan: /skills_pending",
};

export const AAO_DICTIONARIES: Record<"en" | "id", Record<AaoI18nKey, string>> = { en, id };

export function at(key: AaoI18nKey, params: Record<string, string | number> = {}): string {
  const dictionary = getLocale() === "id" ? id : en;
  return dictionary[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
