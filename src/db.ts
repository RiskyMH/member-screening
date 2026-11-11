import { SQL } from "bun";

/** Screening rules, stored as a bitfield in the database. */
export enum JoinGuardCheck {
  RecentAccount = 1 << 0,
  Flagged = 1 << 1,
  DefaultPfp = 1 << 2,
  NoGlobalName = 1 << 3,
}

export const ALL_CHECKS =
  JoinGuardCheck.RecentAccount |
  JoinGuardCheck.Flagged |
  JoinGuardCheck.DefaultPfp |
  JoinGuardCheck.NoGlobalName;

export const CHECK_LABELS: Record<JoinGuardCheck, string> = {
  [JoinGuardCheck.RecentAccount]: "Recent accounts",
  [JoinGuardCheck.Flagged]: "Spammer / unusual DM flags",
  [JoinGuardCheck.DefaultPfp]: "Default avatars",
  [JoinGuardCheck.NoGlobalName]: "No global name",
};

/** Verification window is fixed at 15 minutes. */
export const VERIFY_WINDOW_SECONDS = 15 * 60;

export enum QuarantineStatus {
  Pending = "pending",
  Passed = "passed",
  Kicked = "kicked",
  Left = "left",
}

export type JoinGuardConfig = {
  guild_id: string;
  quarantine_channel_id: string | null;
  quarantine_role_id: string | null;
  log_channel_id: string | null;
  checks: number;
  warning_message_id: string | null;
};

export type QuarantineRow = {
  guild_id: string;
  user_id: string;
  thread_id: string;
  role_id: string;
  status: QuarantineStatus;
  reasons: string;
  failed_checks: number;
  log_channel_id: string | null;
  log_message_id: string | null;
  created_at: number;
  expires_at: number | null;
};

export const db = new SQL(process.env.DATABASE_URL ?? "sqlite://db.sqlite");

export async function initDb() {
  if (db.options.adapter === "sqlite") {
    try {
      await db`PRAGMA foreign_keys = ON;`;
      await db`PRAGMA journal_mode = WAL;`;
      await db`PRAGMA busy_timeout = 5000;`;
      await db`PRAGMA wal_autocheckpoint = 1000;`;
      await db`PRAGMA synchronous = NORMAL;`;
    } catch (err) {
      console.error("Failed to set PRAGMA settings:", err);
    }
  }

  await db`
    CREATE TABLE IF NOT EXISTS join_guard_config (
      guild_id TEXT PRIMARY KEY,
      quarantine_channel_id TEXT,
      quarantine_role_id TEXT,
      log_channel_id TEXT,
      checks INTEGER NOT NULL DEFAULT 15,
      warning_message_id TEXT
    );
  `;

  await db`
    CREATE TABLE IF NOT EXISTS quarantines (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reasons TEXT NOT NULL DEFAULT '[]',
      failed_checks INTEGER NOT NULL DEFAULT 0,
      log_channel_id TEXT,
      log_message_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (guild_id, user_id)
    );
  `;

  await db`
    CREATE INDEX IF NOT EXISTS quarantines_expiry
    ON quarantines (status, expires_at);
  `;
}

export async function removeGuild(guild_id: string): Promise<void> {
  await db`DELETE FROM quarantines WHERE guild_id = ${guild_id};`;
  await db`DELETE FROM join_guard_config WHERE guild_id = ${guild_id};`;
}

export async function getConfig(guild_id: string): Promise<JoinGuardConfig> {
  const [row] = await db`SELECT * FROM join_guard_config WHERE guild_id = ${guild_id}`;
  return {
    guild_id,
    quarantine_channel_id: row?.quarantine_channel_id ?? null,
    quarantine_role_id: row?.quarantine_role_id ?? null,
    log_channel_id: row?.log_channel_id ?? null,
    checks: Number(row?.checks ?? ALL_CHECKS),
    warning_message_id: row?.warning_message_id ?? null,
  };
}

export async function setConfig(
  guild_id: string,
  config: Pick<JoinGuardConfig, "quarantine_channel_id" | "quarantine_role_id" | "log_channel_id" | "checks">,
): Promise<void> {
  await db`
    INSERT INTO join_guard_config (guild_id, quarantine_channel_id, quarantine_role_id, log_channel_id, checks)
    VALUES (${guild_id}, ${config.quarantine_channel_id}, ${config.quarantine_role_id}, ${config.log_channel_id}, ${config.checks})
    ON CONFLICT(guild_id) DO UPDATE SET
      quarantine_channel_id = excluded.quarantine_channel_id,
      quarantine_role_id = excluded.quarantine_role_id,
      log_channel_id = excluded.log_channel_id,
      checks = excluded.checks;
  `;
}

export async function setWarningMessage(guild_id: string, messageId: string | null): Promise<void> {
  await db`UPDATE join_guard_config SET warning_message_id = ${messageId} WHERE guild_id = ${guild_id};`;
}

export async function createQuarantine(row: {
  guild_id: string;
  user_id: string;
  thread_id: string;
  role_id: string;
  reasons: string[];
  failed_checks: number;
  expires_at: number | null;
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db`
    INSERT INTO quarantines (guild_id, user_id, thread_id, role_id, status, reasons, failed_checks, created_at, expires_at)
    VALUES (${row.guild_id}, ${row.user_id}, ${row.thread_id}, ${row.role_id}, ${QuarantineStatus.Pending}, ${JSON.stringify(row.reasons)}, ${row.failed_checks}, ${now}, ${row.expires_at})
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      thread_id = excluded.thread_id,
      role_id = excluded.role_id,
      status = excluded.status,
      reasons = excluded.reasons,
      failed_checks = excluded.failed_checks,
      log_channel_id = NULL,
      log_message_id = NULL,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at;
  `;
}

export async function setQuarantineLog(
  guild_id: string,
  user_id: string,
  thread_id: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await db`
    UPDATE quarantines
    SET log_channel_id = ${channelId}, log_message_id = ${messageId}
    WHERE guild_id = ${guild_id} AND user_id = ${user_id} AND thread_id = ${thread_id};
  `;
}

export async function getQuarantine(guild_id: string, user_id: string): Promise<QuarantineRow | null> {
  const [row] = await db`
    SELECT * FROM quarantines
    WHERE guild_id = ${guild_id} AND user_id = ${user_id}
  `;
  if (!row) return null;
  return row as QuarantineRow;
}

export async function getExpiredQuarantines(now: number): Promise<QuarantineRow[]> {
  const rows = await db`
    SELECT * FROM quarantines
    WHERE status = ${QuarantineStatus.Pending}
      AND expires_at IS NOT NULL
      AND expires_at <= ${now}
  `;
  return rows as QuarantineRow[];
}

export async function setQuarantineStatus(
  guild_id: string,
  user_id: string,
  status: QuarantineStatus,
): Promise<void> {
  await db`
    UPDATE quarantines
    SET status = ${status}
    WHERE guild_id = ${guild_id} AND user_id = ${user_id} AND status = ${QuarantineStatus.Pending};
  `;
}
