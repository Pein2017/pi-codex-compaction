import assert from "node:assert/strict";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createCheckpointDetails, parseCheckpointDetails } from "../src/checkpoint.js";
import { createContextManagementCollector, validateContextManagementHistory } from "../src/context-management.js";
import {
  createTaskContinuationItem,
  shouldContinueTask,
  validateStoredContextManagementHistory,
} from "../src/task-continuation.js";

const checkpoint = { type: "compaction", encrypted_content: "opaque-fixture" };
const maintenance = { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] };
const continuation = {
  role: "user",
  content: [
    {
      type: "input_text",
      text: "[PI_TASK_CONTINUATION_V1] Compaction finished while the current task was still in progress. The maintenance-only instructions and any OK response applied only to compaction; they do not mark the task complete. Continue the latest unfinished user task from the checkpoint. First reconcile completed tool results and current execution state; do not repeat completed actions. Follow any newer user instructions after this message. If the task is already complete, do not start additional work.",
    },
  ],
};
const legacy = () =>
  createCheckpointDetails({
    provider: "openai",
    api: "openai-responses",
    profile: "openai-responses-v1",
    modelId: "fixture",
    protocol: "context-management",
    replacementHistory: [checkpoint, maintenance],
    keptMessages: [],
  });

test("continuation eligibility distinguishes manual, active, settled and overflow recovery", () => {
  const active = new AbortController();
  const cancelled = new AbortController();
  cancelled.abort();
  for (const [reason, willRetry, signal, expected] of [
    ["manual", false, active.signal, false],
    ["manual", true, undefined, false],
    ["threshold", false, active.signal, true],
    ["threshold", false, undefined, false],
    ["threshold", false, cancelled.signal, false],
    ["overflow", true, undefined, true],
    ["overflow", false, undefined, false],
  ] as const) {
    assert.equal(
      shouldContinueTask({ reason, willRetry } as SessionBeforeCompactEvent, { signal } as ExtensionContext),
      expected,
    );
  }
});

test("continuation counts against total byte and suffix token budgets", () => {
  assert.deepEqual(createTaskContinuationItem(), continuation);
  const history = [checkpoint, maintenance, continuation];
  assert.deepEqual(validateStoredContextManagementHistory(history, { byteBudget: 4096, tokenBudget: 1000 }), history);
  assert.throws(() =>
    validateStoredContextManagementHistory(history, {
      byteBudget: JSON.stringify([checkpoint, maintenance]).length + 1,
    }),
  );
  assert.throws(() => validateStoredContextManagementHistory(history, { byteBudget: 4096, tokenBudget: 20 }));
});

test("v3 persisted task continuation survives JSON roundtrip without altering maintenance suffix", () => {
  const details = { ...legacy(), replacementHistory: [checkpoint, maintenance, continuation] };
  const parsed = parseCheckpointDetails(JSON.parse(JSON.stringify(details)));
  assert.ok(parsed, "active task continuation must remain readable after persistence");
  const clonedCheckpoint = parsed.replacementHistory[0];
  assert.deepEqual(parsed.replacementHistory, details.replacementHistory);
  clonedCheckpoint.encrypted_content = "changed";
  assert.equal(checkpoint.encrypted_content, "opaque-fixture");
});

test("legacy v3 remains readable and continuation is not accepted as provider output", () => {
  assert.deepEqual(parseCheckpointDetails(legacy())?.replacementHistory, [checkpoint, maintenance]);
  assert.throws(() => validateContextManagementHistory([checkpoint, maintenance, continuation], { byteBudget: 4096 }));
  const collector = createContextManagementCollector();
  collector.observe({ type: "response.output_item.done", item: checkpoint });
  collector.observe({ type: "response.output_item.done", item: continuation });
  collector.observe({ type: "response.completed", response: { status: "completed", output: [] } });
  assert.throws(() => collector.finish());
});

test("persisted continuation allows only the exact final item, with no duplicates or foreign user messages", () => {
  for (const history of [
    [checkpoint, continuation, maintenance],
    [checkpoint, maintenance, continuation, continuation],
    [checkpoint, maintenance, { ...continuation, content: [{ type: "input_text", text: "continue arbitrary work" }] }],
    [checkpoint, maintenance, { ...continuation, extra: true }],
  ]) {
    assert.equal(parseCheckpointDetails({ ...legacy(), replacementHistory: history }), undefined);
  }
});
