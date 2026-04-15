#!/usr/bin/env bun

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { render, Text, Box, useInput, useApp, useStdout } from "ink";
import process from "node:process";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Mouse scroll filter ──────────────────────────────────────────────────────
// Strategy: monkey-patch process.stdin.read() so mouse SGR escape sequences
// are stripped before Ink sees them (Ink uses stdin in paused/readable mode,
// calling stdin.read() — not data events — so a Transform pipe or prepended
// data listener is insufficient).  Scroll direction is emitted on scrollBus.

const scrollBus = new EventEmitter();
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

if (process.stdin.isTTY) {
  process.stdout.write("\x1b[?1000h\x1b[?1006h");

  const origRead = process.stdin.read.bind(process.stdin) as (size?: number) => string | Buffer | null;

  process.stdin.read = function patchedRead(size?: number): string | Buffer | null {
    const chunk = origRead(size);
    if (chunk == null) return chunk;

    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");

    // Emit scroll events for any mouse wheel bytes found
    SGR_MOUSE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SGR_MOUSE_RE.exec(s)) !== null) {
      const btn = parseInt(m[1]!, 10);
      const x = parseInt(m[2]!, 10);
      const y = parseInt(m[3]!, 10);
      const action = m[4]!;
      if (btn === 64) scrollBus.emit("scroll", +1); // wheel up
      if (btn === 65) scrollBus.emit("scroll", -1); // wheel down
      if (action === "M" && btn === 0) scrollBus.emit("click", { x, y });
    }

    // Return chunk with mouse sequences stripped
    const filtered = s.replace(SGR_MOUSE_RE, "");
    if (filtered.length === 0) return null;
    return typeof chunk === "string" ? filtered : Buffer.from(filtered, "utf8");
  } as typeof process.stdin.read;

  process.on("exit", () => process.stdout.write("\x1b[?1000l\x1b[?1006l"));
}

import Spinner from "ink-spinner";
import { loadState, runAgent, DEFAULT_MODEL, loadUserSkills, loadUserSubagents } from "./core";
import type { AgentState, LogKind, UserSkill, UserSubagent } from "./core";

interface LogEntry {
  id: string;
  text: string;
  detail?: string;
  kind: LogKind | "user" | "info";
  source?: string; // set to subagent name when the line comes from a subagent
}

interface RenderRow {
  type: "spacer" | "entry" | "shelf";
  entry?: LogEntry;
  text?: string;
  kind?: LogEntry["kind"];
  entryId?: string;
}

interface SessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  entries: LogEntry[];
  inputHistory: string[];
}

interface SessionStore {
  currentSessionId: string;
  sessions: SessionRecord[];
}

// Rows consumed by fixed chrome:
//   top border(1) + header(1) + gap(1) + divider(1) + input(1) + status(1) + help(1) + bottom border(1)
const CHROME_ROWS = 8;
// Extra rows used when the completion popup is visible (up to MAX_SUGGESTIONS lines + 1 border)
const MAX_SUGGESTIONS = 6;
const SESSIONS_FILE = path.join(process.cwd(), ".mini-agent-sessions.json");
const LOG_START_ROW = 4;

// ── Helpers ─────────────────────────────────────────────────────────────────

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 });
  useEffect(() => {
    const onResize = () => setSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 });
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
  return size;
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

function createEntryId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createLogEntry(text: string, kind: LogEntry["kind"], source?: string, detail?: string): LogEntry {
  return { id: createEntryId(), text, kind, source, detail };
}

function isToolEntry(entry: Pick<LogEntry, "kind">): boolean {
  return entry.kind === "tool-call" || entry.kind === "tool-result";
}

function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const out: string[] = [];

  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      out.push("");
      continue;
    }

    for (let i = 0; i < rawLine.length; i += safeWidth) {
      out.push(rawLine.slice(i, i + safeWidth));
    }
  }

  return out.length > 0 ? out : [""];
}

function buildDefaultEntries(model: string): LogEntry[] {
  return [
    createLogEntry("Local AI Agent v2026", "info"),
    createLogEntry(`Model: ${model}`, "info"),
    createLogEntry("Type a task or /command. ESC ESC or /exit to exit.", "info"),
  ];
}

function buildSessionTitle(entries: LogEntry[]): string {
  const firstUserEntry = entries.find((entry) => entry.kind === "user" && entry.text.startsWith("> "));
  return firstUserEntry ? truncate(firstUserEntry.text.slice(2), 40) : "Untitled session";
}

