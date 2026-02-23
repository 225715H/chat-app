import cors from "cors";
import crypto from "crypto";
import express, { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { all, get, initDb, run } from "./db";

const app = express();
const PORT = Number(process.env.PORT || 4000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 7);
const DONE_TASK_RETENTION_DAYS = Number(process.env.DONE_TASK_RETENTION_DAYS || 7);
const TASK_BOT_NAME = "TaskBot";
const TASK_BOT_EMAIL = "taskbot@system.local";
const DEFAULT_TASK_BOT_MESSAGE_TEMPLATE = `Task created: "{title}" by {creator}`;

app.use(
  cors({
    origin: FRONTEND_ORIGIN,
  }),
);
app.use(express.json());

type User = { id: number; name: string; email: string };
type AuthRequest = Request & { user?: User };
type TaskStatus = "open" | "doing" | "done";
type TaskRow = {
  id: number;
  message_id: number;
  channel_id: number;
  thread_id: number;
  created_by: number;
  title: string;
  note: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  created_by_name?: string;
  channel_name?: string;
  thread_title?: string;
};
type ReplyRow = {
  id: number;
  message_id: number;
  user_id: number;
  content: string;
  created_at: string;
  user_name: string;
};
type ServerEvent =
  | { type: "channel_created"; channel: { id: number; name: string; created_at: string } }
  | {
      type: "thread_created";
      channelId: number;
      thread: { id: number; channel_id: number; title: string; created_by: number; created_at: string };
    }
  | {
      type: "message_created";
      threadId: number;
      channelId: number;
      channelName: string;
      threadTitle: string;
      message: { id: number; thread_id: number; user_id: number; content: string; created_at: string; user_name: string; reply_count: number };
    }
  | {
      type: "message_updated";
      threadId: number;
      channelId: number;
      channelName: string;
      threadTitle: string;
      message: { id: number; thread_id: number; user_id: number; content: string; created_at: string; user_name: string; reply_count: number };
    }
  | {
      type: "message_deleted";
      threadId: number;
      channelId: number;
      channelName: string;
      threadTitle: string;
      messageId: number;
    }
  | {
      type: "reply_created";
      threadId: number;
      channelId: number;
      channelName: string;
      threadTitle: string;
      messageId: number;
      reply: ReplyRow;
    }
  | {
      type: "reply_updated";
      threadId: number;
      channelId: number;
      channelName: string;
      threadTitle: string;
      messageId: number;
      reply: ReplyRow;
    }
  | {
      type: "reply_deleted";
      threadId: number;
      channelId: number;
      channelName: string;
      threadTitle: string;
      messageId: number;
      replyId: number;
    }
  | { type: "task_created"; task: TaskRow }
  | { type: "task_updated"; task: TaskRow }
  | { type: "task_deleted"; taskId: number; messageId: number; channelId: number; threadId: number };

const streamClients = new Set<Response>();

function broadcastEvent(event: ServerEvent) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of streamClients) {
    try {
      client.write(payload);
    } catch {
      streamClients.delete(client);
    }
  }
}

function hashPassword(password: string) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function getSessionId(req: Request): string | undefined {
  const querySid = typeof req.query.sid === "string" ? req.query.sid : undefined;
  const headerSid = req.header("x-session-id") || undefined;
  return querySid || headerSid;
}

function stripTaskFlag(content: string): string {
  return content.replace(/(^|\s):task(\s|$)/gi, " ").trim();
}

function parseTaskPayload(content: string): { title: string | null; note: string } {
  const cleaned = stripTaskFlag(content).replace(/\r\n/g, "\n").trimEnd();
  const newlineIndex = cleaned.indexOf("\n");
  if (newlineIndex === -1) {
    const title = cleaned.trim();
    if (!title) {
      return { title: null, note: "" };
    }
    return { title, note: "" };
  }
  const title = cleaned.slice(0, newlineIndex).trim();
  if (!title) {
    return { title: null, note: "" };
  }
  const note = cleaned.slice(newlineIndex + 1).replace(/^\n+/, "").trimEnd();
  return { title, note };
}

function renderTaskBotMessage(template: string | undefined, title: string, creator: string): string {
  const source = (template || "").trim();
  if (!source) {
    return DEFAULT_TASK_BOT_MESSAGE_TEMPLATE.replace(/\{title\}/g, title).replace(/\{creator\}/g, creator);
  }
  return source.replace(/\{title\}/g, title).replace(/\{creator\}/g, creator);
}

