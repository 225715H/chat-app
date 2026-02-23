"use client";

import Image from "next/image";
import { CSSProperties, FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import botImage from "../../assets/bot_image.png";

type User = { id: number; name: string; email: string };
type MeResponse = User & { sessionId?: string };
type Channel = { id: number; name: string };
type Thread = { id: number; title: string; channel_id?: number };
type Message = { id: number; thread_id: number; user_id: number; content: string; created_at: string; user_name: string; reply_count: number };
type Reply = { id: number; message_id: number; user_id: number; content: string; created_at: string; user_name: string };
type TaskStatus = "open" | "doing" | "done";
type TaskItem = {
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

type ActivityMeta = {
  channelId?: number;
  channelName?: string;
  threadTitle?: string;
};

type StreamEvent = {
  type:
    | "connected"
    | "channel_created"
    | "thread_created"
    | "message_created"
    | "message_updated"
    | "message_deleted"
    | "reply_created"
    | "reply_updated"
    | "reply_deleted"
    | "task_created"
    | "task_updated"
    | "task_deleted";
  channelId?: number;
  threadId?: number;
  channelName?: string;
  threadTitle?: string;
  messageId?: number;
  replyId?: number;
  channel?: Channel;
  thread?: { id: number; channel_id: number; title: string; created_by: number; created_at: string };
  message?: Message;
  reply?: Reply;
  task?: TaskItem;
  taskId?: number;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "/api";
const SESSION_STORAGE_KEY = "ondemand_chat_session_id";
const TASK_BOT_NAME = "TaskBot";
const TASK_BOT_RECEIVE_STORAGE_KEY = "ondemand_chat_receive_taskbot_messages";
const MESSAGE_INPUT_BASE_HEIGHT = 74;

function getSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(SESSION_STORAGE_KEY);
}

function setSessionId(sessionId: string) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
}

function clearSessionId() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const sid = getSessionId();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(sid ? { "x-session-id": sid } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function formatDateTime(text: string) {
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return text;
  }
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  if (sameYear) {
    return `${month}/${day} ${hour}:${minute}`;
  }
  return `${date.getFullYear()}/${month}/${day} ${hour}:${minute}`;
}

function getTaskNotePreview(note: string) {
  const line = note
    .replace(/\r\n/g, "\n")
    .split("\n")
    .find((part) => part.trim().length > 0);
  return line?.trim() || "";
}

function renderInlineCode(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  let idx = 0;
  let match: RegExpExecArray | null;
  while (true) {
    match = re.exec(text);
    if (!match) break;
    if (match.index > last) {
      out.push(<span key={`${keyPrefix}-text-${idx}`}>{text.slice(last, match.index)}</span>);
    }
    out.push(<code key={`${keyPrefix}-code-${idx}`}>{match[1]}</code>);
    last = re.lastIndex;
    idx += 1;
  }
  if (last < text.length) {
    out.push(<span key={`${keyPrefix}-tail`}>{text.slice(last)}</span>);
  }
  return out;
}

function renderTextWithChecklists(
  text: string,
  keyPrefix: string,
  onChecklistToggle?: (ordinal: number, checked: boolean) => void,
  checklistOrdinalRef?: { value: number },
): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  let normalBuffer = "";
  let i = 0;
  let blockIndex = 0;

  const flushNormal = () => {
    if (!normalBuffer) return;
    out.push(...renderInlineCode(normalBuffer, `${keyPrefix}-normal-${blockIndex}`));
    normalBuffer = "";
    blockIndex += 1;
  };

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^- \[( |x|X)\] (.*)$/);
    if (!match) {
      normalBuffer += normalBuffer ? `\n${line}` : line;
      i += 1;
      continue;
    }

    flushNormal();
    const items: Array<{ checked: boolean; label: string; ordinal: number }> = [];
    while (i < lines.length) {
      const itemMatch = lines[i].match(/^- \[( |x|X)\] (.*)$/);
      if (!itemMatch) break;
      const ordinal = checklistOrdinalRef ? checklistOrdinalRef.value : 0;
      if (checklistOrdinalRef) checklistOrdinalRef.value += 1;
      items.push({ checked: itemMatch[1].toLowerCase() === "x", label: itemMatch[2], ordinal });
      i += 1;
    }
    out.push(
      <ul key={`${keyPrefix}-check-${blockIndex}`} className="checkList">
        {items.map((item, itemIndex) => (
          <li key={`${keyPrefix}-check-${blockIndex}-${itemIndex}`}>
            <input
              type="checkbox"
              checked={item.checked}
              disabled={!onChecklistToggle}
              className={!onChecklistToggle ? "readOnlyChecklist" : ""}
              onChange={(e) => onChecklistToggle?.(item.ordinal, e.target.checked)}
            />
            <span>{renderInlineCode(item.label, `${keyPrefix}-check-inline-${blockIndex}-${itemIndex}`)}</span>
          </li>
        ))}
      </ul>,
    );
    blockIndex += 1;
  }

  flushNormal();
  return out;
}

function renderMessageContent(
  content: string,
  keyPrefix: string,
  onChecklistToggle?: (ordinal: number, checked: boolean) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /```([\s\S]*?)```/g;
  let last = 0;
  let idx = 0;
  const checklistOrdinalRef = { value: 0 };
  let match: RegExpExecArray | null;
  while (true) {
    match = re.exec(content);
    if (!match) break;
    const before = content.slice(last, match.index);
    if (before) {
      out.push(...renderTextWithChecklists(before, `${keyPrefix}-inline-${idx}`, onChecklistToggle, checklistOrdinalRef));
    }
    const blockContent = match[1].replace(/^\r?\n/, "");
    out.push(
      <pre key={`${keyPrefix}-pre-${idx}`}>
        <code>{blockContent}</code>
      </pre>,
    );
    last = re.lastIndex;
    idx += 1;
  }
  const tail = content.slice(last);
  if (tail) {
    const normalizedTail = idx > 0 ? tail.replace(/^\r?\n/, "") : tail;
    if (normalizedTail) {
      out.push(...renderTextWithChecklists(normalizedTail, `${keyPrefix}-tail`, onChecklistToggle, checklistOrdinalRef));
    }
  }
  return out.length ? out : [content];
}