function createSession(model: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: now.replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 8),
    title: "Untitled session",
    createdAt: now,
    updatedAt: now,
    model,
    entries: buildDefaultEntries(model),
    inputHistory: [],
  };
}

function normalizeSession(session: SessionRecord): SessionRecord {
  const model = session.model || DEFAULT_MODEL;
  const entries = session.entries?.length
    ? session.entries.map((entry) => ({ ...entry, id: entry.id || createEntryId() }))
    : buildDefaultEntries(model);
  const inputHistory = Array.isArray(session.inputHistory) ? session.inputHistory : [];
  return {
    ...session,
    model,
    entries,
    inputHistory,
    title: session.title || buildSessionTitle(entries),
    createdAt: session.createdAt || new Date().toISOString(),
    updatedAt: session.updatedAt || new Date().toISOString(),
  };
}

function loadSessionStore(defaultModel: string): SessionStore {
  if (!fs.existsSync(SESSIONS_FILE)) {
    const session = createSession(defaultModel);
    return { currentSessionId: session.id, sessions: [session] };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")) as Partial<SessionStore>;
    const sessions = Array.isArray(raw.sessions)
      ? raw.sessions.map((session) => normalizeSession(session as SessionRecord))
      : [];
    const currentSessionId = raw.currentSessionId;
    const current = sessions.find((session) => session.id === currentSessionId) ?? sessions[0];
    if (current) return { currentSessionId: current.id, sessions };
  } catch {
    // fall through to new store
  }

  const session = createSession(defaultModel);
  return { currentSessionId: session.id, sessions: [session] };
}

function saveSessionStore(store: SessionStore): void {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(store, null, 2));
}

function formatSessionLabel(session: SessionRecord): string {
  return `${session.id.slice(0, 8)}  ${session.title}  (${new Date(session.updatedAt).toLocaleString()})`;
}

function buildTranscript(session: SessionRecord): string {
  const lines = [
    `# mini-agent session ${session.id}`,
    "",
    `Title: ${session.title}`,
    `Model: ${session.model}`,
    `Created: ${session.createdAt}`,
    `Updated: ${session.updatedAt}`,
    "",
    "## Transcript",
    "",
  ];

  for (const entry of session.entries) {
    const source = entry.source ? `[${entry.source}] ` : "";
    const prefix = entry.kind === "reasoning"
      ? "~ "
      : entry.kind === "tool-call"
        ? ">> "
        : entry.kind === "tool-result"
          ? "<< "
          : "";
    lines.push(entry.text === "" ? "" : `${source}${prefix}${entry.text}`);
  }

  lines.push("");
  return lines.join("\n");
}

function openInEditor(filePath: string): string | null {
  const stdin = process.stdin;
  const canToggleRawMode = stdin.isTTY && typeof stdin.setRawMode === "function";
  const wasRaw = canToggleRawMode && "isRaw" in stdin ? Boolean((stdin as typeof stdin & { isRaw?: boolean }).isRaw) : false;

  try {
    if (canToggleRawMode) stdin.setRawMode(false);
    const result = spawnSync("sh", ["-lc", 'exec ${EDITOR:-vi} "$1"', "sh", filePath], {
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) return result.error.message;
    if (typeof result.status === "number" && result.status !== 0) return `editor exited with code ${result.status}`;
    return null;
  } finally {
    if (canToggleRawMode) stdin.setRawMode(wasRaw);
  }
}

// ── Slash-command registry ───────────────────────────────────────────────────

interface SlashCommand {
  name: string;        // without the leading /
  description: string;
}

// Built-in commands (static)
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "model",  description: "Switch model — /model provider:model-id" },
  { name: "skills", description: "List available skills" },
  { name: "agents", description: "List available subagents" },
  { name: "new", description: "Create a new session" },
  { name: "sessions", description: "List, switch, or create sessions" },
  { name: "export", description: "Open current session transcript in $EDITOR" },
  { name: "exit", description: "Exit the app" },
];

// ── Main UI ─────────────────────────────────────────────────────────────────

