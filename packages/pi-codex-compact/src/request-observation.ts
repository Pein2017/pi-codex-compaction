import { randomUUID } from "node:crypto";

export const REQUEST_OBSERVATION_EVENT = "pi:request-observation:v1";
export const MAX_REQUEST_OBSERVATION_BODY_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_LENGTH = 256;

export const REQUEST_OBSERVATION_UNOBSERVED_REASONS = Object.freeze([
  "unsupported-adapter",
  "custom-fetch",
  "transport-unobserved",
  "body-unmaterialized",
  "body-oversized",
  "observation-failed",
  "attribution-unknown",
] as const);
export type RequestObservationUnobservedReason = (typeof REQUEST_OBSERVATION_UNOBSERVED_REASONS)[number];

export function isBuiltInResponsesHttpRoute(provider: string, api: string): boolean {
  return (
    (provider === "openai" && api === "openai-responses") ||
    (provider === "openai-codex" && api === "openai-codex-responses") ||
    (provider === "azure-openai-responses" && api === "azure-openai-responses")
  );
}

export type RequestObservationUsage = Readonly<{
  cachedTokensState: "absent" | "zero" | "value" | "invalid";
  cachedTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}>;

interface RequestObservationIdentity {
  version: 1;
  sessionId: string;
  operationId: string;
  attemptId: string;
  provider: string;
  api: string;
  model: string;
  kind: "compaction";
}

export type RequestObservationEvent =
  | (RequestObservationIdentity & {
      phase: "dispatch";
      coverage: "http-final" | "unknown";
      body: string;
    })
  | (RequestObservationIdentity & {
      phase: "terminal";
      status: "completed" | "error" | "aborted";
      usage: RequestObservationUsage;
      responseId?: string;
    })
  | (RequestObservationIdentity & {
      phase: "unobserved";
      reason: RequestObservationUnobservedReason;
    });

export interface RequestObservationContext {
  sessionId: string;
  provider: string;
  api: string;
  model: string;
  /** True only when this path reaches a qualified built-in HTTP Responses adapter without a supplied fetch. */
  httpFinalEligible: boolean;
  /** False when a caller-supplied fetch may transform or fan out a local fetch invocation. */
  canCorrelateFetch: boolean;
  isCurrent?: () => boolean;
  emit(event: RequestObservationEvent): void;
}

export interface RequestObservationSession {
  readonly operationId: string;
  dispatch(body: unknown): string;
  markResponse(attemptId: string, successful: boolean): void;
  terminal(event: {
    status: "completed" | "error" | "aborted";
    usage: RequestObservationUsage;
    responseId?: string;
  }): void;
  noHttpDispatch(): void;
  dispose(): void;
}

function metadata(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strip controls from public metadata.
  const bounded = value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, MAX_METADATA_LENGTH);
  return bounded || "unknown";
}

function identity(context: RequestObservationContext, operationId: string, attemptId: string) {
  return {
    version: 1 as const,
    sessionId: metadata(context.sessionId),
    operationId,
    attemptId,
    provider: metadata(context.provider),
    api: metadata(context.api),
    model: metadata(context.model),
    kind: "compaction" as const,
  };
}

function publishUsage(value: RequestObservationUsage): RequestObservationUsage {
  return Object.freeze({
    cachedTokensState: value.cachedTokensState,
    ...(value.cachedTokens === undefined ? {} : { cachedTokens: value.cachedTokens }),
    ...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens }),
    ...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }),
  });
}

export function emptyRequestObservationUsage(): RequestObservationUsage {
  return Object.freeze({ cachedTokensState: "absent" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown> | undefined, key: string): { present: boolean; value?: unknown } {
  if (!record) return { present: false };
  try {
    if (!Object.hasOwn(record, key)) return { present: false };
    return { present: true, value: record[key] };
  } catch {
    return { present: true };
  }
}

function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Copies only raw Responses usage counters, retaining cached_tokens field presence. */
export function captureRequestObservationUsage(rawUsage: unknown): RequestObservationUsage {
  try {
    const usage = isRecord(rawUsage) ? rawUsage : undefined;
    const detailsValue = ownValue(usage, "input_tokens_details");
    const details = isRecord(detailsValue.value) ? detailsValue.value : undefined;
    const cached = ownValue(details, "cached_tokens");
    const cachedTokensState: RequestObservationUsage["cachedTokensState"] = !cached.present
      ? "absent"
      : !validTokenCount(cached.value)
        ? "invalid"
        : cached.value === 0
          ? "zero"
          : "value";
    const input = ownValue(usage, "input_tokens");
    const output = ownValue(usage, "output_tokens");
    const cachedTokens = cachedTokensState === "zero" || cachedTokensState === "value" ? cached.value : undefined;
    return publishUsage({
      cachedTokensState,
      ...(typeof cachedTokens === "number" ? { cachedTokens } : {}),
      ...(input.present && validTokenCount(input.value) ? { inputTokens: input.value } : {}),
      ...(output.present && validTokenCount(output.value) ? { outputTokens: output.value } : {}),
    });
  } catch {
    return emptyRequestObservationUsage();
  }
}

function safeResponseId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_METADATA_LENGTH) return undefined;
  return /^[A-Za-z0-9_-]+$/u.test(value) ? value : undefined;
}

