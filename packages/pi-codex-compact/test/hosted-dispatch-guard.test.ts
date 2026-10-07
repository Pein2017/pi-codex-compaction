import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  type Context,
  type Model,
  normalizeContext,
  type Provider,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { test, vi } from "vitest";
import { requestRemoteCompaction } from "../src/remote.js";
import {
  HOSTED_DEADLINE_MS,
  HOSTED_DISPATCH_LIMIT,
  HostedDispatchGuard,
  HostedDispatchGuardError,
} from "./support/hosted-dispatch-guard.js";

const OPENAI_RESPONSES = "https://api.openai.com/v1/responses";
const SYNTHETIC_OAUTH = "synthetic-oauth-token-not-valid-for-network";
const SYNTHETIC_API_KEY = "sk-synthetic-key-not-valid-for-network";
const SYNTHETIC_SESSION = "qualification-session-not-a-user-session";
const sdkProviderSpecifier =
  process.env.COMPACT_TEST_OPENAI_PROVIDER_MODULE ?? "@earendil-works/pi-ai/providers/openai";
const sdkCompactionSpecifier = process.env.COMPACT_TEST_PI_COMPACTION_MODULE ?? "@earendil-works/pi-coding-agent";

interface LoopbackHarness {
  readonly origin: string;
  readonly bodies: string[];
  readonly requestCount: () => number;
  close(): Promise<void>;
}