const AgentUI = () => {
  const { exit } = useApp();
  const { rows, columns } = useTerminalSize();
  const innerWidth = Math.max(20, columns - 4);
  const defaultModel = process.env.MODEL ?? DEFAULT_MODEL;
  const sessionBootstrap = useRef<SessionStore | null>(null);
  if (!sessionBootstrap.current) sessionBootstrap.current = loadSessionStore(defaultModel);

  // Load skills and subagents once on mount
  const [userSkills]    = useState<UserSkill[]>(() => loadUserSkills());
  const [userSubagents] = useState<UserSubagent[]>(() => loadUserSubagents());
  const [sessionStore, setSessionStore] = useState<SessionStore>(() => sessionBootstrap.current!);
  const currentSession = sessionStore.sessions.find((session) => session.id === sessionStore.currentSessionId) ?? sessionStore.sessions[0]!;

  // All slash commands = builtins + one entry per skill + one entry per subagent
  const allCommands = useMemo<SlashCommand[]>(() => [
    ...BUILTIN_COMMANDS,
    ...userSkills.map((s) => ({ name: s.name,    description: `[skill] ${s.description}` })),
    ...userSubagents.map((a) => ({ name: a.name, description: `[subagent] ${a.description}` })),
  ], [userSkills, userSubagents]);

  const [status, setStatus]   = useState<"idle" | "thinking">("idle");
  const [liveEntry, setLiveEntry]         = useState<LogEntry | null>(null);
  const [input, setInput]                 = useState("");
  const [historyIndex, setHistoryIndex]   = useState(-1);
  const [lastEscape, setLastEscape]       = useState(false);
  const [scrollOffset, setScrollOffset]   = useState(0); // 0 = pinned to bottom
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<string | null>(null);
  const approvalResolver = useRef<((v: boolean) => void) | null>(null);
  const stateRef = useRef<AgentState>(loadState());
  const model = currentSession.model;
  const entries = currentSession.entries;
  const inputHistory = currentSession.inputHistory;

  const updateCurrentSession = useCallback((updater: (session: SessionRecord) => SessionRecord) => {
    setSessionStore((prev) => ({
      ...prev,
      sessions: prev.sessions.map((session) =>
        session.id === prev.currentSessionId
          ? updater(session)
          : session,
      ),
    }));
  }, []);

  const setEntries = useCallback((updater: React.SetStateAction<LogEntry[]>) => {
    updateCurrentSession((session) => {
      const nextEntries = typeof updater === "function"
        ? (updater as (prev: LogEntry[]) => LogEntry[])(session.entries)
        : updater;
      return {
        ...session,
        entries: nextEntries,
        title: buildSessionTitle(nextEntries),
        updatedAt: new Date().toISOString(),
      };
    });
  }, [updateCurrentSession]);

  const setInputHistory = useCallback((updater: React.SetStateAction<string[]>) => {
    updateCurrentSession((session) => ({
      ...session,
      inputHistory: typeof updater === "function"
        ? (updater as (prev: string[]) => string[])(session.inputHistory)
        : updater,
      updatedAt: new Date().toISOString(),
    }));
  }, [updateCurrentSession]);

  const setModel = useCallback((nextModel: string) => {
    updateCurrentSession((session) => {
      const nextEntries = session.entries.map((entry, index) => {
        if (index === 1 && entry.kind === "info" && entry.text.startsWith("Model: ")) {
          return { ...entry, text: `Model: ${nextModel}` };
        }
        return entry;
      });

      return {
        ...session,
        model: nextModel,
        entries: nextEntries,
        updatedAt: new Date().toISOString(),
      };
    });
  }, [updateCurrentSession]);

  useEffect(() => {
    saveSessionStore(sessionStore);
  }, [sessionStore]);

  useEffect(() => {
    setExpandedEntryId(null);
  }, [currentSession.id]);

  // Completion state
  const [suggestions, setSuggestions] = useState<SlashCommand[]>([]);
  const [suggIndex, setSuggIndex]     = useState(0);

  // Live stream buffer — now carries source too
  const liveBuf    = useRef<{ text: string; kind: LogKind; source?: string } | null>(null);
  const rafPending = useRef(false);

  // ── Completion logic ────────────────────────────────────────────────────

  // Recompute suggestions whenever input changes
  useEffect(() => {
    if (!input.startsWith("/")) {
      setSuggestions([]);
      return;
    }
    const query = input.slice(1).toLowerCase(); // text after the /
    const filtered = allCommands.filter((c) => c.name.startsWith(query));
    // Exact match with no trailing space → still show so user can see the hint
    setSuggestions(filtered.slice(0, MAX_SUGGESTIONS));
    setSuggIndex(0);
  }, [input, allCommands]);

  // ── Log helpers ─────────────────────────────────────────────────────────

  const flushLive = useCallback(() => {
    const buf = liveBuf.current;
    liveBuf.current = null;
    setLiveEntry(null);
    if (buf?.text.trim()) {
      setEntries((prev) => [...prev, createLogEntry(buf.text.trimEnd(), buf.kind, buf.source)]);
    }
  }, []);

  const addEntry = useCallback((text: string, kind: LogEntry["kind"], source?: string) => {
    flushLive();
    setEntries((prev) => {
      const sep: LogEntry[] = kind === "user" && prev.length > 0 ? [createLogEntry("", "info")] : [];
      return [...prev, ...sep, createLogEntry(text, kind, source)];
    });
  }, [flushLive]);

  const log = useCallback((delta: string, kind: LogKind = "text", source?: string, detail?: string) => {
    if (kind === "text" || kind === "reasoning") {
      // Flush if kind OR source changes (switching between main/subagent mid-stream)
      if (liveBuf.current?.kind !== kind || liveBuf.current?.source !== source) flushLive();
      if (!liveBuf.current) liveBuf.current = { text: "", kind, source };

      const parts = (liveBuf.current.text + delta).split("\n");
      const done  = parts.slice(0, -1) as string[];
      liveBuf.current.text = parts[parts.length - 1] ?? "";

      if (done.length > 0) {
        setEntries((prev) => [
          ...prev,
          ...done.filter((l) => l.trim()).map((l) => createLogEntry(l, kind, source)),
        ]);
      }

      if (!rafPending.current) {
        rafPending.current = true;
        setTimeout(() => {
          if (liveBuf.current) setLiveEntry(createLogEntry(liveBuf.current.text, liveBuf.current.kind, liveBuf.current.source));
          rafPending.current = false;
        }, 32);
      }
    } else {
      flushLive();
      setEntries((prev) => [...prev, createLogEntry(delta, kind, source, detail)]);
    }
  }, [flushLive]);

  // ── Approve callback ────────────────────────────────────────────────────

  const approve = useCallback((msg: string): Promise<boolean> => {
    setPendingApproval(msg);
    return new Promise<boolean>((resolve) => { approvalResolver.current = resolve; });
  }, []);

  // ── Task runner ─────────────────────────────────────────────────────────

  const runTask = useCallback(async (
    prompt: string,
    modelStr: string,
    preloadedSkills: UserSkill[] = [],
  ) => {
    setStatus("thinking");
    try {
      await runAgent(prompt, stateRef.current, approve, log, modelStr, userSkills, preloadedSkills, userSubagents);
      flushLive();
    } catch (e: unknown) {
      flushLive();
      addEntry(`Error: ${(e as { message?: string }).message ?? "Unknown error"}`, "error");
    }
    setStatus("idle");
  }, [approve, log, flushLive, addEntry, userSkills, userSubagents]);

  // ── Command dispatch ────────────────────────────────────────────────────

  const dispatchCommand = useCallback((raw: string) => {
    const [cmd, ...rest] = raw.split(" ");
    const arg = rest.join(" ").trim();

    if (cmd === "exit") {
      exit();
      return;
    }

    if (cmd === "model") {
      if (!arg) { addEntry("Usage: /model provider:model-id", "error"); return; }
      setModel(arg);
      addEntry(`Switched model → ${arg}`, "info");
      return;
    }

    if (cmd === "skills") {
      if (userSkills.length === 0) {
        addEntry("No skills found in ~/.agents/skills/", "info");
        return;
      }
      addEntry(`Available skills (${userSkills.length}):`, "info");
      for (const s of userSkills) {
        addEntry(`  /${s.name}  —  ${truncate(s.description, innerWidth - 20)}`, "info");
      }
      return;
    }

    if (cmd === "agents") {
      if (userSubagents.length === 0) {
        addEntry("No subagents found in ~/.agents/subagents/ or .agents/subagents/", "info");
        return;
      }
      addEntry(`Available subagents (${userSubagents.length}):`, "info");
      for (const a of userSubagents) {
        const tools = a.allowedBinaries ? ` [${a.allowedBinaries.join(", ")}]` : " [all tools]";
        addEntry(`  /${a.name}${tools}  —  ${truncate(a.description, innerWidth - 30)}`, "info");
      }
      return;
    }

    if (cmd === "new") {
      const session = createSession(model);
      setSessionStore((prev) => ({
        currentSessionId: session.id,
        sessions: [...prev.sessions, session],
      }));
      setInput("");
      setHistoryIndex(-1);
      setScrollOffset(0);
      setSuggestions([]);
      return;
    }

    if (cmd === "sessions") {
      if (!arg) {
        addEntry(`Sessions (${sessionStore.sessions.length}):`, "info");
        for (const session of [...sessionStore.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
          const marker = session.id === sessionStore.currentSessionId ? "*" : " ";
          addEntry(`${marker} ${formatSessionLabel(session)}`, "info");
        }
        addEntry("Use /new to create one, or /sessions <id-prefix> to switch.", "info");
        return;
      }

      if (arg === "new") {
        const session = createSession(model);
        setSessionStore((prev) => ({
          currentSessionId: session.id,
          sessions: [...prev.sessions, session],
        }));
        setInput("");
        setHistoryIndex(-1);
        setScrollOffset(0);
        setSuggestions([]);
        return;
      }

      const matches = sessionStore.sessions.filter((session) => session.id.startsWith(arg));
      if (matches.length === 0) {
        addEntry(`No session matches '${arg}'.`, "error");
        return;
      }
      if (matches.length > 1) {
        addEntry(`Multiple sessions match '${arg}'. Use more characters.`, "error");
        return;
      }

      const session = matches[0]!;
      setSessionStore((prev) => ({ ...prev, currentSessionId: session.id }));
      setInput("");
      setHistoryIndex(-1);
      setScrollOffset(0);
      setSuggestions([]);
      return;
    }

    if (cmd === "export") {
      flushLive();
      const exportSession = sessionStore.sessions.find((session) => session.id === sessionStore.currentSessionId) ?? currentSession;
      const exportPath = path.join(os.tmpdir(), `mini-agent-session-${exportSession.id}.md`);
      fs.writeFileSync(exportPath, buildTranscript(exportSession));
      const error = openInEditor(exportPath);
      addEntry(error ? `Export failed: ${error}` : `Opened export in $EDITOR → ${exportPath}`, error ? "error" : "info");
      return;
    }

    // Skill slash-command: /skill-name [optional task args]
    // Preload the skill body directly into the system prompt so it's guaranteed to be applied.
    const skill = userSkills.find((s) => s.name === cmd);
    if (skill) {
      const prompt = arg
        ? `Use the '${skill.name}' skill for the following task: ${arg}`
        : `Apply the '${skill.name}' skill.`;
      addEntry(`> /${skill.name}${arg ? " " + arg : ""}`, "user");
      runTask(prompt, model, [skill]);
      return;
    }

    // Subagent slash-command: /subagent-name [optional task description]
    const subagent = userSubagents.find((a) => a.name === cmd);
    if (subagent) {
      const prompt = arg
        ? `Delegate this task to the '${subagent.name}' subagent: ${arg}`
        : `Use the '${subagent.name}' subagent to help with the current task.`;
      addEntry(`> /${subagent.name}${arg ? " " + arg : ""}`, "user");
      runTask(prompt, model);
      return;
    }

    addEntry(`Unknown command: /${cmd}  (try /skills or /agents to list available)`, "error");
  }, [
    addEntry,
    currentSession,
    exit,
    flushLive,
    innerWidth,
    model,
    runTask,
    sessionStore,
    setModel,
    userSkills,
    userSubagents,
  ]);

  // ── Log geometry (needed both by useInput and render) ───────────────────

  const popupRows = suggestions.length > 0 ? suggestions.length + 1 : 0;
  const logHeight = Math.max(1, rows - CHROME_ROWS - popupRows);

  // ── Input handler ───────────────────────────────────────────────────────

  useInput((inputStr, key) => {
    // Approval gate — intercept everything
    if (pendingApproval) {
      const approved = inputStr === "y" || inputStr === "Y";
      addEntry(approved ? "  APPROVED" : "  DENIED", "info");
      setPendingApproval(null);
      approvalResolver.current?.(approved);
      approvalResolver.current = null;
      return;
    }

    // Tab — accept top suggestion
    if (key.tab && suggestions.length > 0) {
      const picked = suggestions[suggIndex]!;
      setInput(`/${picked.name} `);
      setSuggestions([]);
      return;
    }

    // PageUp / PageDown — scroll log
    if (key.pageUp) {
      setScrollOffset((o) => o + Math.max(1, logHeight - 2));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((o) => Math.max(0, o - Math.max(1, logHeight - 2)));
      return;
    }

    // Up/Down — navigate suggestions if open, else history
    if (key.upArrow) {
      if (suggestions.length > 0) {
        setSuggIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (inputHistory.length > 0) {
        const newIndex = Math.min(historyIndex + 1, inputHistory.length - 1);
        setHistoryIndex(newIndex);
        setInput(inputHistory[inputHistory.length - 1 - newIndex] ?? "");
      }
      return;
    }
    if (key.downArrow) {
      if (suggestions.length > 0) {
        setSuggIndex((i) => (i + 1) % suggestions.length);
        return;
      }
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInput(inputHistory[inputHistory.length - 1 - newIndex] ?? "");
      } else {
        setHistoryIndex(-1);
        setInput("");
      }
      return;
    }

    // Enter
    if (key.return && input.trim() && status === "idle") {
      const query = input.trim();
      setSuggestions([]);

      if (query.startsWith("/")) {
        setInput("");
        setHistoryIndex(-1);
        dispatchCommand(query.slice(1));
        return;
      }

      addEntry(`> ${query}`, "user");
      setInputHistory((prev) => [...prev, query]);
      setHistoryIndex(-1);
      setScrollOffset(0); // pin back to bottom on new submission
      setInput("");
      runTask(query, model);
      return;
    }

    // Escape
    if (key.escape) {
      if (suggestions.length > 0) { setSuggestions([]); return; }
      if (lastEscape) { exit(); return; }
      setLastEscape(true);
      setTimeout(() => setLastEscape(false), 300);
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }

    // Regular character
    if (inputStr && !key.ctrl && !key.meta) {
      setInput((prev) => prev + inputStr);
    }
  });

  // ── Render helpers ──────────────────────────────────────────────────────

  const entryColor = (kind: LogEntry["kind"]): string | undefined => {
    switch (kind) {
      case "reasoning":   return "magenta";
      case "tool-call":   return "cyan";
      case "tool-result": return "green";
      case "error":       return "red";
      case "user":        return "yellow";
      case "info":        return "gray";
      default:            return undefined;
    }
  };

  const buildRenderRows = useCallback((logEntries: LogEntry[]): RenderRow[] => {
    const rows: RenderRow[] = [];
    let prevEntry: LogEntry | null = null;

    for (const entry of logEntries) {
      const isBlank = entry.text === "";
      const needsToolGap = prevEntry && !isBlank
        ? isToolEntry(prevEntry) !== isToolEntry(entry) && (isToolEntry(prevEntry) || isToolEntry(entry))
        : false;

      if (needsToolGap) rows.push({ type: "spacer" });

      rows.push({ type: "entry", entry, entryId: entry.id, kind: entry.kind });

      if (expandedEntryId === entry.id && isToolEntry(entry)) {
        const shelfWidth = Math.max(8, innerWidth - 4);
        const label = entry.kind === "tool-call" ? "command" : "result";
        const shelfText = entry.detail ?? entry.text;
        rows.push({ type: "shelf", text: `┌ ${label}`, kind: entry.kind, entryId: entry.id });
        for (const line of wrapText(shelfText, shelfWidth)) {
          rows.push({ type: "shelf", text: `│ ${line}`, kind: entry.kind, entryId: entry.id });
        }
        rows.push({ type: "shelf", text: "└ click to close", kind: entry.kind, entryId: entry.id });
      }

      if (!isBlank) prevEntry = entry;
    }

    return rows;
  }, [expandedEntryId, innerWidth]);

  const allEntries  = [...entries, ...(liveEntry && scrollOffset === 0 ? [liveEntry] : [])];
  const renderRows = buildRenderRows(allEntries);
  const totalLines  = renderRows.length;
  // clamp offset so we never scroll past the beginning
  const clampedOffset = Math.min(scrollOffset, Math.max(0, totalLines - logHeight));
  // When pinned to bottom (offset=0) show tail; otherwise show a window offset from the end
  const allVisible  = clampedOffset === 0
    ? renderRows.slice(-logHeight)
    : renderRows.slice(
        Math.max(0, totalLines - logHeight - clampedOffset),
        totalLines - clampedOffset,
      );

  // ── Subscribe to mouse scroll events from the module-level filter ───────
  useEffect(() => {
    const SCROLL_LINES = 3;
    const onScroll = (dir: number) => {
      if (dir > 0) setScrollOffset((o) => o + SCROLL_LINES);
      else         setScrollOffset((o) => Math.max(0, o - SCROLL_LINES));
    };

    const onClick = ({ y }: { x: number; y: number }) => {
      const rowIndex = y - LOG_START_ROW;
      if (rowIndex < 0 || rowIndex >= allVisible.length) return;

      const row = allVisible[rowIndex];
      if (!row?.entryId) return;

      const target = allEntries.find((entry) => entry.id === row.entryId);
      if (!target || !isToolEntry(target)) return;

      setExpandedEntryId((current) => current === target.id ? null : target.id);
    };

    scrollBus.on("scroll", onScroll);
    scrollBus.on("click", onClick);
    return () => {
      scrollBus.off("scroll", onScroll);
      scrollBus.off("click", onClick);
    };
  }, [allEntries, allVisible]);

  // ── JSX ─────────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" height={rows} borderStyle="round" borderColor="cyan">
      {/* Header */}
      <Box justifyContent="space-between" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">Local AI Agent</Text>
        <Text color="gray" dimColor>{model}</Text>
      </Box>

      {/* Log area */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
        {allVisible.map((row, i) => {
          if (row.type === "spacer") {
            return <Text key={`spacer-${i}`}> </Text>;
          }

          if (row.type === "shelf") {
            return (
              <Text key={`shelf-${row.entryId}-${i}`} color={entryColor(row.kind ?? "info")} dimColor>
                {truncate(row.text ?? "", innerWidth)}
              </Text>
            );
          }

          const entry = row.entry!;
          const prefix = entry.source ? `[${entry.source}] ` : "";
          const body   = entry.kind === "reasoning" ? `~ ${entry.text}` : entry.text;
          const line   = entry.text === "" ? " " : truncate(prefix + body, innerWidth);
          const expandable = isToolEntry(entry);
          const indicator = expandable ? (expandedEntryId === entry.id ? "[-] " : "[+] ") : "";
          return (
            <Text key={entry.id} color={entryColor(entry.kind)} dimColor={entry.kind === "reasoning"}>
              {entry.source
                ? <><Text>{indicator}</Text><Text color="magenta" dimColor>[{entry.source}] </Text><Text>{truncate(body, innerWidth - prefix.length - indicator.length)}</Text></>
                : `${indicator}${line}`}
            </Text>
          );
        })}
      </Box>

      {/* Completion popup — sits just above the divider */}
      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          {suggestions.map((s, i) => (
            <Box key={s.name}>
              <Text
                color={i === suggIndex ? "black" : "cyan"}
                backgroundColor={i === suggIndex ? "cyan" : undefined}
              >
                {truncate(
                  ` /${s.name.padEnd(22)} ${s.description} `,
                  innerWidth,
                )}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Divider */}
      <Box paddingX={1}>
        <Text color="cyan" dimColor>{"─".repeat(innerWidth)}</Text>
      </Box>

      {/* Input row */}
      <Box paddingX={1}>
        <Text color={status === "thinking" ? "yellow" : "cyan"}>{">"} </Text>
        <Text>{input}</Text>
        {status === "idle" && !input && <Text dimColor>Type a task or /command…</Text>}
      </Box>

      {/* Status row — spinner or approval */}
      <Box paddingX={1} minHeight={1}>
        {status === "thinking" && !pendingApproval && (
          <><Spinner type="dots" /><Text color="yellow"> Thinking…</Text></>
        )}
        {pendingApproval && (
          <Text color="yellow" bold>{"⚠  "}{truncate(pendingApproval, innerWidth - 3)}</Text>
        )}
      </Box>

      {/* Help bar */}
      <Box paddingX={1}>
        <Text dimColor>
          {suggestions.length > 0
            ? "[↑↓ select]  [Tab accept]  [Esc dismiss]"
            : clampedOffset > 0
              ? `[scroll ↑↓ or PgUp/PgDn]  [${clampedOffset} lines up — scroll down to resume]`
              : "[↑↓ history]  [scroll/PgUp to scroll]  [click tool row to expand]"}
        </Text>
      </Box>
    </Box>
  );
};

render(<AgentUI />, { patchConsole: true });
