import { streamText, tool, stepCountIs, createProviderRegistry } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// --- Provider registry ---
// Switch model via MODEL env var, e.g.:
//   MODEL=openrouter:anthropic/claude-3.7-sonnet bun run cli.tsx
//   MODEL=copilot:claude-3-7-sonnet-latest bun run cli.tsx
//   MODEL=lmstudio:llama-3.3-70b bun run cli.tsx
/** Provider registry for AI language models (openrouter, copilot, lmstudio, llama-local). */
export const registry = createProviderRegistry({
  openrouter: createOpenAICompatible({
    name: "openrouter",
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    baseURL: "https://openrouter.ai/api/v1",
  }),
  copilot: createOpenAICompatible({
    name: "copilot",
    apiKey: process.env.GITHUB_TOKEN ?? "",
    baseURL: "https://api.githubcopilot.com",
  }),
  lmstudio: createOpenAICompatible({
    name: "lmstudio",
    apiKey: "lm-studio",
    baseURL: "http://localhost:1234/v1",
  }),
  "llama-local": createOpenAICompatible({
    name: "llama-local",
    apiKey: "sk-no-key-required",
    baseURL: "http://127.0.0.1:8082/v1",
  }),
});

/** Default AI model identifier used when no MODEL env var is set. */
export const DEFAULT_MODEL = "openrouter:anthropic/claude-3.7-sonnet";
/** Resolve a model string to a language model instance from the registry. */

export function resolveModel(modelStr?: string) {
  const id = (modelStr ?? process.env.MODEL ?? DEFAULT_MODEL) as
    | `openrouter:${string}`
    | `copilot:${string}`
    | `lmstudio:${string}`
    | `llama-local:${string}`;
  return registry.languageModel(id);
}

/** Interface representing the runtime state of an agent. */
// --- Types ---
export interface AgentState {
  autonomous_mode: boolean;
  [key: string]: unknown;
}

/** Callback type for confirming user approval on actions requiring permission. */
/** Type defining different categories of log output. */
/** Callback type for logging messages with optional kind and source metadata. */
export type ApproveFn = (msg: string) => Promise<boolean>;
export type LogKind = "text" | "reasoning" | "tool-call" | "tool-result" | "error";
export type LogFn = (msg: string, kind?: LogKind, source?: string, detail?: string) => void;

// --- Team task list ---

/** Type representing possible states of a team task. */
export type TaskStatus = "pending" | "claimed" | "done" | "failed";

/** Interface representing a single task in a team's shared task list. */
export interface TeamTask {
  id: string;
  description: string;
  assignee?: string;   // teammate name that claimed it
  status: TaskStatus;
  result?: string;     // set when done/failed
}

/**
 * File-backed shared task list for agent teams.
 * All mutations are atomic (write to .tmp then rename) so concurrent teammates
 * don't corrupt the file even though execSync is synchronous per-process.
 */
export class TaskList {
  readonly filePath: string;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, "tasks.json");
    if (!fs.existsSync(this.filePath)) this._write([]);
  }

  private _read(): TeamTask[] {
    try { return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as TeamTask[]; }
    catch { return []; }
  }

  private _write(tasks: TeamTask[]): void {
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  init(tasks: Omit<TeamTask, "status">[]): void {
    this._write(tasks.map((t) => ({ ...t, status: "pending" as TaskStatus })));
  }

  read(): TeamTask[] { return this._read(); }

  /** Atomically claim a pending task. Returns false if already claimed/done. */
  claim(id: string, assignee: string): boolean {
    const tasks = this._read();
    const task  = tasks.find((t) => t.id === id);
    if (!task || task.status !== "pending") return false;
    task.status   = "claimed";
    task.assignee = assignee;
    this._write(tasks);
    return true;
  }

  complete(id: string, result: string, failed = false): void {
    const tasks = this._read();
    const task  = tasks.find((t) => t.id === id);
    if (!task) return;
    task.status = failed ? "failed" : "done";
    task.result = result;
    this._write(tasks);
  }

  summary(): string {
    const tasks = this._read();
    return tasks
      .map((t) => `[${t.status.toUpperCase()}] ${t.id}: ${t.description}${t.result ? ` → ${t.result.slice(0, 80)}` : ""}`)
      .join("\n");
  }

  allDone(): boolean {
    return this._read().every((t) => t.status === "done" || t.status === "failed");
  }
}

// --- User skills (loaded from ~/.agents/skills/*/SKILL.md) ---

/** Interface representing a user-defined skill loaded from SKILL.md files. */
export interface UserSkill {
  name: string;
  description: string;
  body: string; // everything after the closing --- of the frontmatter
}

const SKILLS_DIR = path.join(process.env.HOME ?? "~", ".agents", "skills");

// --- User subagents (loaded from ~/.agents/subagents/*/AGENT.md and .agents/subagents/*/AGENT.md) ---