function applyChecklistToggle(content: string, ordinal: number, checked: boolean): string {
  if (ordinal < 0) return content;
  const fenceRe = /```[\s\S]*?```/g;
  let out = "";
  let last = 0;
  let seen = 0;
  let updated = false;
  const replaceInPlain = (plain: string): string => {
    const lines = plain.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/^- \[( |x|X)\] /.test(line)) continue;
      if (seen === ordinal) {
        lines[i] = line.replace(/^- \[( |x|X)\] /, checked ? "- [x] " : "- [ ] ");
        updated = true;
      }
      seen += 1;
    }
    return lines.join("\n");
  };
  while (true) {
    const match = fenceRe.exec(content);
    if (!match) break;
    out += replaceInPlain(content.slice(last, match.index));
    out += match[0];
    last = fenceRe.lastIndex;
  }
  out += replaceInPlain(content.slice(last));
  return updated ? out : content;
}

async function issueSession(userId: number): Promise<string> {
  const sessionId = crypto.randomUUID();
  await run(
    "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', ?))",
    [sessionId, userId, `+${SESSION_TTL_DAYS} days`],
  );
  return sessionId;
}

async function getOrCreateTaskBotUserId(): Promise<number> {
  const bot = await get<{ id: number }>("SELECT id FROM users WHERE email = ?", [TASK_BOT_EMAIL]);
  if (bot) return bot.id;
  const created = await run("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [
    TASK_BOT_NAME,
    TASK_BOT_EMAIL,
    "__system__",
  ]);
  return created.lastID;
}

async function getCurrentUser(req: Request): Promise<User | undefined> {
  const sessionId = getSessionId(req);
  if (!sessionId) {
    return undefined;
  }
  await run("DELETE FROM sessions WHERE expires_at <= datetime('now') OR revoked_at IS NOT NULL");
  return get<User>(
    `SELECT users.id, users.name, users.email
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ?
       AND sessions.revoked_at IS NULL
       AND sessions.expires_at > datetime('now')`,
    [sessionId],
  );
}

async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const sessionId = getSessionId(req);
  const user = await getCurrentUser(req);
  if (!user || !sessionId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  await run("UPDATE sessions SET expires_at = datetime('now', ?) WHERE id = ?", [`+${SESSION_TTL_DAYS} days`, sessionId]);
  req.user = user;
  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/auth/signup", async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(4),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { name, email, password } = parsed.data;
  try {
    const result = await run("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [
      name,
      email,
      hashPassword(password),
    ]);
    const sessionId = await issueSession(result.lastID);
    res.json({ id: result.lastID, name, email, sessionId });
  } catch (error) {
    res.status(400).json({ error: "Email already exists or invalid request." });
  }
});

app.post("/auth/login", async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { email, password } = parsed.data;
  const user = await get<User & { password: string }>("SELECT * FROM users WHERE email = ?", [email]);
  if (!user || user.password !== hashPassword(password)) {
    res.status(401).json({ error: "Invalid credentials." });
    return;
  }

  const sessionId = await issueSession(user.id);
  res.json({ id: user.id, name: user.name, email: user.email, sessionId });
});

app.post("/auth/logout", requireAuth, async (req, res) => {
  const sessionId = getSessionId(req);
  if (sessionId) {
    await run("UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?", [sessionId]);
  }
  res.json({ ok: true });
});

app.get("/auth/me", requireAuth, async (req: AuthRequest, res) => {
  const sessionId = getSessionId(req);
  res.json({ ...req.user, sessionId });
});

app.get("/events", requireAuth, async (req: AuthRequest, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  streamClients.add(res);
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    streamClients.delete(res);
    res.end();
  });
});

app.get("/channels", requireAuth, async (_req, res) => {
  const channels = await all<{ id: number; name: string; created_at: string }>("SELECT * FROM channels ORDER BY id ASC");
  res.json(channels);
});

