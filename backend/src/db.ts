import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";

const requestedDbPath = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.resolve(__dirname, "../data.sqlite");
let dbPath = requestedDbPath;
try {
  const dbDir = path.dirname(requestedDbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
} catch {
  // Render free instances may reject paths like /var/data.
  dbPath = path.resolve("/tmp/data.sqlite");
  const fallbackDir = path.dirname(dbPath);
  if (!fs.existsSync(fallbackDir)) {
    fs.mkdirSync(fallbackDir, { recursive: true });
  }
}
export const db = new sqlite3.Database(dbPath);

export function run(sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onResult(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

export function get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row as T | undefined);
    });
  });
}

export function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows as T[]);
    });
  });
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await all<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some((row) => row.name === column);
}

async function tableSql(table: string): Promise<string | undefined> {
  const row = await get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return row?.sql;
}

export async function initDb() {
  await run(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await run(
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    )`,
  );
  if (!(await columnExists("sessions", "expires_at"))) {
    await run("ALTER TABLE sessions ADD COLUMN expires_at TEXT");
    await run("UPDATE sessions SET expires_at = datetime(created_at, '+7 days') WHERE expires_at IS NULL");
  }
  if (!(await columnExists("sessions", "revoked_at"))) {
    await run("ALTER TABLE sessions ADD COLUMN revoked_at TEXT");
  }
  await run(
    `CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await run(
    `CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await run(
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await run(
    `CREATE TABLE IF NOT EXISTS replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await run(
    `CREATE TABLE IF NOT EXISTS thread_reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      thread_id INTEGER NOT NULL,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, thread_id)
    )`,
  );
  await run(
    `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL UNIQUE,
      channel_id INTEGER NOT NULL,
      thread_id INTEGER NOT NULL,
      created_by INTEGER NOT NULL,
      title TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('open','doing','done')) DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  const currentTasksSql = (await tableSql("tasks")) || "";
  if (currentTasksSql && !currentTasksSql.includes("'doing'")) {
    await run(
      `CREATE TABLE IF NOT EXISTS tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL UNIQUE,
        channel_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        created_by INTEGER NOT NULL,
        title TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('open','doing','done')) DEFAULT 'open',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );
    await run(
      `INSERT INTO tasks_new (id, message_id, channel_id, thread_id, created_by, title, note, status, created_at, updated_at)
       SELECT id, message_id, channel_id, thread_id, created_by, title, '', status, created_at, updated_at
       FROM tasks`,
    );
    await run("DROP TABLE tasks");
    await run("ALTER TABLE tasks_new RENAME TO tasks");
  }
  if (!(await columnExists("tasks", "note"))) {
    await run("ALTER TABLE tasks ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  }
  const existing = await get<{ count: number }>("SELECT COUNT(*) as count FROM channels");
  if (!existing || existing.count === 0) {
    await run("INSERT INTO channels (name) VALUES (?)", ["general"]);
  }
  const generalChannel = await get<{ id: number }>("SELECT id FROM channels WHERE name = ?", ["general"]);
  if (generalChannel) {
    const generalMainThread = await get<{ id: number }>(
      "SELECT id FROM threads WHERE channel_id = ? AND lower(title) = 'main' LIMIT 1",
      [generalChannel.id],
    );
    if (!generalMainThread) {
      await run("INSERT INTO threads (channel_id, title, created_by) VALUES (?, ?, ?)", [generalChannel.id, "main", 0]);
    }
  }
}
