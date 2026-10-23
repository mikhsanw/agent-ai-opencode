import { openDb, type DB } from "./db.js";
import { MemoryStore, type MemoryLimits } from "./memories.js";
import { SkillStore, type SkillLimits } from "./skills.js";
import { renderSnapshot, writeFileAtomic } from "./snapshot.js";

export interface MemoryServiceOptions {
  /** Path database SQLite (mis. /var/lib/aao-bot/memory.db). ":memory:" untuk test. */
  dbPath: string;
  /** Path MEMORY.md yang didaftarkan di `instructions[]` OpenCode. Kosongkan untuk tidak menulis file. */
  snapshotPath?: string;
  /** Mode file snapshot; default 0640 (bisa dibaca grup agen, tidak bisa ditulis). */
  snapshotMode?: number;
  memoryLimits?: Partial<MemoryLimits>;
  skillLimits?: Partial<SkillLimits>;
  now?: () => number;
}

/** Facade: satu database, store memori + skill, dan snapshot yang selalu diperbarui setelah perubahan. */
export class MemoryService {
  readonly memories: MemoryStore;
  readonly skills: SkillStore;
  private readonly db: DB;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly opts: MemoryServiceOptions) {
    this.db = openDb(opts.dbPath);
    const changed = () => this.changed();
    this.memories = new MemoryStore(this.db, opts.memoryLimits, opts.now, changed);
    this.skills = new SkillStore(this.db, opts.skillLimits, opts.now, changed);
    this.writeSnapshot();
  }

  renderSnapshot(): string {
    return renderSnapshot(this.memories.list(), this.skills.listApproved());
  }

  writeSnapshot(): void {
    if (!this.opts.snapshotPath) return;
    writeFileAtomic(this.opts.snapshotPath, this.renderSnapshot(), this.opts.snapshotMode ?? 0o640);
  }

  /** Dipanggil setelah setiap perubahan (mis. untuk digest atau notifikasi Telegram). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.db.close();
  }

  private changed(): void {
    this.writeSnapshot();
    for (const l of this.listeners) l();
  }
}

export function openMemoryService(opts: MemoryServiceOptions): MemoryService {
  return new MemoryService(opts);
}