async function startLoopback(
  options: { retainBodies?: boolean; status?: (index: number) => number } = {},
): Promise<LoopbackHarness> {
  const bodies: string[] = [];
  let requests = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const index = requests++;
      if (options.retainBodies) bodies.push(body);
      const status = options.status?.(index) ?? 200;
      if (status !== 200) {
        response.writeHead(status, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ error: { message: "synthetic loopback rejection" } }));
        return;
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const item = Array.isArray(parsed.context_management)
        ? {
            id: `cmp_local_${index}`,
            type: "compaction",
            encrypted_content: `synthetic-opaque-${index}`,
          }
        : {
            id: `msg_local_${index}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "synthetic loopback completion" }],
          };
      const terminal = {
        id: `resp_local_${index}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      const events = [
        { type: "response.output_item.done", output_index: 0, item },
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
  return {
    origin: `http://127.0.0.1:${address.port}`,
    bodies,
    requestCount: () => requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function endpointAllowed(endpoint: URL): boolean {
  return endpoint.toString() === OPENAI_RESPONSES;
}

function loopbackFetch(harness: LoopbackHarness): typeof globalThis.fetch {
  return async (input, init) => {
    const source = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(source.toString(), OPENAI_RESPONSES);
    const target = new URL(`${source.pathname}${source.search}`, harness.origin);
    const forwardedInput = input instanceof Request ? new Request(target, input) : target;
    return globalThis.fetch(forwardedInput, init);
  };
}

function createGuard(
  harness: LoopbackHarness,
  options: { signal?: AbortSignal; maxDispatches?: number; deadlineMs?: number } = {},
): HostedDispatchGuard {
  return new HostedDispatchGuard({
    fetch: loopbackFetch(harness),
    allowedEndpoint: endpointAllowed,
    ...options,
  });
}

async function openAIFixture(): Promise<{ provider: Provider; model: Model<"openai-responses"> }> {
  const module = (await import(sdkProviderSpecifier)) as { openaiProvider: () => Provider };
  const provider = module.openaiProvider();
  const model = provider.getModels().find((candidate) => candidate.id === "gpt-6-luna");
  assert.ok(model, "installed OpenAI catalog is missing gpt-6-luna");
  assert.equal(model.api, "openai-responses");
  assert.equal(model.provider, "openai");
  assert.equal(model.baseUrl, "https://api.openai.com/v1");
  assert.equal(model.contextWindow, 272_000);
  assert.equal(model.maxTokens, 128_000);
  const responsesModel = model as Model<"openai-responses">;
  assert.deepEqual(responsesModel.cost, {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [{ inputTokensAbove: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }],
  });
  assert.notEqual(responsesModel.compat?.supportsMaxOutputTokens, false);
  return { provider, model: responsesModel };
}

const syntheticContext: Context = {
  systemPrompt: "synthetic qualification system text",
  messages: [{ role: "user", content: [{ type: "text", text: "synthetic qualification history" }], timestamp: 1 }],
  tools: [],
};

async function ordinaryRequest(
  provider: Provider,
  model: Model<"openai-responses">,
  fetch: typeof globalThis.fetch,
  apiKey: string,
): Promise<void> {
  const message = await provider
    .stream(model, normalizeContext(syntheticContext), {
      apiKey,
      maxTokens: model.maxTokens,
      sessionId: SYNTHETIC_SESSION,
      cacheRetention: "short",
      transport: "sse",
      maxRetries: 0,
      fetch,
    })
    .result();
  assert.equal(message.stopReason, "stop");
}

async function contextManagementRequest(
  provider: Provider,
  model: Model<"openai-responses">,
  guard: HostedDispatchGuard,
  preserveCacheAffinity: boolean,
): Promise<void> {
  await requestRemoteCompaction({
    provider,
    model,
    context: syntheticContext,
    protocol: "context-management",
    profile: "openai-responses-v1",
    apiKey: SYNTHETIC_OAUTH,
    signal: new AbortController().signal,
    maxRetries: 0,
    fetch: guard.fetch,
    preserveCacheAffinity,
    sessionId: SYNTHETIC_SESSION,
  });
}

async function nativeCoreCompactionFallback(
  provider: Provider,
  model: Model<"openai-responses">,
  guard: HostedDispatchGuard,
): Promise<void> {
  const module = (await import(sdkCompactionSpecifier)) as {
    compact: (...args: unknown[]) => Promise<unknown>;
  };
  const preparation = {
    firstKeptEntryId: "synthetic-kept-entry",
    messagesToSummarize: [
      { role: "user", content: [{ type: "text", text: "synthetic native-summary source" }], timestamp: 1 },
    ],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 12,
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 128 },
  };
  const nativeStream = (...args: unknown[]) => {
    const [activeModel, activeContext, options] = args;
    return provider.stream(activeModel as Model<"openai-responses">, activeContext as TranscriptContext, {
      ...(options as Record<string, unknown>),
      transport: "sse",
      maxRetries: 0,
      fetch: guard.fetch,
    });
  };
  await module.compact(
    preparation,
    model,
    SYNTHETIC_OAUTH,
    undefined,
    undefined,
    new AbortController().signal,
    undefined,
    nativeStream,
    undefined,
    { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    undefined,
    SYNTHETIC_SESSION,
  );
}

test("installed OpenAI SDK loopback records emitted OAuth controls without inventing a billed output cap", async () => {
  const { provider, model } = await openAIFixture();
  const harness = await startLoopback({ retainBodies: true });
  const guard = createGuard(harness);
  guard.markReady();
  try {
    // The explicit stream option is deliberately supplied: Sign in with ChatGPT still omits it.
    await ordinaryRequest(provider, model, guard.fetch, SYNTHETIC_OAUTH);
    await contextManagementRequest(provider, model, guard, false);
    await contextManagementRequest(provider, model, guard, true);
    // A synthetic API-key contrast confirms the model supports the field on the other SDK branch.
    await ordinaryRequest(provider, model, guard.fetch, SYNTHETIC_API_KEY);

    assert.equal(harness.requestCount(), 4);
    assert.equal(guard.snapshot().dispatches, 4);
    const [ordinaryOAuth, baselineCompact, candidateCompact, apiKeyContrast] = harness.bodies.map(
      (body) => JSON.parse(body) as Record<string, unknown>,
    );
    assert.ok(ordinaryOAuth && baselineCompact && candidateCompact && apiKeyContrast);
    for (const body of [ordinaryOAuth, baselineCompact, candidateCompact]) {
      assert.equal(Object.hasOwn(body, "max_output_tokens"), false);
      assert.equal(Object.hasOwn(body, "prompt_cache_retention"), false);
      assert.equal(Object.hasOwn(body, "prompt_cache_options"), false);
    }
    assert.equal(Object.hasOwn(ordinaryOAuth, "max_output_tokens"), false);
    assert.equal(baselineCompact.max_output_tokens, undefined);
    assert.deepEqual(baselineCompact.context_management, [{ type: "compaction", compact_threshold: 1024 }]);
    assert.equal(baselineCompact.store, false);
    assert.equal(baselineCompact.stream, true);
    assert.equal(baselineCompact.tool_choice, "none");
    assert.equal(Object.hasOwn(baselineCompact, "service_tier"), false);
    assert.equal(Object.hasOwn(baselineCompact, "tools"), false);
    assert.equal(baselineCompact.prompt_cache_key, undefined);
    assert.deepEqual(candidateCompact.context_management, [{ type: "compaction", compact_threshold: 1024 }]);
    assert.equal(candidateCompact.store, false);
    assert.equal(candidateCompact.stream, true);
    assert.equal(candidateCompact.tool_choice, "none");
    assert.deepEqual(candidateCompact.include, ["reasoning.encrypted_content"]);
    assert.equal(Object.hasOwn(candidateCompact, "service_tier"), false);
    assert.equal(Object.hasOwn(candidateCompact, "tools"), false);
    assert.equal(candidateCompact.prompt_cache_key, SYNTHETIC_SESSION);
    assert.equal(apiKeyContrast.max_output_tokens, model.maxTokens);
    assert.equal(
      harness.bodies.some((body) => body.includes(SYNTHETIC_OAUTH) || body.includes(SYNTHETIC_API_KEY)),
      false,
    );
  } finally {
    guard.dispose();
    await harness.close();
  }
});

test("first loopback endpoint failure blocks the SDK-native-summary-shaped fallback dispatch", async () => {
  const { provider, model } = await openAIFixture();
  const harness = await startLoopback({ status: () => 401 });
  const guard = createGuard(harness);
  guard.markReady();
  try {
    await assert.rejects(contextManagementRequest(provider, model, guard, true));
    assert.equal(harness.requestCount(), 1);
    assert.equal(guard.snapshot().state, "external-failure");
    assert.equal(guard.snapshot().dispatches, 1);

    // The installed Pi core compact() helper generates its native summary through the real provider
    // stream function. The shared guard must deny that fallback before a second endpoint dispatch.
    await assert.rejects(nativeCoreCompactionFallback(provider, model, guard));
    assert.equal(harness.requestCount(), 1);
    assert.equal(guard.snapshot().dispatches, 1);
    await assert.rejects(guard.fetch(OPENAI_RESPONSES), (error: unknown) => {
      assert.ok(error instanceof HostedDispatchGuardError);
      assert.equal(error.code, "external-failure");
      return true;
    });
  } finally {
    guard.dispose();
    await harness.close();
  }
});

test("guard starts its deadline at readiness and refuses late work", async () => {
  vi.useFakeTimers();
  let fetches = 0;
  const guard = new HostedDispatchGuard({
    allowedEndpoint: endpointAllowed,
    deadlineMs: 100,
    now: () => Date.now(),
    fetch: async () => {
      fetches += 1;
      return new Response("ok");
    },
  });
  try {
    await assert.rejects(guard.fetch(OPENAI_RESPONSES), (error: unknown) => {
      assert.ok(error instanceof HostedDispatchGuardError);
      assert.equal(error.code, "not-ready");
      return true;
    });
    assert.equal(fetches, 0);
    await vi.advanceTimersByTimeAsync(5_000);
    guard.markReady();
    await vi.advanceTimersByTimeAsync(99);
    const response = await guard.fetch(OPENAI_RESPONSES);
    await response.body?.cancel();
    assert.equal(fetches, 1);
    await vi.advanceTimersByTimeAsync(1);
    await assert.rejects(guard.fetch(OPENAI_RESPONSES), (error: unknown) => {
      assert.ok(error instanceof HostedDispatchGuardError);
      assert.equal(error.code, "deadline");
      return true;
    });
    assert.equal(fetches, 1);
    assert.equal(guard.snapshot().deadlineMs, 100);
  } finally {
    guard.dispose();
    vi.useRealTimers();
  }
});

test("non-allowlisted endpoints are blocked before reaching the fetch delegate", async () => {
  let fetches = 0;
  const guard = new HostedDispatchGuard({
    allowedEndpoint: endpointAllowed,
    fetch: async () => {
      fetches += 1;
      return new Response("unexpected");
    },
  });
  guard.markReady();
  try {
    await assert.rejects(guard.fetch("https://not-openai.invalid/v1/responses"), (error: unknown) => {
      assert.ok(error instanceof HostedDispatchGuardError);
      assert.equal(error.code, "endpoint-blocked");
      return true;
    });
    assert.equal(fetches, 0);
    assert.equal(guard.snapshot().dispatches, 0);
  } finally {
    guard.dispose();
  }
});

test("cancellation aborts the in-flight fetch and counts only the attempted dispatch", async () => {
  const parent = new AbortController();
  let fetches = 0;
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const guard = new HostedDispatchGuard({
    signal: parent.signal,
    allowedEndpoint: endpointAllowed,
    fetch: async (_input, init) => {
      fetches += 1;
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    },
  });
  guard.markReady();
  const pending = guard.fetch(OPENAI_RESPONSES);
  const rejection = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof HostedDispatchGuardError);
    assert.equal(error.code, "cancelled");
    return true;
  });
  await requestStarted;
  parent.abort();
  await rejection;
  assert.equal(fetches, 1);
  assert.equal(guard.snapshot().dispatches, 1);
  assert.equal(guard.snapshot().state, "cancelled");
  guard.dispose();
});

