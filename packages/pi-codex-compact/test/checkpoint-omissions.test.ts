import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionProjection,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  createCheckpointDetails,
  fallbackSummary,
  fingerprintMessage,
  projectCheckpointContext,
} from "../src/checkpoint.js";

const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp });
function fixture(omit: number[] = [1]) {
  const messages = [user("first", 1), user("omitted", 2), user("last", 3)];
  const details = createCheckpointDetails({
    provider: "openai",
    api: "openai-responses",
    profile: "openai-responses-v1",
    modelId: "fixture",
    protocol: "context-management",
    replacementHistory: [{ type: "compaction", encrypted_content: "fixture" }],
    keptMessages: messages,
    checkpointId: "legacy-checkpoint",
  });
  const entries: SessionEntry[] = messages.map((message, i) => ({
    type: "message",
    id: `m${i}`,
    parentId: i ? `m${i - 1}` : null,
    timestamp: new Date(i + 1).toISOString(),
    message,
  }));
  for (const i of omit)
    entries.push({
      type: "context_edit",
      id: `edit${i}`,
      parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date(4).toISOString(),
      targetId: `m${i}`,
      replacement: null,
    });
  entries.push({
    type: "compaction",
    id: "checkpoint",
    parentId: entries.at(-1)?.id ?? null,
    timestamp: new Date(5).toISOString(),
    summary: fallbackSummary(details.checkpointId),
    firstKeptEntryId: "m0",
    tokensBefore: 100,
    details,
  });
  entries.push({
    type: "message",
    id: "tail",
    parentId: "checkpoint",
    timestamp: new Date(6).toISOString(),
    message: user("new prompt", 6),
  });
  return { entries, details, messages, summary: fallbackSummary(details.checkpointId) };
}
function replay(f: ReturnType<typeof fixture>, entries = f.entries, messages?: AgentMessage[]) {
  return projectCheckpointContext(
    messages ?? buildSessionProjection(entries, entries.at(-1)?.id ?? null).messages,
    f.details,
    f.summary,
    entries,
  );
}

test("legacy raw retained span replays only proven null-edit omissions at beginning, middle, end or all", () => {
  for (const omitted of [[0], [1], [2], [0, 1, 2]]) {
    const f = fixture(omitted);
    const projected = replay(f);
    assert.ok(projected, `omitted indices ${omitted}`);
    assert.equal(projected.length, 2);
    assert.deepEqual(projected[1], user("new prompt", 6));
    assert.deepEqual(replay(f), projected, "repeat projection is deterministic");
    assert.equal(
      projectCheckpointContext(buildSessionProjection(f.entries, "tail").messages, f.details, f.summary),
      undefined,
      "missing original evidence must not authorize omissions",
    );
  }
});

test("projection proof accepts a later null edit but rejects content replacement, restoration and sibling edits", () => {
  const f = fixture([]);
  const edit: SessionEntry = {
    type: "context_edit",
    id: "later-edit",
    parentId: "tail",
    timestamp: new Date(7).toISOString(),
    targetId: "m1",
    replacement: null,
  };
  assert.ok(replay(f, [...f.entries, edit]));
  assert.equal(replay(f, [...f.entries, { ...edit, replacement: { content: "changed" } }]), undefined);
  const omitted = fixture();
  assert.equal(
    replay(omitted, [...omitted.entries, { ...edit, id: "restore", replacement: { content: "changed" } }]),
    undefined,
  );
  assert.equal(
    replay(
      f,
      [...f.entries, { ...edit, parentId: "m1" }],
      buildSessionProjection([...f.entries, edit], edit.id).messages,
    ),
    undefined,
    "off-branch edit is not evidence",
  );
});

test("missing/changed raw evidence, boundary drift, and reordered fingerprints fail closed", () => {
  const f = fixture();
  assert.equal(
    replay(
      f,
      f.entries.map((e) =>
        e.id === "m1" && e.type === "message" ? { ...e, message: user("corrupted omitted payload", 2) } : e,
      ),
    ),
    undefined,
  );
  const missing = f.entries
    .filter((e) => e.id !== "m1")
    .map((e) => (e.parentId === "m1" ? { ...e, parentId: "m0" } : e));
  assert.equal(replay(f, missing), undefined);
  assert.equal(
    replay(
      f,
      f.entries.map((e) => (e.type === "compaction" ? { ...e, firstKeptEntryId: "missing" } : e)),
    ),
    undefined,
  );
  const changed = { ...f.details, keptMessageFingerprints: [...f.details.keptMessageFingerprints].reverse() };
  assert.equal(
    projectCheckpointContext(buildSessionProjection(f.entries, "tail").messages, changed, f.summary, f.entries),
    undefined,
  );
  const visible = buildSessionProjection(f.entries, "tail").messages;
  assert.equal(
    replay(
      f,
      f.entries,
      visible.filter((m) => m.role !== "user" || m.timestamp !== 3),
    ),
    undefined,
    "context-hook loss of a visible retained message is unexplained",
  );
  assert.equal(
    replay(
      f,
      f.entries,
      visible.map((m) => (m.role === "user" && m.timestamp === 3 ? user("changed", 3) : m)),
    ),
    undefined,
  );
});

test("an omitted duplicate before firstKeptEntryId cannot excuse a missing retained fingerprint", () => {
  const f = fixture([]);
  const early: SessionEntry = {
    type: "message",
    id: "early",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: f.messages[1],
  };
  const edit: SessionEntry = {
    type: "context_edit",
    id: "early-edit",
    parentId: "early",
    timestamp: new Date(0).toISOString(),
    targetId: "early",
    replacement: null,
  };
  const entries = [
    early,
    edit,
    ...f.entries
      .filter((e) => e.id !== "m1")
      .map((e) =>
        e.id === "m0" ? { ...e, parentId: "early-edit" } : e.parentId === "m1" ? { ...e, parentId: "m0" } : e,
      ),
  ];
  assert.equal(replay(f, entries), undefined);

  // Nearest unsafe repair: waive any expected hash that matches a null-edited
  // raw message anywhere on the branch. This passes ordinary omission fixtures
  // but admits the earlier duplicate outside the checkpoint's retained span.
  const omittedIds = new Set(
    entries.flatMap((entry) => (entry.type === "context_edit" && entry.replacement === null ? [entry.targetId] : [])),
  );
  const omittedHashes = new Set(
    entries.flatMap((entry) =>
      omittedIds.has(entry.id) ? sessionEntryToContextMessages(entry).map(fingerprintMessage) : [],
    ),
  );
  const unsafeDetails = {
    ...f.details,
    keptMessageFingerprints: f.details.keptMessageFingerprints.filter((hash) => !omittedHashes.has(hash)),
  };
  assert.ok(
    projectCheckpointContext(buildSessionProjection(entries, "tail").messages, unsafeDetails, f.summary),
    "the unsafe generic omission bypass admits this counterexample; the real repair must reject it",
  );
});
