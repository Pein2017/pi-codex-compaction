import assert from "node:assert/strict";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { createCheckpointDetails, parseCheckpointDetails } from "../src/checkpoint.js";
import { COMPACTION_MAINTENANCE_MESSAGE } from "../src/context-management.js";
import type { RemoteCompactionProtocol } from "../src/model-api.js";
import { MAX_SSE_BYTES } from "../src/protocol.js";
import { requestRemoteCompaction } from "../src/remote.js";
import type { RemoteCompactionRequest } from "../src/remote-types.js";
import type { RequestObservationEvent } from "../src/request-observation.js";
import { normalizeCodexCompactSettings } from "../src/settings.js";

const protocol: RemoteCompactionProtocol = "context-management";
const model: Model<Api> = {
  id: "gpt-5.5",
  name: "GPT-5.5 fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
};
const first = { type: "compaction", id: "cmp_first", encrypted_content: "first-opaque" };
const latest = { type: "compaction", id: "cmp_latest", encrypted_content: "latest-opaque" };
const suffix = {
  type: "message",
  id: "msg_maintenance",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "OK", annotations: [] }],
};
const context = {
  systemPrompt: "original system",
  messages: [{ role: "user" as const, content: "original history", timestamp: 1 }],
  tools: [],
};
async function provider(): Promise<Provider> {
  const specifier = "@earendil-works/pi-ai/providers/openai";
  const module = await import(specifier);
  return module.openaiProvider();
}
function sse(items: unknown[], terminal: Record<string, unknown> = {}): Response {
  const events = [
    ...items.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        output: [],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        ...terminal,
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
async function request(fetch: typeof globalThis.fetch, options: Partial<RemoteCompactionRequest> = {}) {
  return requestRemoteCompaction({
    provider: await provider(),
    model,
    context,
    protocol,
    profile: "openai-responses-v1",
    apiKey: "fixture-key",
    signal: new AbortController().signal,
    maxRetries: 0,
    fetch,
    ...options,
  });
}

test("server compaction is an explicit opt-in setting, not a new auto route", () => {
  assert.equal(normalizeCodexCompactSettings({ protocol })?.protocol, "context-management");
  assert.equal(normalizeCodexCompactSettings({})?.protocol, "auto");
});

test("stream-only checkpoints select the latest event and retain its exact suffix", async () => {
  let payload: Record<string, unknown> | undefined;
  let fetches = 0;
  const original = structuredClone(context);
  const result = await request(async (input, init) => {
    fetches += 1;
    assert.equal(String(input), "https://api.openai.com/v1/responses");
    payload = JSON.parse(String(init?.body));
    assert.deepEqual(payload?.context_management, [{ type: "compaction", compact_threshold: 1024 }]);
    assert.equal(payload?.store, false);
    assert.equal(payload?.stream, true);
    assert.equal(payload?.tool_choice, "none");
    assert.equal(payload?.previous_response_id, undefined);
    assert.doesNotMatch(JSON.stringify(payload), /compaction_trigger/);
    return sse([first, { ...suffix, id: "msg_before_latest" }, latest, suffix]);
  });
  assert.equal(fetches, 1);
  assert.deepEqual(result.item, latest);
  assert.deepEqual((result as { replacementHistory?: unknown[] }).replacementHistory, [latest, suffix]);
  assert.equal(result.usage.totalTokens, 12);
  assert.deepEqual(context, original);
});

for (const include of [
  undefined,
  null,
  [],
  ["message.output_text.logprobs"],
  ["reasoning.encrypted_content"],
  ["message.output_text.logprobs", "reasoning.encrypted_content", "web_search_call.results"],
  ["message.output_text.logprobs", "message.output_text.logprobs"],
]) {
  test(`stateless reasoning requests merge include ${JSON.stringify(include)} without changing provider fields`, async () => {
    const original = structuredClone(include);
    const previous = include ?? [];
    const expected = previous.includes("reasoning.encrypted_content")
      ? previous
      : [...previous, "reasoning.encrypted_content"];
    const reasoning = { type: "reasoning", id: "rs_requested", summary: [], encrypted_content: "signed-requested" };
    let payload: Record<string, unknown> | undefined;
    const result = await request(
      async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        const returned =
          Array.isArray(payload?.include) && payload.include.includes("reasoning.encrypted_content")
            ? reasoning
            : { ...reasoning, encrypted_content: undefined };
        return sse([latest, returned], { output: [returned] });
      },
      { model: { ...model, samplingParams: { include } } },
    );
    assert.deepEqual(result.replacementHistory, [latest, reasoning]);
    assert.deepEqual(payload?.include, expected);
    assert.equal(payload?.store, false);
    assert.deepEqual(payload?.reasoning, { effort: "none" });
    assert.deepEqual(include, original);
  });
}

for (const activeModel of [
  { ...model, reasoning: false },
  { ...model, thinkingLevelMap: { off: null } },
]) {
  test(`encryption inclusion does not enable thinking for reasoning=${activeModel.reasoning}, off=${JSON.stringify(activeModel.thinkingLevelMap?.off)}`, async () => {
    let payload: Record<string, unknown> | undefined;
    await request(
      async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return sse([latest]);
      },
      { model: activeModel },
    );
    assert.deepEqual(payload?.include, ["reasoning.encrypted_content"]);
    assert.equal(payload?.reasoning, undefined);
  });
}

