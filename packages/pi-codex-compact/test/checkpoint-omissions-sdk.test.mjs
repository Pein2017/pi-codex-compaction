import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Explicit, read-only qualification of the historical JSONL through the managed
// SDK and source extension. No SessionManager.open(): even migrations must not
// touch this evidence. All session mutations use the SDK's in-memory manager.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const installed =
  process.env.PI_COMPACT_SDK_ROOT ??
  resolve(root, "../pi-core/.local/install/releases/1.0.3/node_modules/@earendil-works");
const sdkEntry = join(installed, "pi-coding-agent/dist/index.js");
const sdk = await import(pathToFileURL(sdkEntry).href);
const { createJiti } = createRequire(sdkEntry)("jiti");
const jiti = createJiti(import.meta.url, {
  alias: Object.fromEntries(
    ["pi-ai", "pi-agent-core", "pi-coding-agent", "pi-tui"].map((name) => [
      `@earendil-works/${name}`,
      join(installed, name, "dist/index.js"),
    ]),
  ),
  moduleCache: false,
});
const source = process.env.PI_COMPACT_TEST_SOURCE ?? join(root, "packages/pi-codex-compact/src");
const { createCodexCompactExtension } = await jiti.import(join(source, "codex-compact.ts"));
const { DEFAULT_CODEX_COMPACT_SETTINGS } = await jiti.import(join(source, "settings.ts"));
const { latestCheckpoint, fingerprintMessage, projectCheckpointContext } = await jiti.import(
  join(source, "checkpoint.ts"),
);
const jsonl = process.env.PI_COMPACT_SESSION_JSONL;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
function response(items) {
  const events = items.flatMap((item, output_index) => [
    { type: "response.output_item.added", output_index, item },
    { type: "response.output_item.done", output_index, item },
  ]);
  events.push({
    type: "response.completed",
    response: {
      id: "resp_fixture",
      status: "completed",
      output: items,
      usage: { input_tokens: 20, output_tokens: 1, total_tokens: 21 },
    },
  });
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
const answer = (text) => ({
  type: "message",
  id: "msg_fixture",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const opaque = { type: "compaction", encrypted_content: "SYNTHETIC_REPLACEMENT" };

const generatedEntry = process.env.PI_COMPACT_TEST_ENTRY;
const modes = generatedEntry
  ? ["responses-compact", "recovery", "recovery-retain128"]
  : ["context-management", "remote-v2", "responses-compact", "recovery", "recovery-retain128"];
for (const mode of modes) {
  test(`installed SDK: historical checkpoint replay and ${mode}`, { skip: !jsonl }, async () => {
    const bytes = await readFile(jsonl);
    const entries = bytes.toString("utf8").trim().split("\n").map(JSON.parse);
    const header = entries[0];
    const byId = new Map(entries.slice(1).map((e) => [e.id, e]));
    const branch = [];
    for (let entry = byId.get("760c177f"); entry; entry = byId.get(entry.parentId)) branch.unshift(entry);
    const checkpoint = latestCheckpoint(branch);
    assert.ok(checkpoint);
    assert.equal(checkpoint.entry.id, "760c177f");
    const raw = byId.get("178c1607");
    assert.equal(checkpoint.details.keptMessageFingerprints[15], fingerprintMessage(raw.message));
    const projection = sdk.buildSessionProjection(branch, checkpoint.entry.id);
    assert.deepEqual(projection.entries.find((e) => e.sourceEntry.id === raw.id).messages, []);
    assert.equal(
      projectCheckpointContext(projection.messages, checkpoint.details, checkpoint.entry.summary),
      undefined,
    );

    const directory = await mkdtemp(join(tmpdir(), "compact-omissions-sdk-"));
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    const oldFetch = globalThis.fetch;
    process.env.PI_CODING_AGENT_DIR = directory;
    let session;
    const payloads = [];
    const errors = [];
    const notices = [];
    let cutEvidence;
    const recovery = mode.startsWith("recovery");
    try {
      const settings = {
        ...DEFAULT_CODEX_COMPACT_SETTINGS,
        protocol: recovery ? "context-management" : mode,
        maxRetries: 0,
        checkpointRecovery: recovery ? "summarize" : "cancel",
      };
      const state = { kind: "loaded", path: join(directory, "unused-settings.json"), document: {}, settings };
      const settingsRuntime = {
        get: () => state,
        reload: async () => state,
        flush: async () => {},
        update: async () => {
          throw Error("unexpected settings write");
        },
      };
      const coreSettings = sdk.SettingsManager.inMemory({
        compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: mode === "recovery-retain128" ? 128 : 1 },
        retry: { enabled: false, provider: { maxRetries: 0 } },
        transport: "sse",
        cacheWarming: "off",
        defaultTools: [],
      });
      const runtime = await sdk.ModelRuntime.create({
        authPath: join(directory, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      runtime.registerProvider("openai", {
        api: "openai-responses",
        apiKey: "synthetic-key",
        baseUrl: "http://127.0.0.1:1/v1",
        models: [
          {
            id: checkpoint.details.modelId,
            reasoning: false,
            input: ["text"],
            cost: zeroCost,
            contextWindow: 2_000_000,
            maxTokens: 128,
          },
        ],
      });
      const loader = new sdk.DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager: coreSettings,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        additionalExtensionPaths: generatedEntry ? [generatedEntry] : [],
        extensionFactories: [
          (pi) =>
            pi.on("session_before_compact", (event) => {
              const projected = sdk.buildSessionProjection(event.branchEntries, event.branchEntries.at(-1)?.id);
              const cut = projected.entries.findIndex((e) => e.sourceEntry.id === event.preparation.firstKeptEntryId);
              const kept = projected.entries
                .slice(cut)
                .flatMap((e) => e.messages)
                .filter((m) => m.role !== "system");
              const current = projectCheckpointContext(
                projected.messages,
                checkpoint.details,
                checkpoint.entry.summary,
                event.branchEntries,
              );
              const suffix = current.slice(-kept.length);
              cutEvidence = {
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                keptRoles: kept.map((m) => m.role),
                projectedSuffixRoles: suffix.map((m) => m.role),
                cutAlreadyCheckpointed: checkpoint.details.keptMessageFingerprints.includes(
                  fingerprintMessage(kept[0]),
                ),
                exactSuffix:
                  kept.length <= current.length &&
                  kept.every((m, i) => fingerprintMessage(m) === fingerprintMessage(suffix[i])),
              };
            }),
          ...(generatedEntry ? [] : [createCodexCompactExtension({ settingsRuntime })]),
        ],
        systemPrompt: "Synthetic test only.",
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const manager = sdk.SessionManager.inMemory(directory, undefined, structuredClone([header, ...branch]));
      assert.equal(manager.isPersisted(), false);
      ({ session } = await sdk.createAgentSession({
        cwd: directory,
        agentDir: directory,
        modelRuntime: runtime,
        model: runtime.getModel("openai", checkpoint.details.modelId),
        thinkingLevel: "off",
        tools: [],
        settingsManager: coreSettings,
        sessionManager: manager,
        resourceLoader: loader,
      }));
      await session.bindExtensions({
        mode: "rpc",
        onError: (error) => errors.push(error),
        uiContext: { notify: (text) => notices.push(text), setStatus() {}, setWidget() {} },
      });
      globalThis.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        assert.equal(new URL(request.url).origin, "http://127.0.0.1:1", "no paid endpoint permitted");
        const payload = JSON.parse(await request.text());
        payloads.push(payload);
        assert.ok(payloads.length <= 4, "bounded local calls");
        assert.ok(
          payload.input.some(
            (item) =>
              item.type === "compaction" &&
              item.encrypted_content === checkpoint.details.replacementHistory[0].encrypted_content,
          ),
          "every caller must replay the original opaque checkpoint",
        );
        assert.doesNotMatch(JSON.stringify(payload), /PI_CODEX_REMOTE_CHECKPOINT|stores the older history opaquely/);
        if (JSON.stringify(payload).includes("Summarize the preceding conversation"))
          return response([answer("Recovered synthetic plaintext.")]);
        const maintenance =
          payload.context_management ||
          payload.input.some((item) => item.type === "compaction_trigger") ||
          new URL(request.url).pathname.endsWith("/compact");
        if (maintenance && recovery)
          return Response.json({ error: { message: "synthetic remote failure" } }, { status: 400 });
        if (maintenance && mode === "responses-compact")
          return Response.json({ output: [opaque], usage: { input_tokens: 20, output_tokens: 1, total_tokens: 21 } });
        return response(maintenance ? [opaque] : [answer("Synthetic ordinary answer.")]);
      };
      await session.prompt("SYNTHETIC_NEXT_PROMPT");
      assert.equal(session.getLastAssistantText(), "Synthetic ordinary answer.");
      assert.equal(payloads.length, 1);
      if (mode === "recovery-retain128") {
        const before = manager.getBranch();
        await assert.rejects(session.compact(), /Compaction cancelled/);
        assert.equal(payloads.length, 2, "unsafe cut must cancel before a summary request");
        assert.ok(notices.some((text) => text.includes("Checkpoint recovery retained tail does not match")));
        if (!generatedEntry) {
          assert.equal(cutEvidence.exactSuffix, false);
          assert.equal(cutEvidence.firstKeptEntryId, "0c749964");
          assert.equal(cutEvidence.cutAlreadyCheckpointed, true);
          assert.deepEqual(cutEvidence.keptRoles, ["assistant", "user", "assistant"]);
          assert.deepEqual(cutEvidence.projectedSuffixRoles, ["system", "user", "assistant"]);
        }
        assert.deepEqual(manager.getBranch(), before, "cancellation must not publish a replacement");
        console.log(
          JSON.stringify({ limitation: "retained cut overlaps checkpoint-covered messages", ...cutEvidence }),
        );
        return;
      }
      const result = await session.compact().catch((error) => {
        throw new Error(`${error.message}; ${notices.join("; ")}`);
      });
      assert.ok(result);
      assert.deepEqual(errors, []);
      assert.equal(payloads.length, recovery ? 3 : 2);
      assert.equal(cutEvidence.exactSuffix, true);
      if (recovery) {
        assert.match(result.summary, /Recovered synthetic plaintext/);
        assert.equal(latestCheckpoint(manager.getBranch()), undefined);
        assert.equal(
          JSON.stringify(payloads[2]).includes("Synthetic ordinary answer."),
          false,
          "recovery must not summarize the separately retained assistant suffix",
        );
      } else {
        const next = latestCheckpoint(manager.getBranch());
        assert.equal(next.details.replacementHistory.at(-1).encrypted_content, opaque.encrypted_content);
        assert.equal(
          next.details.keptMessageFingerprints.includes(fingerprintMessage(raw.message)),
          false,
          "new producer must not perpetuate the legacy omitted fingerprint",
        );
      }
    } finally {
      session?.dispose();
      globalThis.fetch = oldFetch;
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      await rm(directory, { recursive: true, force: true });
      assert.equal(hash(await readFile(jsonl)), hash(bytes), "historical JSONL remains byte-identical");
    }
  });
}
