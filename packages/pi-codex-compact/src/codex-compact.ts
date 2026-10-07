import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  buildSessionProjection,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { preserveAffinityContext } from "./cache-affinity.js";
import {
  buildReplacementHistory,
  type CodexCheckpointDetails,
  checkpointMarker,
  createCheckpointDetails,
  fallbackSummary,
  fingerprintMessage,
  hasActiveCheckpointClaim,
  latestCheckpoint,
  projectCheckpointContext,
  REPLACEMENT_BYTE_BUDGET,
} from "./checkpoint.js";
import { recoverCheckpoint, summaryPrefix } from "./checkpoint-recovery.js";
import {
  compactionFailureDetail,
  compactionFailureMessage,
  inspectFailureResponse,
  isOAuthOperationRejection,
  observeSseRejections,
  streamOperationRejection,
} from "./compaction-failure.js";
import { validateContextManagementHistory } from "./context-management.js";
import { type CompactionRoute, resolveCompactionRoute } from "./model-api.js";
import { hasCheckpointMarker, rewriteCheckpointMarker } from "./protocol.js";
import { RejectedRoutes, rejectionRouteKey } from "./rejection-state.js";
import { requestRemoteCompaction } from "./remote.js";
import {
  isBuiltInResponsesHttpRoute,
  REQUEST_OBSERVATION_EVENT,
  type RequestObservationContext,
} from "./request-observation.js";
import {
  type CodexCompactSettings,
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  createCodexCompactSettingsRuntime,
} from "./settings.js";
import {
  createTaskContinuationItem,
  shouldContinueTask,
  shouldDeferThresholdCompaction,
  validateStoredContextManagementHistory,
} from "./task-continuation.js";
import { terminalText } from "./terminal.js";

const STATUS_KEY = "codex-compact";

function activeCheckpoint(ctx: ExtensionContext) {
  return latestCheckpoint(ctx.sessionManager.getBranch());
}

function isCheckpointCompatible(
  details: CodexCheckpointDetails,
  model: Model<Api> | undefined,
  settings: CodexCompactSettings,
): boolean {
  const route = resolveCompactionRoute(model, settings);
  return (
    route.kind === "remote" &&
    model !== undefined &&
    route.api === details.api &&
    route.profile === details.profile &&
    model.id === details.modelId
  );
}

function keptMessages(event: SessionBeforeCompactEvent): AgentMessage[] {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const contextEntries = buildSessionProjection(event.branchEntries, leafId).entries;
  const keptIndex = contextEntries.findIndex((entry) => entry.sourceEntry.id === event.preparation.firstKeptEntryId);
  if (keptIndex < 0) {
    throw new Error("Pi compaction cut point is not present in the active context");
  }
  // Pi owns system declarations and can move/replace them when preparing the
  // next prompt. Only retained conversation messages belong to replay matching.
  return contextEntries
    .slice(keptIndex)
    .flatMap((entry) => entry.messages)
    .filter((message) => message.role !== "system");
}

