import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Explicit qualification runner: pins both the session caller and extension peers.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = join(root, "packages/pi-codex-compact");
const installed =
  process.env.PI_COMPACT_SDK_ROOT ??
  resolve(root, "../pi-core/.local/install/releases/1.0.3/node_modules/@earendil-works");
const sdkEntry = join(installed, "pi-coding-agent/dist/index.js");
const sdk = await import(pathToFileURL(sdkEntry).href);
const { createJiti } = createRequire(sdkEntry)("jiti");
const aliases = Object.fromEntries(
  ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"].map((name) => [
    `@earendil-works/${name}`,
    join(installed, name, "dist/index.js"),
  ]),
);
const jiti = createJiti(import.meta.url, { alias: aliases, moduleCache: false });
const { createCodexCompactExtension } = await jiti.import(join(packageRoot, "src/codex-compact.ts"));
const { DEFAULT_CODEX_COMPACT_SETTINGS } = await jiti.import(join(packageRoot, "src/settings.ts"));
const { parseCheckpointDetails } = await jiti.import(join(packageRoot, "src/checkpoint.ts"));
const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
const facts = [];
const opaque = { type: "compaction", id: "cmp_affinity_sdk", encrypted_content: "SYNTHETIC_OPAQUE" };
function finish(response, items, inputTokens = 50) {
  const events = items.flatMap((item, output_index) => [
    { type: "response.output_item.added", output_index, item },
    { type: "response.output_item.done", output_index, item },
  ]);
  events.push({
    type: "response.completed",
    response: {
      id: "resp_local",
      status: "completed",
      output: items,
      usage: { input_tokens: inputTokens, output_tokens: 1, total_tokens: inputTokens + 1 },
    },
  });
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}
const answer = {
  type: "message",
  id: "msg_local",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "ACK", annotations: [] }],
};
async function fixture(enabled, generated = false, forced = false, withTool = false) {
  const dir = await mkdtemp(join(tmpdir(), "compact-affinity-sdk-"));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const requests = [];
  const notices = [];
  let pause;
  let entered;
  let ready;
  let toolCalls = 0;
  let ordinaryCount = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const payload = JSON.parse(body);
    requests.push({ body, payload, headers: req.headers });
    if (requests.length > 12) {
      res.writeHead(500);
      res.end();
      return;
    }
    if (payload.context_management && pause) {
      entered();
      await pause;
    }
    if (!payload.context_management && ++ordinaryCount === 1 && withTool) {
      finish(
        res,
        [
          {
            type: "function_call",
            id: "fc_once",
            call_id: "call_once",
            name: "effect_once",
            arguments: "{}",
            status: "completed",
          },
        ],
        7500,
      );
    } else finish(res, payload.context_management ? [opaque] : [answer]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const settings = {
    ...DEFAULT_CODEX_COMPACT_SETTINGS,
    protocol: "context-management",
    maxRetries: 0,
    preserveCacheAffinity: enabled,
    checkpointRecovery: "cancel",
    notifyOnFallback: true,
  };
  const state = { kind: "loaded", path: join(agentDir, "pi-codex-compact.json"), document: settings, settings };
  await writeFile(state.path, JSON.stringify(settings));
  const settingsRuntime = {
    get: () => structuredClone(state),
    reload: async () => structuredClone(state),
    update: async () => {
      throw Error("unused");
    },
    flush: async () => {},
  };
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("openai", {
    api: "openai-responses",
    apiKey: "synthetic-key",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [
      {
        id: "affinity-fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: withTool ? 8192 : 32768,
        maxTokens: 128,
      },
    ],
  });
  const factories = generated ? [] : [createCodexCompactExtension({ settingsRuntime })];
  if (forced)
    factories.push((pi) => {
      pi.on("before_agent_start", () => ({ systemPrompt: "FORCED_EFFECTIVE" }));
    });
  const loader = new sdk.DefaultResourceLoader({
    cwd: dir,
    agentDir,
    settingsManager: sdk.SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: generated ? [join(packageRoot, "dist/index.ts")] : [],
    extensionFactories: factories,
    systemPrompt: "BASE_INSTRUCTION",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: withTool, keepRecentTokens: withTool ? 256 : 0, reserveTokens: withTool ? 1024 : 128 },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    cacheWarming: "off",
    transport: "sse",
  });
  let manager = sdk.SessionManager.create(dir, join(dir, "sessions"));
  let session;
  const open = async () => {
    ({ session } = await sdk.createAgentSession({
      cwd: dir,
      agentDir,
      modelRuntime: runtime,
      model: runtime.getModel("openai", "affinity-fixture"),
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
      tools: withTool ? ["effect_once"] : [],
      customTools: withTool
        ? [
            {
              name: "effect_once",
              label: "Effect",
              description: "Execute once.",
              parameters: { type: "object", properties: {} },
              execute: async () => {
                toolCalls++;
                return {
                  content: [{ type: "text", text: "DONE " + "padding ".repeat(250) }],
                  details: { completed: true },
                };
              },
            },
          ]
        : [],
      thinkingLevel: "off",
    }));
    await session.bindExtensions({
      mode: "rpc",
      uiContext: { notify: (text) => notices.push(text), setStatus() {}, setWidget() {} },
      onError: (error) => notices.push(JSON.stringify(error)),
    });
  };
  await open();
  return {
    requests,
    notices,
    get toolCalls() {
      return toolCalls;
    },
    get session() {
      return session;
    },
    get manager() {
      return manager;
    },
    async reopen() {
      const path = manager.getSessionFile();
      session.dispose();
      await loader.reload();
      manager = sdk.SessionManager.open(path);
      await open();
    },
    block() {
      const waiting = new Promise((resolve) => {
        entered = resolve;
      });
      pause = new Promise((resolve) => {
        ready = resolve;
      });
      return waiting;
    },
    release() {
      ready?.();
      pause = undefined;
    },
    async close() {
      ready?.();
      await session.abort();
      session.dispose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    },
  };
}
function contrast(ordinary, maintenance) {
  const first = ordinary.input.findIndex((item, i) => JSON.stringify(item) !== JSON.stringify(maintenance.input[i]));
  return {
    instructions: [hash(ordinary.instructions), hash(maintenance.instructions)],
    tools: [hash(ordinary.tools), hash(maintenance.tools)],
    input: [hash(ordinary.input), hash(maintenance.input)],
    firstDivergence: first < 0 ? ordinary.input.length : first,
    inputLengths: [ordinary.input.length, maintenance.input.length],
    positions: maintenance.input.map((item, index) => ({ index, role: item.role ?? item.type, hash: hash(item) })),
  };
}
for (const generated of [false, true]) {
  if (generated && process.env.PI_COMPACT_BASELINE === "1") continue;
  test(`${generated ? "generated Jiti" : "source"} installed SDK public caller: prefix, repeated compact, reopen, exact opaque tail`, async () => {
    const f = await fixture(true, generated);
    try {
      await f.session.prompt("SYNTHETIC_FIRST");
      await f.session.prompt("SYNTHETIC_SECOND");
      const ordinary = f.requests.at(-1).payload;
      const result = await f.session.compact();
      const maintenance = f.requests.at(-1).payload;
      const evidence = contrast(ordinary, maintenance);
      facts.push({ generated, phase: "pre-checkpoint", ...evidence });
      assert.ok(parseCheckpointDetails(result.details), f.notices.join("; "));
      if (process.env.PI_COMPACT_BASELINE === "1") {
        assert.equal(evidence.firstDivergence, 0, "before repair the first system input is duplicated");
        assert.ok(JSON.stringify(maintenance.input[0]).length > JSON.stringify(ordinary.input[0]).length);
        return;
      }
      assert.equal(maintenance.prompt_cache_key, f.manager.getSessionId());
      assert.deepEqual(maintenance.input.slice(0, ordinary.input.length), ordinary.input);
      assert.deepEqual(maintenance.tools, ordinary.tools);
      assert.equal(maintenance.instructions, ordinary.instructions);
      assert.equal(maintenance.tool_choice, "none");
      assert.equal(maintenance.store, false);
      await f.reopen();
      await f.session.prompt("SYNTHETIC_NEW_TAIL");
      const replay = f.requests.at(-1).payload;
      assert.equal(replay.input.filter((item) => item.type === "compaction").length, 1);
      assert.deepEqual(
        replay.input.find((item) => item.type === "compaction"),
        opaque,
      );
      assert.ok(JSON.stringify(replay.input).includes("SYNTHETIC_NEW_TAIL"));
      assert.ok(!JSON.stringify(replay.input).includes("SYNTHETIC_FIRST"));
      await f.session.compact().catch((error) => {
        throw new Error(`${error.message}: ${f.notices.join("; ")}`);
      });
      const second = f.requests.at(-1).payload;
      assert.equal(second.input.filter((item) => item.type === "compaction").length, 1);
      assert.deepEqual(second.input.slice(0, replay.input.length), replay.input);
      facts.push({ generated, phase: "checkpoint-epoch", ...contrast(replay, second) });
    } finally {
      await f.close();
    }
  });
}
if (process.env.PI_COMPACT_BASELINE !== "1")
  test("installed SDK generated cancellation publishes no checkpoint", async () => {
    const f = await fixture(true, true);
    try {
      await f.session.prompt("CANCEL_FIXTURE");
      const before = f.manager.getEntries().filter((e) => e.type === "compaction").length;
      const entered = f.block();
      const pending = f.session.compact().then(
        () => "resolved",
        () => "rejected",
      );
      await entered;
      f.session.abortCompaction();
      f.release();
      await pending;
      assert.equal(f.manager.getEntries().filter((e) => e.type === "compaction").length, before);
    } finally {
      await f.close();
    }
  });
