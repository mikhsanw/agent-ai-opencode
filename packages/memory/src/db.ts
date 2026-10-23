import Database from "better-sqlite3";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

/** Migrasi berurutan; indeks = versi skema - 1. Jangan ubah migrasi yang sudah dirilis, tambahkan yang baru. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    norm TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX memories_active ON memories(scope, deleted_at);

  CREATE VIRTUAL TABLE memories_fts USING fts5(
    text, content='memories', content_rowid='id', tokenize='trigram'
  );
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE OF text ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
  END;

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    memory_id INTEGER NOT NULL,
    before_text TEXT,
    after_text TEXT,
    before_deleted INTEGER,
    after_deleted INTEGER,
    undone INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    risk TEXT NOT NULL DEFAULT '[]',
    proposed_by TEXT NOT NULL,
    proposed_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT
  );
  `,
];

export function openDb(path: string): DB {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const isNew = path === ":memory:" || !existsSync(path);
  const db = new Database(path);
  if (isNew && path !== ":memory:") chmodSync(path, 0o600);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