for (const [index, include] of [
  "reasoning.encrypted_content",
  3,
  {},
  [null],
  [undefined],
  Array(1),
  ["message.output_text.logprobs", 3],
].entries()) {
  test(`malformed include case ${index}: ${JSON.stringify(include)} is rejected before dispatch`, async () => {
    let fetches = 0;
    await assert.rejects(
      request(
        async () => {
          fetches += 1;
          return sse([latest]);
        },
        { model: { ...model, samplingParams: { include } } },
      ),
      /invalid include/,
    );
    assert.equal(fetches, 0);
  });
}

test("new checkpoint-first history survives parsing while legacy layouts remain readable", () => {
  const details = createCheckpointDetails({
    provider: model.provider,
    api: model.api,
    profile: "openai-responses-v1",
    modelId: model.id,
    protocol,
    replacementHistory: [latest, suffix],
    keptMessages: [],
  });
  assert.deepEqual(parseCheckpointDetails(details)?.replacementHistory, [latest, suffix]);
  assert.equal(parseCheckpointDetails({ ...details, protocol: "remote-v2" }), undefined);
  assert.equal(parseCheckpointDetails({ ...details, version: 2 }), undefined);
  assert.equal(parseCheckpointDetails({ ...details, replacementHistory: [suffix, latest] }), undefined);
});

for (const signature of [undefined, null, ""]) {
  test(`persisted checkpoints reject unreplayable ${String(signature)} reasoning`, () => {
    const reasoning = { type: "reasoning", id: "rs_persisted", summary: [], encrypted_content: "signed" };
    const details = createCheckpointDetails({
      provider: model.provider,
      api: model.api,
      profile: "openai-responses-v1",
      modelId: model.id,
      protocol,
      replacementHistory: [latest, reasoning, suffix],
      keptMessages: [],
    });
    assert.equal(
      parseCheckpointDetails({
        ...details,
        replacementHistory: [latest, { ...reasoning, encrypted_content: signature }, suffix],
      }),
      undefined,
    );
  });
}

test("maintenance control is appended exactly once and prior checkpoint expansion preserves its suffix", async () => {
  const prior = [latest, suffix];
  await request(
    async (_input, init) => {
      const payload = JSON.parse(String(init?.body));
      assert.deepEqual(payload.input.slice(1, -1), prior);
      assert.equal(payload.input[0].content, "original system");
      assert.deepEqual(payload.input.at(-1), {
        role: "user",
        content: [{ type: "input_text", text: COMPACTION_MAINTENANCE_MESSAGE }],
      });
      assert.equal(
        payload.input.filter((item: unknown) => JSON.stringify(item).includes(COMPACTION_MAINTENANCE_MESSAGE)).length,
        1,
      );
      return sse([{ ...latest, encrypted_content: "next" }]);
    },
    {
      context: { ...context, messages: [{ role: "user", content: "prior marker", timestamp: 1 }] },
      priorCheckpoint: { marker: "prior marker", replacementHistory: prior },
    },
  );
});

test("auth, custom headers, environment and original tool definitions stay provider-owned", async () => {
  let optionsSeen = false;
  const native = await provider();
  const wrapped: Provider = {
    ...native,
    stream(activeModel, activeContext, options) {
      assert.equal(options?.apiKey, "fixture-key");
      assert.deepEqual(options?.headers, { "X-Request-Auth": "fixture-header" });
      assert.deepEqual(options?.env, { FIXTURE_ENV: "fixture-env" });
      assert.equal(options?.transport, "sse");
      assert.equal(options?.cacheRetention, "none");
      optionsSeen = true;
      return native.stream(activeModel, activeContext, options);
    },
  };
  await request(
    async (_input, init) => {
      const payload = JSON.parse(String(init?.body));
      assert.equal(new Headers(init?.headers).get("X-Request-Auth"), "fixture-header");
      assert.equal(payload.tools[0].name, "read");
      assert.equal(payload.tool_choice, "none");
      return sse([latest]);
    },
    {
      provider: wrapped,
      headers: { "X-Request-Auth": "fixture-header" },
      env: { FIXTURE_ENV: "fixture-env" },
      context: {
        ...context,
        tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }],
      },
    },
  );
  assert.equal(optionsSeen, true);
});

