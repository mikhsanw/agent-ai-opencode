import type { DB } from "./db.js";
import { normalize, similarity, numbersOf, toFtsQuery } from "./text.js";
import { prepareText, type Rejection } from "./sanitize.js";

export type Actor = "tool" | "capture" | "telegram";

export interface Memory {
  id: number;
  text: string;
  source: Actor;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryLimits {
  /** Panjang maksimum satu entri (karakter). */
  maxEntryChars: number;
  /** Total karakter semua entri aktif; menjaga biaya token karena snapshot disalin ke setiap sesi. */
  maxTotalChars: number;
  /** Ambang kemiripan trigram untuk menandai kandidat duplikat. */
  similarThreshold: number;
}

export const DEFAULT_LIMITS: MemoryLimits = {
  maxEntryChars: 300,
  maxTotalChars: 4000,
  similarThreshold: 0.6,
};

export interface SimilarCandidate {
  memory: Memory;
  score: number;
  /** Angka/versi berbeda: kemungkinan besar pembaruan fakta yang sama (mis. Laravel 10 → 11). */
  numbersDiffer: boolean;
}

export type WriteResult =
  | { status: "saved"; memory: Memory }
  | { status: "duplicate"; existing: Memory }
  | { status: "similar"; candidates: SimilarCandidate[] }
  | { status: "not_found"; id: number }
  | Rejection;

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  action: "insert" | "update" | "delete" | "undo";
  memoryId: number;
  beforeText: string | null;
  afterText: string | null;
  undone: boolean;
}

interface Row {
  id: number;
  text: string;
  source: Actor;
  created_at: number;
  updated_at: number;
}

