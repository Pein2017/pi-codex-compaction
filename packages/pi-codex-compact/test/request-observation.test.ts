import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { parseCheckpointDetails } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import {
  captureRequestObservationTerminal,
  captureRequestObservationUsage,
  createRequestObservationSession,
  emptyRequestObservationUsage,
  MAX_REQUEST_OBSERVATION_BODY_BYTES,
  REQUEST_OBSERVATION_EVENT,
  REQUEST_OBSERVATION_UNOBSERVED_REASONS,
  type RequestObservationContext,
  type RequestObservationEvent,
} from "../src/request-observation.js";
import {
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";

const secretHeader = "LOOPBACK_PRIVATE_HEADER_SENTINEL";
const privatePrompt = "PRIVATE_INPUT_SENTINEL";
const sdkProviderSpecifier =
  process.env.COMPACT_TEST_OPENAI_PROVIDER_MODULE ?? "@earendil-works/pi-ai/providers/openai";

function observationContext(
  overrides: Partial<RequestObservationContext> = {},
  emit: (event: RequestObservationEvent) => void = () => {},
): RequestObservationContext {
  return {
    sessionId: "observation-session",
    provider: "openai",
    api: "openai-responses",
    model: "gpt-fixture",
    httpFinalEligible: true,
    canCorrelateFetch: true,
    emit,
    ...overrides,
  };
}

test("raw terminal usage preserves cached-token absence, zero, value, and invalid states", () => {
  assert.deepEqual(captureRequestObservationUsage({ input_tokens: 10, output_tokens: 2 }), {
    cachedTokensState: "absent",
    inputTokens: 10,
    outputTokens: 2,
  });
  assert.deepEqual(
    captureRequestObservationUsage({
      input_tokens: 10,
      output_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
    }),
    { cachedTokensState: "zero", cachedTokens: 0, inputTokens: 10, outputTokens: 2 },
  );
  assert.deepEqual(captureRequestObservationUsage({ input_tokens_details: { cached_tokens: 7 }, output_tokens: -1 }), {
    cachedTokensState: "value",
    cachedTokens: 7,
  });
  for (const cachedTokens of [null, "0", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      captureRequestObservationUsage({ input_tokens_details: { cached_tokens: cachedTokens } }).cachedTokensState,
      "invalid",
    );
  }
  const inheritedDetails = Object.create({ cached_tokens: 0 }) as Record<string, unknown>;
  assert.equal(captureRequestObservationUsage({ input_tokens_details: inheritedDetails }).cachedTokensState, "absent");
});

test("terminal observations detach only allowlisted provider fields", () => {
  const raw = {
    type: "response.completed",
    response: {
      id: "resp_fixture-01",
      status: "completed",
      usage: { input_tokens: 20, output_tokens: 3, input_tokens_details: { cached_tokens: 0, raw: secretHeader } },
      rawProviderObject: secretHeader,
    },
  };
  const terminal = captureRequestObservationTerminal(raw);
  assert.deepEqual(terminal, {
    status: "completed",
    responseId: "resp_fixture-01",
    usage: { cachedTokensState: "zero", cachedTokens: 0, inputTokens: 20, outputTokens: 3 },
  });
  assert.ok(terminal);
  assert.ok(Object.isFrozen(terminal.usage));
  raw.response.usage.input_tokens = 99;
  assert.equal(terminal.usage.inputTokens, 20);
  assert.doesNotMatch(JSON.stringify(terminal), /LOOPBACK_PRIVATE_HEADER_SENTINEL|rawProviderObject/);
});

test("request observation bounds bodies and fails closed after session replacement", () => {
  const events: RequestObservationEvent[] = [];
  let current = true;
  const observation = createRequestObservationSession(
    observationContext({ isCurrent: () => current }, (event) => events.push(event)),
  );
  const firstAttempt = observation.dispatch({ body: "not a string" });
  const largeUtf8Body = "é".repeat(MAX_REQUEST_OBSERVATION_BODY_BYTES / 2 + 1);
  observation.dispatch(largeUtf8Body);
  current = false;
  observation.terminal({ status: "error", usage: emptyRequestObservationUsage() });
  current = true;
  assert.equal(observation.dispatch("late body"), "unknown");
  observation.dispose();
  assert.notEqual(firstAttempt, "unknown");
  assert.deepEqual(
    events.map((event) => (event.phase === "unobserved" ? event.reason : event.phase)),
    ["body-unmaterialized", "body-oversized"],
  );
  assert.ok(events.every((event) => Object.isFrozen(event)));
  assert.doesNotMatch(JSON.stringify(events), /é{20}/u);

  const failures: RequestObservationEvent[] = [];
  let throwOnce = true;
  const failing = createRequestObservationSession(
    observationContext({}, (event) => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("PRIVATE_OBSERVATION_FAILURE_SENTINEL");
      }
      failures.push(event);
    }),
  );
  failing.dispatch("{}");
  failing.dispose();
  assert.deepEqual(
    failures.map((event) => (event.phase === "unobserved" ? event.reason : event.phase)),
    ["observation-failed"],
  );
  assert.doesNotMatch(JSON.stringify(failures), /PRIVATE_OBSERVATION_FAILURE_SENTINEL/);
});