for (const status of [400, 401, 403]) {
  test(`HTTP ${status} fails once without changing protocol, endpoint or credentials`, async () => {
    let requests = 0;
    await assert.rejects(
      request(
        async (input) => {
          requests += 1;
          assert.equal(String(input), "https://api.openai.com/v1/responses");
          return Response.json({ error: { message: "fixture rejection", type: "invalid_request_error" } }, { status });
        },
        { maxRetries: 2 },
      ),
      /fixture rejection/,
    );
    assert.equal(requests, 1);
  });
}

test("transient retry stays bounded and collects only the successful response", async () => {
  let requests = 0;
  const result = await request(
    async () => {
      requests += 1;
      if (requests === 1) return new Response("unavailable", { status: 503, headers: { "retry-after": "0" } });
      return sse([latest]);
    },
    { maxRetries: 1 },
  );
  assert.equal(requests, 2);
  assert.deepEqual(result.replacementHistory, [latest]);
});

test("retried raw terminal attribution stays unknown when the supplied fetch is not auditable", async () => {
  let requests = 0;
  const observations: RequestObservationEvent[] = [];
  const result = await request(
    async (_input, init) => {
      requests += 1;
      assert.equal(typeof init?.body, "string");
      if (requests === 1) return new Response("unavailable", { status: 503, headers: { "retry-after": "0" } });
      return sse([latest]);
    },
    {
      maxRetries: 1,
      requestObservation: {
        sessionId: "retry-session",
        provider: model.provider,
        api: model.api,
        model: model.id,
        httpFinalEligible: false,
        canCorrelateFetch: false,
        emit: (event) => observations.push(event),
      },
    },
  );
  const dispatches = observations.filter((event) => event.phase === "dispatch");
  const terminal = observations.find((event) => event.phase === "terminal");
  assert.equal(requests, 2);
  assert.deepEqual(result.replacementHistory, [latest]);
  assert.equal(dispatches.length, 2);
  assert.ok(dispatches.every((event) => event.phase === "dispatch" && event.coverage === "unknown"));
  assert.notEqual(dispatches[0]?.attemptId, dispatches[1]?.attemptId);
  assert.ok(terminal?.phase === "terminal");
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.attemptId, "unknown");
  assert.equal(terminal.responseId, "resp_fixture");
  assert.ok(observations.some((event) => event.phase === "unobserved" && event.reason === "attribution-unknown"));
  assert.ok(observations.some((event) => event.phase === "unobserved" && event.reason === "custom-fetch"));
  assert.equal(terminal.operationId, dispatches[0]?.operationId);
  assert.doesNotMatch(JSON.stringify(observations), /fixture-key|unavailable/);
});

for (const failure of [
  "missing checkpoint",
  "unsafe tool",
  "incomplete",
  "malformed JSON",
  "truncated stream",
] as const) {
  test(`rejects ${failure} without returning a checkpoint`, async () => {
    await assert.rejects(
      request(async () => {
        if (failure === "missing checkpoint") return sse([]);
        if (failure === "unsafe tool")
          return sse([latest, { type: "function_call", id: "call", call_id: "call", name: "read", arguments: "{}" }]);
        if (failure === "incomplete") return sse([latest], { status: "incomplete" });
        if (failure === "malformed JSON")
          return new Response("data: {broken}\n\n", { headers: { "content-type": "text/event-stream" } });
        return new Response(`data: ${JSON.stringify({ type: "response.output_item.done", item: latest })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
  });
}

for (const status of [200, 401]) {
  test(`HTTP ${status} body limit rejects oversized comments and cancels the upstream body`, async () => {
    let cancelled = false;
    await assert.rejects(
      request(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(`:${"x".repeat(MAX_SSE_BYTES)}\n\n`));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status, headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    assert.equal(cancelled, true);
  });
}

for (const mode of ["cancel", "timeout"] as const) {
  test(`${mode} settles an idle body and releases its upstream reader`, async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let cancelled = false;
    const pending = request(
      async (_input, init) => {
        assert.ok(init?.signal);
        ready();
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { signal: controller.signal, requestTimeoutMs: mode === "timeout" ? 100 : 30_000 },
    );
    const assertion = assert.rejects(pending, mode === "timeout" ? /timed out/ : /abort/i);
    await started;
    if (mode === "cancel") controller.abort();
    await assertion;
    assert.equal(cancelled, true);
  });
}

test("already aborted input never dispatches", async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  await assert.rejects(
    request(
      async () => {
        requests += 1;
        return sse([latest]);
      },
      { signal: controller.signal },
    ),
    /aborted/i,
  );
  assert.equal(requests, 0);
});