/** Interface defining a subagent configuration with optional constraints and model selection. */
export interface UserSubagent {
  name: string;
  description: string;
  /** Full system prompt body (everything after closing --- of frontmatter). */
  prompt: string;
  /**
   * Optional allowlist of specific binaries the subagent's terminal tool may run.
   * If undefined, all binaries are permitted (same as the parent agent).
   */
  allowedBinaries?: string[];
  /** Model override. Falls back to parent's model. */
  model?: string;
  /**
   * If true, this agent is a team member rather than a solo subagent.
   * Team agents are spawned together via spawn_team and coordinate via a shared task list.
   */
  team?: boolean;
}

/**
 * Expand a raw tools list from AGENT.md frontmatter into a flat binary allowlist.
 * Entries that match a SKILLS category name are expanded to that category's cmds.
 * All other entries are kept as-is (treated as literal binary names).
 *
 * e.g. ["EXPLORE", "READ", "jq"] → ["ls","tree","fd","rg","find","stat","du","file","cat",…,"jq"]
 */
export function expandToolsToAllowlist(raw: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const token of raw) {
    const upper = token.toUpperCase() as keyof typeof SKILLS;
    const category = SKILLS[upper];
    const binaries: readonly string[] = category ? category.cmds : [token];
    for (const b of binaries) {
      if (!seen.has(b)) { seen.add(b); result.push(b); }
    }
  }
  return result;
}

const USER_SUBAGENTS_DIR  = path.join(process.env.HOME ?? "~", ".agents", "subagents");
const LOCAL_SUBAGENTS_DIR = path.join(process.cwd(), ".agents", "subagents");

/**
 * Parse AGENT.md frontmatter fields: name, description, tools (array), model.
 * `tools` becomes `allowedBinaries` — a per-binary allowlist for the terminal tool.
 */
function parseSubagentFrontmatter(
  raw: string,
): { name: string; description: string; prompt: string; allowedBinaries?: string[]; model?: string; team?: boolean } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const fm   = match[1] ?? "";
  const body = (match[2] ?? "").trim();

  let name        = "";
  let description = "";
  let model: string | undefined;
  let team: boolean | undefined;
  let allowedBinaries: string[] | undefined;
  let inDesc  = false;
  let inTools = false;
  const descLines:  string[]   = [];
  const toolsItems: string[]   = [];

  for (const line of fm.split("\n")) {
    // --- tools list (YAML sequence) ---
    if (inTools) {
      const item = line.match(/^\s+-\s+(.+)/);
      if (item) { toolsItems.push(item[1]!.trim()); continue; }
      inTools = false; // non-list line ends the block
    }
    // --- description block scalar ---
    if (inDesc) {
      if (/^\S/.test(line)) { inDesc = false; }
      else { descLines.push(line.trim()); continue; }
    }

    const nameM = line.match(/^name:\s*(.+)/);
    if (nameM) { name = nameM[1]!.trim(); continue; }

    const modelM = line.match(/^model:\s*(.+)/);
    if (modelM) { model = modelM[1]!.trim(); continue; }

    const teamM = line.match(/^team:\s*(true|false)/i);
    if (teamM) { team = teamM[1]!.toLowerCase() === "true"; continue; }

    const toolsM = line.match(/^tools:\s*(.*)/);
    if (toolsM) {
      const inline = toolsM[1]!.trim();
      if (inline.startsWith("[")) {
        // inline array: tools: [EXPLORE, READ, jq]
        const raw = inline.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
        allowedBinaries = expandToolsToAllowlist(raw);
      } else {
        inTools = true; // block sequence follows
      }
      continue;
    }

    const descM = line.match(/^description:\s*(>-?|[^>].*)?/);
    if (descM) {
      const inline = (descM[1] ?? "").trim();
      if (inline && !inline.startsWith(">")) { description = inline; }
      else { inDesc = true; }
      continue;
    }
  }

  if (inDesc || descLines.length)  description     = descLines.join(" ").trim();
  if (inTools || toolsItems.length) allowedBinaries = expandToolsToAllowlist(toolsItems);
  if (!name) return null;
  return { name, description, prompt: body, allowedBinaries, model, team };
}

/**
 * Load subagents from both the user-global dir and the local project dir.
 * Project-local subagents (.agents/subagents/) take priority over user-global ones
 * when names collide (project wins — same convention as skills).
 */
