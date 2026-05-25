import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Account = {
  id: string;
  enabled?: boolean;
  cooldownUntil?: number | null;
  usage?: {
    primaryUsedPercent?: number;
    primaryResetAfterSeconds?: number;
    secondaryUsedPercent?: number;
    secondaryResetAfterSeconds?: number;
    limitReached?: boolean;
    limitReachedType?: string;
    error?: string | null;
  };
  usageError?: string | null;
  usageFetchedAt?: number | null;
  lastRateLimitAt?: number | null;
  lastRateLimitReason?: string;
};

type PoolConfig = {
  activeProvider?: string;
  defaultCooldownMinutes?: number;
  providers?: Record<string, { type?: string; labels?: { primary?: string; secondary?: string }; pinnedAccount?: string; accounts: Account[] }>;
  // Legacy prototype shape:
  accounts?: Account[];
};

function configPath(): string {
  return process.env.PI_POOL_CONFIG || path.join(os.homedir(), ".pi", "account-pool.json");
}
function providerName(): string {
  return process.env.PI_POOL_PROVIDER || "openai-codex";
}
function accountId(): string | undefined {
  return process.env.PI_POOL_ACCOUNT_ID;
}
function readConfig(): PoolConfig | null {
  try { return JSON.parse(fs.readFileSync(configPath(), "utf8")) as PoolConfig; } catch { return null; }
}
function writeConfig(config: PoolConfig) {
  const file = configPath();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function accounts(config: PoolConfig | null): Account[] {
  if (!config) return [];
  return config.providers?.[providerName()]?.accounts || config.accounts || [];
}
function current(config: PoolConfig | null): Account | undefined {
  const id = accountId();
  return id ? accounts(config).find((a) => String(a.id) === String(id)) : undefined;
}
function relSeconds(s?: number): string {
  if (!Number.isFinite(s)) return "-";
  if ((s as number) <= 0) return "now";
  const d = Math.floor((s as number) / 86400);
  const h = Math.floor(((s as number) % 86400) / 3600);
  const m = Math.floor(((s as number) % 3600) / 60);
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}
function labels(config: PoolConfig | null): { primary: string; secondary: string } {
  const provider = config?.providers?.[providerName()];
  if (provider?.labels) return { primary: provider.labels.primary || 'primary', secondary: provider.labels.secondary || 'secondary' };
  if (provider?.type === 'openai-codex' || providerName() === 'openai-codex') return { primary: '5h', secondary: 'weekly' };
  return { primary: 'primary', secondary: 'secondary' };
}
function summary(account: Account | undefined, config: PoolConfig | null = readConfig()): string {
  if (!account) return "pool acct unknown";
  if (account.usageError) return `acct ${account.id} usage error`;
  const u = account.usage;
  if (!u) return `acct ${account.id} usage unknown`;
  if (u.limitReachedType && !Number.isFinite(u.primaryUsedPercent) && !Number.isFinite(u.secondaryUsedPercent)) return `acct ${account.id} limit ${u.limitReachedType}`;
  const l = labels(config);
  const parts = [`acct ${account.id}`];
  if (Number.isFinite(u.primaryUsedPercent)) parts.push(`${l.primary} ${Math.round(u.primaryUsedPercent!)}%/${relSeconds(u.primaryResetAfterSeconds)}`);
  if (Number.isFinite(u.secondaryUsedPercent)) parts.push(`${l.secondary} ${Math.round(u.secondaryUsedPercent!)}%/${relSeconds(u.secondaryResetAfterSeconds)}`);
  return parts.join(" · ");
}
function retryAfterToMs(value: unknown): number | null {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] : String(value);
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const dateMs = Date.parse(raw.trim());
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}
function markCooldown(durationMs: number, reason: string): number | null {
  const config = readConfig();
  const id = accountId();
  if (!config || !id) return null;
  const account = accounts(config).find((a) => String(a.id) === String(id));
  if (!account) return null;
  const until = Date.now() + Math.max(60_000, durationMs);
  account.cooldownUntil = Math.max(account.cooldownUntil || 0, until);
  account.lastRateLimitAt = Date.now();
  account.lastRateLimitReason = reason;
  writeConfig(config);
  return account.cooldownUntil;
}
function textFromMessage(message: any): string {
  const chunks: string[] = [];
  if (message?.errorMessage) chunks.push(String(message.errorMessage));
  for (const block of message?.content || []) if (block?.type === "text" && block.text) chunks.push(String(block.text));
  return chunks.join("\n");
}
function parseCooldownFromText(text: string): number | null {
  if (!/(rate limit|too many requests|usage limit|try again|429)/i.test(text)) return null;
  const patterns: Array<[RegExp, number]> = [
    [/try again in\s+(\d+)\s*seconds?/i, 1000], [/try again in\s+(\d+)\s*minutes?/i, 60_000], [/try again in\s+(\d+)\s*hours?/i, 3_600_000],
    [/in\s+(\d+)\s*seconds?/i, 1000], [/in\s+(\d+)\s*minutes?/i, 60_000], [/in\s+(\d+)\s*hours?/i, 3_600_000],
  ];
  for (const [re, mult] of patterns) { const m = text.match(re); if (m) return Number(m[1]) * mult; }
  return null;
}
function format(ms: number): string { return new Date(ms).toLocaleString(); }