test("missing HTTP fetch emits canonical unobserved reasons and unknown attribution", () => {
  assert.deepEqual(REQUEST_OBSERVATION_UNOBSERVED_REASONS, [
    "unsupported-adapter",
    "custom-fetch",
    "transport-unobserved",
    "body-unmaterialized",
    "body-oversized",
    "observation-failed",
    "attribution-unknown",
  ]);
  const events: RequestObservationEvent[] = [];
  const observation = createRequestObservationSession(observationContext({}, (event) => events.push(event)));
  observation.noHttpDispatch();
  observation.terminal({ status: "error", usage: emptyRequestObservationUsage() });
  observation.dispose();
  assert.deepEqual(
    events.map((event) => event.phase),
    ["unobserved", "unobserved", "terminal"],
  );
  assert.equal(events[0]?.phase === "unobserved" ? events[0].reason : undefined, "transport-unobserved");
  assert.equal(events[1]?.phase === "unobserved" ? events[1].reason : undefined, "attribution-unknown");
  assert.equal(events[0]?.attemptId, "unknown");
  assert.equal(events[2]?.attemptId, "unknown");

  const unsupported: RequestObservationEvent[] = [];
  const unsupportedAdapter = createRequestObservationSession(
    observationContext({ httpFinalEligible: false }, (event) => unsupported.push(event)),
  );
  unsupportedAdapter.noHttpDispatch();
  unsupportedAdapter.dispose();
  assert.equal(unsupported[0]?.phase === "unobserved" ? unsupported[0].reason : undefined, "unsupported-adapter");
});

const assistantUsage = {
  input: 20,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 21,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function branchEntries(api: string, provider: string, modelId: string): SessionEntry[] {
  return [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: privatePrompt }], timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant",
      parentId: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ready" }],
        api,
        provider,
        model: modelId,
        usage: assistantUsage,
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ] as SessionEntry[];
}

function compactEvent(entries: SessionEntry[]): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "assistant",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 123,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    },
    branchEntries: entries,
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

function memorySettingsRuntime(requestDiagnostics: boolean): CodexCompactSettingsRuntime {
  let state: CodexCompactSettingsState = {
    kind: "loaded",
    path: "/tmp/pi-codex-compact-request-observation.json",
    settings: {
      ...DEFAULT_CODEX_COMPACT_SETTINGS,
      protocol: "context-management",
      requestDiagnostics,
    },
    document: {},
  };
  return {
    get: () => structuredClone(state),
    async reload() {
      return structuredClone(state);
    },
    async update(patch) {
      state = { ...state, settings: { ...state.settings, ...patch } };
      return structuredClone(state);
    },
    async flush() {},
  };
}

interface CompactResult {
  compaction: { details: unknown; usage: unknown; firstKeptEntryId: string; tokensBefore: number };
}