export function loadUserSubagents(): UserSubagent[] {
  const map = new Map<string, UserSubagent>();

  for (const dir of [USER_SUBAGENTS_DIR, LOCAL_SUBAGENTS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mdPath = path.join(dir, entry.name, "AGENT.md");
      if (!fs.existsSync(mdPath)) continue;
      try {
        const raw    = fs.readFileSync(mdPath, "utf8");
        const parsed = parseSubagentFrontmatter(raw);
        if (parsed) map.set(parsed.name, parsed); // later (local) wins
      } catch { /* skip unreadable */ }
    }
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse YAML-ish frontmatter (name/description only — no full YAML parser needed). */
function parseFrontmatter(raw: string): { name: string; description: string; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const fm = match[1] ?? "";
  const body = (match[2] ?? "").trim();

  // description may be a YAML block scalar ("> \n  text text\n  text")
  let name = "";
  let description = "";
  let inDesc = false;
  const descLines: string[] = [];

  for (const line of fm.split("\n")) {
    if (!inDesc) {
      const nameM = line.match(/^name:\s*(.+)/);
      if (nameM) { name = nameM[1]!.trim(); continue; }
      const descM = line.match(/^description:\s*(>-?|[^>].*)?/);
      if (descM) {
        const inline = (descM[1] ?? "").trim();
        if (inline && !inline.startsWith(">")) {
          description = inline;
        } else {
          inDesc = true;
        }
        continue;
      }
    } else {
      if (/^\S/.test(line)) { inDesc = false; }  // new top-level key ends block scalar
      else { descLines.push(line.trim()); }
    }
  }

  if (inDesc || descLines.length) description = descLines.join(" ").trim();
  if (!name) return null;
  return { name, description, body };
}

/** Load all skills from SKILLS_DIR. Returns empty array if dir doesn't exist. */
export function loadUserSkills(): UserSkill[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const skills: UserSkill[] = [];
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mdPath = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(mdPath)) continue;
    try {
      const raw = fs.readFileSync(mdPath, "utf8");
      const parsed = parseFrontmatter(raw);
      if (parsed) skills.push(parsed);
    } catch { /* skip unreadable files */ }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// --- Skill Dictionary (informational — shown to the model, not used for allow/deny) ---
/** Constant mapping of predefined tool categories to their commands and descriptions. */
export const SKILLS = {
  EXPLORE: { cmds: ["ls", "tree", "fd", "rg", "find", "stat", "du", "file"], desc: "Map and search files" },
  READ:    { cmds: ["cat", "pdftotext", "ffprobe", "sed", "head", "wc", "grep", "diff", "awk"], desc: "Read surgical slices of data" },
  WRITE:   { cmds: ["patch", "tee", "touch", "mkdir", "cp", "mv", "rm", "bun", "node", "python", "python3"], desc: "Modify files / run scripts" },
  NET:     { cmds: ["curl", "wget"], desc: "Network requests (require approval)" },
  DATA:    { cmds: ["jq", "duckdb", "sqlite3"], desc: "Process structured data" },
} as const;

// --- State persistence ---
const STATE_FILE = "./agent_state.json";
/** Load persisted agent state from disk, falling back to defaults if unavailable. */

export function loadState(): AgentState {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as AgentState;
    } catch {
      /* corrupted file, use defaults */
    }
  }
  return { autonomous_mode: true };
/** Persist the current agent state to disk for later retrieval. */
}

export function saveState(state: AgentState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Commands that always require explicit user approval
const ALWAYS_APPROVE: ReadonlySet<string> = new Set<string>(["rm", "curl", "wget"]);

// Commands that need network access (run with --share-net instead of --unshare-net)
const NEEDS_NET: ReadonlySet<string> = new Set<string>(["curl", "wget"]);

// --- bwrap sandbox ---

/**
 * Build the bwrap argv for a sandboxed execution.
 * - CWD is bind-mounted read-write; nothing outside it is writable.
 * - /usr /lib /lib64 /etc /bin are read-only (binaries + dynamic linker).
 * - /tmp is writable (many tools need it).
 * - /home /root /mnt /media are absent.
 * - Network is unshared by default; pass shareNet=true for curl/wget.
 */
function bwrapArgs(cwd: string, shareNet: boolean): string[] {
  const args = [
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind", "/etc", "/etc",
    "--bind", "/tmp", "/tmp",
    "--proc", "/proc",
    "--dev", "/dev",
    "--bind", cwd, cwd,
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
  ];
  if (!shareNet) args.push("--unshare-net");
  return args;
}

// --- Secure Executor ---

/** Extract all bare path-like tokens from a command (skip flags). */
function extractPaths(command: string): string[] {
  return command
    .split(/\s+/)
    .filter((t) => (t.startsWith("/") || t.startsWith("./") || t.startsWith("../")) && !t.startsWith("-"));
}

/** Return an error string if any explicit path in the command escapes base, else null. */
function checkCwdEscape(command: string, base: string): string | null {
  for (const token of extractPaths(command)) {
    const resolved = path.resolve(base, token);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      return `Path escape detected — '${token}' resolves outside working directory.`;
    }
  }
  return null;
}

