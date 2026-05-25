import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const S = {
  string: (description: string) => ({ type: "string", description }),
  number: (description: string) => ({ type: "number", description }),
  boolean: (description: string) => ({ type: "boolean", description }),
};

const DEFAULT_SESSION = "agent-observer";
const DEFAULT_SCROLLBACK = 100;
const STATE_FILE = path.join(os.homedir(), ".pi", "agent", "state", "zellij-tasks.json");

type TaskStatus = "starting" | "running" | "ready" | "failed" | "exited" | "closed" | "unknown";
type ZellijTask = {
  id: string;
  session?: string;
  pane_id: string;
  name: string;
  cwd: string;
  command: string;
  status: TaskStatus;
  created_at: number;
  updated_at: number;
  last_snapshot?: string;
  last_exit_code?: number | null;
};
type ZellijState = { version: 1; tasks: ZellijTask[] };

const RunParams = {
  type: "object",
  properties: {
    command: S.string("Command to run in the Zellij pane"),
    name: S.string("Human-readable pane name"),
    cwd: S.string("Working directory for the pane"),
    session: S.string("Zellij session name. Defaults to agent-observer"),
    detached: S.boolean("Use/create a detached background session. Default true"),
    direction: S.string("Split direction for attached sessions: right or down. Default right"),
    subscribe: S.boolean("Return subscribe command. Default true"),
  },
  required: ["command"],
  additionalProperties: false,
} as const;

const PaneParams = {
  type: "object",
  properties: {
    pane_id: S.string("Pane ID, eg terminal_1"),
    session: S.string("Zellij session name"),
  },
  required: ["pane_id"],
  additionalProperties: false,
} as const;

const SubscribeParams = {
  type: "object",
  properties: {
    pane_id: S.string("Pane ID, eg terminal_1"),
    session: S.string("Zellij session name"),
    scrollback: S.number("Scrollback lines for initial delivery. Default 100"),
    format: S.string("raw or json. Default json"),
    seconds: S.number("Optional max seconds to collect before returning. Default 3"),
  },
  required: ["pane_id"],
  additionalProperties: false,
} as const;

const WaitParams = {
  type: "object",
  properties: {
    pane_id: S.string("Pane ID, eg terminal_1"),
    session: S.string("Zellij session name"),
    pattern: S.string("Regex pattern to wait for in pane output"),
    timeout_seconds: S.number("Max seconds to wait. Default 60"),
    fail_pattern: S.string("Optional regex that fails early if seen"),
  },
  required: ["pane_id", "pattern"],
  additionalProperties: false,
} as const;

const ListParams = {
  type: "object",
  properties: {
    session: S.string("Zellij session name"),
  },
  required: [],
  additionalProperties: false,
} as const;

const TasksParams = {
  type: "object",
  properties: {
    refresh: S.boolean("Refresh statuses from Zellij before returning. Default true"),
  },
  required: [],
  additionalProperties: false,
} as const;


function readState(): ZellijState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { version: 1, tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch {
    return { version: 1, tasks: [] };
  }
}