if (process.env.PI_COMPACT_BASELINE !== "1")
  for (const forced of [false, true])
    test(`installed SDK generated active-task continuation, forced=${forced}, no repeated tool`, async () => {
      const f = await fixture(true, true, forced, true);
      try {
        await f.session.prompt("Run effect_once once, then finish. " + "Synthetic context. ".repeat(250));
        assert.equal(f.toolCalls, 1);
        const maintenance = f.requests.filter((r) => r.payload.context_management);
        const ordinary = f.requests.filter((r) => !r.payload.context_management);
        assert.equal(maintenance.length, 1);
        assert.equal(ordinary.length, 2);
        assert.equal(maintenance[0].payload.prompt_cache_key, f.manager.getSessionId());
        assert.equal(JSON.stringify(ordinary[1].payload.input).split("[PI_TASK_CONTINUATION_V1]").length - 1, 1);
        assert.equal(ordinary[1].payload.input.filter((item) => item.type === "compaction").length, 1);
        if (forced) {
          assert.ok(JSON.stringify(ordinary[0].payload.input).includes("FORCED_EFFECTIVE"));
          assert.ok(JSON.stringify(maintenance[0].payload.input).includes("FORCED_EFFECTIVE"));
          assert.ok(JSON.stringify(maintenance[0].payload.input).includes("BASE_INSTRUCTION"));
        }
        facts.push({
          generated: true,
          phase: forced ? "forced-effective-conservative" : "active-task",
          toolExecutions: f.toolCalls,
          ...contrast(ordinary[0].payload, maintenance[0].payload),
        });
      } finally {
        await f.close();
      }
    });

test.after(async () => {
  const receipt = process.env.PI_COMPACT_PREFIX_RECEIPT;
  if (receipt)
    await writeFile(
      receipt,
      JSON.stringify(
        { sdk: JSON.parse(await readFile(join(installed, "pi-ai/package.json"), "utf8")).version, facts },
        null,
        2,
      ) + "\n",
    );
});