/** Execute a command in a sandboxed environment with optional approval gating and path validation. */
export async function executeSecurely(
  command: string,
  approve: ApproveFn,
  workdir?: string,
): Promise<string> {
  const cwd = path.resolve(workdir ?? process.cwd());
  const binary = command.trim().split(/\s+/)[0] ?? "";

  // CWD escape check — give early feedback before spawning bwrap
  const escapeErr = checkCwdEscape(command, cwd);

  // cat size guard (skip when piped)
  if (binary === "cat" && !command.includes("|")) {
    const args = command.split(/\s+/).filter((t) => !t.startsWith("-") && t !== "cat");
    const file = args[0] ?? "";
    if (file) {
      try {
        const count = parseInt(execSync(`wc -l < "${file}"`, { cwd, encoding: "utf8" }));
        if (!isNaN(count) && count > 100)
          return `Error: File too large (${count} lines). Use 'sed -n' or 'head' to slice it.`;
      } catch {
        return `Error: Could not read file '${file}'`;
      }
    }
  }

  // Approval gate: rm always; curl/wget always; anything else only on path escape
  if (ALWAYS_APPROVE.has(binary) || escapeErr !== null) {
    const suffix = escapeErr ? ` [WARNING: ${escapeErr}]` : "";
    const ok = await approve(`APPROVE [${command}]?${suffix} (y/n)`);
    if (!ok) return "Error: User denied permission.";
  }

  const shareNet = NEEDS_NET.has(binary);
  const sandboxArgs = bwrapArgs(cwd, shareNet);
  // Pass command directly as sh -c argument via spawnSync (no outer shell quoting),
  // so heredoc newlines and other shell syntax reach sh -c unmangled.
  const bwrapArgsFull = [...sandboxArgs, "sh", "-c", command];

  try {
    const result = spawnSync("bwrap", bwrapArgsFull, { cwd, encoding: "utf8", timeout: 30000 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").trim();
      const stdout = (result.stdout ?? "").trim();
      return `Error: ${stderr || stdout || `exit code ${result.status}`}`;
    }
    return (result.stdout ?? "").trim() || "Success.";
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return `Error: ${err.stderr ?? err.message ?? "unknown error"}`;
  }
}

// --- Teammate tool factory ---

/**
 * Extra tools injected only into teammate agents (not the main agent).
 * Provides task-list coordination: read, claim, complete, and peer messaging.
 */
function buildTeammateTools(
  teammateName: string,
  taskList: TaskList,
  mailbox: Map<string, string[]>, // simple in-memory message bus keyed by recipient name
) {
  return {
    read_task_list: tool({
      description:
        "Read the shared team task list to see what tasks are pending, claimed, or done. " +
        "Call this at the start of your work and whenever you need to decide what to do next.",
      inputSchema: z.object({}),
      execute: async (): Promise<string> => taskList.summary() || "(task list is empty)",
    }),
    claim_task: tool({
      description:
        "Atomically claim a pending task so no other teammate picks it up. " +
        "Returns 'claimed' on success or an error if the task is already taken.",
      inputSchema: z.object({
        id: z.string().describe("Task ID exactly as shown in the task list."),
      }),
      execute: async ({ id }: { id: string }): Promise<string> => {
        const ok = taskList.claim(id, teammateName);
        return ok ? `Claimed task '${id}'.` : `Error: task '${id}' is not available (already claimed or done).`;
      },
    }),
    complete_task: tool({
      description: "Mark a task as done and record a brief result summary.",
      inputSchema: z.object({
        id:     z.string().describe("Task ID."),
        result: z.string().describe("Brief summary of what was done / output produced."),
        failed: z.boolean().optional().describe("Set true if the task could not be completed."),
      }),
      execute: async ({ id, result, failed }: { id: string; result: string; failed?: boolean }): Promise<string> => {
        taskList.complete(id, result, failed ?? false);
        return `Task '${id}' marked ${failed ? "failed" : "done"}.`;
      },
    }),
    message_teammate: tool({
      description:
        "Send a short message to another teammate. " +
        "Use to share intermediate findings or coordinate on overlapping tasks.",
      inputSchema: z.object({
        to:      z.string().describe("Recipient teammate name."),
        message: z.string().describe("The message (keep it concise)."),
      }),
      execute: async ({ to, message }: { to: string; message: string }): Promise<string> => {
        const inbox = mailbox.get(to) ?? [];
        inbox.push(`[${teammateName}]: ${message}`);
        mailbox.set(to, inbox);
        return `Message sent to '${to}'.`;
      },
    }),
    read_messages: tool({
      description: "Read messages sent to you by other teammates.",
      inputSchema: z.object({}),
      execute: async (): Promise<string> => {
        const msgs = mailbox.get(teammateName) ?? [];
        if (msgs.length === 0) return "(no messages)";
        mailbox.set(teammateName, []); // drain on read
        return msgs.join("\n");
      },
    }),
  };
}

/**
 * Run a single teammate inside a team session.
 * Returns the teammate's final text output.
 */
async function runTeammate(
  teammate: UserSubagent,
  taskList: TaskList,
  mailbox: Map<string, string[]>,
  state: AgentState,
  approve: ApproveFn,
  userSkills: UserSkill[],
  parentModelStr: string | undefined,
  log: LogFn | undefined,
): Promise<string> {
  const tmLog: LogFn | undefined = log
    ? (msg, kind, _src) => log(msg, kind, teammate.name)
    : undefined;

  const baseTools    = buildTools(state, approve, userSkills, [], tmLog, teammate.model ?? parentModelStr, teammate.allowedBinaries);
  const teamTools    = buildTeammateTools(teammate.name, taskList, mailbox);
  const allTools     = { ...baseTools, ...teamTools };

  const initialPrompt =
    `You are '${teammate.name}', a member of an agent team.\n` +
    `Use read_task_list to see available tasks, claim_task to take one, ` +
    `terminal to do the work, and complete_task when done. ` +
    `Repeat until all tasks you can handle are done, then stop.\n\n` +
    `Team context: ${taskList.summary()}`;

  const result = streamText({
    model:    resolveModel(teammate.model ?? parentModelStr),
    stopWhen: stepCountIs(80),
    system:   teammate.prompt || "You are a specialised team member. Claim tasks, complete them, and report results.",
    tools:    allTools,
    prompt:   initialPrompt,
  });

  let fullText = "";
  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case "reasoning-delta": tmLog?.(chunk.text, "reasoning"); break;
      case "text-delta":
        fullText += chunk.text;
        tmLog?.(chunk.text, "text");
        break;
      case "tool-call":
        tmLog?.(
          formatToolCall(chunk.toolName, chunk.input as Record<string, unknown>),
          "tool-call",
          undefined,
          formatToolDetail(chunk.toolName, chunk.input as Record<string, unknown>),
        );
        break;
      case "tool-result":
        tmLog?.(formatToolResult(String(chunk.output)), "tool-result", undefined, String(chunk.output));
        break;
      case "error":
        tmLog?.(`Error: ${String(chunk.error)}`, "error");
        break;
    }
  }
  return fullText;
}

