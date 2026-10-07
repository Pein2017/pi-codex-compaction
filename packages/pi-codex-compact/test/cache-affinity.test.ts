import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  type Context,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Model,
  normalizeContext,
  type Provider,
} from "@earendil-works/pi-ai";
import { test } from "vitest";
import { preserveAffinityContext } from "../src/cache-affinity.js";
import { requestRemoteCompaction } from "../src/remote.js";
import { createCodexCompactSettingsRuntime, normalizeCodexCompactSettings } from "../src/settings.js";

const model: Model<Api> = {
  id: "gpt-fixture",
  name: "Fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 128,
};
const item = { type: "compaction", id: "cmp_affinity", encrypted_content: "opaque" };
const context = {
  systemPrompt: "system",
  messages: [{ role: "user" as const, content: "history", timestamp: 1 }],
  tools: [],
};
function completion(): Response {
  return new Response(
    [
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_affinity",
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("affinity is default false, strictly boolean, queued, durable, and explicitly reversible", async () => {
  assert.equal(normalizeCodexCompactSettings({})?.preserveCacheAffinity, false);
  for (const value of [null, 0, "true", [], {}])
    assert.equal(normalizeCodexCompactSettings({ preserveCacheAffinity: value }), undefined);
  for (const value of [false, true])
    assert.equal(normalizeCodexCompactSettings({ preserveCacheAffinity: value })?.preserveCacheAffinity, value);
  const root = await mkdtemp(join(tmpdir(), "compact-affinity-settings-"));
  try {
    const path = join(root, "pi-codex-compact.json");
    const runtime = createCodexCompactSettingsRuntime(path);
    const save = runtime.update({ preserveCacheAffinity: true });
    const reload = runtime.reload();
    await save;
    assert.equal((await reload).settings.preserveCacheAffinity, true);
    await runtime.update({ preserveCacheAffinity: false });
    await runtime.flush();
    assert.equal(JSON.parse(await readFile(path, "utf8")).preserveCacheAffinity, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function capture(
  preserveCacheAffinity: boolean | undefined,
  options: {
    protocol?: "context-management" | "remote-v2" | "responses-compact";
    env?: Record<string, string>;
    compat?: Model<Api>["compat"];
    apiKey?: string;
    custom?: boolean;
  } = {},
) {
  const specifier = process.env.COMPACT_TEST_OPENAI_PROVIDER_MODULE ?? "@earendil-works/pi-ai/providers/openai";
  const provider: Provider = (await import(specifier)).openaiProvider();
  let body = "";
  let headers = new Headers();
  let streamOptions: Record<string, unknown> = {};
  const active = {
    ...model,
    ...(options.compat ? { compat: options.compat } : {}),
    ...(options.custom ? { api: "custom-responses" } : {}),
  };
  const delegated: Provider = {
    ...provider,
    stream(original, transcript, opts) {
      assert.equal(original, active, "pass the supplied model without substituting its API");
      streamOptions = opts as Record<string, unknown>;
      return provider.stream(original, transcript, opts);
    },
  };
  await requestRemoteCompaction({
    provider: delegated,
    model: active,
    context,
    protocol: options.protocol ?? "context-management",
    profile: "openai-responses-v1",
    apiKey: options.apiKey ?? "sk-fixture-key",
    env: options.env ?? { PI_CACHE_RETENTION: "short" },
    signal: new AbortController().signal,
    maxRetries: 0,
    ...(preserveCacheAffinity === undefined ? {} : { preserveCacheAffinity }),
    sessionId: "origin-session",
    fetch: async (_input, init) => {
      body = String(init?.body);
      headers = new Headers(init?.headers);
      return options.protocol === "responses-compact"
        ? Response.json({ output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } })
        : completion();
    },
  });
  return { body, payload: JSON.parse(body), headers, options: streamOptions };
}

for (const fixture of [
  { name: "API key default short", env: { PI_CACHE_RETENTION: "short" }, retention: undefined },
  { name: "environment long", env: { PI_CACHE_RETENTION: "long" }, retention: "24h" },
  { name: "environment none is not a disable switch", env: { PI_CACHE_RETENTION: "none" }, retention: undefined },
  {
    name: "compat no long",
    env: { PI_CACHE_RETENTION: "long" },
    compat: { supportsLongCacheRetention: false },
    retention: undefined,
  },
  {
    name: "explicit mode",
    env: { PI_CACHE_RETENTION: "long" },
    compat: { supportsExplicitPromptCacheMode: true },
    retention: undefined,
    cacheOptions: { ttl: "30m" },
  },
  {
    name: "ChatGPT sign-in omits retention",
    env: { PI_CACHE_RETENTION: "long" },
    apiKey: `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.signature`,
    retention: undefined,
  },
  { name: "custom API keeps original model", custom: true, env: { PI_CACHE_RETENTION: "long" }, retention: "24h" },
]) {
  test(`enabled affinity delegates provider policy: ${fixture.name}`, async () => {
    const result = await capture(true, fixture);
    assert.equal(result.options.sessionId, "origin-session");
    assert.equal(Object.hasOwn(result.options, "cacheRetention"), false);
    assert.equal(result.payload.prompt_cache_key, "origin-session");
    assert.equal(result.payload.prompt_cache_retention, fixture.retention);
    assert.deepEqual(result.payload.prompt_cache_options, "cacheOptions" in fixture ? fixture.cacheOptions : undefined);
    assert.equal(result.headers.get("session_id"), "origin-session");
  });
}
const tool = (name: string, description = name) => ({
  name,
  description,
  parameters: { type: "object" as const, properties: {} },
});
for (const fixture of [
  {
    name: "explicit disable over absent persisted constraint",
    persisted: {},
    outer: { constrainedSampling: false as const },
    redundant: false,
  },
  {
    name: "matching explicit disable",
    persisted: { constrainedSampling: false as const },
    outer: { constrainedSampling: false as const },
    redundant: true,
  },
  {
    name: "matching constraint config",
    persisted: { constrainedSampling: { type: "json_schema" as const, strict: "require" as const } },
    outer: { constrainedSampling: { type: "json_schema" as const, strict: "require" as const } },
    redundant: true,
  },
  {
    name: "differing constraint config",
    persisted: { constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const } },
    outer: { constrainedSampling: { type: "json_schema" as const, strict: "require" as const } },
    redundant: false,
  },
  {
    name: "absent outer constraint retains persisted disable",
    persisted: { constrainedSampling: false as const },
    outer: {},
    redundant: true,
  },
  {
    name: "unknown explicit outer field is not assumed redundant",
    persisted: {},
    outer: { futureProviderOption: false },
    redundant: false,
  },
]) {
  test(`tool fidelity: ${fixture.name}`, () => {
    const persisted = { ...tool("read"), ...fixture.persisted };
    const tools = [{ ...tool("read"), ...fixture.outer }];
    const before: Context = {
      systemPrompt: "base",
      messages: [{ role: "system", content: "base", toolsAdded: [persisted], timestamp: 0 }],
      tools,
    };
    const snapshot = structuredClone(before);
    const after = preserveAffinityContext(before);
    assert.deepEqual(before, snapshot, "preparation does not mutate the caller");
    assert.equal(after.messages, before.messages, "persisted declarations are retained verbatim");
    assert.equal(
      after.tools,
      fixture.redundant ? undefined : tools,
      "explicit overrides survive unless proven identical",
    );
    assert.deepEqual(getCurrentTools(after.messages), [persisted]);
  });
}

for (const variant of [
  "persisted",
  "sections",
  "ordered-deltas",
  "forced-different",
  "legacy",
  "changed-tools",
  "opaque-marker",
] as const) {
  test(`prefix repair preserves authoritative ${variant} declarations`, async () => {
    const messages: Context["messages"] =
      variant === "legacy"
        ? []
        : [{ role: "system", content: "base", toolsAdded: [tool("read"), tool("write")], timestamp: 0 }];
    if (variant === "sections")
      messages.push({
        role: "system",
        content: "persisted instruction",
        sections: { rules: "new rule" },
        timestamp: 1,
      });
    if (variant === "ordered-deltas")
      messages.push({
        role: "system",
        content: "",
        toolsRemoved: [{ name: "read" }],
        toolsAdded: [tool("read", "updated")],
        timestamp: 1,
      });
    messages.push({
      role: "user",
      content: variant === "opaque-marker" ? "[opaque checkpoint marker]" : "history",
      timestamp: 2,
    });
    const effective =
      variant === "forced-different"
        ? "forced effective prompt"
        : variant === "legacy"
          ? "legacy system"
          : getCurrentSystemPrompt(messages);
    const tools = variant === "changed-tools" || variant === "legacy" ? [tool("new")] : getCurrentTools(messages);
    const before: Context = { systemPrompt: effective, tools, messages };
    const snapshot = structuredClone(before);
    const after = preserveAffinityContext(before);
    assert.deepEqual(before, snapshot);
    assert.deepEqual(after.messages, before.messages, "never remove persisted instructions or deltas");
    if (variant === "legacy" || variant === "forced-different") assert.equal(after.systemPrompt, effective);
    else assert.equal(after.systemPrompt, undefined);
    if (variant === "changed-tools") assert.deepEqual(after.tools, tools);
    if (variant === "legacy" || variant === "changed-tools" || variant === "forced-different") return;
    const specifier = process.env.COMPACT_TEST_OPENAI_PROVIDER_MODULE ?? "@earendil-works/pi-ai/providers/openai";
    const provider: Provider = (await import(specifier)).openaiProvider();
    for (const midConversation of [false, true]) {
      const payloads: string[] = [];
      for (const transcript of [normalizeContext({ messages }), normalizeContext(after)]) {
        const stream = provider.stream(
          { ...model, compat: { supportsMidConvoSystemMessages: midConversation, supportsAdditionalTools: true } },
          transcript,
          {
            apiKey: "fixture",
            maxRetries: 0,
            fetch: async (_input, init) => {
              payloads.push(String(init?.body));
              return completion();
            },
          },
        );
        for await (const event of stream) if (event.type === "error") assert.fail(event.error.errorMessage);
      }
      assert.equal(payloads[1], payloads[0], "ordinary provider system/tool ordering stays byte-identical");
    }
  });
}

for (const protocol of ["context-management", "remote-v2", "responses-compact"] as const) {
  test(`${protocol}: off/absent byte equivalence and other protocols never inherit affinity`, async () => {
    const absent = await capture(undefined, { protocol });
    const off = await capture(false, { protocol });
    assert.equal(absent.body, off.body);
    assert.equal(off.options.cacheRetention, "none");
    assert.equal(off.options.sessionId, undefined);
    assert.equal(off.payload.prompt_cache_key, undefined);
    if (protocol !== "context-management") {
      const on = await capture(true, { protocol });
      assert.equal(on.body, off.body);
      assert.equal(on.options.sessionId, undefined);
    }
  });
}