test("eight actual fetches fit the bound, the ninth is blocked, and concurrent dispatch is fail-closed", async () => {
  let fetches = 0;
  const guard = new HostedDispatchGuard({
    allowedEndpoint: endpointAllowed,
    fetch: async () => {
      fetches += 1;
      return new Response("ok");
    },
  });
  guard.markReady();
  try {
    assert.equal(guard.snapshot().maxDispatches, HOSTED_DISPATCH_LIMIT);
    assert.equal(guard.snapshot().deadlineMs, HOSTED_DEADLINE_MS);
    for (let index = 0; index < HOSTED_DISPATCH_LIMIT; index += 1) {
      const response = await guard.fetch(OPENAI_RESPONSES);
      await response.body?.cancel();
    }
    await assert.rejects(guard.fetch(OPENAI_RESPONSES), (error: unknown) => {
      assert.ok(error instanceof HostedDispatchGuardError);
      assert.equal(error.code, "dispatch-limit");
      return true;
    });
    assert.equal(fetches, HOSTED_DISPATCH_LIMIT);
    assert.equal(guard.snapshot().dispatches, HOSTED_DISPATCH_LIMIT);
  } finally {
    guard.dispose();
  }

  let resolveFirst!: (response: Response) => void;
  let concurrentFetches = 0;
  const concurrent = new HostedDispatchGuard({
    allowedEndpoint: endpointAllowed,
    fetch: async () => {
      concurrentFetches += 1;
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    },
  });
  concurrent.markReady();
  const first = concurrent.fetch(OPENAI_RESPONSES);
  await Promise.resolve();
  await assert.rejects(concurrent.fetch(OPENAI_RESPONSES), (error: unknown) => {
    assert.ok(error instanceof HostedDispatchGuardError);
    assert.equal(error.code, "overlap");
    return true;
  });
  resolveFirst(new Response("ok"));
  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof HostedDispatchGuardError);
    assert.equal(error.code, "overlap");
    return true;
  });
  assert.equal(concurrentFetches, 1);
  assert.equal(concurrent.snapshot().dispatches, 1);
  concurrent.dispose();
});