function activeTools(pi: ExtensionAPI): Tool[] {
  const available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  return pi.getActiveTools().flatMap((name) => {
    const tool = available.get(name);
    return tool
      ? [
          {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        ]
      : [];
  });
}

function projectedCurrentMessages(
  event: SessionBeforeCompactEvent,
  model: Model<Api>,
  route: Extract<CompactionRoute, { kind: "remote" }>,
): { messages: AgentMessage[]; prior?: CodexCheckpointDetails } {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const session = buildSessionContext(event.branchEntries, leafId);
  const prior = latestCheckpoint(event.branchEntries);
  if (!prior) return { messages: session.messages };
  if (
    prior.details.api !== route.api ||
    prior.details.profile !== route.profile ||
    prior.details.modelId !== model.id
  ) {
    throw new Error("The active opaque checkpoint belongs to a different Responses model");
  }
  const projected = projectCheckpointContext(session.messages, prior.details, prior.entry.summary, event.branchEntries);
  if (!projected) {
    throw new Error("The previous opaque checkpoint could not be projected safely");
  }
  return { messages: projected, prior: prior.details };
}

function notifyFailure(
  ctx: ExtensionContext,
  error: unknown,
  settings: CodexCompactSettings,
  requestValues: readonly string[],
  checkpointPresent = false,
  routePaused = true,
): void {
  if (!ctx.hasUI || !settings.notifyOnFallback) return;
  const diagnosis = compactionFailureMessage(error, requestValues);
  const message = routePaused
    ? diagnosis
    : diagnosis.replace(
        "This route is paused for this session; /reload retries it. ",
        "This failure did not pause the route. ",
      );
  ctx.ui.notify(
    checkpointPresent
      ? message.replace(
          "Responses compaction failed; using Pi compaction. ",
          "Responses compaction failed; applying checkpoint recovery (summary or safe cancellation). ",
        )
      : message,
    "warning",
  );
}

function sessionStillOwned(ctx: ExtensionContext, sessionId: string, signal: AbortSignal): boolean {
  return !signal.aborted && ctx.sessionManager.getSessionId() === sessionId;
}

async function compactRemotely(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  settings: CodexCompactSettings,
  ownerSignal: AbortSignal,
  rejected: RejectedRoutes,
  isCurrent: () => boolean,
  ownsStatus: () => boolean,
  fetch?: typeof globalThis.fetch,
) {
  const model = ctx.model;
  const route = resolveCompactionRoute(model, settings);
  const signal = AbortSignal.any([event.signal, ownerSignal]);
  if (signal.aborted) return { cancel: true };
  if (route.kind === "native" || !model)
    return settings.enabled && hasActiveCheckpointClaim(ctx.sessionManager.getBranch()) ? { cancel: true } : undefined;
  const publicRouteKey = rejectionRouteKey(model, route);
  let routeKey = publicRouteKey;
  let endpointObserved = false;
  let paused = false;
  const sessionId = ctx.sessionManager.getSessionId();
  const checkpoint = latestCheckpoint(event.branchEntries);
  const checkpointPresent = hasActiveCheckpointClaim(event.branchEntries);
  const leafId = event.branchEntries.at(-1)?.id;
  const stillCurrent = () =>
    sessionStillOwned(ctx, sessionId, signal) && isCurrent() && ctx.sessionManager.getBranch().at(-1)?.id === leafId;
  let requestValues: string[] = [];
  let remoteAttempted = false;
  let rejectionError: Error | undefined;
  const remoteController = new AbortController();
  const remoteSignal = AbortSignal.any([signal, remoteController.signal]);
  const recordRejection = (error: Error) => {
    if (!remoteAttempted || !stillCurrent() || rejectionError) return;
    rejectionError = error;
    rejected.add(routeKey);
    rejected.observe(publicRouteKey, routeKey);
    // Stream callbacks can run inside a TransformStream; abort after that callback
    // unwinds to avoid reentrant stream teardown. This controller owns only this task.
    queueMicrotask(() => remoteController.abort());
  };
  ctx.ui.setStatus(
    STATUS_KEY,
    route.protocol === "context-management"
      ? "Responses Context Management…"
      : route.protocol === "remote-v2"
        ? "Responses Remote V2…"
        : "Responses Compact API…",
  );
  try {
    if (checkpointPresent && !checkpoint)
      throw new Error("The active opaque checkpoint is invalid or unsupported; history preserved");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!stillCurrent()) return { cancel: true };
    if (!auth.ok) throw new Error(auth.error);
    // Keep resolved request values local and redact them if the provider echoes them in an error.
    requestValues = [auth.apiKey, ...Object.values(auth.headers ?? {}), ...Object.values(auth.env ?? {})].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const provider = ctx.modelRegistry.getProvider(model.provider);
    if (!provider) throw new Error("The active Responses provider is unavailable");
    const current = projectedCurrentMessages(event, model, route);
    const preserveCacheAffinity = settings.preserveCacheAffinity === true && route.protocol === "context-management";
    const preparedContext: Context = {
      systemPrompt: ctx.getSystemPrompt(),
      messages: convertToLlm(current.messages),
      tools: activeTools(pi),
    };
    const context = preserveCacheAffinity ? preserveAffinityContext(preparedContext) : preparedContext;
    const requestObservation: RequestObservationContext | undefined =
      settings.requestDiagnostics && route.protocol === "context-management"
        ? {
            sessionId,
            provider: model.provider,
            api: model.api,
            model: model.id,
            httpFinalEligible: fetch === undefined && isBuiltInResponsesHttpRoute(model.provider, model.api),
            canCorrelateFetch: fetch === undefined,
            isCurrent: () =>
              isCurrent() &&
              ctx.sessionManager.getSessionId() === sessionId &&
              ctx.sessionManager.getBranch().at(-1)?.id === leafId,
            emit: (observation) => {
              try {
                pi.events.emit(REQUEST_OBSERVATION_EVENT, observation);
              } catch {
                // The versioned observation bus is optional and never owns compaction behavior.
              }
            },
          }
        : undefined;
    const response = await requestRemoteCompaction({
      provider,
      model,
      context,
      protocol: route.protocol,
      profile: route.profile,
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal: remoteSignal,
      priorCheckpoint: current.prior
        ? {
            marker: checkpointMarker(current.prior.checkpointId),
            replacementHistory: current.prior.replacementHistory,
          }
        : undefined,
      requestTimeoutMs: settings.requestTimeoutMs,
      maxRetries: settings.maxRetries,
      onProviderStreamEvent: (raw) => {
        const error = streamOperationRejection(raw);
        if (error) recordRejection(error);
      },
      ...(requestObservation ? { requestObservation } : {}),
      ...(preserveCacheAffinity ? { preserveCacheAffinity: true, sessionId } : {}),
      fetch: async (input, init) => {
        if (!stillCurrent()) throw new Error("Compaction ownership changed before dispatch");
        const endpoint = input instanceof Request ? input.url : String(input);
        routeKey = rejectionRouteKey(model, route, endpoint);
        endpointObserved = true;
        rejected.observe(publicRouteKey, routeKey);
        paused = rejected.has(routeKey);
        if (paused) {
          // Cancel only the remote subrequest, including adapter-owned retries.
          // Keep the parent compaction signal available for checkpoint recovery.
          remoteController.abort();
          return Response.json(
            { error: { message: "Remote compaction route is paused after an OAuth operation rejection" } },
            { status: 409, headers: { "x-should-retry": "false" } },
          );
        }
        remoteAttempted = true;
        const response = await (fetch ?? globalThis.fetch)(input, init);
        if (!stillCurrent()) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error("Compaction ownership changed after response");
        }
        const signals = [
          remoteSignal,
          ...(init?.signal ? [init.signal] : []),
          ...(input instanceof Request ? [input.signal] : []),
        ];
        const requestSignal = AbortSignal.any(signals);
        const failure = await inspectFailureResponse(response, requestSignal);
        if (!stillCurrent()) {
          void failure.response.body?.cancel().catch(() => undefined);
          throw new Error("Compaction ownership changed during error inspection");
        }
        if (failure.rejection) recordRejection(failure.rejection);
        return route.protocol === "responses-compact"
          ? failure.response
          : observeSseRejections(failure.response, requestSignal, recordRejection);
      },
    });
    if (!stillCurrent()) return { cancel: true };
    let replacementHistory =
      route.protocol === "context-management"
        ? validateContextManagementHistory(response.replacementHistory ?? [], {
            byteBudget: REPLACEMENT_BYTE_BUDGET,
            tokenBudget: settings.replacementTokenBudget,
          })
        : buildReplacementHistory(response.compactedOutput?.slice(0, -1) ?? response.promptInput, response.item, {
            tokenBudget: settings.replacementTokenBudget,
          });
    if (route.protocol === "context-management" && shouldContinueTask(event, ctx)) {
      // The host will continue its existing run (or overflow retry). Put task
      // intent after maintenance output; newer user input stays after this item.
      replacementHistory = validateStoredContextManagementHistory(
        [...replacementHistory, createTaskContinuationItem()],
        { byteBudget: REPLACEMENT_BYTE_BUDGET, tokenBudget: settings.replacementTokenBudget },
      );
    }
    const details = createCheckpointDetails({
      provider: model.provider,
      api: route.api,
      profile: route.profile,
      modelId: model.id,
      protocol: route.protocol,
      replacementHistory,
      keptMessages: keptMessages(event),
    });
    return {
      compaction: {
        summary: fallbackSummary(details.checkpointId),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: response.usage,
        details,
      },
    };
  } catch (error) {
    if (!stillCurrent()) return { cancel: true };
    if (remoteAttempted && isOAuthOperationRejection(error))
      recordRejection(error instanceof Error ? error : new Error(String(error)));
    if (!paused || remoteAttempted)
      notifyFailure(ctx, rejectionError ?? error, settings, requestValues, checkpointPresent, rejected.has(routeKey));
    if (!checkpointPresent) return undefined;
    if (!checkpoint) return { cancel: true };
    if (settings.checkpointRecovery === "cancel") return { cancel: true };
    try {
      const current = projectedCurrentMessages(event, model, route);
      if (!current.prior) throw new Error("Checkpoint recovery lost its checkpoint");
      const messages = summaryPrefix(current.messages, keptMessages(event), fingerprintMessage);
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!stillCurrent()) return { cancel: true };
      if (!auth.ok) throw new Error(auth.error);
      requestValues = [
        ...requestValues,
        auth.apiKey,
        ...Object.values(auth.headers ?? {}),
        ...Object.values(auth.env ?? {}),
      ].filter((value): value is string => typeof value === "string" && value.length > 0);
      const provider = ctx.modelRegistry.getProvider(model.provider);
      if (!provider) throw new Error("The active Responses provider is unavailable");
      ctx.ui.setStatus(STATUS_KEY, "Checkpoint recovery summary…");
      const compaction = await recoverCheckpoint(
        {
          provider,
          model,
          context: { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(messages), tools: [] },
          profile: route.profile,
          protocol: route.protocol,
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          signal,
          priorCheckpoint: {
            marker: checkpointMarker(current.prior.checkpointId),
            replacementHistory: current.prior.replacementHistory,
          },
          requestTimeoutMs: settings.requestTimeoutMs,
          maxRetries: settings.maxRetries,
          fetch: async (input, init) => {
            if (!stillCurrent()) throw new Error("Checkpoint recovery ownership changed before dispatch");
            const endpoint = new URL(input instanceof Request ? input.url : String(input));
            // Unary compaction derives /responses/compact from the provider's
            // inference endpoint. Compare that exact public dispatch identity.
            if (route.protocol === "responses-compact") endpoint.pathname += "/compact";
            if (endpointObserved && rejectionRouteKey(model, route, endpoint.toString()) !== routeKey) {
              return Response.json(
                { error: { message: "Checkpoint recovery backend changed before dispatch" } },
                { status: 400, headers: { "x-should-retry": "false" } },
              );
            }
            return (fetch ?? globalThis.fetch)(input, init);
          },
        },
        event,
      );
      if (!stillCurrent()) return { cancel: true };
      return { compaction };
    } catch (recoveryError) {
      if (stillCurrent() && ctx.hasUI && settings.notifyOnFallback) {
        ctx.ui.notify(
          `Checkpoint recovery could not complete; compaction cancelled and history preserved. ${compactionFailureDetail(recoveryError, requestValues)}`,
          "warning",
        );
      }
      return { cancel: true };
    }
  } finally {
    remoteController.abort();
    if (!ownerSignal.aborted && ctx.sessionManager.getSessionId() === sessionId && ownsStatus()) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }
}