async function createLoopbackHarness(options: {
  usage: Array<{ input_tokens: number; output_tokens: number; total_tokens: number; input_tokens_details?: unknown }>;
  fetch?: typeof globalThis.fetch;
  requestDiagnostics?: boolean;
}) {
  const requestBodies: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requestBodies.push(Buffer.concat(chunks).toString("utf8"));
      const requestIndex = requestBodies.length - 1;
      const checkpoint = {
        type: "compaction",
        id: `cmp_loopback_${requestIndex}`,
        encrypted_content: `opaque_loopback_${requestIndex}`,
      };
      const terminal = {
        id: `resp_loopback_${requestIndex}`,
        status: "completed",
        output: [checkpoint],
        usage: options.usage[requestIndex] ?? options.usage.at(-1),
      };
      const events = [
        { type: "response.output_item.done", output_index: 0, item: checkpoint },
        { type: "response.completed", response: terminal },
      ];
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const providerModule = await import(sdkProviderSpecifier);
  const provider: Provider = providerModule.openaiProvider();
  const model: Model<Api> = {
    id: "gpt-loopback-fixture",
    name: "Loopback fixture",
    api: "openai-responses",
    provider: "openai",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  };
  const entries = branchEntries(model.api, model.provider, model.id);
  const sessionManager = {
    getSessionId: () => "loopback-session",
    getSessionName: () => undefined,
    getBranch: () => entries,
    getEntries: () => entries,
  };
  const { ctx } = createMockContext({
    mode: "tui",
    model,
    getSystemPrompt: () => "loopback system",
    sessionManager,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "loopback-test-key",
        headers: { "x-loopback-private": secretHeader },
      }),
      getProvider: () => provider,
    },
  });
  const settingsRuntime = memorySettingsRuntime(options.requestDiagnostics ?? false);
  const mock = createMockPi();
  createCodexCompactExtension({
    settingsRuntime,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })(mock.pi);
  const start = mock.events.get("session_start")?.[0];
  const beforeCompact = mock.events.get("session_before_compact")?.[0];
  assert.ok(start);
  assert.ok(beforeCompact);
  await start({ type: "session_start", reason: "startup" }, ctx);

  return {
    requestBodies,
    mock,
    settingsRuntime,
    async compact() {
      return (await beforeCompact(compactEvent(entries), ctx)) as CompactResult;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test("installed OpenAI adapter loopback ties public observations to the returned checkpoint", async () => {
  const harness = await createLoopbackHarness({
    requestDiagnostics: false,
    usage: [
      { input_tokens: 19, output_tokens: 2, total_tokens: 21 },
      { input_tokens: 20, output_tokens: 2, total_tokens: 22 },
      { input_tokens: 21, output_tokens: 2, total_tokens: 23, input_tokens_details: { cached_tokens: 0 } },
    ],
  });
  const observations: RequestObservationEvent[] = [];
  let mutationRejected = false;
  let throwingListenerCalls = 0;
  harness.mock.eventBus.on(REQUEST_OBSERVATION_EVENT, (value) => {
    const event = value as RequestObservationEvent;
    if (event.phase === "dispatch") {
      throwingListenerCalls += 1;
      const body = event.body;
      mutationRejected ||=
        Object.isFrozen(event) && !Reflect.set(event, "body", "listener-mutation") && event.body === body;
      throw new Error("PRIVATE_LISTENER_ERROR_SENTINEL");
    }
  });
  harness.mock.eventBus.on(REQUEST_OBSERVATION_EVENT, (value) => observations.push(value as RequestObservationEvent));

  try {
    const defaultOffResult = await harness.compact();
    assert.ok(parseCheckpointDetails(defaultOffResult.compaction.details));
    assert.equal(observations.length, 0);
    assert.equal(harness.requestBodies.length, 1);

    await harness.settingsRuntime.update({ requestDiagnostics: true });
    const first = await harness.compact();
    const second = await harness.compact();
    const firstDetails = parseCheckpointDetails(first.compaction.details);
    const secondDetails = parseCheckpointDetails(second.compaction.details);
    assert.ok(firstDetails);
    assert.ok(secondDetails);
    assert.deepEqual(firstDetails.replacementHistory, [
      { type: "compaction", id: "cmp_loopback_1", encrypted_content: "opaque_loopback_1" },
    ]);
    assert.deepEqual(secondDetails.replacementHistory, [
      { type: "compaction", id: "cmp_loopback_2", encrypted_content: "opaque_loopback_2" },
    ]);

    const dispatches = observations.filter((event) => event.phase === "dispatch");
    const terminals = observations.filter((event) => event.phase === "terminal");
    assert.equal(observations.filter((event) => event.phase === "unobserved").length, 0);
    assert.equal(dispatches.length, 2);
    assert.equal(terminals.length, 2);
    assert.equal(harness.requestBodies.length, 3);
    assert.equal(throwingListenerCalls, 2);
    assert.equal(mutationRejected, true);
    for (let index = 0; index < dispatches.length; index += 1) {
      const dispatch = dispatches[index];
      const terminal = terminals[index];
      assert.ok(dispatch?.phase === "dispatch");
      assert.ok(terminal?.phase === "terminal");
      const requestIndex = index + 1;
      assert.equal(dispatch.version, 1);
      assert.equal(dispatch.kind, "compaction");
      assert.equal(dispatch.sessionId, "loopback-session");
      assert.equal(dispatch.coverage, "http-final");
      assert.equal(dispatch.body, harness.requestBodies[requestIndex]);
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.operationId, dispatch.operationId);
      assert.equal(terminal.attemptId, dispatch.attemptId);
      assert.equal(terminal.responseId, `resp_loopback_${requestIndex}`);
      assert.ok(Object.isFrozen(dispatch));
      assert.ok(Object.isFrozen(terminal));
      assert.ok(Object.isFrozen(terminal.usage));
      assert.deepEqual(JSON.parse(dispatch.body).context_management, [{ type: "compaction", compact_threshold: 1024 }]);
      assert.match(dispatch.body, new RegExp(privatePrompt));
    }
    assert.notEqual(dispatches[0]?.operationId, dispatches[1]?.operationId);
    assert.notEqual(dispatches[0]?.attemptId, dispatches[1]?.attemptId);
    assert.deepEqual((terminals[0] as Extract<RequestObservationEvent, { phase: "terminal" }>).usage, {
      cachedTokensState: "absent",
      inputTokens: 20,
      outputTokens: 2,
    });
    assert.deepEqual((terminals[1] as Extract<RequestObservationEvent, { phase: "terminal" }>).usage, {
      cachedTokensState: "zero",
      cachedTokens: 0,
      inputTokens: 21,
      outputTokens: 2,
    });
    assert.doesNotMatch(
      JSON.stringify(observations),
      /loopback-test-key|LOOPBACK_PRIVATE_HEADER_SENTINEL|PRIVATE_LISTENER_ERROR_SENTINEL/,
    );
  } finally {
    await harness.close();
  }
});

test("a caller-supplied transforming fetch is reported as unknown coverage", async () => {
  let transformedBody: string | undefined;
  const harness = await createLoopbackHarness({
    requestDiagnostics: true,
    usage: [{ input_tokens: 19, output_tokens: 2, total_tokens: 21 }],
    fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      body.caller_transform = "present only after this extension boundary";
      transformedBody = JSON.stringify(body);
      return globalThis.fetch(input, { ...init, body: transformedBody });
    },
  });
  const observations: RequestObservationEvent[] = [];
  harness.mock.eventBus.on(REQUEST_OBSERVATION_EVENT, (value) => observations.push(value as RequestObservationEvent));
  try {
    const result = await harness.compact();
    assert.ok(parseCheckpointDetails(result.compaction.details));
    assert.equal(harness.requestBodies.length, 1);
    const dispatch = observations.find((event) => event.phase === "dispatch");
    const terminal = observations.find((event) => event.phase === "terminal");
    assert.ok(dispatch?.phase === "dispatch");
    assert.ok(terminal?.phase === "terminal");
    assert.equal(dispatch.coverage, "unknown");
    assert.notEqual(dispatch.body, transformedBody);
    assert.equal(harness.requestBodies[0], transformedBody);
    assert.equal(terminal.attemptId, "unknown");
    assert.ok(observations.some((event) => event.phase === "unobserved" && event.reason === "custom-fetch"));
  } finally {
    await harness.close();
  }
});