function writeState(state: ZellijState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

function upsertTask(patch: Partial<ZellijTask> & { pane_id: string }): ZellijTask {
  const state = readState();
  const now = Date.now();
  const existing = state.tasks.find((t) => t.pane_id === patch.pane_id && (patch.session === undefined || t.session === patch.session));
  const task: ZellijTask = existing
    ? { ...existing, ...patch, updated_at: now }
    : {
        id: `zt_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        session: patch.session,
        pane_id: patch.pane_id,
        name: patch.name || patch.pane_id,
        cwd: patch.cwd || "",
        command: patch.command || "",
        status: patch.status || "running",
        created_at: now,
        updated_at: now,
        last_exit_code: null,
      };
  if (existing) state.tasks[state.tasks.indexOf(existing)] = task;
  else state.tasks.unshift(task);
  state.tasks = state.tasks.slice(0, 50);
  writeState(state);
  return task;
}

function statusIcon(status: TaskStatus): string {
  return ({ starting: "⏳", running: "▶", ready: "✅", failed: "❌", exited: "■", closed: "×", unknown: "?" } as Record<TaskStatus, string>)[status] || "?";
}

function renderTaskLines(): string[] {
  const tasks = readState().tasks;
  const active = tasks.filter((t) => !["closed", "exited", "failed"].includes(t.status));
  if (tasks.length === 0) return [];
  const counts = tasks.reduce<Record<string, number>>((acc, t) => ((acc[t.status] = (acc[t.status] || 0) + 1), acc), {});
  const summary = `🧩 zellij ${active.length} active / ${tasks.length} tracked` +
    Object.entries(counts).map(([k, v]) => ` · ${k}:${v}`).join("");
  const recent = tasks.slice(0, 3).map((t) => `${statusIcon(t.status)} ${t.name} ${t.session ? `${t.session}:` : ""}${t.pane_id}`);
  return [summary, ...recent];
}

function updateWidget(ctx: any) {
  if (!ctx?.hasUI) return;
  const lines = renderTaskLines();
  ctx.ui.setWidget("zellij-tasks", lines.length ? lines : undefined);
}

function q(s: string): string {
  return JSON.stringify(s);
}

function sessionArgs(session?: string): string[] {
  return session ? ["--session", session] : [];
}

async function exec(pi: ExtensionAPI, args: string[], timeout = 30_000) {
  return pi.exec("zellij", args, { timeout });
}

function makeSubscribeCommand(session: string | undefined, paneId: string, scrollback = DEFAULT_SCROLLBACK) {
  const prefix = session ? `zellij --session ${q(session)}` : "zellij";
  return `${prefix} subscribe --pane-id ${q(paneId)} --format json --scrollback ${scrollback}`;
}

function looksLongRunning(command: string): boolean {
  const c = command.trim();
  return [
    /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?dev\b/i,
    /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?start\b/i,
    /\b(next|vite|astro|nuxt|storybook)\s+(dev|--host|start)\b/i,
    /\b(tsc|jest|vitest|pytest|cargo)\b.*\s(-w|--watch|watch)\b/i,
    /\btail\s+-f\b/i,
    /^watch\s+/i,
    /\b(rails\s+s|rails\s+server|python\s+-m\s+http\.server|uvicorn|gunicorn|nodemon)\b/i,
    /\b(docker\s+compose\s+up|docker-compose\s+up)\b/i,
  ].some((r) => r.test(c));
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "zellij_run",
    label: "Zellij Run",
    description: "Run a long-lived or interactive command in a Zellij pane and return its pane ID. Prefer this over bash for dev servers, watchers, REPLs, tail -f, and other long-running commands.",
    parameters: RunParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const session = params.detached === false ? params.session : (params.session || DEFAULT_SESSION);
      const detached = params.detached !== false;
      const name = params.name || "pi-task";
      const direction = params.direction || "right";
      const cwd = params.cwd || ctx.cwd;

      if (detached) {
        await exec(pi, ["attach", "--create-background", session, "options", "--web-sharing", "on", "--web-server", "true"], 20_000);
      }

      const args = [
        ...sessionArgs(session),
        "action", "new-pane",
        "-n", name,
        "--cwd", cwd,
      ];
      if (!detached) args.push("-d", direction);
      args.push("--", "zsh", "-ic", params.command);

      const result = await exec(pi, args, 30_000);
      if (result.code !== 0) {
        return { content: [{ type: "text", text: `Failed to create Zellij pane:\n${result.stderr || result.stdout}` }], isError: true, details: { exitCode: result.code } };
      }
      const paneId = result.stdout.trim().split(/\s+/).find((x) => x.startsWith("terminal_") || x.startsWith("plugin_")) || result.stdout.trim();
      const task = upsertTask({ session, pane_id: paneId, name, cwd, command: params.command, status: "running" });
      updateWidget(ctx);
      const subscribeCommand = makeSubscribeCommand(session, paneId);
      return {
        content: [{ type: "text", text: `Started ${q(params.command)} in ${session}:${paneId}\nMonitor with:\n${subscribeCommand}` }],
        details: { task_id: task.id, session, pane_id: paneId, name, cwd, command: params.command, subscribe_command: subscribeCommand },
      };
    },
  });

  pi.registerTool({
    name: "zellij_subscribe",
    label: "Zellij Subscribe",
    description: "Collect live rendered output from a Zellij pane for a few seconds using zellij subscribe.",
    parameters: SubscribeParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const seconds = params.seconds ?? 3;
      const format = params.format || "json";
      const scrollback = params.scrollback ?? DEFAULT_SCROLLBACK;
      const shell = `${makeSubscribeCommand(params.session, params.pane_id, scrollback).replace("--format json", `--format ${format}`)} & pid=$!; sleep ${seconds}; kill $pid 2>/dev/null; wait $pid 2>/dev/null || true`;
      const result = await pi.exec("bash", ["-lc", shell], { timeout: (seconds + 5) * 1000 });
      upsertTask({ session: params.session, pane_id: params.pane_id, status: result.code === 0 ? "running" : "unknown", last_snapshot: (result.stdout || result.stderr || "").slice(-4000) });
      updateWidget(ctx);
      return { content: [{ type: "text", text: result.stdout || result.stderr || "" }], details: { exitCode: result.code } };
    },
  });

  pi.registerTool({
    name: "zellij_wait",
    label: "Zellij Wait",
    description: "Wait until a regex appears in a Zellij pane's subscribed output; optionally fail early on another regex.",
    parameters: WaitParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const timeout = params.timeout_seconds ?? 60;
      const cmd = `zellij ${params.session ? `--session ${q(params.session)} ` : ""}subscribe --pane-id ${q(params.pane_id)} --format raw --scrollback ${DEFAULT_SCROLLBACK}`;
      const failCheck = params.fail_pattern
        ? `if grep -Eiq -- ${q(params.fail_pattern)} "$out"; then status=2; break; fi`
        : "";
      const script = `
        out=$(mktemp /tmp/pi-zellij-wait.XXXXXX)
        ${cmd} > "$out" 2>&1 & subpid=$!
        status=1
        for _ in $(seq 1 ${Math.max(1, Math.ceil(timeout * 2))}); do
          if grep -Eiq -- ${q(params.pattern)} "$out"; then status=0; break; fi
          ${failCheck}
          sleep 0.5
        done
        kill "$subpid" 2>/dev/null || true
        wait "$subpid" 2>/dev/null || true
        cat "$out"
        rm -f "$out"
        exit "$status"
      `;
      const result = await pi.exec("bash", ["-lc", script], { timeout: (timeout + 5) * 1000 });
      const ok = result.code === 0;
      const failed = result.code === 2;
      upsertTask({ session: params.session, pane_id: params.pane_id, status: ok ? "ready" : failed ? "failed" : "unknown", last_snapshot: (result.stdout || result.stderr || "").slice(-4000) });
      updateWidget(ctx);
      return { content: [{ type: "text", text: ok ? `Matched ${params.pattern}\n${result.stdout}` : `${failed ? "Fail pattern matched" : `Did not match ${params.pattern}`} (exit ${result.code})\n${result.stdout || result.stderr}` }], isError: !ok, details: { exitCode: result.code } };
    },
  });

  pi.registerTool({
    name: "zellij_list",
    label: "Zellij List Panes",
    description: "List Zellij panes as JSON.",
    parameters: ListParams,
    async execute(_id, params) {
      const result = await exec(pi, [...sessionArgs(params.session), "action", "list-panes", "--json", "--all"], 20_000);
      return { content: [{ type: "text", text: result.stdout || result.stderr }], isError: result.code !== 0, details: { exitCode: result.code } };
    },
  });

  pi.registerTool({
    name: "zellij_snapshot",
    label: "Zellij Snapshot",
    description: "Dump the current rendered pane contents, including scrollback.",
    parameters: PaneParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await exec(pi, [...sessionArgs(params.session), "action", "dump-screen", "--pane-id", params.pane_id, "--full"], 20_000);
      upsertTask({ session: params.session, pane_id: params.pane_id, status: result.code === 0 ? "running" : "unknown", last_snapshot: (result.stdout || result.stderr || "").slice(-4000) });
      updateWidget(ctx);
      return { content: [{ type: "text", text: result.stdout || result.stderr }], isError: result.code !== 0, details: { exitCode: result.code } };
    },
  });

  pi.registerTool({
    name: "zellij_close",
    label: "Zellij Close Pane",
    description: "Close a Zellij pane by ID.",
    parameters: PaneParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await exec(pi, [...sessionArgs(params.session), "action", "close-pane", "--pane-id", params.pane_id], 20_000);
      upsertTask({ session: params.session, pane_id: params.pane_id, status: result.code === 0 ? "closed" : "unknown" });
      updateWidget(ctx);
      return { content: [{ type: "text", text: result.code === 0 ? `Closed ${params.pane_id}` : (result.stderr || result.stdout) }], isError: result.code !== 0, details: { exitCode: result.code } };
    },
  });

  pi.registerTool({
    name: "zellij_tasks",
    label: "Zellij Tasks",
    description: "Show Pi-tracked Zellij background tasks and their statuses.",
    parameters: TasksParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      updateWidget(ctx);
      const state = readState();
      const lines = renderTaskLines();
      return {
        content: [{ type: "text", text: lines.length ? lines.join("\n") : "No tracked Zellij tasks." }],
        details: { state_file: STATE_FILE, tasks: state.tasks },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => updateWidget(ctx));
  pi.on("before_agent_start", async (_event, ctx) => updateWidget(ctx));

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command = String((event.input as any).command || "");
    if (looksLongRunning(command)) {
      return {
        block: true,
        reason: `This looks long-running. Use zellij_run instead so Pi can monitor it with zellij_subscribe. Command: ${command}`,
      };
    }
  });
}
