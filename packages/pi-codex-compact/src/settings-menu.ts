import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type MenuDefinition, runMenu } from "@narumitw/pi-tui-kit";
import { resolveCompactionRouteForApi } from "./model-api.js";
import type { CodexCompactSettings, CodexCompactSettingsRuntime, CodexCompactSettingsState } from "./settings.js";
import { terminalText as safeText } from "./terminal.js";

type Screen = "main" | "settings" | "invalid";
type Action =
  | "compact-now"
  | "set-enabled"
  | "set-deferral"
  | "set-protocol"
  | "set-timeout"
  | "set-retries"
  | "set-retention"
  | "set-notify"
  | "set-recovery"
  | "set-request-diagnostics"
  | "set-cache-affinity";

export interface SettingsMenuOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
  isPaused?(): boolean;
  hasCheckpoint?(): boolean;
  canReplayCheckpoint?(): boolean;
}

interface CompactMenuStatus {
  model: string;
  api?: Api;
}

function timeoutLabel(milliseconds: number): string {
  return `${milliseconds / 60_000} min`;
}

function retentionLabel(tokens: number): string {
  return `${tokens / 1000}K tokens`;
}

function protocolLabel(protocol: CodexCompactSettings["protocol"]): string {
  switch (protocol) {
    case "auto":
      return "Auto";
    case "remote-v2":
      return "Remote V2";
    case "responses-compact":
      return "Responses Compact";
    case "context-management":
      return "Context Management (experimental)";
  }
}

async function update(
  runtime: CodexCompactSettingsRuntime,
  ctx: ExtensionCommandContext,
  patch: Partial<CodexCompactSettings>,
  signal: AbortSignal,
) {
  try {
    await runtime.update(patch, signal);
    if (signal.aborted) return { kind: "rejected" as const };
    ctx.ui.notify("Responses compaction settings saved.", "info");
    return { kind: "stay" as const };
  } catch (error) {
    if (signal.aborted) return { kind: "rejected" as const };
    ctx.ui.notify(
      `Could not save pi-codex-compact.json: ${safeText(error instanceof Error ? error.message : String(error))}`,
      "error",
    );
    return { kind: "rejected" as const };
  }
}

