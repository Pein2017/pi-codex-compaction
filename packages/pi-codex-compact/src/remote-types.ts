import type { Api, Context, Model, Provider, ProviderHeaders, Usage } from "@earendil-works/pi-ai";
import type { RemoteCompactionProtocol, ResponsesCompactionProfile } from "./model-api.js";
import type { JsonObject } from "./protocol.js";
import type { RequestObservationContext } from "./request-observation.js";

export interface PriorCheckpointPayload {
  marker: string;
  replacementHistory: readonly unknown[];
}

export interface RemoteCompactionRequest {
  provider: Provider;
  model: Model<Api>;
  profile: ResponsesCompactionProfile;
  context: Context;
  protocol: RemoteCompactionProtocol;
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
  signal: AbortSignal;
  priorCheckpoint?: PriorCheckpointPayload;
  requestTimeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  onProviderStreamEvent?: (event: unknown) => void;
  requestObservation?: RequestObservationContext;
  /** Experimental; only the Context Management adapter consumes these fields. */
  preserveCacheAffinity?: boolean;
  sessionId?: string;
}

export interface RemoteCompactionResponse {
  item: JsonObject;
  promptInput: JsonObject[];
  compactedOutput?: JsonObject[];
  replacementHistory?: JsonObject[];
  usage: Usage;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function abortError(): DOMException {
  return new DOMException("Compaction aborted", "AbortError");
}

export function assertPreparedInput(payload: JsonObject): JsonObject[] {
  if (!Array.isArray(payload.input) || !payload.input.every(isJsonObject)) {
    throw new Error("Prepared compaction payload has invalid input items");
  }
  return structuredClone(payload.input);
}
