#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";

if (process.argv[2] !== "--live" || process.argv.length > 4) {
  throw new Error("Usage: node packages/pi-codex-compact/test/live-continuation.mjs --live [package-directory]");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const packagePath = path.resolve(process.argv[3] ?? path.join(root, "packages/pi-codex-compact"));
const sharedProfile = "/data/CoordExp/.pi";
const version = readFileSync(path.join(sharedProfile, "install/current-version"), "utf8").trim();
const sdkEntry = path.join(
  sharedProfile,
  "install/releases",
  version,
  "node_modules/@earendil-works/pi-coding-agent/dist/index.js",
);
const scratchRoot = path.join(root, ".local/qualification");
mkdirSync(scratchRoot, { recursive: true });
const directory = mkdtempSync(path.join(scratchRoot, "continuation-"));
const agentDir = path.join(directory, "agent");
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(
  path.join(agentDir, "pi-codex-compact.json"),
  JSON.stringify({ enabled: true, protocol: "context-management", maxRetries: 0, checkpointRecovery: "cancel" }),
);
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(
  pathToFileURL(sdkEntry).href
);
const runtime = await ModelRuntime.create({
  authPath: path.join(sharedProfile, "auth.json"),
  modelsPath: path.join(sharedProfile, "models.json"),
  refreshOnCreate: false,
});
const catalogModel = runtime.getModel("openai", "gpt-6-luna");
assert.ok(catalogModel, "selected model must exist in the actual managed catalog");
const model = { ...catalogModel, contextWindow: 10_000, maxTokens: 1024 };
const settings = SettingsManager.inMemory({
  compaction: { enabled: true, reserveTokens: 4000, keepRecentTokens: 100 },
  retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 120_000 } },
  defaultTools: [],
});
const expected = `continuity-${randomUUID()}`;
const observation = {
  sdkVersion: version,
  model: model.id,
  packagePath,
  toolCalls: 0,
  normalRequests: 0,
  compactions: 0,
  replayHadCheckpoint: false,
  replayHadContinuation: false,
  reasons: [],
  errors: [],
};
const observer = (pi) => {
  pi.on("session_before_compact", (event, ctx) => {
    observation.compactions += 1;
    observation.reasons.push(event.reason);
    if (observation.compactions > 1) {
      ctx.abort();
      return { cancel: true };
    }
  });
  pi.on("before_provider_request", (event, ctx) => {
    observation.normalRequests += 1;
    if (observation.normalRequests > 2) {
      ctx.abort();
      throw new Error("Bounded smoke exceeded two normal requests");
    }
    if (observation.normalRequests === 2) {
      const input = event.payload.input;
      observation.replayHadCheckpoint = input.some((item) => item.type === "compaction");
      observation.replayHadContinuation = input.some(
        (item) => item.role === "user" && JSON.stringify(item).includes("[PI_TASK_CONTINUATION_V1]"),
      );
    }
  });
};
const loader = new DefaultResourceLoader({
  cwd: directory,
  agentDir,
  settingsManager: settings,
  additionalExtensionPaths: [packagePath],
  extensionFactories: [observer],
  noExtensions: true,
  noContextFiles: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  systemPrompt:
    "Complete the user's bounded verification task. Use only the provided tool. Never repeat a completed tool call.",
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const manager = SessionManager.create(directory, path.join(directory, "sessions"));
const { session } = await createAgentSession({
  cwd: directory,
  agentDir,
  modelRuntime: runtime,
  model,
  thinkingLevel: "off",
  settingsManager: settings,
  sessionManager: manager,
  resourceLoader: loader,
  tools: ["checkpoint_probe"],
  customTools: [
    {
      name: "checkpoint_probe",
      label: "Checkpoint probe",
      description:
        "Read the one-use verification token. Call exactly once; it also returns padding for a compaction test.",
      parameters: Type.Object({}),
      execute: async () => {
        observation.toolCalls += 1;
        assert.equal(observation.toolCalls, 1, "completed side effect must not repeat");
        return {
          content: [
            {
              type: "text",
              text: `Verification token: ${expected}\nIgnore the following diagnostic padding: ${"padding ".repeat(3100)}`,
            },
          ],
          details: {},
        };
      },
    },
  ],
});
session.subscribe((event) => {
  if (
    event.type === "message_end" &&
    event.message.role === "assistant" &&
    ["error", "aborted"].includes(event.message.stopReason)
  )
    observation.errors.push(event.message.stopReason);
});
await session.bindExtensions({
  mode: "json",
  onError: (error) => observation.errors.push(error.event ?? "extension-error"),
});
const deadline = setTimeout(() => {
  observation.errors.push("deadline");
  void session.abort();
}, 240_000);
try {
  await session.prompt(
    "Call checkpoint_probe exactly once. After it returns, finish by replying with only its verification token. Do not stop at an acknowledgement and do not repeat the tool.",
  );
  const checkpoint = manager.getBranch().findLast((entry) => entry.type === "compaction");
  const answer = manager
    .getBranch()
    .findLast((entry) => entry.type === "message" && entry.message.role === "assistant")?.message;
  observation.checkpointProtocol = checkpoint?.details?.protocol;
  observation.finalStopReason = answer?.stopReason;
  observation.taskCompleted =
    answer?.content.some((part) => part.type === "text" && part.text.trim() === expected) ?? false;
  observation.passed =
    observation.toolCalls === 1 &&
    observation.normalRequests === 2 &&
    observation.compactions === 1 &&
    observation.replayHadCheckpoint &&
    observation.replayHadContinuation &&
    observation.checkpointProtocol === "context-management" &&
    observation.taskCompleted &&
    observation.errors.length === 0;
  assert.equal(
    observation.passed,
    true,
    "hosted continuation must finish the original task without a fresh user prompt",
  );
} finally {
  clearTimeout(deadline);
  await session.dispose();
  writeFileSync(path.join(directory, "result.json"), `${JSON.stringify(observation, null, 2)}\n`);
  console.log(JSON.stringify({ ...observation, receipt: path.join(directory, "result.json") }, null, 2));
}