export default function (pi: ExtensionAPI) {
  const updateStatus = (ctx: any) => {
    if (accountId()) { const cfg = readConfig(); ctx.ui.setStatus("pi-pool", summary(current(cfg), cfg)); }
  };

  pi.on("session_start", async (_event, ctx) => updateStatus(ctx));
  pi.on("before_agent_start", async (_event, ctx) => updateStatus(ctx));

  pi.on("after_provider_response", async (event: any, ctx) => {
    if (!accountId() || event.status !== 429) return;
    const cfg = readConfig();
    const fallback = ((cfg?.defaultCooldownMinutes ?? 180) || 180) * 60_000;
    const retryMs = retryAfterToMs(event.headers?.["retry-after"] || event.headers?.["Retry-After"]);
    const until = markCooldown(retryMs ?? fallback, retryMs ? "HTTP 429 retry-after" : "HTTP 429");
    if (until) {
      ctx.ui.setStatus("pi-pool", `acct ${accountId()} cooldown until ${format(until)}`);
      ctx.ui.notify(`pi-pool: account ${accountId()} marked cooling down until ${format(until)}`, "info");
    }
  });

  pi.on("message_end", async (event: any, ctx) => {
    if (!accountId() || event.message?.role !== "assistant") return;
    const parsed = parseCooldownFromText(textFromMessage(event.message));
    if (!parsed) return;
    const until = markCooldown(parsed, "assistant rate-limit message");
    if (until) ctx.ui.notify(`pi-pool: account ${accountId()} marked cooling down until ${format(until)}`, "info");
  });

  pi.registerCommand("pool-status", {
    description: "Show pi-account-pool account status",
    handler: async (_args, ctx) => {
      const config = readConfig();
      if (!config) return ctx.ui.notify(`pi-pool: could not read ${configPath()}`, "error");
      const now = Date.now();
      const lines = accounts(config).map((a) => {
        const state = !a.enabled ? "disabled" : a.cooldownUntil && a.cooldownUntil > now ? `cooldown until ${format(a.cooldownUntil)}` : a.usage?.limitReached ? "limit" : "ready";
        return `${a.id}: ${state} · ${summary(a, config).replace(/^acct [^ ]+ ·?\s*/, "")}`;
      });
      ctx.ui.setWidget("pi-pool-status", lines);
      ctx.ui.notify("pi-pool status shown above editor", "info");
    }
  });

  pi.registerCommand("pool-pin", {
    description: "Pin an account for the next pi-pool launch. Usage: /pool-pin <account-id>",
    handler: async (args, ctx) => {
      const id = args?.trim();
      const config = readConfig();
      const provider = config?.providers?.[providerName()];
      if (!id || !config || !provider) return ctx.ui.notify("Usage: /pool-pin <account-id>", "error");
      const account = provider.accounts.find((a) => String(a.id) === id);
      if (!account) return ctx.ui.notify(`pi-pool: unknown account ${id}`, "error");
      provider.pinnedAccount = id;
      writeConfig(config);
      ctx.ui.notify(`pi-pool: pinned ${providerName()}/${id}. Restart or run pi-pool -c to use it.`, "info");
    }
  });

  pi.registerCommand("pool-unpin", {
    description: "Clear the pinned account for the current provider",
    handler: async (_args, ctx) => {
      const config = readConfig();
      const provider = config?.providers?.[providerName()];
      if (!config || !provider) return ctx.ui.notify("pi-pool: no provider config found", "error");
      delete provider.pinnedAccount;
      writeConfig(config);
      ctx.ui.notify(`pi-pool: cleared pinned account for ${providerName()}`, "info");
    }
  });

  pi.registerCommand("pool-provider", {
    description: "Set active provider for next pi-pool launch. Usage: /pool-provider <provider-name>",
    handler: async (args, ctx) => {
      const name = args?.trim();
      const config = readConfig();
      if (!name || !config?.providers?.[name]) return ctx.ui.notify(`Usage: /pool-provider <${Object.keys(config?.providers || {}).join("|") || "provider"}>`, "error");
      config.activeProvider = name;
      writeConfig(config);
      ctx.ui.notify(`pi-pool: active provider set to ${name}. Restart or run pi-pool -c to use it.`, "info");
    }
  });

  pi.registerCommand("pool-cooldown", {
    description: "Mark current pi-pool account cooling down. Usage: /pool-cooldown [minutes]",
    handler: async (args, ctx) => {
      if (!accountId()) return ctx.ui.notify("pi-pool: not launched through pi-pool", "error");
      const cfg = readConfig();
      const minutes = Number(args?.trim() || cfg?.defaultCooldownMinutes || 180);
      if (!Number.isFinite(minutes) || minutes <= 0) return ctx.ui.notify("Usage: /pool-cooldown [positive minutes]", "error");
      const until = markCooldown(minutes * 60_000, "manual /pool-cooldown");
      if (until) ctx.ui.notify(`pi-pool: account ${accountId()} marked cooling down until ${format(until)}`, "info");
    }
  });
}