// --- Tool factory ---
export function buildTools(
  state: AgentState,
  approve: ApproveFn,
  userSkills: UserSkill[],
/** Construct the tool set available to an agent, incorporating user skills and subagent definitions. */
  userSubagents: UserSubagent[] = [],
  log?: LogFn,
  parentModelStr?: string,
  allowedBinaries?: string[],
) {
  const skillMap    = new Map(userSkills.map((s) => [s.name, s]));
  const subagentMap = new Map(userSubagents.map((a) => [a.name, a]));

  /** Wrap executeSecurely with an optional per-binary allowlist. */
  const execTool = async (command: string, workdir?: string): Promise<string> => {
    if (allowedBinaries) {
      const binary = command.trim().split(/\s+/)[0] ?? "";
      if (!allowedBinaries.includes(binary)) {
        return `Error: This subagent is restricted to [${allowedBinaries.join(", ")}]. Command '${binary}' is not permitted.`;
      }
    }
    return executeSecurely(command, approve, workdir);
  };

  return {
    terminal: tool({
      description:
        "Execute an authorized CLI command. Use workdir to operate in a subdirectory — " +
        "all paths are resolved relative to workdir and must stay inside it." +
        (allowedBinaries ? ` Permitted binaries: ${allowedBinaries.join(", ")}.` : ""),
      inputSchema: z.object({
        command: z.string().describe("The shell command to run."),
        workdir: z
          .string()
          .optional()
          .describe("Working directory relative to the project root. Defaults to project root."),
      }),
      execute: async ({ command, workdir }: { command: string; workdir?: string }) =>
        execTool(command, workdir),
    }),
    load_skill: tool({
      description:
        "Load the full instructions for a skill by name. " +
        "Call this when the user asks you to use a skill, or when the task matches a skill's description. " +
        "The returned instructions should guide your subsequent responses.",
      inputSchema: z.object({
        name: z.string().describe("The skill name, exactly as listed in the Available Skills section."),
      }),
      execute: async ({ name }: { name: string }) => {
        const skill = skillMap.get(name);
        if (!skill) return `Error: skill '${name}' not found. Use one of: ${[...skillMap.keys()].join(", ")}`;
        return `# Skill: ${skill.name}\n\n${skill.body}`;
      },
    }),
    remember_preference: tool({
      description: "Update your long-term memory/preferences.",
      inputSchema: z.object({ key: z.string(), value: z.unknown() }),
      execute: async ({ key, value }: { key: string; value: unknown }) => {
        state[key] = value;
        saveState(state);
        return `I will remember that ${key} is now ${value}.`;
      },
    }),
    tldr: tool({
      description:
        "Look up a concise usage reference (examples + flags) for a command-line tool. " +
        "Call this before using an unfamiliar tool or when you are unsure of the correct flags.",
      inputSchema: z.object({
        command: z.string().describe("The command name to look up, e.g. 'patch', 'jq', 'ffprobe'."),
      }),
      execute: async ({ command }: { command: string }): Promise<string> => {
        const safe = command.trim().split(/\s+/)[0] ?? "";
        try {
          const proc = Bun.spawn(["tldr", "--quiet", safe], { stdout: "pipe", stderr: "pipe" });
          const chunks: Uint8Array[] = [];
          await proc.stdout.pipeTo(new WritableStream({ write(chunk) { chunks.push(chunk); } }));
          const text = Buffer.concat(chunks).toString("utf8").trim();
          if (text.length === 0) return `No tldr page found for '${safe}'.`;
          return text;
        } catch {
          return `tldr is not installed or failed for '${safe}'.`;
        }
      },
    }),
    spawn_subagent: tool({
      description:
        "Delegate a self-contained task to a specialised subagent. " +
        "The subagent runs in its own isolated context and returns only its final summary. " +
        "Use this when a side task would flood your context with details you won't reference again. " +
        "Available subagents are listed in the ## Available subagents section of your system prompt.",
      inputSchema: z.object({
        name: z.string().describe("Subagent name, exactly as listed in Available subagents."),
        task: z.string().describe("Clear description of the task for the subagent to perform."),
      }),
      execute: async ({ name, task }: { name: string; task: string }): Promise<string> => {
        const subagent = subagentMap.get(name);
        if (!subagent) {
          return `Error: subagent '${name}' not found. Available: ${[...subagentMap.keys()].join(", ")}`;
        }

        log?.(`  ↳ spawning subagent '${name}'`, "tool-call");

        // Wrap parent log to tag every line with this subagent's name as source.
        const subLog: LogFn | undefined = log
          ? (msg, kind, _src) => log(msg, kind, name)
          : undefined;

        // Build a subagent-scoped tool set: inherits skills + state, but uses
        // the subagent's own allowedBinaries restriction and model.
        const subTools = buildTools(
          state,
          approve,
          userSkills,
          [], // subagents cannot recursively spawn subagents
          subLog,
          subagent.model ?? parentModelStr,
          subagent.allowedBinaries,
        );

        const subResult = streamText({
          model: resolveModel(subagent.model ?? parentModelStr),
          stopWhen: stepCountIs(50),
          system: subagent.prompt || "You are a specialised subagent. Complete the assigned task and return a concise summary.",
          tools: subTools,
          prompt: task,
        });

        let fullText = "";
        for await (const chunk of subResult.fullStream) {
          switch (chunk.type) {
            case "reasoning-delta": subLog?.(chunk.text, "reasoning"); break;
            case "text-delta":
              fullText += chunk.text;
              subLog?.(chunk.text, "text");
              break;
            case "tool-call":
              subLog?.(
                formatToolCall(chunk.toolName, chunk.input as Record<string, unknown>),
                "tool-call",
                undefined,
                formatToolDetail(chunk.toolName, chunk.input as Record<string, unknown>),
              );
              break;
            case "tool-result":
              subLog?.(formatToolResult(String(chunk.output)), "tool-result", undefined, String(chunk.output));
              break;
            case "error":
              subLog?.(`Error: ${String(chunk.error)}`, "error");
              break;
          }
        }

        log?.(`  ↳ subagent '${name}' done`, "tool-result");
        return fullText || "(subagent returned no output)";
      },
    }),
    spawn_team: tool({
      description:
        "Spawn a team of specialised agents that work in parallel on a shared task list. " +
        "Use this for large tasks that can be decomposed into independent work items. " +
        "You define the tasks; the team claims and executes them concurrently. " +
        "Available team agents are listed in the ## Agent teams section of your system prompt.",
      inputSchema: z.object({
        teammates: z
          .array(z.string())
          .describe("Names of team agents to spawn, exactly as listed in Available teams."),
        tasks: z
          .array(
            z.object({
              id:          z.string().describe("Short unique task ID, e.g. 'task-1'."),
              description: z.string().describe("Clear description of what needs to be done."),
              assignee:    z.string().optional().describe("Pre-assign to a specific teammate name, or omit to let anyone claim it."),
            }),
          )
          .describe("Task list. Teammates will claim and execute these concurrently."),
      }),
      execute: async ({
        teammates: teammateNames,
        tasks: rawTasks,
      }: {
        teammates: string[];
        tasks: { id: string; description: string; assignee?: string }[];
      }): Promise<string> => {
        // Resolve teammate definitions
        const resolved = teammateNames
          .map((n) => subagentMap.get(n))
          .filter((a): a is UserSubagent => !!a && (a.team === true));

        if (resolved.length === 0) {
          return `Error: none of [${teammateNames.join(", ")}] are known team agents.`;
        }

        // Set up shared task list in a temp dir scoped to this run
        const runId   = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const runDir  = path.join("/tmp", `agent-team-${runId}`);
        const tl      = new TaskList(runDir);
        tl.init(rawTasks);

        // In-memory mailbox — map from teammate name → queued messages
        const mailbox = new Map<string, string[]>();

        log?.(`  ↳ spawning team [${resolved.map((a) => a.name).join(", ")}] with ${rawTasks.length} task(s)`, "tool-call");

        // Run all teammates concurrently
        const results = await Promise.allSettled(
          resolved.map((tm) =>
            runTeammate(tm, tl, mailbox, state, approve, userSkills, parentModelStr, log),
          ),
        );

        // Collect outcomes
        const summary = [
          "## Team task results",
          tl.summary(),
          "",
          "## Teammate outputs",
          ...results.map((r, i) => {
            const name = resolved[i]!.name;
            return r.status === "fulfilled"
              ? `### ${name}\n${r.value}`
              : `### ${name}\nError: ${String(r.reason)}`;
          }),
        ].join("\n");

        log?.(`  ↳ team done`, "tool-result");
        return summary;
      },
    }),
  };
}