export function createCodexCompactMenu(
  runtime: CodexCompactSettingsRuntime,
  options: {
    onCompactRequested?: () => void;
    status?: CompactMenuStatus;
    isPaused?: () => boolean;
    hasCheckpoint?: () => boolean;
    canReplayCheckpoint?: () => boolean;
  } = {},
): MenuDefinition<CodexCompactSettingsState, Screen, Action, ExtensionCommandContext> {
  return {
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Responses Compaction",
        lines: [
          `Remote compaction: ${state.settings.enabled ? "On" : "Off"}`,
          `Protocol setting: ${protocolLabel(state.settings.protocol)}`,
          `Active model: ${safeText(options.status?.model ?? "none")}`,
          `Compact route: ${safeText(compactRoute(state, options.status))}`,
          ...(state.settings.enabled && options.hasCheckpoint?.() && options.canReplayCheckpoint?.() === false
            ? ["Compaction cancels: the active checkpoint cannot replay on this model/route."]
            : []),
          ...(options.isPaused?.()
            ? [
                "Last observed remote operation paused after OAuth rejection; /reload retries it.",
                options.hasCheckpoint?.()
                  ? state.settings.checkpointRecovery === "cancel" || options.canReplayCheckpoint?.() === false
                    ? "Recovery: cancel compaction; preserve checkpoint history."
                    : "Recovery: checkpoint-aware summary; cancel if unsafe or unsuccessful."
                  : "Recovery: Pi native compaction.",
              ]
            : []),
        ],
        items: [
          {
            id: "compact-now",
            label: "Compact now",
            description: "Close this menu and compact the active session immediately.",
            action: "compact-now",
          },
          state.kind === "invalid"
            ? {
                id: "settings",
                label: "Settings",
                description: "Read-only until the invalid settings file is repaired.",
                to: "invalid" as const,
              }
            : { id: "settings", label: "Settings", to: "settings" as const },
          { id: "close", label: "Close", close: true },
        ],
        hint: "close",
      }),
      settings: ({ state }) => ({
        kind: "settings",
        title: "Responses Compaction Settings",
        lines: [`User settings · ${safeText(state.path)}`],
        items: [
          {
            id: "enabled",
            label: "Remote compaction",
            description: "Use a supported Responses compaction protocol.",
            currentValue: state.settings.enabled ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-enabled",
          },
          {
            id: "protocol",
            label: "Protocol",
            description: "Choose a protocol. Experimental Context Management makes a normal inference request.",
            currentValue: protocolLabel(state.settings.protocol),
            values: ["Auto", "Remote V2", "Responses Compact", "Context Management (experimental)"],
            action: "set-protocol",
          },
          {
            id: "deferPostAnswerCompaction",
            label: "Defer post-answer compaction",
            description: "Experimental: compact completed answers before the next model request instead.",
            currentValue: state.settings.deferPostAnswerCompaction ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-deferral",
          },
          {
            id: "checkpointRecovery",
            label: "Checkpoint recovery",
            description:
              "On remote failure: Summarize uses inference quota; failure always cancels. Cancel preserves history without a summary request.",
            currentValue: state.settings.checkpointRecovery === "cancel" ? "Cancel" : "Summarize",
            values: ["Summarize", "Cancel"],
            action: "set-recovery",
          },
          {
            id: "requestTimeoutMs",
            label: "Request timeout",
            description: "Maximum time for the extension-owned remote compaction request.",
            currentValue: timeoutLabel(state.settings.requestTimeoutMs),
            values: ["2 min", "5 min", "10 min"],
            action: "set-timeout",
          },
          {
            id: "maxRetries",
            label: "Transport retries",
            description: "Retry transient provider failures before falling back to Pi.",
            currentValue: String(state.settings.maxRetries),
            values: ["0", "1", "2"],
            action: "set-retries",
          },
          {
            id: "replacementTokenBudget",
            label: "Replacement text budget",
            description: "Approximate user-history budget, or a hard limit for Context Management output.",
            currentValue: retentionLabel(state.settings.replacementTokenBudget),
            values: ["32K tokens", "64K tokens", "96K tokens", "128K tokens"],
            action: "set-retention",
          },
          {
            id: "notifyOnFallback",
            label: "Fallback notifications",
            description: "Warn when remote compaction fails and Pi native takes over.",
            currentValue: state.settings.notifyOnFallback ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-notify",
          },
          {
            id: "preserveCacheAffinity",
            label: "Preserve cache affinity (experimental)",
            description:
              "Context Management only: forward session identity and use provider-default retention. No cache-hit guarantee.",
            currentValue: state.settings.preserveCacheAffinity ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-cache-affinity",
          },
          {
            id: "requestDiagnostics",
            label: "Request diagnostics (experimental)",
            description:
              "Emit bounded Context Management request and raw terminal observations. Trusted listeners can see the request body in memory.",
            currentValue: state.settings.requestDiagnostics ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-request-diagnostics",
          },
        ],
      }),
      invalid: ({ state }) => ({
        kind: "detail",
        title: "Codex Compact Settings · Read only",
        lines: [
          `Invalid settings file: ${safeText(state.path)}`,
          `Issue: ${safeText(state.issue ?? "unknown validation error")}`,
          "Built-in defaults are active. Repair the file and run /reload; it will not be overwritten.",
        ],
        hint: "back",
      }),
    },
    actions: {
      "compact-now": async () => {
        options.onCompactRequested?.();
        return { kind: "close" };
      },
      "set-enabled": ({ ctx, value, signal }) => update(runtime, ctx, { enabled: value === "On" }, signal),
      "set-deferral": ({ ctx, value, signal }) =>
        update(runtime, ctx, { deferPostAnswerCompaction: value === "On" }, signal),
      "set-protocol": ({ ctx, value, signal }) =>
        update(
          runtime,
          ctx,
          {
            protocol:
              value === "Context Management (experimental)"
                ? "context-management"
                : value === "Remote V2"
                  ? "remote-v2"
                  : value === "Responses Compact"
                    ? "responses-compact"
                    : "auto",
          },
          signal,
        ),
      "set-recovery": ({ ctx, value, signal }) =>
        update(runtime, ctx, { checkpointRecovery: value === "Cancel" ? "cancel" : "summarize" }, signal),
      "set-timeout": ({ ctx, value, signal }) =>
        update(runtime, ctx, { requestTimeoutMs: Number.parseInt(value ?? "5", 10) * 60_000 }, signal),
      "set-retries": ({ ctx, value, signal }) =>
        update(runtime, ctx, { maxRetries: Number.parseInt(value ?? "2", 10) }, signal),
      "set-retention": ({ ctx, value, signal }) =>
        update(runtime, ctx, { replacementTokenBudget: Number.parseInt(value ?? "64", 10) * 1000 }, signal),
      "set-notify": ({ ctx, value, signal }) => update(runtime, ctx, { notifyOnFallback: value === "On" }, signal),
      "set-cache-affinity": ({ ctx, value, signal }) =>
        update(runtime, ctx, { preserveCacheAffinity: value === "On" }, signal),
      "set-request-diagnostics": ({ ctx, value, signal }) =>
        update(runtime, ctx, { requestDiagnostics: value === "On" }, signal),
    },
  };
}

