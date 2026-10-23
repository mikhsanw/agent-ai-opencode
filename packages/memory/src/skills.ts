import type { DB } from "./db.js";
import { findSecrets, type SecretFinding } from "./secrets.js";
import { toSingleLine } from "./sanitize.js";

export type SkillStatus = "pending" | "approved" | "rejected";

export type RiskFlag = "shell" | "url" | "sensitive_path" | "override" | "encoded";

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  status: SkillStatus;
  risk: RiskFlag[];
  proposedBy: string;
  proposedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export interface SkillLimits {
  maxBodyChars: number;
  maxDescriptionChars: number;
  /** Usulan yang tidak diputuskan dalam jangka ini dianggap kedaluwarsa. */
  pendingTtlMs: number;
}

export const DEFAULT_SKILL_LIMITS: SkillLimits = {
  maxBodyChars: 8000,
  maxDescriptionChars: 300,
  pendingTtlMs: 14 * 24 * 60 * 60 * 1000,
};

export type ProposeResult =
  | { status: "pending"; skill: Skill }
  | { status: "rejected"; reason: "invalid_id" | "invalid_name" | "empty" | "too_long" | "exists"; detail?: string }
  | { status: "rejected"; reason: "secret"; findings: SecretFinding[] };

const ID_RE = /^[a-z0-9][a-z0-9-]{2,47}$/;

const RISK_RULES: { flag: RiskFlag; re: RegExp }[] = [
  {
    flag: "shell",
    re: /```(?:bash|sh|shell|zsh|console)\b|\b(?:sudo|rm\s+-[a-z]*r[a-z]*f?|chmod|chown|curl|wget|nc|ncat|ssh|scp|eval|exec|crontab|systemctl)\b|\|\s*(?:ba|z)?sh\b/i,
  },
  { flag: "url", re: /\bhttps?:\/\/|\bftp:\/\//i },
  { flag: "sensitive_path", re: /(?:~\/|\/root\b|\/etc\/|\.ssh\b|(?:^|[\s/])\.env\b|\/var\/lib\/|id_rsa|authorized_keys)/i },
  {
    flag: "override",
    re: /\b(?:abaikan|lupakan|ignore|disregard|override)\b[^.\n]{0,40}\b(?:instruksi|perintah|aturan|instructions?|rules?|previous)\b|jangan\s+(?:beri\s*tahu|bilang|laporkan)\s+(?:ke\s+)?pengguna|do\s+not\s+(?:tell|inform)\s+the\s+user/i,
  },
  { flag: "encoded", re: /[A-Za-z0-9+/]{80,}={0,2}/ },
];

export function riskFlags(text: string): RiskFlag[] {
  return RISK_RULES.filter((r) => r.re.test(text)).map((r) => r.flag);
}

interface Row {
  id: string;
  name: string;
  description: string;
  body: string;
  status: SkillStatus;
  risk: string;
  proposed_by: string;
  proposed_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

const toSkill = (r: Row): Skill => ({
  id: r.id,
  name: r.name,
  description: r.description,
  body: r.body,
  status: r.status,
  risk: JSON.parse(r.risk) as RiskFlag[],
  proposedBy: r.proposed_by,
  proposedAt: r.proposed_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
});

/**
 * Skill hasil belajar. Agen hanya bisa MENGUSULKAN (status pending).
 * `approve`/`reject` sengaja tidak diekspos lewat MCP; hanya dipanggil handler Telegram in-process.
 */
export class SkillStore {
  readonly limits: SkillLimits;

  constructor(
    private readonly db: DB,
    limits: Partial<SkillLimits> = {},
    private readonly now: () => number = Date.now,
    private readonly onChange: () => void = () => {},
  ) {
    this.limits = { ...DEFAULT_SKILL_LIMITS, ...limits };
  }

  propose(input: { id: string; name: string; description: string; body: string; actor: string }): ProposeResult {
    const id = input.id.trim().toLowerCase();
    if (!ID_RE.test(id)) {
      return { status: "rejected", reason: "invalid_id", detail: "pakai huruf kecil, angka, dan '-', 3-48 karakter" };
    }
    const name = toSingleLine(input.name);
    const description = toSingleLine(input.description);
    const body = input.body.replace(/\r\n/g, "\n").trim();
    if (!name || name.length > 80) return { status: "rejected", reason: "invalid_name", detail: "1-80 karakter" };
    if (!description || !body) return { status: "rejected", reason: "empty" };
    if (description.length > this.limits.maxDescriptionChars || body.length > this.limits.maxBodyChars) {
      return {
        status: "rejected",
        reason: "too_long",
        detail: `deskripsi maks ${this.limits.maxDescriptionChars}, isi maks ${this.limits.maxBodyChars} karakter`,
      };
    }
    const findings = findSecrets(`${name}\n${description}\n${body}`);
    if (findings.length > 0) return { status: "rejected", reason: "secret", findings };

    const existing = this.getAny(id);
    if (existing && existing.status === "approved") {
      return { status: "rejected", reason: "exists", detail: "skill dengan id ini sudah aktif; usulkan dengan id baru" };
    }

    const risk = riskFlags(`${description}\n${body}`);
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO skills (id, name, description, body, status, risk, proposed_by, proposed_at, decided_at, decided_by)
         VALUES (@id, @name, @description, @body, 'pending', @risk, @actor, @ts, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET name = @name, description = @description, body = @body, status = 'pending',
           risk = @risk, proposed_by = @actor, proposed_at = @ts, decided_at = NULL, decided_by = NULL`,
      )
      .run({ id, name, description, body, risk: JSON.stringify(risk), actor: input.actor, ts });
    this.onChange();
    return { status: "pending", skill: this.getAny(id)! };
  }

  /** Skill aktif saja; inilah satu-satunya yang boleh dilihat agen. */
  listApproved(): Skill[] {
    return (this.db.prepare("SELECT * FROM skills WHERE status = 'approved' ORDER BY id").all() as Row[]).map(toSkill);
  }

  getApproved(id: string): Skill | undefined {
    const row = this.db.prepare("SELECT * FROM skills WHERE id = ? AND status = 'approved'").get(id) as Row | undefined;
    return row ? toSkill(row) : undefined;
  }

  listPending(): Skill[] {
    const cutoff = this.now() - this.limits.pendingTtlMs;
    return (
      this.db.prepare("SELECT * FROM skills WHERE status = 'pending' AND proposed_at >= ? ORDER BY proposed_at").all(cutoff) as Row[]
    ).map(toSkill);
  }

  approve(id: string, by: string): Skill | undefined {
    return this.decide(id, "approved", by);
  }

  reject(id: string, by: string): Skill | undefined {
    return this.decide(id, "rejected", by);
  }

  /** Nonaktifkan skill yang sudah disetujui (mis. lewat Telegram). */
  revoke(id: string, by: string): Skill | undefined {
    const skill = this.getApproved(id);
    if (!skill) return undefined;
    this.db.prepare("UPDATE skills SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?").run(this.now(), by, id);
    this.onChange();
    return this.getAny(id);
  }

  private decide(id: string, status: "approved" | "rejected", by: string): Skill | undefined {
    const pending = this.listPending().find((s) => s.id === id);
    if (!pending) return undefined;
    this.db.prepare("UPDATE skills SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?").run(status, this.now(), by, id);
    this.onChange();
    return this.getAny(id);
  }

  private getAny(id: string): Skill | undefined {
    const row = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as Row | undefined;
    return row ? toSkill(row) : undefined;
  }
}