// --- System prompt ---
function buildSystemPrompt(
  state: AgentState,
  userSkills: UserSkill[],
  preloadedSkills: UserSkill[] = [],
  userSubagents: UserSubagent[] = [],
): string {
  const cmdLines = Object.entries(SKILLS)
    .map(([name, s]) => `  ${name} [${s.cmds.join(", ")}]: ${s.desc}`)
    .join("\n");

  const preloadedNames = new Set(preloadedSkills.map((s) => s.name));
  const skillIndex = userSkills.length
    ? userSkills
        .map((s) => `  ${s.name}${preloadedNames.has(s.name) ? " (loaded)" : ""}: ${s.description}`)
        .join("\n")
    : "  (none)";

  const preloadedBlocks = preloadedSkills.length
    ? "\n\n## Active skills\n" +
      preloadedSkills.map((s) => `### ${s.name}\n${s.body}`).join("\n\n")
    : "";

  const soloAgents = userSubagents.filter((a) => !a.team);
  const teamAgents = userSubagents.filter((a) => a.team);

  const fmtAgent = (a: UserSubagent) => {
    const restriction = a.allowedBinaries ? ` [tools: ${a.allowedBinaries.join(", ")}]` : "";
    const modelNote   = a.model ? ` [model: ${a.model}]` : "";
    return `  ${a.name}${restriction}${modelNote}: ${a.description}`;
  };

  const subagentIndex = soloAgents.length ? soloAgents.map(fmtAgent).join("\n") : "  (none)";
  const teamIndex     = teamAgents.length  ? teamAgents.map(fmtAgent).join("\n") : "  (none)";

  return `\
You are a high-autonomy CLI agent.

## Sandbox
Every command runs inside a bubblewrap (bwrap) OS-level sandbox:
- Your working directory is fully accessible (read + write).
- System binaries (/usr, /lib, /etc) are available read-only.
- /home, /root, /mnt, /media are completely absent — you cannot access them.
- Network is off by default. \`curl\` and \`wget\` re-enable it but require user approval.
- \`rm\` always requires user approval (irreversible).
- You MAY use any binary available on the system — bun, node, python, git, etc.

## Recommended commands
${cmdLines}

## Available skills
Call \`load_skill\` with the skill name to load its full instructions before using it.
${skillIndex}

## Available subagents
Call \`spawn_subagent\` to delegate a self-contained task to a specialised subagent.
The subagent runs in its own isolated context — use it for tasks that would flood your
context with details (search results, large logs, file contents) you won't reference again.
${subagentIndex}

## Agent teams
Call \`spawn_team\` with a list of teammate names and a task list to run work in parallel.
Teammates claim tasks from the shared list, execute them concurrently, and report results.
Use teams when a task can be split into independent work items that benefit from parallelism.
${teamIndex}

## Response style
Respond with the minimum words needed. Drop filler (articles, hedges, pleasantries).
Fragments are fine. Short synonyms preferred. Technical terms exact. Code blocks unchanged.
- Wrong: "Sure! I'd be happy to help. The issue you're experiencing is likely caused by…"
- Right: "Bug in auth middleware. Token expiry check uses '<' not '<='. Fix:"
Longer elaboration increases error rate on clear-cut tasks — stop as soon as the answer is complete.
Exception: multi-step sequences where fragment order risks misread, or safety-critical confirmations.

## Rules
- Prefer structured output: use \`--json\` flags (gh, ffprobe, etc.) and pipe through \`jq\`.
- Never \`cat\` a large file whole. Use \`head\`, \`sed -n 'M,Np'\`, or \`grep\` to slice.
- Use \`rg\` or \`grep\` over \`find | xargs\` for content searches.
- Set \`workdir\` when operating in a subdirectory instead of building long absolute paths.
- Proceed autonomously through as many steps as needed to fully complete the task.
- When done, give a concise summary of what you did and any relevant output.

## File operations

### Reading files
- Never read a whole file blindly. Always slice:
  - Lines N–M: \`sed -n 'N,Mp' file\`
  - First N lines: \`head -n N file\`
  - Search for context: \`rg 'pattern' -n file\`
- For large files, first check size/line count (\`wc -l file\`) then read relevant sections.

### Writing / editing files

**Existing files** — use \`patch\`:
\`\`\`
patch -p0 path/to/file << 'EOF'
--- path/to/file
+++ path/to/file
@@ -N,M +N,M @@
 context line
-old line
+new line
 context line
EOF
\`\`\`
- Use \`-p0\` so the path in the diff header matches the actual path.
- Include 3 lines of context around every change.
- For appends: hunk at end of file (\`@@ -N,0 +N,K @@\` where N is last line).
- Always verify with \`sed -n 'N,Mp' file\` after applying.

**New files** — use \`tee\` (safe with any content, no delimiter conflicts):
\`\`\`
tee path/to/file << 'ENDOFFILE'
file content here
ENDOFFILE
\`\`\`
- Never use \`cat >\` heredoc for new files — content containing \`---\` or \`EOF\` will break it.
- \`tee\` with a unique delimiter (\`ENDOFFILE\`) is always safe.

## Persistent preferences
${JSON.stringify(state, null, 2)}${preloadedBlocks}
`;
}
// --- Log formatters ---