app.post("/channels", requireAuth, async (req: AuthRequest, res) => {
  const parsed = z.object({ name: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const result = await run("INSERT INTO channels (name) VALUES (?)", [parsed.data.name]);
    const channel = await get<{ id: number; name: string; created_at: string }>("SELECT * FROM channels WHERE id = ?", [
      result.lastID,
    ]);
    const mainThreadResult = await run("INSERT INTO threads (channel_id, title, created_by) VALUES (?, ?, ?)", [
      result.lastID,
      "main",
      req.user!.id,
    ]);
    const mainThread = await get<{ id: number; channel_id: number; title: string; created_by: number; created_at: string }>(
      "SELECT * FROM threads WHERE id = ?",
      [mainThreadResult.lastID],
    );
    if (channel) {
      broadcastEvent({ type: "channel_created", channel });
    }
    if (mainThread) {
      broadcastEvent({ type: "thread_created", channelId: result.lastID, thread: mainThread });
    }
    res.json(channel);
  } catch {
    res.status(400).json({ error: "Channel name already exists." });
  }
});

app.get("/channels/:channelId/threads", requireAuth, async (req, res) => {
  const channelId = Number(req.params.channelId);
  const threads = await all<{ id: number; title: string; created_at: string; created_by: number }>(
    "SELECT id, title, created_at, created_by FROM threads WHERE channel_id = ? ORDER BY id DESC",
    [channelId],
  );
  res.json(threads);
});

app.post("/channels/:channelId/threads", requireAuth, async (req: AuthRequest, res) => {
  const channelId = Number(req.params.channelId);
  const parsed = z.object({ title: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success || !req.user) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const result = await run("INSERT INTO threads (channel_id, title, created_by) VALUES (?, ?, ?)", [
    channelId,
    parsed.data.title,
    req.user.id,
  ]);
  const thread = await get<{ id: number; channel_id: number; title: string; created_by: number; created_at: string }>(
    "SELECT * FROM threads WHERE id = ?",
    [result.lastID],
  );
  if (thread) {
    broadcastEvent({ type: "thread_created", channelId, thread });
  }
  res.json(thread);
});

app.get("/threads/:threadId/messages", requireAuth, async (req, res) => {
  const threadId = Number(req.params.threadId);
  const messages = await all<{
    id: number;
    thread_id: number;
    user_id: number;
    content: string;
    created_at: string;
    user_name: string;
    reply_count: number;
  }>(
    `SELECT messages.*,
            users.name as user_name,
            COALESCE((SELECT COUNT(*) FROM replies WHERE replies.message_id = messages.id), 0) as reply_count
     FROM messages
     JOIN users ON users.id = messages.user_id
     WHERE thread_id = ?
     ORDER BY id ASC`,
    [threadId],
  );
  res.json(messages);
});

app.post("/threads/:threadId/messages", requireAuth, async (req: AuthRequest, res) => {
  const threadId = Number(req.params.threadId);
  const parsed = z
    .object({ content: z.string().min(1), createTask: z.boolean().optional(), botMessage: z.string().max(300).optional() })
    .safeParse(req.body);
  if (!parsed.success || !req.user) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const rawContent = parsed.data.content.trim();
  const hasTaskFlag = /(^|\s):task(\s|$)/i.test(rawContent);
  const shouldCreateTask = parsed.data.createTask === true || hasTaskFlag;
  const sanitizedContent = hasTaskFlag ? stripTaskFlag(rawContent) : rawContent;
  const contentForMessage = sanitizedContent.length > 0 ? sanitizedContent : rawContent;
  const taskPayload = parseTaskPayload(parsed.data.createTask === true ? contentForMessage : rawContent);
  const taskTitle = taskPayload.title;
  const taskNote = taskPayload.note;
  const result = await run("INSERT INTO messages (thread_id, user_id, content) VALUES (?, ?, ?)", [
    threadId,
    req.user.id,
    contentForMessage,
  ]);
  const message = await get<{
    id: number;
    thread_id: number;
    user_id: number;
    content: string;
    created_at: string;
    user_name: string;
    reply_count: number;
  }>(
    `SELECT messages.*,
            users.name as user_name,
            COALESCE((SELECT COUNT(*) FROM replies WHERE replies.message_id = messages.id), 0) as reply_count
     FROM messages
     JOIN users ON users.id = messages.user_id
     WHERE messages.id = ?`,
    [result.lastID],
  );
  if (message) {
    const threadMeta = await get<{ channel_id: number; channel_name: string; thread_title: string }>(
      `SELECT threads.channel_id, channels.name as channel_name, threads.title as thread_title
       FROM threads
       JOIN channels ON channels.id = threads.channel_id
       WHERE threads.id = ?`,
      [threadId],
    );
    if (threadMeta) {
      broadcastEvent({
        type: "message_created",
        threadId,
        channelId: threadMeta.channel_id,
        channelName: threadMeta.channel_name,
        threadTitle: threadMeta.thread_title,
        message,
      });
    }
    if (shouldCreateTask && taskTitle) {
      const threadInfo = await get<{ channel_id: number }>("SELECT channel_id FROM threads WHERE id = ?", [threadId]);
      if (threadInfo) {
        await run(
          `INSERT OR IGNORE INTO tasks (message_id, channel_id, thread_id, created_by, title, note, status)
           VALUES (?, ?, ?, ?, ?, ?, 'open')`,
          [message.id, threadInfo.channel_id, threadId, req.user.id, taskTitle, taskNote],
        );
        const task = await get<TaskRow>(
          `SELECT tasks.*, users.name as created_by_name, channels.name as channel_name, threads.title as thread_title
           FROM tasks
           JOIN users ON users.id = tasks.created_by
           JOIN channels ON channels.id = tasks.channel_id
           JOIN threads ON threads.id = tasks.thread_id
           WHERE tasks.message_id = ?`,
          [message.id],
        );
        if (task) {
          broadcastEvent({ type: "task_created", task });
        }
      }
    }
  }
  res.json(message);
});

app.patch("/messages/:messageId", requireAuth, async (req: AuthRequest, res) => {
  const messageId = Number(req.params.messageId);
  const parsed = z.object({ content: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success || !req.user) {
    res.status(400).json({ error: "Invalid body." });
    return;
  }
  const existing = await get<{ id: number; thread_id: number; user_id: number }>(
    "SELECT id, thread_id, user_id FROM messages WHERE id = ?",
    [messageId],
  );
  if (!existing) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  if (existing.user_id !== req.user.id) {
    res.status(403).json({ error: "You can edit only your own messages." });
    return;
  }

  const nextContent = parsed.data.content.trim();
  if (!nextContent) {
    res.status(400).json({ error: "Message cannot be empty." });
    return;
  }

  await run("UPDATE messages SET content = ? WHERE id = ?", [nextContent, messageId]);
  const message = await get<{
    id: number;
    thread_id: number;
    user_id: number;
    content: string;
    created_at: string;
    user_name: string;
    reply_count: number;
  }>(
    `SELECT messages.*,
            users.name as user_name,
            COALESCE((SELECT COUNT(*) FROM replies WHERE replies.message_id = messages.id), 0) as reply_count
     FROM messages
     JOIN users ON users.id = messages.user_id
     WHERE messages.id = ?`,
    [messageId],
  );
  if (!message) {
    res.status(500).json({ error: "Failed to update message." });
    return;
  }
  const threadMeta = await get<{ channel_id: number; channel_name: string; thread_title: string }>(
    `SELECT threads.channel_id, channels.name as channel_name, threads.title as thread_title
     FROM threads
     JOIN channels ON channels.id = threads.channel_id
     WHERE threads.id = ?`,
    [message.thread_id],
  );
  if (threadMeta) {
    broadcastEvent({
      type: "message_updated",
      threadId: message.thread_id,
      channelId: threadMeta.channel_id,
      channelName: threadMeta.channel_name,
      threadTitle: threadMeta.thread_title,
      message,
    });
  }
  res.json(message);
});

app.post("/messages/:messageId/checklist", requireAuth, async (req: AuthRequest, res) => {
  const messageId = Number(req.params.messageId);
  const parsed = z.object({ ordinal: z.number().int().min(0), checked: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const existing = await get<{ id: number; thread_id: number; content: string }>(
    "SELECT id, thread_id, content FROM messages WHERE id = ?",
    [messageId],
  );
  if (!existing) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  const nextContent = applyChecklistToggle(existing.content, parsed.data.ordinal, parsed.data.checked);
  if (nextContent === existing.content) {
    res.status(400).json({ error: "Checklist item not found." });
    return;
  }
  await run("UPDATE messages SET content = ? WHERE id = ?", [nextContent, messageId]);
  const message = await get<{
    id: number;
    thread_id: number;
    user_id: number;
    content: string;
    created_at: string;
    user_name: string;
    reply_count: number;
  }>(
    `SELECT messages.*,
            users.name as user_name,
            COALESCE((SELECT COUNT(*) FROM replies WHERE replies.message_id = messages.id), 0) as reply_count
     FROM messages
     JOIN users ON users.id = messages.user_id
     WHERE messages.id = ?`,
    [messageId],
  );
  if (!message) {
    res.status(500).json({ error: "Failed to update message." });
    return;
  }
  const threadMeta = await get<{ channel_id: number; channel_name: string; thread_title: string }>(
    `SELECT threads.channel_id, channels.name as channel_name, threads.title as thread_title
     FROM threads
     JOIN channels ON channels.id = threads.channel_id
     WHERE threads.id = ?`,
    [message.thread_id],
  );
  if (threadMeta) {
    broadcastEvent({
      type: "message_updated",
      threadId: message.thread_id,
      channelId: threadMeta.channel_id,
      channelName: threadMeta.channel_name,
      threadTitle: threadMeta.thread_title,
      message,
    });
  }
  res.json(message);
});

app.delete("/messages/:messageId", requireAuth, async (req: AuthRequest, res) => {
  const messageId = Number(req.params.messageId);
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const existing = await get<{ id: number; thread_id: number; user_id: number }>(
    "SELECT id, thread_id, user_id FROM messages WHERE id = ?",
    [messageId],
  );
  if (!existing) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  if (existing.user_id !== req.user.id) {
    res.status(403).json({ error: "You can delete only your own messages." });
    return;
  }
  const threadMeta = await get<{ channel_id: number; channel_name: string; thread_title: string }>(
    `SELECT threads.channel_id, channels.name as channel_name, threads.title as thread_title
     FROM threads
     JOIN channels ON channels.id = threads.channel_id
     WHERE threads.id = ?`,
    [existing.thread_id],
  );
  await run("DELETE FROM replies WHERE message_id = ?", [messageId]);
  await run("DELETE FROM tasks WHERE message_id = ?", [messageId]);
  await run("DELETE FROM messages WHERE id = ?", [messageId]);
  if (threadMeta) {
    broadcastEvent({
      type: "message_deleted",
      threadId: existing.thread_id,
      channelId: threadMeta.channel_id,
      channelName: threadMeta.channel_name,
      threadTitle: threadMeta.thread_title,
      messageId,
    });
  }
  res.json({ ok: true });
});

app.get("/messages/:messageId/replies", requireAuth, async (req, res) => {
  const messageId = Number(req.params.messageId);
  const parent = await get<{ id: number }>("SELECT id FROM messages WHERE id = ?", [messageId]);
  if (!parent) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  const replies = await all<ReplyRow>(
    `SELECT replies.*, users.name as user_name
     FROM replies
     JOIN users ON users.id = replies.user_id
     WHERE replies.message_id = ?
     ORDER BY replies.id ASC`,
    [messageId],
  );
  res.json(replies);
});

app.post("/messages/:messageId/replies", requireAuth, async (req: AuthRequest, res) => {
  const messageId = Number(req.params.messageId);
  const parsed = z
    .object({ content: z.string().min(1), createTask: z.boolean().optional(), botMessage: z.string().max(300).optional() })
    .safeParse(req.body);
  if (!parsed.success || !req.user) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const parent = await get<{ id: number; thread_id: number }>("SELECT id, thread_id FROM messages WHERE id = ?", [messageId]);
  if (!parent) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  const rawContent = parsed.data.content.trim();
  const hasTaskFlag = /(^|\s):task(\s|$)/i.test(rawContent);
  const shouldCreateTask = parsed.data.createTask === true || hasTaskFlag;
  const sanitizedContent = hasTaskFlag ? stripTaskFlag(rawContent) : rawContent;
  const contentForReply = sanitizedContent.length > 0 ? sanitizedContent : rawContent;
  const taskPayload = parseTaskPayload(parsed.data.createTask === true ? contentForReply : rawContent);
  const taskTitle = taskPayload.title;
  const taskNote = taskPayload.note;
  if (!contentForReply) {
    res.status(400).json({ error: "Reply cannot be empty." });
    return;
  }
  const created = await run("INSERT INTO replies (message_id, user_id, content) VALUES (?, ?, ?)", [messageId, req.user.id, contentForReply]);
  const reply = await get<ReplyRow>(
    `SELECT replies.*, users.name as user_name
     FROM replies
     JOIN users ON users.id = replies.user_id
     WHERE replies.id = ?`,
    [created.lastID],
  );
  if (!reply) {
    res.status(500).json({ error: "Failed to create reply." });
    return;
  }
  const threadMeta = await get<{ channel_id: number; channel_name: string; thread_title: string }>(
    `SELECT threads.channel_id, channels.name as channel_name, threads.title as thread_title
     FROM threads
     JOIN channels ON channels.id = threads.channel_id
     WHERE threads.id = ?`,
    [parent.thread_id],
  );
  if (threadMeta) {
    broadcastEvent({
      type: "reply_created",
      threadId: parent.thread_id,
      channelId: threadMeta.channel_id,
      channelName: threadMeta.channel_name,
      threadTitle: threadMeta.thread_title,
      messageId,
      reply,
    });
  }
  if (shouldCreateTask && taskTitle) {
    const threadInfo = await get<{ channel_id: number }>("SELECT channel_id FROM threads WHERE id = ?", [parent.thread_id]);
    if (threadInfo) {
      const inserted = await run(
        `INSERT OR IGNORE INTO tasks (message_id, channel_id, thread_id, created_by, title, note, status)
         VALUES (?, ?, ?, ?, ?, ?, 'open')`,
        [messageId, threadInfo.channel_id, parent.thread_id, req.user.id, taskTitle, taskNote],
      );
      if (inserted.changes > 0) {
        const task = await get<TaskRow>(
          `SELECT tasks.*, users.name as created_by_name, channels.name as channel_name, threads.title as thread_title
           FROM tasks
           JOIN users ON users.id = tasks.created_by
           JOIN channels ON channels.id = tasks.channel_id
           JOIN threads ON threads.id = tasks.thread_id
           WHERE tasks.message_id = ?`,
          [messageId],
        );
        if (task) {
          broadcastEvent({ type: "task_created", task });
        }
      }
    }
  }
  res.json(reply);
});

app.patch("/replies/:replyId", requireAuth, async (req: AuthRequest, res) => {
  const replyId = Number(req.params.replyId);
  const parsed = z.object({ content: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success || !req.user) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const existing = await get<{ id: number; message_id: number; user_id: number }>(
    "SELECT id, message_id, user_id FROM replies WHERE id = ?",
    [replyId],
  );
  if (!existing) {
    res.status(404).json({ error: "Reply not found." });
    return;
  }
  if (existing.user_id !== req.user.id) {
    res.status(403).json({ error: "You can edit only your own replies." });
    return;
  }
  const nextContent = parsed.data.content.trim();
  if (!nextContent) {
    res.status(400).json({ error: "Reply cannot be empty." });
    return;
  }
  await run("UPDATE replies SET content = ? WHERE id = ?", [nextContent, replyId]);
  const reply = await get<ReplyRow>(
    `SELECT replies.*, users.name as user_name
     FROM replies
     JOIN users ON users.id = replies.user_id
     WHERE replies.id = ?`,
    [replyId],
  );
  if (!reply) {
    res.status(500).json({ error: "Failed to update reply." });
    return;
  }
  const parent = await get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", [existing.message_id]);
  if (!parent) {
    res.status(500).json({ error: "Parent message not found." });
    return;
  }
  const threadMeta = await get<{ channel_id: number; channel_name: string; thread_title: string }>(
    `SELECT threads.channel_id, channels.name as channel_name, threads.title as thread_title
     FROM threads
     JOIN channels ON channels.id = threads.channel_id
     WHERE threads.id = ?`,
    [parent.thread_id],
  );
  if (threadMeta) {
    broadcastEvent({
      type: "reply_updated",
      threadId: parent.thread_id,
      channelId: threadMeta.channel_id,
      channelName: threadMeta.channel_name,
      threadTitle: threadMeta.thread_title,
      messageId: existing.message_id,
      reply,
    });
  }
  res.json(reply);
});

app.post("/replies/:replyId/checklist", requireAuth, async (req: AuthRequest, res) => {
  const replyId = Number(req.params.replyId);
  const parsed = z.object({ ordinal: z.number().int().min(0), checked: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const existing = await get<{ id: number; message_id: number; content: string }>(
    "SELECT id, message_id, content FROM replies WHERE id = ?",
    [replyId],
  );
  if (!existing) {
    res.status(404).json({ error: "Reply not found." });
    return;
  }
  const nextContent = applyChecklistToggle(existing.content, parsed.data.ordinal, parsed.data.checked);
  if (nextContent === existing.content) {
    res.status(400).json({ error: "Checklist item not found." });
    return;
  }
  await run("UPDATE replies SET content = ? WHERE id = ?", [nextContent, replyId]);
  const reply = await get<ReplyRow>(
    `SELECT replies.*, users.name as user_name
     FROM replies
     JOIN users ON users.id = replies.user_id
     WHERE replies.id = ?`,
    [replyId],
  );
  if (!reply) {
    res.status(500).json({ error: "Failed to update reply." });
    return;
  }
  const parent = await get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", [existing.message_id]);
  if (!parent) {
    res.status(500).json({ error: "Parent message not found." });
    return;
  }
  const threadMeta = await get<{ channel_id: number; channel_name: string; thread_title: string }>(
    `SELECT threads.channel_id, channels.name as channel_name, threads.title as thread_title
     FROM threads
     JOIN channels ON channels.id = threads.channel_id
     WHERE threads.id = ?`,
    [parent.thread_id],
  );
  if (threadMeta) {
    broadcastEvent({
      type: "reply_updated",
      threadId: parent.thread_id,
      channelId: threadMeta.channel_id,
      channelName: threadMeta.channel_name,
      threadTitle: threadMeta.thread_title,
      messageId: existing.message_id,
      reply,
    });
  }
  res.json(reply);
});

app.delete("/replies/:replyId", requireAuth, async (req: AuthRequest, res) => {
  const replyId = Number(req.params.replyId);
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const existing = await get<{ id: number; message_id: number; user_id: number }>(
    "SELECT id, message_id, user_id FROM replies WHERE id = ?",
    [replyId],
  );
  if (!existing) {
    res.status(404).json({ error: "Reply not found." });
    return;
  }
  if (existing.user_id !== req.user.id) {
    res.status(403).json({ error: "You can delete only your own replies." });
    return;
  }
  const parent = await get<{ thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?", [existing.message_id]);
  if (!parent) {
    res.status(500).json({ error: "Parent message not found." });
    return;
  }
  const threadMeta = await get<{ channel_id: number; channel_name: string; thread_title: string }>(
    `SELECT threads.channel_id, channels.name as channel_name, threads.title as thread_title
     FROM threads
     JOIN channels ON channels.id = threads.channel_id
     WHERE threads.id = ?`,
    [parent.thread_id],
  );
  await run("DELETE FROM replies WHERE id = ?", [replyId]);
  if (threadMeta) {
    broadcastEvent({
      type: "reply_deleted",
      threadId: parent.thread_id,
      channelId: threadMeta.channel_id,
      channelName: threadMeta.channel_name,
      threadTitle: threadMeta.thread_title,
      messageId: existing.message_id,
      replyId,
    });
  }
  res.json({ ok: true });
});

app.post("/threads/:threadId/read", requireAuth, async (req: AuthRequest, res) => {
  const threadId = Number(req.params.threadId);
  const parsed = z.object({ lastReadMessageId: z.number().int().nonnegative() }).safeParse(req.body);
  if (!parsed.success || !req.user) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  await run(
    `INSERT INTO thread_reads (user_id, thread_id, last_read_message_id)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, thread_id)
     DO UPDATE SET last_read_message_id = excluded.last_read_message_id, updated_at = CURRENT_TIMESTAMP`,
    [req.user.id, threadId, parsed.data.lastReadMessageId],
  );
  res.json({ ok: true });
});

app.get("/tasks", requireAuth, async (req, res) => {
  const status =
    req.query.status === "done" ? "done" : req.query.status === "open" ? "open" : req.query.status === "doing" ? "doing" : undefined;
  const channelId = req.query.channelId ? Number(req.query.channelId) : undefined;
  const threadId = req.query.threadId ? Number(req.query.threadId) : undefined;
  const params: unknown[] = [];
  let where = "WHERE 1=1";
  if (status) {
    where += " AND tasks.status = ?";
    params.push(status);
    if (status === "done") {
      where += " AND tasks.updated_at >= datetime('now', ?)";
      params.push(`-${DONE_TASK_RETENTION_DAYS} days`);
    }
  } else {
    where += " AND (tasks.status != 'done' OR tasks.updated_at >= datetime('now', ?))";
    params.push(`-${DONE_TASK_RETENTION_DAYS} days`);
  }
  if (channelId) {
    where += " AND tasks.channel_id = ?";
    params.push(channelId);
  }
  if (threadId) {
    where += " AND tasks.thread_id = ?";
    params.push(threadId);
  }
  const tasks = await all<TaskRow>(
    `SELECT tasks.*, users.name as created_by_name, channels.name as channel_name, threads.title as thread_title
     FROM tasks
     JOIN users ON users.id = tasks.created_by
     JOIN channels ON channels.id = tasks.channel_id
     JOIN threads ON threads.id = tasks.thread_id
     ${where}
     ORDER BY tasks.id DESC
     LIMIT 200`,
    params,
  );
  res.json(tasks);
});

app.post("/tasks", requireAuth, async (req: AuthRequest, res) => {
  const parsed = z
    .object({
      threadId: z.number().int().positive(),
      title: z.string().min(1),
      note: z.string().optional(),
      botMessage: z.string().max(300).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success || !req.user) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const threadId = parsed.data.threadId;
  const title = parsed.data.title.trim();
  const note = (parsed.data.note || "").trim();
  if (!title) {
    res.status(400).json({ error: "Title cannot be empty." });
    return;
  }
  const threadMeta = await get<{ channel_id: number; channel_name: string; thread_title: string }>(
    `SELECT threads.channel_id, channels.name as channel_name, threads.title as thread_title
     FROM threads
     JOIN channels ON channels.id = threads.channel_id
     WHERE threads.id = ?`,
    [threadId],
  );
  if (!threadMeta) {
    res.status(404).json({ error: "Thread not found." });
    return;
  }
  const messageContent = note ? `${title}\n${note}` : title;
  const messageInsert = await run("INSERT INTO messages (thread_id, user_id, content) VALUES (?, ?, ?)", [
    threadId,
    req.user.id,
    messageContent,
  ]);
  const message = await get<{
    id: number;
    thread_id: number;
    user_id: number;
    content: string;
    created_at: string;
    user_name: string;
    reply_count: number;
  }>(
    `SELECT messages.*,
            users.name as user_name,
            COALESCE((SELECT COUNT(*) FROM replies WHERE replies.message_id = messages.id), 0) as reply_count
     FROM messages
     JOIN users ON users.id = messages.user_id
     WHERE messages.id = ?`,
    [messageInsert.lastID],
  );
  if (message) {
    broadcastEvent({
      type: "message_created",
      threadId,
      channelId: threadMeta.channel_id,
      channelName: threadMeta.channel_name,
      threadTitle: threadMeta.thread_title,
      message,
    });
  }
  await run(
    `INSERT INTO tasks (message_id, channel_id, thread_id, created_by, title, note, status)
     VALUES (?, ?, ?, ?, ?, ?, 'open')`,
    [messageInsert.lastID, threadMeta.channel_id, threadId, req.user.id, title, note],
  );
  const task = await get<TaskRow>(
    `SELECT tasks.*, users.name as created_by_name, channels.name as channel_name, threads.title as thread_title
     FROM tasks
     JOIN users ON users.id = tasks.created_by
     JOIN channels ON channels.id = tasks.channel_id
     JOIN threads ON threads.id = tasks.thread_id
     WHERE tasks.message_id = ?`,
    [messageInsert.lastID],
  );
  if (!task) {
    res.status(500).json({ error: "Failed to create task." });
    return;
  }
  broadcastEvent({ type: "task_created", task });
  const taskBotId = await getOrCreateTaskBotUserId();
  const botMessageText = renderTaskBotMessage(parsed.data.botMessage, task.title, req.user.name);
  const botMessageInsert = await run("INSERT INTO messages (thread_id, user_id, content) VALUES (?, ?, ?)", [threadId, taskBotId, botMessageText]);
  const botMessage = await get<{
    id: number;
    thread_id: number;
    user_id: number;
    content: string;
    created_at: string;
    user_name: string;
    reply_count: number;
  }>(
    `SELECT messages.*,
            users.name as user_name,
            COALESCE((SELECT COUNT(*) FROM replies WHERE replies.message_id = messages.id), 0) as reply_count
     FROM messages
     JOIN users ON users.id = messages.user_id
     WHERE messages.id = ?`,
    [botMessageInsert.lastID],
  );
  if (botMessage) {
    broadcastEvent({
      type: "message_created",
      threadId,
      channelId: threadMeta.channel_id,
      channelName: threadMeta.channel_name,
      threadTitle: threadMeta.thread_title,
      message: botMessage,
    });
  }
  res.json(task);
});

app.patch("/tasks/:taskId", requireAuth, async (req, res) => {
  const taskId = Number(req.params.taskId);
  const parsed = z
    .object({
      status: z.enum(["open", "doing", "done"]).optional(),
      title: z.string().min(1).optional(),
      note: z.string().optional(),
    })
    .refine((data) => data.status !== undefined || data.title !== undefined || data.note !== undefined, {
      message: "At least one field is required.",
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.title !== undefined && !parsed.data.title.trim()) {
    res.status(400).json({ error: "Title cannot be empty." });
    return;
  }
  const updates: string[] = [];
  const params: unknown[] = [];
  if (parsed.data.status !== undefined) {
    updates.push("status = ?");
    params.push(parsed.data.status);
  }
  if (parsed.data.title !== undefined) {
    updates.push("title = ?");
    params.push(parsed.data.title.trim());
  }
  if (parsed.data.note !== undefined) {
    updates.push("note = ?");
    params.push(parsed.data.note);
  }
  params.push(taskId);
  await run(`UPDATE tasks SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params);
  const task = await get<TaskRow>(
    `SELECT tasks.*, users.name as created_by_name, channels.name as channel_name, threads.title as thread_title
     FROM tasks
     JOIN users ON users.id = tasks.created_by
     JOIN channels ON channels.id = tasks.channel_id
     JOIN threads ON threads.id = tasks.thread_id
     WHERE tasks.id = ?`,
    [taskId],
  );
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  broadcastEvent({ type: "task_updated", task });
  res.json(task);
});

app.post("/tasks/:taskId/checklist", requireAuth, async (req, res) => {
  const taskId = Number(req.params.taskId);
  const parsed = z.object({ ordinal: z.number().int().min(0), checked: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const existing = await get<{ id: number; note: string }>("SELECT id, note FROM tasks WHERE id = ?", [taskId]);
  if (!existing) {
    res.status(404).json({ error: "Task not found." });
    return;
  }
  const nextNote = applyChecklistToggle(existing.note || "", parsed.data.ordinal, parsed.data.checked);
  if (nextNote === existing.note) {
    res.status(400).json({ error: "Checklist item not found." });
    return;
  }
  await run("UPDATE tasks SET note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [nextNote, taskId]);
  const task = await get<TaskRow>(
    `SELECT tasks.*, users.name as created_by_name, channels.name as channel_name, threads.title as thread_title
     FROM tasks
     JOIN users ON users.id = tasks.created_by
     JOIN channels ON channels.id = tasks.channel_id
     JOIN threads ON threads.id = tasks.thread_id
     WHERE tasks.id = ?`,
    [taskId],
  );
  if (!task) {
    res.status(404).json({ error: "Task not found." });
    return;
  }
  broadcastEvent({ type: "task_updated", task });
  res.json(task);
});

app.delete("/tasks/:taskId", requireAuth, async (req, res) => {
  const taskId = Number(req.params.taskId);
  const existing = await get<Pick<TaskRow, "id" | "message_id" | "channel_id" | "thread_id">>(
    "SELECT id, message_id, channel_id, thread_id FROM tasks WHERE id = ?",
    [taskId],
  );
  if (!existing) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  await run("DELETE FROM tasks WHERE id = ?", [taskId]);
  broadcastEvent({
    type: "task_deleted",
    taskId: existing.id,
    messageId: existing.message_id,
    channelId: existing.channel_id,
    threadId: existing.thread_id,
  });
  res.json({ ok: true });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