const toMemory = (r: Row): Memory => ({
  id: r.id,
  text: r.text,
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class MemoryStore {
  readonly limits: MemoryLimits;

  constructor(
    private readonly db: DB,
    limits: Partial<MemoryLimits> = {},
    private readonly now: () => number = Date.now,
    private readonly onChange: () => void = () => {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  list(): Memory[] {
    const rows = this.db
      .prepare("SELECT id, text, source, created_at, updated_at FROM memories WHERE deleted_at IS NULL ORDER BY id")
      .all() as Row[];
    return rows.map(toMemory);
  }

  get(id: number): Memory | undefined {
    const row = this.db
      .prepare("SELECT id, text, source, created_at, updated_at FROM memories WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Row | undefined;
    return row ? toMemory(row) : undefined;
  }

  totalChars(): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM memories WHERE deleted_at IS NULL").get() as {
      n: number;
    };
    return r.n;
  }

  search(query: string, limit = 10): Memory[] {
    const fts = toFtsQuery(query);
    if (fts) {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.text, m.source, m.created_at, m.updated_at
             FROM memories_fts f JOIN memories m ON m.id = f.rowid
            WHERE memories_fts MATCH ? AND m.deleted_at IS NULL
            ORDER BY bm25(memories_fts) LIMIT ?`,
        )
        .all(fts, limit) as Row[];
      return rows.map(toMemory);
    }
    const like = `%${normalize(query)}%`;
    const rows = this.db
      .prepare(
        "SELECT id, text, source, created_at, updated_at FROM memories WHERE deleted_at IS NULL AND norm LIKE ? ORDER BY id DESC LIMIT ?",
      )
      .all(like, limit) as Row[];
    return rows.map(toMemory);
  }

  /** Kandidat mirip, diurutkan dari yang paling mirip. `excludeId` dipakai saat replace. */
  findSimilar(text: string, excludeId?: number): SimilarCandidate[] {
    const nums = numbersOf(text).join(" ");
    return this.list()
      .filter((m) => m.id !== excludeId)
      .map((m) => ({ memory: m, score: similarity(text, m.text), numbersDiffer: numbersOf(m.text).join(" ") !== nums }))
      .filter((c) => c.score >= this.limits.similarThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  write(input: { text: string; actor: Actor; force?: boolean }): WriteResult {
    const prepared = prepareText(input.text, this.limits.maxEntryChars);
    if (!prepared.ok) return prepared.rejection;
    const text = prepared.text;
    const norm = normalize(text);

    const dup = this.db
      .prepare("SELECT id, text, source, created_at, updated_at FROM memories WHERE deleted_at IS NULL AND norm = ?")
      .get(norm) as Row | undefined;
    if (dup) return { status: "duplicate", existing: toMemory(dup) };

    if (!input.force) {
      const candidates = this.findSimilar(text);
      if (candidates.length > 0) return { status: "similar", candidates };
    }

    const total = this.totalChars() + text.length;
    if (total > this.limits.maxTotalChars) {
      return { status: "rejected", reason: "budget", total, max: this.limits.maxTotalChars };
    }

    const ts = this.now();
    const memory = this.db.transaction(() => {
      const info = this.db
        .prepare("INSERT INTO memories (text, norm, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(text, norm, input.actor, ts, ts);
      const id = Number(info.lastInsertRowid);
      this.audit(input.actor, "insert", id, null, text, null, 0);
      return { id, text, source: input.actor, createdAt: ts, updatedAt: ts } satisfies Memory;
    })();
    this.onChange();
    return { status: "saved", memory };
  }

  replace(id: number, rawText: string, actor: Actor): WriteResult {
    const current = this.get(id);
    if (!current) return { status: "not_found", id };
    const prepared = prepareText(rawText, this.limits.maxEntryChars);
    if (!prepared.ok) return prepared.rejection;
    const text = prepared.text;
    const norm = normalize(text);

    const dup = this.db
      .prepare(
        "SELECT id, text, source, created_at, updated_at FROM memories WHERE deleted_at IS NULL AND norm = ? AND id != ?",
      )
      .get(norm, id) as Row | undefined;
    if (dup) return { status: "duplicate", existing: toMemory(dup) };

    const total = this.totalChars() - current.text.length + text.length;
    if (total > this.limits.maxTotalChars) {
      return { status: "rejected", reason: "budget", total, max: this.limits.maxTotalChars };
    }

    const ts = this.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE memories SET text = ?, norm = ?, updated_at = ? WHERE id = ?").run(text, norm, ts, id);
      this.audit(actor, "update", id, current.text, text, 0, 0);
    })();
    this.onChange();
    return { status: "saved", memory: { ...current, text, updatedAt: ts } };
  }

  remove(id: number, actor: Actor): { status: "deleted"; memory: Memory } | { status: "not_found"; id: number } {
    const current = this.get(id);
    if (!current) return { status: "not_found", id };
    const ts = this.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").run(ts, id);
      this.audit(actor, "delete", id, current.text, current.text, 0, 1);
    })();
    this.onChange();
    return { status: "deleted", memory: current };
  }

  /** Batalkan perubahan terakhir yang belum dibatalkan. */
  undo(actor: Actor = "telegram"): { status: "undone"; entry: AuditEntry } | { status: "nothing" } {
    const row = this.db
      .prepare("SELECT * FROM audit WHERE undone = 0 AND action != 'undo' ORDER BY id DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    if (!row) return { status: "nothing" };
    const entry = toAudit(row);
    const ts = this.now();
    this.db.transaction(() => {
      if (entry.action === "insert") {
        this.db.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").run(ts, entry.memoryId);
      } else if (entry.action === "update") {
        const text = entry.beforeText ?? "";
        this.db
          .prepare("UPDATE memories SET text = ?, norm = ?, updated_at = ? WHERE id = ?")
          .run(text, normalize(text), ts, entry.memoryId);
      } else if (entry.action === "delete") {
        this.db.prepare("UPDATE memories SET deleted_at = NULL, updated_at = ? WHERE id = ?").run(ts, entry.memoryId);
      }
      this.db.prepare("UPDATE audit SET undone = 1 WHERE id = ?").run(entry.id);
      this.audit(actor, "undo", entry.memoryId, entry.afterText, entry.beforeText, null, null, 1);
    })();
    this.onChange();
    return { status: "undone", entry };
  }

  history(limit = 20): AuditEntry[] {
    return (this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map(
      toAudit,
    );
  }

  private audit(
    actor: string,
    action: AuditEntry["action"],
    memoryId: number,
    beforeText: string | null,
    afterText: string | null,
    beforeDeleted: number | null,
    afterDeleted: number | null,
    undone = 0,
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit (ts, actor, action, memory_id, before_text, after_text, before_deleted, after_deleted, undone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.now(), actor, action, memoryId, beforeText, afterText, beforeDeleted, afterDeleted, undone);
  }
}

function toAudit(r: Record<string, unknown>): AuditEntry {
  return {
    id: r.id as number,
    ts: r.ts as number,
    actor: r.actor as string,
    action: r.action as AuditEntry["action"],
    memoryId: r.memory_id as number,
    beforeText: (r.before_text as string | null) ?? null,
    afterText: (r.after_text as string | null) ?? null,
    undone: r.undone === 1,
  };
}