/** Produce a concise one-line description of a tool invocation. */
function formatToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "terminal") {
    const cmd = String(input.command ?? "");
    const wd  = input.workdir ? ` (in ${input.workdir})` : "";
    return `  ▶ ${cmd}${wd}`;
  }
  if (toolName === "remember_preference") {
    return `  ▶ remember: ${input.key} = ${JSON.stringify(input.value)}`;
  }
  // Generic fallback — show key names only, not values
  const keys = Object.keys(input).join(", ");
  return `  ▶ ${toolName}(${keys})`;
}

/** Produce expanded detail for a tool invocation. */
function formatToolDetail(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "terminal") {
    const cmd = String(input.command ?? "");
    const wd = typeof input.workdir === "string" && input.workdir.length > 0
      ? `# workdir: ${input.workdir}\n${cmd}`
      : cmd;
    return wd;
  }

  if (toolName === "remember_preference") {
    return `${String(input.key ?? "key")} = ${JSON.stringify(input.value, null, 2)}`;
  }

  return JSON.stringify(input ?? {}, null, 2);
}

/** Produce a concise one-line summary of a tool result. */
function formatToolResult(output: string): string {
  const firstLine = output.split("\n").find((l) => l.trim()) ?? output;
  const trimmed   = firstLine.trim().slice(0, 120);
  const suffix    = output.trim().length > trimmed.length ? " …" : "";
  return `  ← ${trimmed}${suffix}`;
}

