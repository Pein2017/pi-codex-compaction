import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { test } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const continuation = /\[PI_TASK_CONTINUATION_V1\]/;
const taskAnswer = "TASK_FINISHED_742";
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
type Item = Record<string, unknown>;
type RequestBody = { input: Item[]; context_management?: unknown };

function textItem(text: string): Item {
  return {
    type: "message",
    id: "msg_fixture",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

// Real SSE bytes are consumed by the SDK's built-in Responses parser, including
// provider stream events used by the extension's checkpoint collector.
function response(items: Item[], inputTokens: number): Response {
  const events: Item[] = [{ type: "response.created", response: { id: "resp_fixture" } }];
  items.forEach((item, output_index) => {
    events.push({ type: "response.output_item.added", output_index, item });
    events.push({ type: "response.output_item.done", output_index, item });
  });
  events.push({
    type: "response.completed",
    response: {
      id: "resp_fixture",
      status: "completed",
      output: items,
      usage: { input_tokens: inputTokens, output_tokens: 20, total_tokens: inputTokens + 20 },
    },
  });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function fixture(
  options: { tool?: boolean; pauseMaintenance?: boolean; finalTokens?: number; maxNormalRequests?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-continuation-sdk-"));
  const agentDir = join(root, "agent");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalFetch = globalThis.fetch;
  let session: AgentSession | undefined;
  const normal: RequestBody[] = [];
  const maintenance: RequestBody[] = [];
  const errors: unknown[] = [];
  const reasons: string[] = [];
  let toolCalls = 0;
  let resolveEntered!: () => void;
  let resolveRelease!: () => void;
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  try {
    await mkdir(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(
      join(agentDir, "pi-codex-compact.json"),
      JSON.stringify({ enabled: true, protocol: "context-management", maxRetries: 0, checkpointRecovery: "cancel" }),
    );
    const settings = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 256 },
      retry: { enabled: false, provider: { maxRetries: 0 } },
      transport: "sse",
      cacheWarming: "off",
      defaultTools: [],
    });
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    runtime.registerProvider("openai", {
      api: "openai-responses",
      apiKey: "sk-local-fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      models: [
        {
          id: "sdk-continuation-fixture",
          name: "SDK fixture",
          reasoning: false,
          input: ["text"],
          cost: zeroCost,
          contextWindow: 8192,
          maxTokens: 1024,
        },
      ],
    });
    const model = runtime.getModel("openai", "sdk-continuation-fixture");
    assert.ok(model);
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: [process.env.PI_COMPACT_TEST_ENTRY ?? join(packageRoot, "src/index.ts")],
      extensionFactories: [
        (pi) => {
          pi.on("session_before_compact", (event) => {
            reasons.push(event.reason);
          });
        },
      ],
      systemPrompt: "Complete the user's task; never repeat a completed tool.",
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.ok(loader.getExtensions().extensions.some((extension) => extension.commands.has("codex-compact")));
    const manager = SessionManager.create(root, join(root, "sessions"));
    manager.appendMessage({ role: "user", content: "Old context. ".repeat(250), timestamp: Date.now() - 20_000 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Old context noted." }],
      api: "openai-responses",
      provider: "openai",
      model: model.id,
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: zeroCost },
      stopReason: "stop",
      timestamp: Date.now() - 10_000,
    });
    manager.appendMessage({ role: "user", content: "Recent context. ".repeat(150), timestamp: Date.now() - 9000 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Recent context noted." }],
      api: "openai-responses",
      provider: "openai",
      model: model.id,
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: zeroCost },
      stopReason: "stop",
      timestamp: Date.now() - 8000,
    });
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      settingsManager: settings,
      sessionManager: manager,
      resourceLoader: loader,
      tools: options.tool ? ["sdk_effect"] : [],
      customTools: [
        {
          name: "sdk_effect",
          label: "SDK effect",
          description: "Execute exactly once and return the task token.",
          parameters: Type.Object({}),
          execute: async () => {
            toolCalls += 1;
            assert.equal(toolCalls, 1);
            return {
              content: [{ type: "text", text: `Effect complete: ${taskAnswer}. ${"padding ".repeat(250)}` }],
              details: { executed: true },
            };
          },
        },
      ],
    }));
    await session.bindExtensions({
      mode: "json",
      onError: (error) => {
        errors.push(error);
      },
    });
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      assert.equal(new URL(request.url).origin, "http://127.0.0.1:1", "fixture must never contact a paid endpoint");
      const body = JSON.parse(await request.text()) as RequestBody;
      if (body.context_management) {
        maintenance.push(body);
        assert.equal(maintenance.length, 1, "bounded fixture permits one compaction");
        resolveEntered();
        if (options.pauseMaintenance) await release;
        return response(
          [{ type: "compaction", id: "cmp_fixture", encrypted_content: "OPAQUE_LOCAL_FIXTURE" }, textItem("OK")],
          10,
        );
      }
      normal.push(body);
      assert.ok(normal.length <= (options.maxNormalRequests ?? 2), "bounded fixture task request limit");
      if (options.tool && normal.length === 1)
        return response(
          [
            {
              type: "function_call",
              id: "fc_fixture",
              call_id: "call_sdk_effect",
              name: "sdk_effect",
              arguments: "{}",
              status: "completed",
            },
          ],
          7500,
        );
      const serialized = JSON.stringify(body.input);
      return response(
        [
          textItem(
            serialized.includes("STOP_NEWER_USER") ? "STOPPED" : continuation.test(serialized) ? taskAnswer : "OK",
          ),
        ],
        options.finalTokens ?? 100,
      );
    };
    return {
      get session() {
        assert.ok(session);
        return session;
      },
      manager,
      normal,
      maintenance,
      errors,
      reasons,
      entered,
      release: resolveRelease,
      async reopen() {
        assert.ok(session);
        session.dispose();
        await loader.reload();
        const sessionFile = manager.getSessionFile();
        assert.ok(sessionFile);
        const restored = SessionManager.open(sessionFile);
        ({ session } = await createAgentSession({
          cwd: root,
          agentDir,
          modelRuntime: runtime,
          model,
          thinkingLevel: "off",
          settingsManager: settings,
          sessionManager: restored,
          resourceLoader: loader,
          tools: [],
        }));
        await session.bindExtensions({
          mode: "json",
          onError: (error) => {
            errors.push(error);
          },
        });
        return restored;
      },
      get toolCalls() {
        return toolCalls;
      },
      async close() {
        resolveRelease();
        await session?.abort();
        session?.dispose();
        globalThis.fetch = originalFetch;
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    resolveRelease();
    await session?.abort();
    session?.dispose();
    globalThis.fetch = originalFetch;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function checkpoint(f: Awaited<ReturnType<typeof fixture>>) {
  const entry = [...f.manager.getBranch()].reverse().find((entry) => entry.type === "compaction");
  assert.ok(entry && entry.type === "compaction", "real SDK must persist extension checkpoint");
  return entry.details as { version: number; replacementHistory: Item[] };
}
function finalText(f: Awaited<ReturnType<typeof fixture>>) {
  const entry = [...f.manager.getBranch()]
    .reverse()
    .find((entry) => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(entry && entry.type === "message" && entry.message.role === "assistant");
  return entry.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

test("real SDK continues the unfinished turn after mid-tool compaction without repeating the effect", async () => {
  const f = await fixture({ tool: true });
  try {
    await f.session.prompt(`Run sdk_effect exactly once, then report ${taskAnswer}.`);
    assert.equal(f.toolCalls, 1);
    assert.equal(f.maintenance.length, 1);
    assert.equal(f.normal.length, 2);
    assert.deepEqual(f.reasons, ["threshold"]);
    assert.deepEqual(f.errors, []);
    const stored = checkpoint(f);
    assert.equal(stored.version, 3);
    assert.equal(stored.replacementHistory[0]?.type, "compaction");
    assert.equal(stored.replacementHistory[1]?.role, "assistant", "keep the complete provider suffix");
    assert.equal(stored.replacementHistory.at(-1)?.role, "user", "active task needs a fresh user continuation anchor");
    assert.match(JSON.stringify(stored.replacementHistory.at(-1)), continuation);
    assert.equal((JSON.stringify(f.normal[1].input).match(/\[PI_TASK_CONTINUATION_V1\]/g) ?? []).length, 1);
    assert.equal(finalText(f), taskAnswer, "maintenance OK must not become task completion");
  } finally {
    await f.close();
  }
});

test("manual compaction persists maintenance history without starting a task turn", async () => {
  const f = await fixture();
  try {
    await f.session.compact();
    assert.deepEqual(f.reasons, ["manual"]);
    assert.equal(f.maintenance.length, 1);
    assert.equal(f.normal.length, 0);
    assert.deepEqual(f.errors, []);
    assert.doesNotMatch(JSON.stringify(checkpoint(f).replacementHistory), continuation);
    assert.equal(checkpoint(f).replacementHistory.at(-1)?.role, "assistant");
  } finally {
    await f.close();
  }
});

test("post-answer threshold maintenance does not restart a settled task", async () => {
  const f = await fixture({ finalTokens: 7500 });
  try {
    await f.session.prompt("A settled task needs only a brief acknowledgement.");
    assert.deepEqual(f.reasons, ["threshold"]);
    assert.equal(f.maintenance.length, 1);
    assert.equal(f.normal.length, 1);
    assert.equal(f.toolCalls, 0);
    assert.deepEqual(f.errors, []);
    assert.doesNotMatch(JSON.stringify(checkpoint(f).replacementHistory), continuation);
  } finally {
    await f.close();
  }
});

test("newer steering queued during compaction follows the continuation anchor", async () => {
  const f = await fixture({ tool: true, pauseMaintenance: true });
  try {
    const run = f.session.prompt(`Run sdk_effect exactly once, then report ${taskAnswer}.`);
    await f.entered;
    await f.session.prompt("STOP_NEWER_USER: stop the original task and acknowledge STOPPED.", {
      streamingBehavior: "steer",
    });
    f.release();
    await run;
    assert.equal(f.toolCalls, 1);
    assert.equal(f.maintenance.length, 1);
    assert.equal(f.normal.length, 2);
    assert.deepEqual(f.errors, []);
    const serializedItems = f.normal[1].input.map((item) => JSON.stringify(item));
    const anchorIndex = serializedItems.findIndex((item) => continuation.test(item));
    const stopIndex = serializedItems.findIndex((item) => item.includes("STOP_NEWER_USER"));
    assert.ok(anchorIndex >= 0, "active automatic compaction retains the fresh anchor");
    assert.ok(stopIndex > anchorIndex, "later user steering must follow and override the anchor");
    assert.equal(finalText(f), "STOPPED");
  } finally {
    await f.close();
  }
});

test("abort at the maintenance barrier publishes no checkpoint or additional task request", async () => {
  const f = await fixture({ tool: true, pauseMaintenance: true });
  try {
    const run = f.session.prompt(`Run sdk_effect exactly once, then report ${taskAnswer}.`);
    await f.entered;
    const aborted = f.session.abort();
    f.release();
    await aborted;
    await run;
    assert.equal(f.toolCalls, 1);
    assert.equal(f.maintenance.length, 1);
    assert.equal(f.normal.length, 1);
    assert.equal(f.manager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
    assert.doesNotMatch(JSON.stringify(f.manager.getBranch()), continuation);
  } finally {
    await f.close();
  }
});

test("JSONL reload replays the same opaque checkpoint and continuation prefix before newer user input", async () => {
  const f = await fixture({ tool: true, maxNormalRequests: 3 });
  try {
    await f.session.prompt(`Run sdk_effect exactly once, then report ${taskAnswer}.`);
    const stored = checkpoint(f);
    assert.match(JSON.stringify(stored.replacementHistory.at(-1)), continuation);
    const restored = await f.reopen();
    const reloaded = [...restored.getBranch()].reverse().find((entry) => entry.type === "compaction");
    assert.ok(reloaded && reloaded.type === "compaction");
    assert.deepEqual(reloaded.details, stored, "checkpoint must survive real JSONL serialization/reload");
    await f.session.prompt("FRESH_REPLAY_USER: acknowledge the completed original task without repeating its tool.");
    assert.equal(f.toolCalls, 1);
    assert.equal(f.maintenance.length, 1);
    assert.equal(f.normal.length, 3);
    assert.deepEqual(f.errors, []);
    const initial = f.normal[1].input;
    const replay = f.normal[2].input;
    const initialCheckpoint = initial.findIndex((item) => item.type === "compaction");
    const replayCheckpoint = replay.findIndex((item) => item.type === "compaction");
    assert.ok(initialCheckpoint >= 0 && replayCheckpoint >= 0);
    assert.deepEqual(
      initial.slice(initialCheckpoint, initialCheckpoint + stored.replacementHistory.length),
      stored.replacementHistory,
    );
    assert.deepEqual(
      replay.slice(replayCheckpoint, replayCheckpoint + stored.replacementHistory.length),
      stored.replacementHistory,
      "ordinary replay preserves the checkpoint prefix byte structure and order",
    );
    assert.equal((JSON.stringify(replay).match(/\[PI_TASK_CONTINUATION_V1\]/g) ?? []).length, 1);
    const freshIndex = replay.findIndex((item) => JSON.stringify(item).includes("FRESH_REPLAY_USER"));
    assert.ok(freshIndex > replayCheckpoint + stored.replacementHistory.length - 1);
  } finally {
    await f.close();
  }
});