export function createCodexCompactExtension(
  options: { fetch?: typeof globalThis.fetch; settingsRuntime?: CodexCompactSettingsRuntime } = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const providerWarnings = new Set<string>();
    const settingsRuntime = options.settingsRuntime ?? createCodexCompactSettingsRuntime();
    type Owner = {
      controller: AbortController;
      rejected: RejectedRoutes;
      sessionId: string;
      operation?: AbortController;
      completedRun?: boolean;
    };
    const owners = new WeakMap<object, Owner>();
    const ownerFor = (ctx: ExtensionContext): Owner => {
      let owner = owners.get(ctx.sessionManager);
      const sessionId = ctx.sessionManager.getSessionId();
      if (owner?.controller.signal.aborted) return owner;
      if (!owner || owner.sessionId !== sessionId) {
        owner?.controller.abort();
        if (owner) ctx.ui.setStatus(STATUS_KEY, undefined);
        owner = { controller: new AbortController(), rejected: new RejectedRoutes(), sessionId };
        owners.set(ctx.sessionManager, owner);
      }
      return owner;
    };

    const cancelOperation = (ctx: ExtensionContext) => {
      const owner = owners.get(ctx.sessionManager);
      const operation = owner?.operation;
      if (!owner || !operation) return;
      operation.abort();
      if (owners.get(ctx.sessionManager) === owner && owner.operation === operation) {
        owner.operation = undefined;
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    };

    pi.registerCommand("codex-compact", {
      description: "Compact now or configure Responses compaction",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /codex-compact");
        const owner = ownerFor(ctx);
        const controller = owner.controller;
        const { showCodexCompactMenu } = await import("./settings-menu.js");
        if (owners.get(ctx.sessionManager) !== owner || controller.signal.aborted) return;
        await showCodexCompactMenu(settingsRuntime, ctx, {
          signal: controller.signal,
          isCurrent: () =>
            owners.get(ctx.sessionManager) === owner &&
            !controller.signal.aborted &&
            ctx.sessionManager.getSessionId() === owner.sessionId,
          isPaused: () => {
            const route = resolveCompactionRoute(ctx.model, settingsRuntime.get().settings);
            return (
              !!ctx.model && route.kind === "remote" && owner.rejected.hasObserved(rejectionRouteKey(ctx.model, route))
            );
          },
          hasCheckpoint: () => hasActiveCheckpointClaim(ctx.sessionManager.getBranch()),
          canReplayCheckpoint: () => {
            const checkpoint = activeCheckpoint(ctx);
            return (
              !!checkpoint && isCheckpointCompatible(checkpoint.details, ctx.model, settingsRuntime.get().settings)
            );
          },
        });
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      owners.get(ctx.sessionManager)?.controller.abort();
      const owner: Owner = {
        controller: new AbortController(),
        rejected: new RejectedRoutes(),
        sessionId: ctx.sessionManager.getSessionId(),
      };
      owners.set(ctx.sessionManager, owner);
      ctx.ui.setStatus(STATUS_KEY, undefined);
      const sessionId = ctx.sessionManager.getSessionId();
      providerWarnings.clear();
      let state: Readonly<CodexCompactSettingsState>;
      try {
        state = await settingsRuntime.reload(owner.controller.signal);
      } catch (error) {
        if (
          owner.controller.signal.aborted ||
          owners.get(ctx.sessionManager) !== owner ||
          ctx.sessionManager.getSessionId() !== sessionId
        )
          return;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Could not load pi-codex-compact.json; using defaults. ${terminalText(error instanceof Error ? error.message : String(error))}`,
            "warning",
          );
        }
        return;
      }
      if (
        owner.controller.signal.aborted ||
        owners.get(ctx.sessionManager) !== owner ||
        ctx.sessionManager.getSessionId() !== sessionId
      ) {
        return;
      }
      if (ctx.hasUI && state.kind === "invalid") {
        ctx.ui.notify(
          `Invalid pi-codex-compact.json; using defaults without overwriting it. ${terminalText(state.issue ?? "unknown validation error")}`,
          "warning",
        );
      }
    });

    pi.on("session_before_compact", (event, ctx) => {
      const settings = settingsRuntime.get().settings;
      const model = ctx.model;
      const route = resolveCompactionRoute(model, settings);
      const owner = ownerFor(ctx);
      if (
        settings.deferPostAnswerCompaction &&
        owner.completedRun &&
        route.kind === "remote" &&
        shouldDeferThresholdCompaction(event, ctx)
      )
        return { cancel: true };
      cancelOperation(ctx);
      const operation = new AbortController();
      owner.operation = operation;
      const key = model && route.kind === "remote" ? rejectionRouteKey(model, route) : undefined;
      const isCurrent = () => {
        if (owners.get(ctx.sessionManager) !== owner || owner.operation !== operation || operation.signal.aborted)
          return false;
        const currentSettings = settingsRuntime.get().settings;
        const currentRoute = resolveCompactionRoute(ctx.model, currentSettings);
        return (
          JSON.stringify(currentSettings) === JSON.stringify(settings) &&
          (key === undefined ||
            (!!ctx.model && currentRoute.kind === "remote" && rejectionRouteKey(ctx.model, currentRoute) === key))
        );
      };
      return compactRemotely(
        pi,
        event,
        ctx,
        settings,
        AbortSignal.any([owner.controller.signal, operation.signal]),
        owner.rejected,
        isCurrent,
        () => owners.get(ctx.sessionManager) === owner && owner.operation === operation,
        options.fetch,
      ).finally(() => {
        if (owner.operation === operation) owner.operation = undefined;
        operation.abort();
      });
    });

    pi.on("agent_end", (event, ctx) => {
      const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
      ownerFor(ctx).completedRun = assistant?.role === "assistant" && assistant.stopReason === "stop";
    });

    pi.on("input", (_event, ctx) => {
      ownerFor(ctx).completedRun = false;
    });

    pi.on("before_agent_start", (_event, ctx) => {
      ownerFor(ctx).completedRun = false;
    });

    pi.on("context", (event, ctx) => {
      if (!settingsRuntime.get().settings.enabled) return undefined;
      const settings = settingsRuntime.get().settings;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model, settings)) return undefined;
      const messages = projectCheckpointContext(
        event.messages,
        checkpoint.details,
        checkpoint.entry.summary,
        ctx.sessionManager.getBranch(),
      );
      return messages ? { messages } : undefined;
    });

    pi.on("before_provider_request", (event, ctx) => {
      if (!settingsRuntime.get().settings.enabled) return undefined;
      const settings = settingsRuntime.get().settings;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || !isCheckpointCompatible(checkpoint.details, ctx.model, settings)) return undefined;
      const marker = checkpointMarker(checkpoint.details.checkpointId);
      if (!hasCheckpointMarker(event.payload, marker)) return undefined;
      return rewriteCheckpointMarker(event.payload, marker, checkpoint.details.replacementHistory);
    });

    pi.on("session_tree", (_event, ctx) => cancelOperation(ctx));

    pi.on("model_select", (event, ctx) => {
      cancelOperation(ctx);
      if (!settingsRuntime.get().settings.enabled) return;
      const settings = settingsRuntime.get().settings;
      const checkpoint = activeCheckpoint(ctx);
      if (!checkpoint || isCheckpointCompatible(checkpoint.details, event.model, settings)) return;
      const key = `${ctx.sessionManager.getSessionId()}:${event.model.provider}:${event.model.id}`;
      if (providerWarnings.has(key)) return;
      providerWarnings.add(key);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "The active Responses checkpoint cannot replay on this model; Pi will expose only its fallback marker and retained recent messages.",
          "warning",
        );
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const owner = owners.get(ctx.sessionManager) ?? ownerFor(ctx);
      owner.controller.abort();
      owner.rejected = new RejectedRoutes();
      owner.operation = undefined;
      // Keep an aborted tombstone until session_start so queued old-context
      // events cannot recreate an active controller after shutdown.
      providerWarnings.clear();
      ctx.ui.setStatus(STATUS_KEY, undefined);
      await settingsRuntime.flush();
    });
  };
}

export default createCodexCompactExtension();