// --- Run agent ---
/** Execute an agent session with the given prompt, state, and configuration. */
export async function runAgent(
  prompt: string,
  state: AgentState,
  approve: ApproveFn,
  log?: LogFn,
  modelStr?: string,
  userSkills: UserSkill[] = [],
  preloadedSkills: UserSkill[] = [],
  userSubagents: UserSubagent[] = [],
): Promise<string> {
  const result = streamText({
    model: resolveModel(modelStr),
    stopWhen: stepCountIs(100),
    system: buildSystemPrompt(state, userSkills, preloadedSkills, userSubagents),
    tools: buildTools(state, approve, userSkills, userSubagents, log, modelStr),
    prompt,
  });

  let fullText = "";
  let reasoningBuf = "";
  let textBuf = "";

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case "reasoning-start":
        reasoningBuf = "";
        break;
      case "reasoning-delta":
        reasoningBuf += chunk.text;
        log?.(chunk.text, "reasoning");
        break;
      case "reasoning-end":
        reasoningBuf = "";
        break;
      case "text-delta":
        textBuf += chunk.text;
        fullText += chunk.text;
        log?.(chunk.text, "text");
        break;
      case "tool-call": {
        // flush any buffered text first
        if (textBuf.trim()) { textBuf = ""; }
        const callSummary = formatToolCall(chunk.toolName, chunk.input as Record<string, unknown>);
        log?.(callSummary, "tool-call", undefined, formatToolDetail(chunk.toolName, chunk.input as Record<string, unknown>));
        break;
      }
      case "tool-result": {
        const resultSummary = formatToolResult(String(chunk.output));
        log?.(resultSummary, "tool-result", undefined, String(chunk.output));
        break;
      }
      case "error":
        log?.(`Error: ${String(chunk.error)}`, "error");
        break;
    }
  }

  return fullText;
}