function applyChecklistToggleInContent(content: string, ordinal: number, checked: boolean): string {
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

function renderAvatar(userName: string) {
  if (userName === TASK_BOT_NAME) {
    return (
      <div className="avatar avatarImage">
        <Image src={botImage} alt="TaskBot" width={34} height={34} />
      </div>
    );
  }
  return <div className="avatar">{userName.slice(0, 1).toUpperCase()}</div>;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "signup">("signup");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedMessageId, setSelectedMessageId] = useState<number | null>(null);
  const [focusedMessageId, setFocusedMessageId] = useState<number | null>(null);
  const [menuMessageId, setMenuMessageId] = useState<number | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [editingMessageText, setEditingMessageText] = useState("");
  const [menuReplyId, setMenuReplyId] = useState<number | null>(null);
  const [editingReplyId, setEditingReplyId] = useState<number | null>(null);
  const [editingReplyText, setEditingReplyText] = useState("");
  const [replies, setReplies] = useState<Reply[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [draggingTaskId, setDraggingTaskId] = useState<number | null>(null);
  const [selectedDashboardTaskId, setSelectedDashboardTaskId] = useState<number | null>(null);
  const [isTaskDetailPaneOpen, setIsTaskDetailPaneOpen] = useState(false);
  const [taskDetailPaneWidth, setTaskDetailPaneWidth] = useState(340);
  const [selectedChannelId, setSelectedChannelId] = useState<number | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [pendingReplyOpenMessageId, setPendingReplyOpenMessageId] = useState<number | null>(null);
  const [activeMainTab, setActiveMainTab] = useState<"thread" | "dashboard" | "activity">("thread");
  const [dashboardFilterScope, setDashboardFilterScope] = useState<"all" | "channel" | "thread">("all");
  const [dashboardFilterChannelId, setDashboardFilterChannelId] = useState<number | null>(null);
  const [dashboardFilterThreadId, setDashboardFilterThreadId] = useState<number | null>(null);
  const [isReplyPaneOpen, setIsReplyPaneOpen] = useState(false);
  const [rightPaneMode, setRightPaneMode] = useState<"reply" | "task">("reply");
  const [replyPaneWidth, setReplyPaneWidth] = useState(320);
  const [leftPaneWidth, setLeftPaneWidth] = useState(290);
  const [unreadByThread, setUnreadByThread] = useState<Record<number, number>>({});
  const [activityThreadOrder, setActivityThreadOrder] = useState<number[]>([]);
  const [activityMetaByThread, setActivityMetaByThread] = useState<Record<number, ActivityMeta>>({});
  const [activityUpdatedAtByThread, setActivityUpdatedAtByThread] = useState<Record<number, number>>({});
  const [error, setError] = useState("");
  const replyListRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollRepliesRef = useRef(false);
  const messagesPaneRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollMessagesRef = useRef(false);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const replyInputRef = useRef<HTMLTextAreaElement | null>(null);
  const clearFocusTimerRef = useRef<number | null>(null);

  const [name, setName] = useState("Demo User");
  const [email, setEmail] = useState("demo@example.com");
  const [password, setPassword] = useState("pass1234");
  const [newChannelName, setNewChannelName] = useState("");
  const [newThreadTitle, setNewThreadTitle] = useState("");
  const [isChannelFormOpen, setIsChannelFormOpen] = useState(false);
  const [isThreadFormOpen, setIsThreadFormOpen] = useState(false);
  const [newMessage, setNewMessage] = useState("");
  const [createTaskFromMessage, setCreateTaskFromMessage] = useState(false);
  const [newReply, setNewReply] = useState("");
  const [createTaskFromReply, setCreateTaskFromReply] = useState(false);
  const [newDashboardTaskTitle, setNewDashboardTaskTitle] = useState("");
  const [newDashboardTaskNote, setNewDashboardTaskNote] = useState("");
  const [receiveTaskBotMessages, setReceiveTaskBotMessages] = useState(true);
  const [isDashboardTaskCreateOpen, setIsDashboardTaskCreateOpen] = useState(false);
  const [dashboardTaskThreadId, setDashboardTaskThreadId] = useState<number | null>(null);
  const [isEditingTaskDetail, setIsEditingTaskDetail] = useState(false);
  const [editingTaskTitle, setEditingTaskTitle] = useState("");
  const [editingTaskNote, setEditingTaskNote] = useState("");
  const [isEditingQuickTaskDetail, setIsEditingQuickTaskDetail] = useState(false);
  const [editingQuickTaskTitle, setEditingQuickTaskTitle] = useState("");
  const [editingQuickTaskNote, setEditingQuickTaskNote] = useState("");

  const selectedThread = useMemo(() => threads.find((t) => t.id === selectedThreadId), [threads, selectedThreadId]);
  const selectedChannel = useMemo(() => channels.find((c) => c.id === selectedChannelId), [channels, selectedChannelId]);
  const dashboardScopeChannel = useMemo(
    () => channels.find((c) => c.id === dashboardFilterChannelId) ?? null,
    [channels, dashboardFilterChannelId],
  );
  const dashboardScopeThread = useMemo(
    () => threads.find((t) => t.id === dashboardFilterThreadId) ?? null,
    [threads, dashboardFilterThreadId],
  );
  const selectedMessage = useMemo(() => messages.find((m) => m.id === selectedMessageId) ?? null, [messages, selectedMessageId]);
  const selectedDashboardTask = useMemo(
    () => tasks.find((t) => t.id === selectedDashboardTaskId) ?? null,
    [tasks, selectedDashboardTaskId],
  );
  const visibleMessages = useMemo(
    () => (receiveTaskBotMessages ? messages : messages.filter((m) => m.user_name !== TASK_BOT_NAME)),
    [messages, receiveTaskBotMessages],
  );
  const openTasks = useMemo(() => tasks.filter((t) => t.status === "open"), [tasks]);
  const doingTasks = useMemo(() => tasks.filter((t) => t.status === "doing"), [tasks]);
  const doneTasks = useMemo(() => tasks.filter((t) => t.status === "done"), [tasks]);
  const taskByMessageId = useMemo(() => {
    const map = new Map<number, TaskItem>();
    for (const task of tasks) {
      map.set(task.message_id, task);
    }
    return map;
  }, [tasks]);
  const activityEntries = useMemo(
    () =>
      [...activityThreadOrder, ...Object.keys(unreadByThread).map(Number)]
        .filter((threadId, index, arr) => arr.indexOf(threadId) === index)
        .filter((threadId) => (unreadByThread[threadId] || 0) > 0)
        .sort((a, b) => (activityUpdatedAtByThread[b] || 0) - (activityUpdatedAtByThread[a] || 0))
        .map((threadId) => ({
          threadId,
          count: unreadByThread[threadId],
          meta: activityMetaByThread[threadId],
        })),
    [activityThreadOrder, unreadByThread, activityMetaByThread, activityUpdatedAtByThread],
  );
  const dashboardScopeLabel = useMemo(() => {
    if (dashboardFilterScope === "thread") {
      const channelName = dashboardScopeChannel?.name ? `#${dashboardScopeChannel.name}` : "#-";
      const threadTitle = dashboardScopeThread?.title || "-";
      return `${channelName} / ${threadTitle}`;
    }
    if (dashboardFilterScope === "channel") {
      return dashboardScopeChannel?.name ? `#${dashboardScopeChannel.name}` : "#-";
    }
    return "All channels / threads";
  }, [dashboardFilterScope, dashboardScopeChannel?.name, dashboardScopeThread?.title]);

  function markThreadActivity(threadId: number, meta?: ActivityMeta) {
    const now = Date.now();
    setUnreadByThread((prev) => ({ ...prev, [threadId]: (prev[threadId] || 0) + 1 }));
    setActivityThreadOrder((prev) => [threadId, ...prev.filter((id) => id !== threadId)]);
    setActivityUpdatedAtByThread((prev) => ({ ...prev, [threadId]: now }));
    if (meta) {
      setActivityMetaByThread((prev) => ({
        ...prev,
        [threadId]: { ...(prev[threadId] || {}), ...meta },
      }));
    }
  }

  function clearThreadActivity(threadId: number) {
    setUnreadByThread((prev) => {
      if (!prev[threadId]) return prev;
      const next = { ...prev };
      delete next[threadId];
      return next;
    });
    setActivityThreadOrder((prev) => prev.filter((id) => id !== threadId));
    setActivityUpdatedAtByThread((prev) => {
      if (!(threadId in prev)) return prev;
      const next = { ...prev };
      delete next[threadId];
      return next;
    });
  }

  async function loadChannels() {
    const data = await api<Channel[]>("/channels");
    setChannels(data);
    if (!selectedChannelId && data.length > 0) {
      setSelectedChannelId(data[0].id);
    }
  }

  async function loadThreads(channelId: number) {
    const data = await api<Thread[]>(`/channels/${channelId}/threads`);
    setThreads(data);
    if (data.length > 0) {
      const mainThread = data.find((t) => t.title.toLowerCase() === "main");
      setSelectedThreadId((prev) => prev ?? mainThread?.id ?? data[0].id);
    } else {
      setSelectedThreadId(null);
      setMessages([]);
    }
  }

  async function loadThreadData(threadId: number) {
    const msgData = await api<Message[]>(`/threads/${threadId}/messages`);
    setMessages(msgData);
  }

  async function loadTasks(scope: "all" | "channel" | "thread" = dashboardFilterScope, channelId = dashboardFilterChannelId, threadId = dashboardFilterThreadId) {
    const params = new URLSearchParams();
    if (scope === "channel" && channelId) {
      params.set("channelId", String(channelId));
    }
    if (scope === "thread" && threadId) {
      params.set("threadId", String(threadId));
    }
    const query = params.toString();
    const taskData = await api<TaskItem[]>(query ? `/tasks?${query}` : "/tasks");
    setTasks(taskData);
  }

  async function loadReplies(messageId: number) {
    const data = await api<Reply[]>(`/messages/${messageId}/replies`);
    setReplies(data);
  }

  async function bootstrap() {
    if (!getSessionId()) {
      setUser(null);
      return;
    }
    try {
      const me = await api<MeResponse>("/auth/me");
      setUser(me);
      if (me.sessionId) {
        setSessionId(me.sessionId);
      }
      setError("");
      await loadChannels();
      await loadTasks("all", null, null);
    } catch {
      setUser(null);
      clearSessionId();
    }
  }

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    return () => {
      if (clearFocusTimerRef.current) {
        window.clearTimeout(clearFocusTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(TASK_BOT_RECEIVE_STORAGE_KEY);
    if (stored === "0") {
      setReceiveTaskBotMessages(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(TASK_BOT_RECEIVE_STORAGE_KEY, receiveTaskBotMessages ? "1" : "0");
  }, [receiveTaskBotMessages]);

  useEffect(() => {
    if (user && selectedChannelId) {
      void loadThreads(selectedChannelId);
    }
  }, [user, selectedChannelId]);

  useEffect(() => {
    if (user && selectedThreadId) {
      void loadThreadData(selectedThreadId);
      if (pendingReplyOpenMessageId) {
        setSelectedMessageId(pendingReplyOpenMessageId);
        setRightPaneMode("reply");
        setIsReplyPaneOpen(true);
        setPendingReplyOpenMessageId(null);
      } else {
        setSelectedMessageId(null);
        setRightPaneMode("reply");
        setIsReplyPaneOpen(false);
      }
      setMenuMessageId(null);
      setEditingMessageId(null);
      setEditingMessageText("");
      setMenuReplyId(null);
      setEditingReplyId(null);
      setEditingReplyText("");
      setReplies([]);
      setNewReply("");
    }
  }, [user, selectedThreadId, pendingReplyOpenMessageId]);

  useEffect(() => {
    if (!user) return;
    void loadTasks();
  }, [user, dashboardFilterScope, dashboardFilterChannelId, dashboardFilterThreadId]);

  useEffect(() => {
    if (!user) return;
    if (dashboardFilterScope === "channel") {
      setDashboardFilterChannelId(selectedChannelId ?? null);
      setDashboardFilterThreadId(null);
    } else if (dashboardFilterScope === "thread") {
      setDashboardFilterChannelId(selectedChannelId ?? null);
      setDashboardFilterThreadId(selectedThreadId ?? null);
    }
  }, [user, dashboardFilterScope, selectedChannelId, selectedThreadId]);

  useEffect(() => {
    if (!user || !selectedMessageId) {
      setReplies([]);
      setCreateTaskFromReply(false);
      return;
    }
    void loadReplies(selectedMessageId);
    setCreateTaskFromReply(false);
  }, [user, selectedMessageId]);

  useEffect(() => {
    if (!selectedMessageId || receiveTaskBotMessages) return;
    const selected = messages.find((m) => m.id === selectedMessageId);
    if (selected?.user_name === TASK_BOT_NAME) {
      setSelectedMessageId(null);
      setReplies([]);
    }
  }, [selectedMessageId, receiveTaskBotMessages, messages]);

  useEffect(() => {
    if (!shouldScrollRepliesRef.current) return;
    const pane = replyListRef.current;
    if (!pane) return;
    pane.scrollTop = pane.scrollHeight;
    shouldScrollRepliesRef.current = false;
  }, [replies]);

  useEffect(() => {
    const pane = messagesPaneRef.current;
    if (!pane) return;

    if (shouldScrollMessagesRef.current) {
      pane.scrollTop = pane.scrollHeight;
      shouldScrollMessagesRef.current = false;
    }

    if (focusedMessageId) {
      const target = pane.querySelector<HTMLElement>(`[data-message-id="${focusedMessageId}"]`);
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        if (clearFocusTimerRef.current) {
          window.clearTimeout(clearFocusTimerRef.current);
        }
        clearFocusTimerRef.current = window.setTimeout(() => setFocusedMessageId(null), 1800);
      }
    }
  }, [messages, focusedMessageId]);

  useEffect(() => {
    if (!user) return;
    const sid = getSessionId();
    if (!sid) return;
    const stream = new EventSource(`${API_BASE}/events?sid=${encodeURIComponent(sid)}`);

    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as StreamEvent;
        if (payload.type === "channel_created" && payload.channel) {
          setChannels((prev) => (prev.some((c) => c.id === payload.channel!.id) ? prev : [...prev, payload.channel!]));
        }
        if (payload.type === "thread_created" && payload.thread && selectedChannelId && payload.channelId === selectedChannelId) {
          setThreads((prev) => (prev.some((t) => t.id === payload.thread!.id) ? prev : [payload.thread!, ...prev]));
        }
        if (payload.type === "message_created") {
          if (selectedThreadId && payload.threadId === selectedThreadId && payload.message) {
            if (!receiveTaskBotMessages && payload.message.user_name === TASK_BOT_NAME) {
              return;
            }
            setMessages((prev) => (prev.some((m) => m.id === payload.message!.id) ? prev : [...prev, payload.message!]));
          } else if (payload.threadId && payload.message) {
            if (!receiveTaskBotMessages && payload.message.user_name === TASK_BOT_NAME) {
              return;
            }
            markThreadActivity(payload.threadId, {
              channelId: payload.channelId,
              channelName: payload.channelName,
              threadTitle: payload.threadTitle,
            });
          }
        }
        if (payload.type === "message_updated" && payload.message) {
          if (selectedThreadId && payload.threadId === selectedThreadId) {
            setMessages((prev) => prev.map((m) => (m.id === payload.message!.id ? payload.message! : m)));
          }
        }
        if (payload.type === "message_deleted" && typeof payload.messageId === "number") {
          if (selectedThreadId && payload.threadId === selectedThreadId) {
            setMessages((prev) => prev.filter((m) => m.id !== payload.messageId));
            if (selectedMessageId === payload.messageId) {
              setSelectedMessageId(null);
              setReplies([]);
              setNewReply("");
            }
          } else if (typeof payload.threadId === "number") {
            markThreadActivity(payload.threadId, {
              channelId: payload.channelId,
              channelName: payload.channelName,
              threadTitle: payload.threadTitle,
            });
          }
        }
        if (payload.type === "reply_created" && payload.reply && payload.messageId) {
          if (selectedThreadId && payload.threadId === selectedThreadId) {
            setMessages((prev) =>
              prev.map((m) => (m.id === payload.messageId ? { ...m, reply_count: m.reply_count + 1 } : m)),
            );
            if (selectedMessageId === payload.messageId) {
              setReplies((prev) => (prev.some((r) => r.id === payload.reply!.id) ? prev : [...prev, payload.reply!]));
            }
          } else if (typeof payload.threadId === "number") {
            markThreadActivity(payload.threadId, {
              channelId: payload.channelId,
              channelName: payload.channelName,
              threadTitle: payload.threadTitle,
            });
          }
        }
        if (payload.type === "reply_updated" && payload.reply && payload.messageId) {
          if (selectedThreadId && payload.threadId === selectedThreadId) {
            if (selectedMessageId === payload.messageId) {
              setReplies((prev) => prev.map((r) => (r.id === payload.reply!.id ? payload.reply! : r)));
            }
          }
        }
        if (payload.type === "reply_deleted" && typeof payload.replyId === "number" && payload.messageId) {
          if (selectedThreadId && payload.threadId === selectedThreadId) {
            setMessages((prev) =>
              prev.map((m) => (m.id === payload.messageId ? { ...m, reply_count: Math.max(0, m.reply_count - 1) } : m)),
            );
            if (selectedMessageId === payload.messageId) {
              setReplies((prev) => prev.filter((r) => r.id !== payload.replyId));
              if (editingReplyId === payload.replyId) {
                setEditingReplyId(null);
                setEditingReplyText("");
                setMenuReplyId(null);
              }
            }
          } else if (typeof payload.threadId === "number") {
            markThreadActivity(payload.threadId, {
              channelId: payload.channelId,
              channelName: payload.channelName,
              threadTitle: payload.threadTitle,
            });
          }
        }
        if (payload.type === "task_created" && payload.task) {
          void loadTasks();
        }
        if (payload.type === "task_updated" && payload.task) {
          void loadTasks();
        }
        if (payload.type === "task_deleted") {
          if (typeof payload.taskId === "number") {
            setTasks((prev) => prev.filter((task) => task.id !== payload.taskId));
          }
          void loadTasks();
        }
      } catch {
        // Ignore malformed events.
      }
    };

    return () => stream.close();
  }, [user, selectedChannelId, selectedThreadId, selectedMessageId, editingReplyId, dashboardFilterScope, dashboardFilterChannelId, dashboardFilterThreadId, receiveTaskBotMessages]);

  useEffect(() => {
    if (!user || !selectedThreadId) return;
    clearThreadActivity(selectedThreadId);
    const lastReadMessageId = messages.length ? messages[messages.length - 1].id : 0;
    void api(`/threads/${selectedThreadId}/read`, {
      method: "POST",
      body: JSON.stringify({ lastReadMessageId }),
    }).catch(() => { });
  }, [user, selectedThreadId, messages]);

  useEffect(() => {
    if (!tasks.length) {
      setSelectedDashboardTaskId(null);
      return;
    }
    if (!selectedDashboardTaskId || !tasks.some((t) => t.id === selectedDashboardTaskId)) {
      setSelectedDashboardTaskId(tasks[0].id);
    }
  }, [tasks, selectedDashboardTaskId]);

  useEffect(() => {
    if (!selectedDashboardTask) {
      setIsEditingTaskDetail(false);
      setEditingTaskTitle("");
      setEditingTaskNote("");
      setIsEditingQuickTaskDetail(false);
      setEditingQuickTaskTitle("");
      setEditingQuickTaskNote("");
      return;
    }
    setIsEditingTaskDetail(false);
    setEditingTaskTitle(selectedDashboardTask.title);
    setEditingTaskNote(selectedDashboardTask.note || "");
    setIsEditingQuickTaskDetail(false);
    setEditingQuickTaskTitle(selectedDashboardTask.title);
    setEditingQuickTaskNote(selectedDashboardTask.note || "");
  }, [selectedDashboardTask?.id]);

  async function handleAuth(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      let authResponse: User & { sessionId: string };
      if (authMode === "signup") {
        authResponse = await api<User & { sessionId: string }>("/auth/signup", {
          method: "POST",
          body: JSON.stringify({ name, email, password }),
        });
      } else {
        authResponse = await api<User & { sessionId: string }>("/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
      }
      setSessionId(authResponse.sessionId);
      await bootstrap();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auth failed");
    }
  }

  async function handleCreateChannel(e: FormEvent) {
    e.preventDefault();
    if (!newChannelName.trim()) return;
    const created = await api<Channel>("/channels", { method: "POST", body: JSON.stringify({ name: newChannelName.trim() }) });
    setNewChannelName("");
    setChannels((prev) => (prev.some((c) => c.id === created.id) ? prev : [...prev, created]));
    setSelectedChannelId(created.id);
    setSelectedThreadId(null);
    setThreads([]);
    setMessages([]);
    setActiveMainTab("thread");
    setIsChannelFormOpen(false);
  }

  async function handleCreateThread(e: FormEvent) {
    e.preventDefault();
    if (!selectedChannelId || !newThreadTitle.trim()) return;
    const created = await api<Thread>(`/channels/${selectedChannelId}/threads`, {
      method: "POST",
      body: JSON.stringify({ title: newThreadTitle.trim() }),
    });
    setNewThreadTitle("");
    setThreads((prev) => (prev.some((t) => t.id === created.id) ? prev : [created, ...prev]));
    setSelectedThreadId(created.id);
    clearThreadActivity(created.id);
    setActiveMainTab("thread");
    setIsThreadFormOpen(false);
  }

  async function handlePostMessage(e: FormEvent) {
    e.preventDefault();
    await postMessage();
  }

  async function postMessage() {
    if (!selectedThreadId || !newMessage.trim()) return;
    shouldScrollMessagesRef.current = true;
    await api(`/threads/${selectedThreadId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: newMessage.trim(),
        createTask: createTaskFromMessage,
      }),
    });
    setNewMessage("");
    setCreateTaskFromMessage(false);
    if (messageInputRef.current) {
      messageInputRef.current.style.height = `${MESSAGE_INPUT_BASE_HEIGHT}px`;
      messageInputRef.current.style.overflowY = "hidden";
    }
  }

  function resizeMessageInput(target: HTMLTextAreaElement) {
    const maxHeight = 160;
    target.style.height = "auto";
    const nextHeight = Math.min(target.scrollHeight, maxHeight);
    target.style.height = `${nextHeight}px`;
    target.style.overflowY = target.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function handleMessageInputChange(value: string, target: HTMLTextAreaElement) {
    setNewMessage(value);
    resizeMessageInput(target);
  }

  function handleMessageKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void postMessage();
    }
  }

  async function handlePostReply(e: FormEvent) {
    e.preventDefault();
    await postReply();
  }

  async function postReply() {
    if (!selectedMessageId || !newReply.trim()) return;
    shouldScrollRepliesRef.current = true;
    await api<Reply>(`/messages/${selectedMessageId}/replies`, {
      method: "POST",
      body: JSON.stringify({
        content: newReply.trim(),
        createTask: createTaskFromReply,
      }),
    });
    setNewReply("");
    setCreateTaskFromReply(false);
    if (replyInputRef.current) {
      replyInputRef.current.style.height = "40px";
      replyInputRef.current.style.overflowY = "hidden";
    }
  }

  async function handleMessageChecklistToggle(messageId: number, ordinal: number, checked: boolean) {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, content: applyChecklistToggleInContent(m.content, ordinal, checked) } : m)),
    );
    await api(`/messages/${messageId}/checklist`, {
      method: "POST",
      body: JSON.stringify({ ordinal, checked }),
    });
  }

  async function handleReplyChecklistToggle(replyId: number, ordinal: number, checked: boolean) {
    setReplies((prev) =>
      prev.map((r) => (r.id === replyId ? { ...r, content: applyChecklistToggleInContent(r.content, ordinal, checked) } : r)),
    );
    await api(`/replies/${replyId}/checklist`, {
      method: "POST",
      body: JSON.stringify({ ordinal, checked }),
    });
  }

  async function handleTaskChecklistToggle(taskId: number, ordinal: number, checked: boolean) {
    setTasks((prev) =>
      prev.map((task) =>
        task.id === taskId ? { ...task, note: applyChecklistToggleInContent(task.note || "", ordinal, checked) } : task,
      ),
    );
    await api(`/tasks/${taskId}/checklist`, {
      method: "POST",
      body: JSON.stringify({ ordinal, checked }),
    });
  }

  function resizeReplyInput(target: HTMLTextAreaElement) {
    const maxHeight = 110;
    target.style.height = "auto";
    const nextHeight = Math.min(target.scrollHeight, maxHeight);
    target.style.height = `${nextHeight}px`;
    target.style.overflowY = target.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function handleReplyInputChange(value: string, target: HTMLTextAreaElement) {
    setNewReply(value);
    resizeReplyInput(target);
  }

  function handleReplyKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void postReply();
    }
  }

  function startReplyPaneResize(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = replyPaneWidth;
    const onMove = (event: MouseEvent) => {
      const delta = startX - event.clientX;
      const next = Math.max(260, Math.min(520, startWidth + delta));
      setReplyPaneWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startTaskPaneResize(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = taskDetailPaneWidth;
    const onMove = (event: MouseEvent) => {
      const delta = startX - event.clientX;
      const next = Math.max(280, Math.min(560, startWidth + delta));
      setTaskDetailPaneWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startLeftPaneResize(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftPaneWidth;
    const onMove = (event: MouseEvent) => {
      const delta = event.clientX - startX;
      const next = Math.max(220, Math.min(520, startWidth + delta));
      setLeftPaneWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startMessageEdit(message: Message) {
    setEditingMessageId(message.id);
    setEditingMessageText(message.content);
    setMenuMessageId(null);
  }

  async function saveMessageEdit() {
    if (!editingMessageId || !editingMessageText.trim()) return;
    await api<Message>(`/messages/${editingMessageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: editingMessageText.trim() }),
    });
    setEditingMessageId(null);
    setEditingMessageText("");
  }

  async function handleSaveMessageEdit(e: FormEvent) {
    e.preventDefault();
    await saveMessageEdit();
  }

  function handleEditKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void saveMessageEdit();
    }
  }

  function cancelMessageEdit() {
    setEditingMessageId(null);
    setEditingMessageText("");
  }

  async function handleDeleteMessage(message: Message) {
    const ok = window.confirm("Delete this message? This will also delete related replies and task link.");
    if (!ok) return;
    await api<{ ok: boolean }>(`/messages/${message.id}`, { method: "DELETE" });
    setMenuMessageId(null);
    if (selectedMessageId === message.id) {
      setSelectedMessageId(null);
      setReplies([]);
      setNewReply("");
      setIsReplyPaneOpen(false);
    }
  }

  function startReplyEdit(reply: Reply) {
    setEditingReplyId(reply.id);
    setEditingReplyText(reply.content);
    setMenuReplyId(null);
  }

  async function saveReplyEdit() {
    if (!editingReplyId || !editingReplyText.trim()) return;
    await api<Reply>(`/replies/${editingReplyId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: editingReplyText.trim() }),
    });
    setEditingReplyId(null);
    setEditingReplyText("");
  }

  async function handleSaveReplyEdit(e: FormEvent) {
    e.preventDefault();
    await saveReplyEdit();
  }

  function handleReplyEditKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void saveReplyEdit();
    }
  }

  function cancelReplyEdit() {
    setEditingReplyId(null);
    setEditingReplyText("");
  }

  async function handleDeleteReply(reply: Reply) {
    const ok = window.confirm("Delete this reply?");
    if (!ok) return;
    await api<{ ok: boolean }>(`/replies/${reply.id}`, { method: "DELETE" });
    setMenuReplyId(null);
    if (editingReplyId === reply.id) {
      setEditingReplyId(null);
      setEditingReplyText("");
    }
  }

  async function handleLogout() {
    await api("/auth/logout", { method: "POST" });
    clearSessionId();
    setUser(null);
    setChannels([]);
    setThreads([]);
    setMessages([]);
    setTasks([]);
    setUnreadByThread({});
    setActivityThreadOrder([]);
    setActivityMetaByThread({});
    setActivityUpdatedAtByThread({});
  }

  async function handleTaskStatus(taskId: number, status: TaskStatus) {
    await api<TaskItem>(`/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }

  async function handleDeleteTask(task: TaskItem) {
    const ok = window.confirm("Delete this task?");
    if (!ok) return;
    await api<{ ok: boolean }>(`/tasks/${task.id}`, { method: "DELETE" });
    setTasks((prev) => prev.filter((item) => item.id !== task.id));
  }

  function openDashboardTaskCreate() {
    setDashboardTaskThreadId(selectedThreadId ?? threads[0]?.id ?? null);
    setIsDashboardTaskCreateOpen(true);
  }

  function closeDashboardTaskCreate() {
    setIsDashboardTaskCreateOpen(false);
    setNewDashboardTaskTitle("");
    setNewDashboardTaskNote("");
  }

  async function handleCreateDashboardTask(e: FormEvent) {
    e.preventDefault();
    if (!dashboardTaskThreadId || !newDashboardTaskTitle.trim()) return;
    await api<TaskItem>("/tasks", {
      method: "POST",
      body: JSON.stringify({
        threadId: dashboardTaskThreadId,
        title: newDashboardTaskTitle.trim(),
        note: newDashboardTaskNote,
      }),
    });
    closeDashboardTaskCreate();
  }

  function openDashboardTab() {
    const threadId = selectedThreadId ?? null;
    const channelId = selectedChannelId ?? null;
    if (threadId) {
      setDashboardFilterScope("thread");
      setDashboardFilterThreadId(threadId);
      setDashboardFilterChannelId(channelId);
    } else if (channelId) {
      setDashboardFilterScope("channel");
      setDashboardFilterChannelId(channelId);
      setDashboardFilterThreadId(null);
    } else {
      setDashboardFilterScope("all");
      setDashboardFilterChannelId(null);
      setDashboardFilterThreadId(null);
    }
    setActiveMainTab("dashboard");
  }

  async function saveTaskDetailEdits() {
    if (!selectedDashboardTask || !editingTaskTitle.trim()) return;
    await api<TaskItem>(`/tasks/${selectedDashboardTask.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: editingTaskTitle.trim(), note: editingTaskNote }),
    });
    setIsEditingTaskDetail(false);
  }

  async function saveQuickTaskDetailEdits() {
    if (!selectedDashboardTask || !editingQuickTaskTitle.trim()) return;
    await api<TaskItem>(`/tasks/${selectedDashboardTask.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: editingQuickTaskTitle.trim(), note: editingQuickTaskNote }),
    });
    setIsEditingQuickTaskDetail(false);
  }

  function hasUnsavedQuickTaskDetailChanges(task: TaskItem) {
    return editingQuickTaskTitle !== task.title || editingQuickTaskNote !== (task.note || "");
  }

  function closeQuickTaskDetailPane() {
    if (selectedDashboardTask && isEditingQuickTaskDetail) {
      if (hasUnsavedQuickTaskDetailChanges(selectedDashboardTask)) {
        const ok = window.confirm("Unsaved changes will be discarded. Cancel editing?");
        if (!ok) return;
      }
      setEditingQuickTaskTitle(selectedDashboardTask.title);
      setEditingQuickTaskNote(selectedDashboardTask.note || "");
      setIsEditingQuickTaskDetail(false);
      return;
    }
    setIsReplyPaneOpen(false);
  }

  function hasUnsavedTaskDetailChanges(task: TaskItem) {
    return editingTaskTitle !== task.title || editingTaskNote !== (task.note || "");
  }

  function closeTaskDetailPane() {
    if (selectedDashboardTask && isEditingTaskDetail) {
      if (hasUnsavedTaskDetailChanges(selectedDashboardTask)) {
        const ok = window.confirm("Unsaved changes will be discarded. Cancel editing?");
        if (!ok) return;
      }
      setEditingTaskTitle(selectedDashboardTask.title);
      setEditingTaskNote(selectedDashboardTask.note || "");
      setIsEditingTaskDetail(false);
      return;
    }
    setIsTaskDetailPaneOpen(false);
  }

  function openDashboardTask(task: TaskItem) {
    if (
      selectedDashboardTask &&
      selectedDashboardTask.id !== task.id &&
      isEditingTaskDetail &&
      hasUnsavedTaskDetailChanges(selectedDashboardTask)
    ) {
      const ok = window.confirm("Unsaved changes will be discarded. Open another task?");
      if (!ok) return;
    }
    setSelectedDashboardTaskId(task.id);
    setIsTaskDetailPaneOpen(true);
    setIsEditingTaskDetail(false);
  }

  function openTaskMessage(task: TaskItem) {
    setSelectedChannelId(task.channel_id);
    setSelectedThreadId(task.thread_id);
    setSelectedMessageId(task.message_id);
    setFocusedMessageId(task.message_id);
    setPendingReplyOpenMessageId(task.message_id);
    setRightPaneMode("reply");
    setActiveMainTab("thread");
    setIsReplyPaneOpen(true);
  }

  function openTaskDetailFromMessage(messageId: number) {
    const task = taskByMessageId.get(messageId);
    if (!task) return;
    setSelectedMessageId(messageId);
    setFocusedMessageId(messageId);
    setSelectedDashboardTaskId(task.id);
    setRightPaneMode("task");
    setIsReplyPaneOpen(true);
  }

  function onTaskDragStart(taskId: number) {
    setDraggingTaskId(taskId);
  }

  function onTaskDragEnd() {
    setDraggingTaskId(null);
  }

  async function onTaskDrop(target: TaskStatus) {
    if (!draggingTaskId) return;
    const current = tasks.find((t) => t.id === draggingTaskId);
    if (!current || current.status === target) {
      setDraggingTaskId(null);
      return;
    }
    await handleTaskStatus(draggingTaskId, target);
    setDraggingTaskId(null);
  }

  if (!user) {
    return (
      <main className="authShell">
        <section className="authCard">
          <h1>OnDemand Chat</h1>
          <p className="sub">Slack-style MVP UI</p>
          <form onSubmit={handleAuth} className="stack">
            <div className="row">
              <button type="button" onClick={() => setAuthMode("signup")} className={authMode === "signup" ? "active" : ""}>
                Sign up
              </button>
              <button type="button" onClick={() => setAuthMode("login")} className={authMode === "login" ? "active" : ""}>
                Login
              </button>
            </div>
            {authMode === "signup" && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" />}
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
            <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" type="password" />
            <button type="submit">{authMode === "signup" ? "Create account" : "Login"}</button>
            {error && <p className="error">{error}</p>}
          </form>
        </section>
      </main>
    );
  }

  return (
    <main
      className="slackShell"
      style={{ ["--left-pane-width" as string]: `${leftPaneWidth}px` } as CSSProperties}
      onClick={() => {
        setMenuMessageId(null);
        setMenuReplyId(null);
      }}
    >
      <aside className="leftRail">
        <div className="workspaceBox">
          <h1>OnDemand Chat</h1>
          <p>{user.name}</p>
          <label className="taskBotReceiveControl">
            <input
              type="checkbox"
              checked={receiveTaskBotMessages}
              onChange={(e) => setReceiveTaskBotMessages(e.target.checked)}
            />
            Receive TaskBot messages
          </label>
          <button className="ghostButton" onClick={handleLogout}>
            Logout
          </button>
        </div>

        <section className="railSection">
          <div className="railSectionHeader">
            <h2>Channels</h2>
            <button
              type="button"
              className="railToggleButton"
              onClick={() => setIsChannelFormOpen((prev) => !prev)}
              aria-label={isChannelFormOpen ? "Close channel form" : "Open channel form"}
              title={isChannelFormOpen ? "Close" : "Add channel"}
            >
              +
            </button>
          </div>
          {isChannelFormOpen ? (
            <form onSubmit={handleCreateChannel} className="stack compactStack">
              <input value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} placeholder="add channel" />
              <button type="submit">Create</button>
            </form>
          ) : null}
          <ul className="listSlim">
            {channels.map((c) => (
              <li key={c.id}>
                <button
                  className={c.id === selectedChannelId ? "active" : ""}
                  onClick={() => {
                    setSelectedChannelId(c.id);
                    setSelectedThreadId(null);
                    setActiveMainTab("thread");
                  }}
                >
                  # {c.name}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="railSection">
          <div className="railSectionHeader">
            <h2>Threads</h2>
            <button
              type="button"
              className="railToggleButton"
              onClick={() => setIsThreadFormOpen((prev) => !prev)}
              aria-label={isThreadFormOpen ? "Close thread form" : "Open thread form"}
              title={isThreadFormOpen ? "Close" : "Add thread"}
            >
              +
            </button>
          </div>
          {isThreadFormOpen ? (
            <form onSubmit={handleCreateThread} className="stack compactStack">
              <input value={newThreadTitle} onChange={(e) => setNewThreadTitle(e.target.value)} placeholder="new thread" />
              <button type="submit" disabled={!selectedChannelId}>
                Add
              </button>
            </form>
          ) : null}
          <ul className="listSlim">
            {threads.map((t) => (
              <li key={t.id}>
                <button
                  className={t.id === selectedThreadId ? "active" : ""}
                  onClick={() => {
                    setSelectedThreadId(t.id);
                    setActiveMainTab("thread");
                  }}
                >
                  <span className="threadLabel">{t.title}</span>
                  {unreadByThread[t.id] ? <span className="unreadBadge">{unreadByThread[t.id]}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </aside>
      <div className="leftPaneResizer" onMouseDown={startLeftPaneResize} />

      <section className="mainPane">
        <header className="chatHeader">
          <div>
            <p className="meta">#{selectedChannel?.name || "channel"}</p>
            <h2>
              {activeMainTab === "thread"
                ? selectedThread?.title || "Select thread"
                : activeMainTab === "dashboard"
                  ? "Task Dashboard"
                  : "Activity"}
            </h2>
          </div>
          <div className="headerTabs">
            <button className={`tabButton ${activeMainTab === "thread" ? "activeTab" : ""}`} onClick={() => setActiveMainTab("thread")}>
              Thread
            </button>
            <button className={`tabButton ${activeMainTab === "dashboard" ? "activeTab" : ""}`} onClick={openDashboardTab}>
              Dashboard
              {tasks.length > 0 ? <span className="tabBadge">{tasks.length}</span> : null}
            </button>
            <button className={`tabButton ${activeMainTab === "activity" ? "activeTab" : ""}`} onClick={() => setActiveMainTab("activity")}>
              Activity
              {activityEntries.length > 0 ? <span className="tabBadge">{activityEntries.length}</span> : null}
            </button>
          </div>
        </header>

        {activeMainTab === "thread" ? (
          <>
            <div
              className={`threadWorkspace ${isReplyPaneOpen ? "" : "replyClosed"}`}
              style={{ ["--reply-pane-width" as string]: `${replyPaneWidth}px` } as CSSProperties}
            >
              <div className="messagesPane" ref={messagesPaneRef}>
                {visibleMessages.map((m) => {
                  const linkedTask = taskByMessageId.get(m.id);
                  return (
                  <article
                    key={m.id}
                    data-message-id={m.id}
                    className={`messageRow ${selectedMessageId === m.id ? "selectedMessage" : ""} ${focusedMessageId === m.id ? "messageFocus" : ""} ${rightPaneMode === "task" && selectedMessageId === m.id ? "taskSourceMessage" : ""} ${m.user_id === user.id ? "messageOwnRow" : ""} ${menuMessageId === m.id ? "menuOpen" : ""}`}
                  >
                    {renderAvatar(m.user_name)}
                    <div className="messageContent">
                      <p className="messageHead">
                        <strong className="usernameText" title={m.user_name}>
                          {m.user_name}
                        </strong>
                        <span>{formatDateTime(m.created_at)}</span>
                        {linkedTask ? (
                          <button
                            type="button"
                            className={`taskMessageBadge ${linkedTask.status}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              openTaskDetailFromMessage(m.id);
                            }}
                            title="Open task detail"
                            aria-label="Open task detail"
                          >
                            {linkedTask.status === "open" ? "Task • Open" : linkedTask.status === "doing" ? "Task • Doing" : "Task • Done"}
                          </button>
                        ) : null}
                        {m.user_id === user.id ? (
                          <span className="messageHeadActions">
                                  <button
                                    type="button"
                                    className="messageMenuButton"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                setMenuMessageId((prev) => (prev === m.id ? null : m.id));
                              }}
                              aria-label="Message menu"
                            >
                              ...
                            </button>
                            {menuMessageId === m.id ? (
                              <span className="messageMenu">
                                <button
                                  className="messageMenuIconButton"
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    startMessageEdit(m);
                                  }}
                                  title="Edit"
                                  aria-label="Edit"
                                >
                                  ✎
                                </button>
                                <button
                                  className="messageMenuIconButton"
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleDeleteMessage(m);
                                  }}
                                  title="Delete"
                                  aria-label="Delete"
                                >
                                  🗑
                                </button>
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </p>
                      {editingMessageId === m.id ? (
                        <form
                          className="inlineEditor"
                          onSubmit={handleSaveMessageEdit}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <textarea
                            value={editingMessageText}
                            onChange={(e) => setEditingMessageText(e.target.value)}
                            onKeyDown={handleEditKeyDown}
                            rows={3}
                            autoFocus
                          />
                          <div className="inlineEditorActions">
                            <button type="submit">Save</button>
                            <button type="button" onClick={cancelMessageEdit}>
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="messageBody">
                          {renderMessageContent(m.content, `msg-${m.id}`)}
                        </div>
                      )}
                      <div className={`messageQuickActions ${m.reply_count > 0 ? "hasReplies" : ""}`}>
                        <button
                          type="button"
                          className={`replyQuickButton ${m.reply_count > 0 ? "hasReplies" : ""}`}
                          onClick={() => {
                            setMenuMessageId(null);
                            setSelectedMessageId(m.id);
                            setRightPaneMode("reply");
                            setIsReplyPaneOpen(true);
                          }}
                          title="Reply"
                          aria-label="Reply"
                        >
                          ↩
                          {m.reply_count > 0 ? <span className="replyQuickCount">{m.reply_count}</span> : null}
                        </button>
                      </div>
                    </div>
                  </article>
                  );
                })}
              </div>

              <div className="replyPaneResizer" onMouseDown={startReplyPaneResize} />
              <aside className="replyPane">
                {rightPaneMode === "task" && selectedDashboardTask ? (
                  <div className="taskQuickPane">
                    <div className="taskDetailHeader">
                      <p className="meta">Task Detail</p>
                      {!isEditingQuickTaskDetail ? (
                        <>
                          <button
                            type="button"
                            className="taskDetailEditButton"
                            onClick={() => setIsEditingQuickTaskDetail(true)}
                            title="Edit task"
                            aria-label="Edit task"
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            className="taskDetailDeleteButton"
                            onClick={() => void handleDeleteTask(selectedDashboardTask)}
                            title="Delete task"
                            aria-label="Delete task"
                          >
                            🗑
                          </button>
                        </>
                      ) : null}
                      <button type="button" className="taskDetailCloseButton" onClick={closeQuickTaskDetailPane} aria-label="Close task detail">
                        ×
                      </button>
                    </div>
                    <h3>
                      {isEditingQuickTaskDetail ? (
                        <input
                          className="taskInlineTitleInput"
                          value={editingQuickTaskTitle}
                          onChange={(e) => setEditingQuickTaskTitle(e.target.value)}
                          placeholder="Task title"
                        />
                      ) : (
                        selectedDashboardTask.title
                      )}
                    </h3>
                    <div className="taskDetailStatus">
                      <span className={`statusBadge ${selectedDashboardTask.status}`}>
                        {selectedDashboardTask.status === "open" ? "○ Open" : selectedDashboardTask.status === "doing" ? "◐ Doing" : "✓ Done"}
                      </span>
                      <label className="taskStatusSelectLabel">
                        <span className="meta">Status</span>
                        <select
                          value={selectedDashboardTask.status}
                          onChange={(e) => void handleTaskStatus(selectedDashboardTask.id, e.target.value as TaskStatus)}
                        >
                          <option value="open">Open</option>
                          <option value="doing">Doing</option>
                          <option value="done">Done</option>
                        </select>
                      </label>
                    </div>
                    <div className="taskMetaGrid">
                      <div className="taskMetaItem">
                        <p className="meta">Thread</p>
                        <p className="taskMetaValue">#{selectedDashboardTask.channel_name} / {selectedDashboardTask.thread_title}</p>
                      </div>
                      <div className="taskMetaItem">
                        <p className="meta">Created by</p>
                        <p className="taskMetaValue">
                          <span className="taskCreatorPill">{selectedDashboardTask.created_by_name}</span>
                        </p>
                      </div>
                    </div>
                    <p className="meta">Source message is highlighted in the thread.</p>
                    <div className={`taskNoteBlock ${isEditingQuickTaskDetail ? "editingNoteBlock" : ""}`}>
                      <p className="meta">Note</p>
                      {isEditingQuickTaskDetail ? (
                        <textarea
                          className="taskInlineNoteInput"
                          value={editingQuickTaskNote}
                          onChange={(e) => setEditingQuickTaskNote(e.target.value)}
                          placeholder="Task note"
                          rows={6}
                        />
                      ) : selectedDashboardTask.note ? (
                        <div className="messageBody">
                          {renderMessageContent(selectedDashboardTask.note, `thread-task-note-${selectedDashboardTask.id}`, (ordinal, checked) => {
                            void handleTaskChecklistToggle(selectedDashboardTask.id, ordinal, checked);
                          })}
                        </div>
                      ) : (
                        <p className="meta">No note.</p>
                      )}
                    </div>
                    <div className="taskActions">
                      {isEditingQuickTaskDetail ? (
                        <>
                          <button type="button" onClick={() => void saveQuickTaskDetailEdits()}>
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setIsEditingQuickTaskDetail(false);
                              setEditingQuickTaskTitle(selectedDashboardTask.title);
                              setEditingQuickTaskNote(selectedDashboardTask.note || "");
                            }}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="iconAction jump openMessageAction" title="Open message" aria-label="Open message" onClick={() => openTaskMessage(selectedDashboardTask)}>
                            ↗ Open message
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ) : selectedMessage ? (
                  <>
                    <div className="replyParent">
                      <div className="replyHeader">
                        <p className="meta">Reply thread</p>
                        <button type="button" className="replyCloseButton" onClick={() => setIsReplyPaneOpen(false)} aria-label="Close replies">
                          ×
                        </button>
                      </div>
                      <p className="messageHead">
                        <strong className="usernameText" title={selectedMessage.user_name}>
                          {selectedMessage.user_name}
                        </strong>
                        <span>{formatDateTime(selectedMessage.created_at)}</span>
                      </p>
                      <div className="messageBody">
                        {renderMessageContent(selectedMessage.content, `selected-${selectedMessage.id}`)}
                      </div>
                    </div>
                    <div className="replyList" ref={replyListRef}>
                      {replies.map((r) => (
                        <article key={r.id} className="messageRow replyMessageRow">
                          {renderAvatar(r.user_name)}
                          <div className={`messageContent ${r.user_id === user.id ? "messageOwnRow" : ""} ${menuReplyId === r.id ? "menuOpen" : ""}`}>
                            <p className="messageHead">
                              <strong className="usernameText" title={r.user_name}>
                                {r.user_name}
                              </strong>
                              <span>{formatDateTime(r.created_at)}</span>
                              {r.user_id === user.id ? (
                                <span className="messageHeadActions">
                                  <button
                                    type="button"
                                    className="messageMenuButton"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setMenuReplyId((prev) => (prev === r.id ? null : r.id));
                                    }}
                                    aria-label="Reply menu"
                                  >
                                    ...
                                  </button>
                                  {menuReplyId === r.id ? (
                                    <span className="messageMenu">
                                      <button
                                        className="messageMenuIconButton"
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          startReplyEdit(r);
                                        }}
                                        title="Edit"
                                        aria-label="Edit"
                                      >
                                        ✎
                                      </button>
                                      <button
                                        className="messageMenuIconButton"
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void handleDeleteReply(r);
                                        }}
                                        title="Delete"
                                        aria-label="Delete"
                                      >
                                        🗑
                                      </button>
                                    </span>
                                  ) : null}
                                </span>
                              ) : null}
                            </p>
                            {editingReplyId === r.id ? (
                              <form className="inlineEditor" onSubmit={handleSaveReplyEdit}>
                                <textarea
                                  value={editingReplyText}
                                  onChange={(e) => setEditingReplyText(e.target.value)}
                                  onKeyDown={handleReplyEditKeyDown}
                                  rows={3}
                                  autoFocus
                                />
                                <div className="inlineEditorActions">
                                  <button type="submit">Save</button>
                                  <button type="button" onClick={cancelReplyEdit}>
                                    Cancel
                                  </button>
                                </div>
                              </form>
                            ) : (
                              <div className="messageBody">
                                {renderMessageContent(r.content, `reply-${r.id}`)}
                              </div>
                            )}
                          </div>
                        </article>
                      ))}
                      {replies.length === 0 ? <p className="meta">No replies yet.</p> : null}
                    </div>
                    <form onSubmit={handlePostReply} className="replyComposer">
                      <div className="replyInputWrap">
                        <textarea
                          ref={replyInputRef}
                          value={newReply}
                          onChange={(e) => handleReplyInputChange(e.target.value, e.target)}
                          onKeyDown={handleReplyKeyDown}
                          placeholder="Reply to message..."
                          rows={1}
                        />
                        <button
                          type="button"
                          className={`composerTaskPill replyTaskPill ${createTaskFromReply ? "active" : ""}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => setCreateTaskFromReply((prev) => !prev)}
                          aria-pressed={createTaskFromReply}
                        >
                          Task
                        </button>
                      </div>
                      <p className="composerHint replyComposerHint">Cmd/Ctrl+Enter to send</p>
                      <button type="submit" className="sendIconButton" title="Send reply" aria-label="Send reply">
                        ➤
                      </button>
                    </form>
                  </>
                ) : (
                  <div className="replyEmpty">
                    <button type="button" className="replyCloseButton" onClick={() => setIsReplyPaneOpen(false)} aria-label="Close replies">
                      ×
                    </button>
                    <p className="meta">Click a message to view replies.</p>
                  </div>
                )}
              </aside>
            </div>

            <form onSubmit={handlePostMessage} className="composer">
              <div className="composerInputWrap">
                <textarea
                  ref={messageInputRef}
                  value={newMessage}
                  onChange={(e) => handleMessageInputChange(e.target.value, e.target)}
                  onKeyDown={handleMessageKeyDown}
                  placeholder="Message thread..."
                  rows={1}
                />
                <button
                  type="button"
                  className={`composerTaskPill messageTaskPill ${createTaskFromMessage ? "active" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setCreateTaskFromMessage((prev) => !prev)}
                  aria-pressed={createTaskFromMessage}
                >
                  Task
                </button>
              </div>
              <p className="composerHint">Enter: newline / Cmd(Ctrl)+Enter: send</p>
              <button type="submit" className="sendIconButton" title="Send message" aria-label="Send message" disabled={!selectedThreadId}>
                ➤
              </button>
            </form>
          </>
        ) : activeMainTab === "dashboard" ? (
          <section className="dashboardPane">
            <div className="dashboardFilterBar">
              <div className="dashboardFilterMain">
                <label>
                  Scope
                  <select
                    value={dashboardFilterScope}
                    onChange={(e) => {
                      const scope = e.target.value as "all" | "channel" | "thread";
                      setDashboardFilterScope(scope);
                      if (scope === "all") {
                        setDashboardFilterChannelId(null);
                        setDashboardFilterThreadId(null);
                      } else if (scope === "channel") {
                        setDashboardFilterChannelId(selectedChannelId ?? null);
                        setDashboardFilterThreadId(null);
                      } else {
                        setDashboardFilterChannelId(selectedChannelId ?? null);
                        setDashboardFilterThreadId(selectedThreadId ?? null);
                      }
                    }}
                  >
                    <option value="all">All</option>
                    <option value="channel" disabled={!selectedChannelId}>
                      Current channel
                    </option>
                    <option value="thread" disabled={!selectedThreadId}>
                      Current thread
                    </option>
                  </select>
                </label>
                <p className="meta">
                  <span className="dashboardScopeBlock">
                    <span className="dashboardScopeHead">Viewing</span>
                    <strong className="dashboardScopeValue">{dashboardScopeLabel}</strong>
                  </span>
                </p>
              </div>
              <div className="dashboardFilterActions">
                {dashboardFilterScope !== "all" ? (
                  <button
                    type="button"
                    className="dashboardAddTaskButton"
                    onClick={openDashboardTaskCreate}
                    title="Create task"
                    aria-label="Create task"
                  >
                    +
                  </button>
                ) : (
                  <span className="dashboardAddTaskPlaceholder" aria-hidden />
                )}
              </div>
            </div>
            {isDashboardTaskCreateOpen ? (
              <div className="dashboardTaskCreateOverlay" onClick={closeDashboardTaskCreate}>
                <form
                  className="dashboardTaskCreateCard"
                  onSubmit={handleCreateDashboardTask}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="dashboardTaskCreateHead">
                    <p className="meta">Create Task</p>
                    <button type="button" className="taskDetailCloseButton" onClick={closeDashboardTaskCreate} aria-label="Close create task">
                      ×
                    </button>
                  </div>
                  <label>
                    Thread
                    <select
                      value={dashboardTaskThreadId ?? ""}
                      onChange={(e) => setDashboardTaskThreadId(e.target.value ? Number(e.target.value) : null)}
                    >
                      {threads.length === 0 ? <option value="">No thread</option> : null}
                      {threads.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <input
                    value={newDashboardTaskTitle}
                    onChange={(e) => setNewDashboardTaskTitle(e.target.value)}
                    placeholder="Task title"
                  />
                  <textarea
                    value={newDashboardTaskNote}
                    onChange={(e) => setNewDashboardTaskNote(e.target.value)}
                    placeholder="Note (optional)"
                    rows={4}
                  />
                  <div className="dashboardTaskCreateActions">
                    <button type="button" onClick={closeDashboardTaskCreate}>
                      Cancel
                    </button>
                    <button type="submit" disabled={!dashboardTaskThreadId || !newDashboardTaskTitle.trim()}>
                      Create
                    </button>
                  </div>
                </form>
              </div>
            ) : null}
            {tasks.length === 0 ? (
              <p className="meta">No open tasks.</p>
            ) : (
              <div
                className={`dashboardBoardWorkspace ${isTaskDetailPaneOpen ? "" : "detailClosed"}`}
                style={{ ["--task-pane-width" as string]: `${taskDetailPaneWidth}px` } as CSSProperties}
              >
                <div className="taskBoard">
                  <section className="taskColumn">
                    <h3>
                      Open <span>{openTasks.length}</span>
                    </h3>
                    <ul onDragOver={(e) => e.preventDefault()} onDrop={() => void onTaskDrop("open")}>
                      {openTasks.map((task) => (
                        <li
                          key={task.id}
                          className={`activityCard clickableCard taskCard dashboardTaskCard ${selectedDashboardTaskId === task.id ? "selectedTaskCard" : ""} ${draggingTaskId === task.id ? "dragging" : ""}`}
                          draggable
                          onDragStart={() => onTaskDragStart(task.id)}
                          onDragEnd={onTaskDragEnd}
                          onClick={() => openDashboardTask(task)}
                        >
                          <p>
                            <strong>{task.title}</strong>
                          </p>
                          {task.note?.trim() ? <p className="taskCardNotePreview">{getTaskNotePreview(task.note)}</p> : null}
                          <div className="taskCardMetaRow">
                            <button
                              type="button"
                              className="meta taskCardThreadLink"
                              title="Open message"
                              aria-label="Open message"
                              onClick={(e) => {
                                e.stopPropagation();
                                openTaskMessage(task);
                              }}
                            >
                              #{task.channel_name} / {task.thread_title}
                            </button>
                            <span className="taskCardActions">
                              <button
                                type="button"
                                className="taskCardDeleteButton"
                                title="Delete task"
                                aria-label="Delete task"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleDeleteTask(task);
                                }}
                              >
                                🗑
                              </button>
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section className="taskColumn">
                    <h3>
                      Doing <span>{doingTasks.length}</span>
                    </h3>
                    <ul onDragOver={(e) => e.preventDefault()} onDrop={() => void onTaskDrop("doing")}>
                      {doingTasks.map((task) => (
                        <li
                          key={task.id}
                          className={`activityCard clickableCard taskCard dashboardTaskCard ${selectedDashboardTaskId === task.id ? "selectedTaskCard" : ""} ${draggingTaskId === task.id ? "dragging" : ""}`}
                          draggable
                          onDragStart={() => onTaskDragStart(task.id)}
                          onDragEnd={onTaskDragEnd}
                          onClick={() => openDashboardTask(task)}
                        >
                          <p>
                            <strong>{task.title}</strong>
                          </p>
                          {task.note?.trim() ? <p className="taskCardNotePreview">{getTaskNotePreview(task.note)}</p> : null}
                          <div className="taskCardMetaRow">
                            <button
                              type="button"
                              className="meta taskCardThreadLink"
                              title="Open message"
                              aria-label="Open message"
                              onClick={(e) => {
                                e.stopPropagation();
                                openTaskMessage(task);
                              }}
                            >
                              #{task.channel_name} / {task.thread_title}
                            </button>
                            <span className="taskCardActions">
                              <button
                                type="button"
                                className="taskCardDeleteButton"
                                title="Delete task"
                                aria-label="Delete task"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleDeleteTask(task);
                                }}
                              >
                                🗑
                              </button>
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section className="taskColumn">
                    <h3>
                      Done <span>{doneTasks.length}</span>
                    </h3>
                    <ul onDragOver={(e) => e.preventDefault()} onDrop={() => void onTaskDrop("done")}>
                      {doneTasks.map((task) => (
                        <li
                          key={task.id}
                          className={`activityCard clickableCard taskCard dashboardTaskCard ${selectedDashboardTaskId === task.id ? "selectedTaskCard" : ""} ${draggingTaskId === task.id ? "dragging" : ""}`}
                          draggable
                          onDragStart={() => onTaskDragStart(task.id)}
                          onDragEnd={onTaskDragEnd}
                          onClick={() => openDashboardTask(task)}
                        >
                          <p>
                            <strong>{task.title}</strong>
                          </p>
                          {task.note?.trim() ? <p className="taskCardNotePreview">{getTaskNotePreview(task.note)}</p> : null}
                          <div className="taskCardMetaRow">
                            <button
                              type="button"
                              className="meta taskCardThreadLink"
                              title="Open message"
                              aria-label="Open message"
                              onClick={(e) => {
                                e.stopPropagation();
                                openTaskMessage(task);
                              }}
                            >
                              #{task.channel_name} / {task.thread_title}
                            </button>
                            <span className="taskCardActions">
                              <button
                                type="button"
                                className="taskCardDeleteButton"
                                title="Delete task"
                                aria-label="Delete task"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleDeleteTask(task);
                                }}
                              >
                                🗑
                              </button>
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>
                <div className="taskPaneResizer" onMouseDown={startTaskPaneResize} />
                <aside className="taskDetailPane">
                  {selectedDashboardTask ? (
                    <>
                      <div className="taskDetailHeader">
                        <p className="meta">Task Detail</p>
                        {!isEditingTaskDetail ? (
                          <>
                            <button
                              type="button"
                              className="taskDetailEditButton"
                              onClick={() => setIsEditingTaskDetail(true)}
                              title="Edit task"
                              aria-label="Edit task"
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              className="taskDetailDeleteButton"
                              onClick={() => void handleDeleteTask(selectedDashboardTask)}
                              title="Delete task"
                              aria-label="Delete task"
                            >
                              🗑
                            </button>
                          </>
                        ) : null}
                        <button
                          type="button"
                          className="taskDetailCloseButton"
                          onClick={closeTaskDetailPane}
                          aria-label="Close task detail"
                        >
                          ×
                        </button>
                      </div>
                      {isEditingTaskDetail ? <p className="meta">Editing mode: title and note are editable.</p> : null}
                      <h3>
                        {isEditingTaskDetail ? (
                          <input
                            className="taskInlineTitleInput"
                            value={editingTaskTitle}
                            onChange={(e) => setEditingTaskTitle(e.target.value)}
                            placeholder="Task title"
                          />
                        ) : (
                          selectedDashboardTask.title
                        )}
                      </h3>
                      <div className="taskDetailStatus">
                        <span className={`statusBadge ${selectedDashboardTask.status}`}>
                          {selectedDashboardTask.status === "open" ? "○ Open" : selectedDashboardTask.status === "doing" ? "◐ Doing" : "✓ Done"}
                        </span>
                        <label className="taskStatusSelectLabel">
                          <span className="meta">Status</span>
                          <select
                            value={selectedDashboardTask.status}
                            onChange={(e) => void handleTaskStatus(selectedDashboardTask.id, e.target.value as TaskStatus)}
                          >
                            <option value="open">Open</option>
                            <option value="doing">Doing</option>
                            <option value="done">Done</option>
                          </select>
                        </label>
                      </div>
                      <div className="taskMetaGrid">
                        <div className="taskMetaItem">
                          <p className="meta">Thread</p>
                          <p className="taskMetaValue">#{selectedDashboardTask.channel_name} / {selectedDashboardTask.thread_title}</p>
                        </div>
                        <div className="taskMetaItem">
                          <p className="meta">Created by</p>
                          <p className="taskMetaValue">
                            <span className="taskCreatorPill">{selectedDashboardTask.created_by_name}</span>
                          </p>
                        </div>
                      </div>
                      <div className={`taskNoteBlock ${isEditingTaskDetail ? "editingNoteBlock" : ""}`}>
                        <p className="meta">Note</p>
                        {isEditingTaskDetail ? (
                          <textarea
                            className="taskInlineNoteInput"
                            value={editingTaskNote}
                            onChange={(e) => setEditingTaskNote(e.target.value)}
                            placeholder="Task note"
                            rows={6}
                          />
                        ) : selectedDashboardTask.note ? (
                          <div className="messageBody">
                            {renderMessageContent(selectedDashboardTask.note, `task-note-${selectedDashboardTask.id}`, (ordinal, checked) => {
                              void handleTaskChecklistToggle(selectedDashboardTask.id, ordinal, checked);
                            })}
                          </div>
                        ) : (
                          <p className="meta">No note.</p>
                        )}
                      </div>
                      {isEditingTaskDetail ? (
                        <div className="taskActions">
                          <button type="button" onClick={() => void saveTaskDetailEdits()}>
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setIsEditingTaskDetail(false);
                              setEditingTaskTitle(selectedDashboardTask.title);
                              setEditingTaskNote(selectedDashboardTask.note || "");
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="taskActions">
                          <button
                            className="iconAction jump openMessageAction"
                            title="Open message"
                            aria-label="Open message"
                            onClick={() => openTaskMessage(selectedDashboardTask)}
                          >
                            ↗ Open message
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="replyEmpty">
                      <button
                        type="button"
                        className="taskDetailCloseButton"
                        onClick={closeTaskDetailPane}
                        aria-label="Close task detail"
                      >
                        ×
                      </button>
                      <p className="meta">Select a task.</p>
                    </div>
                  )}
                </aside>
              </div>
            )}
          </section>
        ) : (
          <section className="dashboardPane">
            <div>
              <h2 style={{ marginTop: 0 }}>Activity</h2>
              <p className="meta">Unread updates across channels and threads</p>
            </div>
            <ul className="activityList">
              {activityEntries.map(({ threadId, count, meta }) => (
                <li key={threadId} className="activityCard clickableCard" onClick={() => {
                  if (meta?.channelId) {
                    setSelectedChannelId(meta.channelId);
                  }
                  setSelectedThreadId(threadId);
                  setIsReplyPaneOpen(false);
                  setActiveMainTab("thread");
                }}>
                  <p>
                    {meta?.channelName ? `#${meta.channelName} / ` : ""}
                    {meta?.threadTitle || `Thread #${threadId}`}: <strong>{count}</strong> updates
                  </p>
                </li>
              ))}
              {activityEntries.length === 0 ? <li className="activityCard">No unread updates.</li> : null}
            </ul>
          </section>
        )}
      </section>
    </main>
  );
}
