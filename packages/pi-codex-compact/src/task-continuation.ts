import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { validateContextManagementHistory } from "./context-management.js";
import { CodexCompactionProtocolError, type JsonObject } from "./protocol.js";

const TASK_CONTINUATION_MESSAGE =
  "[PI_TASK_CONTINUATION_V1] Compaction finished while the current task was still in progress. " +
  "The maintenance-only instructions and any OK response applied only to compaction; they do not mark the task complete. " +
  "Continue the latest unfinished user task from the checkpoint. " +
  "First reconcile completed tool results and current execution state; do not repeat completed actions. " +
  "Follow any newer user instructions after this message. If the task is already complete, do not start additional work.";

export function createTaskContinuationItem(): JsonObject {
  return { role: "user", content: [{ type: "input_text", text: TASK_CONTINUATION_MESSAGE }] };
}

export function shouldContinueTask(event: SessionBeforeCompactEvent, ctx: ExtensionContext): boolean {
  // isIdle() is also false during manual compaction. The live run signal is the
  // public distinction between in-loop threshold and post-answer maintenance.
  return (
    event.reason !== "manual" &&
    ((ctx.signal !== undefined && !ctx.signal.aborted) || (event.reason === "overflow" && event.willRetry))
  );
}

export function shouldDeferThresholdCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext): boolean {
  // The owner distinguishes a just-completed run from the next prompt's
  // preflight. A live signal identifies active in-loop compaction.
  const assistant = [...event.branchEntries]
    .reverse()
    .find((entry) => entry.type === "message" && entry.message.role === "assistant");
  return (
    event.reason === "threshold" &&
    ctx.signal === undefined &&
    assistant?.type === "message" &&
    assistant.message.role === "assistant" &&
    assistant.message.stopReason === "stop"
  );
}

/** Provider output stays strict; only stored history may end with our exact item. */
export function validateStoredContextManagementHistory(
  history: readonly unknown[],
  options: { byteBudget: number; tokenBudget?: number },
): JsonObject[] {
  const continuation = createTaskContinuationItem();
  if (!isDeepStrictEqual(history.at(-1), continuation)) return validateContextManagementHistory(history, options);
  if (
    Buffer.byteLength(JSON.stringify(history), "utf8") > options.byteBudget ||
    (options.tokenBudget !== undefined && JSON.stringify(history.slice(1)).length > options.tokenBudget * 4)
  ) {
    throw new CodexCompactionProtocolError("Task continuation exceeded the replacement history limit");
  }
  return [...validateContextManagementHistory(history.slice(0, -1), options), continuation];
}