/** Extracts detached terminal metadata without sharing or mutating a provider event. */
export function captureRequestObservationTerminal(
  rawEvent: unknown,
): { status: "completed" | "error"; usage: RequestObservationUsage; responseId?: string } | undefined {
  try {
    if (!isRecord(rawEvent)) return undefined;
    const eventType = rawEvent.type;
    if (typeof eventType !== "string") return undefined;
    if (
      eventType !== "response.completed" &&
      eventType !== "response.done" &&
      eventType !== "response.failed" &&
      eventType !== "response.incomplete" &&
      eventType !== "error"
    ) {
      return undefined;
    }
    const response = isRecord(rawEvent.response) ? rawEvent.response : undefined;
    const status =
      (eventType === "response.completed" || eventType === "response.done") && response?.status === "completed"
        ? "completed"
        : "error";
    const responseId = safeResponseId(ownValue(response, "id").value);
    return {
      status,
      usage: captureRequestObservationUsage(ownValue(response, "usage").value),
      ...(responseId === undefined ? {} : { responseId }),
    };
  } catch {
    return undefined;
  }
}

export function createRequestObservationSession(context: RequestObservationContext): RequestObservationSession {
  const operationId = randomUUID();
  let closed = false;
  let terminalSent = false;
  let noHttpDispatchSent = false;
  let attemptCount = 0;
  let onlyAttemptId: string | undefined;
  let successfulAttemptCount = 0;
  let onlySuccessfulAttemptId: string | undefined;

  const isOpen = (): boolean => {
    if (closed) return false;
    if (!context.isCurrent) return true;
    try {
      if (context.isCurrent()) return true;
    } catch {
      // An observation guard is fail-closed and never reports its error.
    }
    closed = true;
    return false;
  };

  const emit = (event: RequestObservationEvent): boolean => {
    if (!isOpen()) return false;
    try {
      context.emit(Object.freeze(event));
      return true;
    } catch {
      // An optional observer must never affect dispatch, retry, cancellation, or checkpoint publication.
      return false;
    }
  };
  const reportUnobserved = (attemptId: string, reason: RequestObservationUnobservedReason): void => {
    const eventIdentity = identity(context, operationId, attemptId);
    if (!emit({ ...eventIdentity, phase: "unobserved", reason })) {
      emit({ ...eventIdentity, phase: "unobserved", reason: "observation-failed" });
    }
  };

  return {
    operationId,
    dispatch(body) {
      if (closed || terminalSent) return "unknown";
      const attemptId = randomUUID();
      onlyAttemptId = attemptCount === 0 ? attemptId : undefined;
      attemptCount = Math.min(2, attemptCount + 1);
      const eventIdentity = identity(context, operationId, attemptId);
      if (typeof body !== "string") {
        reportUnobserved(attemptId, "body-unmaterialized");
        return attemptId;
      }
      const bodyBytes =
        body.length > MAX_REQUEST_OBSERVATION_BODY_BYTES
          ? MAX_REQUEST_OBSERVATION_BODY_BYTES + 1
          : Buffer.byteLength(body, "utf8");
      if (bodyBytes > MAX_REQUEST_OBSERVATION_BODY_BYTES) {
        reportUnobserved(attemptId, "body-oversized");
        return attemptId;
      }
      if (!context.canCorrelateFetch) reportUnobserved(attemptId, "custom-fetch");
      const dispatched = emit({
        ...eventIdentity,
        phase: "dispatch",
        coverage: context.httpFinalEligible ? "http-final" : "unknown",
        body,
      });
      if (!dispatched) reportUnobserved(attemptId, "observation-failed");
      return attemptId;
    },
    markResponse(attemptId, successful) {
      if (closed || terminalSent || !successful) return;
      onlySuccessfulAttemptId = successfulAttemptCount === 0 ? attemptId : undefined;
      successfulAttemptCount = Math.min(2, successfulAttemptCount + 1);
    },
    terminal(event) {
      if (closed || terminalSent) return;
      terminalSent = true;
      const attemptId = !context.canCorrelateFetch
        ? "unknown"
        : successfulAttemptCount === 1
          ? (onlySuccessfulAttemptId ?? "unknown")
          : attemptCount === 1
            ? (onlyAttemptId ?? "unknown")
            : "unknown";
      const responseId = safeResponseId(event.responseId);
      if (attemptId === "unknown") reportUnobserved(attemptId, "attribution-unknown");
      const published = emit({
        ...identity(context, operationId, attemptId),
        phase: "terminal",
        status: event.status,
        usage: publishUsage(event.usage),
        ...(responseId === undefined ? {} : { responseId }),
      });
      if (!published) reportUnobserved(attemptId, "observation-failed");
    },
    noHttpDispatch() {
      if (closed || terminalSent || noHttpDispatchSent || attemptCount !== 0) return;
      noHttpDispatchSent = true;
      const reason = !context.canCorrelateFetch
        ? "custom-fetch"
        : context.httpFinalEligible
          ? "transport-unobserved"
          : "unsupported-adapter";
      reportUnobserved("unknown", reason);
    },
    dispose() {
      closed = true;
    },
  };
}