export async function showCodexCompactMenu(
  runtime: CodexCompactSettingsRuntime,
  ctx: ExtensionCommandContext,
  owner: SettingsMenuOwner,
): Promise<void> {
  if (ctx.mode === "rpc" && ctx.hasUI) {
    ctx.ui.notify(`Edit Responses compaction settings at ${safeText(runtime.get().path)}.`, "info");
    return;
  }
  if (ctx.mode !== "tui") {
    throw new Error("/codex-compact requires TUI or RPC UI support");
  }
  if (owner.signal.aborted || !owner.isCurrent()) return;
  let compactRequested = false;
  await runMenu(
    ctx,
    createCodexCompactMenu(runtime, {
      onCompactRequested: () => {
        compactRequested = true;
      },
      status: {
        get model() {
          return compactMenuStatus(ctx).model;
        },
        get api() {
          return ctx.model?.api;
        },
      },
      isPaused: owner.isPaused,
      hasCheckpoint: owner.hasCheckpoint,
      canReplayCheckpoint: owner.canReplayCheckpoint,
    }),
    {
      getState: () => runtime.get(),
      signal: owner.signal,
      isCurrent: owner.isCurrent,
    },
  );
  if (!compactRequested || owner.signal.aborted || !owner.isCurrent()) return;
  ctx.compact({
    onError: (error) => {
      if (!owner.signal.aborted && owner.isCurrent()) {
        ctx.ui.notify(`Compaction failed: ${safeText(error.message)}`, "error");
      }
    },
  });
}

export function compactMenuStatus(ctx: ExtensionCommandContext): CompactMenuStatus {
  const model = ctx.model;
  return {
    model: model ? `${model.provider}/${model.id}` : "none",
    api: model?.api,
  };
}

function compactRoute(state: Readonly<CodexCompactSettingsState>, status: CompactMenuStatus | undefined): string {
  const route = resolveCompactionRouteForApi(status?.api, state.settings);
  if (route.kind === "native") return `Pi native (${route.reason})`;
  return route.protocol === "context-management"
    ? "Responses Context Management (experimental)"
    : route.protocol === "remote-v2"
      ? "Responses Remote V2"
      : "Responses Compact API";
}
