# Local compaction ownership

This independent CoordExp repository maintains `packages/pi-codex-compact` from
`narumiruna/pi-extensions`. The `upstream` remote retains source provenance;
local development and release do not publish to GitHub or npm. Other packages
are retained upstream source and build dependencies, not installed extensions.

## Runtime and releases

The shared CLI/Web profile is `/data/CoordExp/.pi`. Its `packages` setting selects
one versioned package under this repository's `.local/releases/`. Runtime loads
the packaged `dist/index.ts`, never editable source. Keep the original package
name for existing checkpoint identity and settings compatibility.

Local versions use `<upstream-version>-coordexp.<revision>`. After source review,
repository checks, tests and a local commit:

```bash
npm run release:codex-compact:local
```

The command builds and packs the compaction workspace, installs only its runtime
dependencies into the extracted package, and records the source/upstream commits
and tarball SHA-256. An existing release version is never overwritten. Generated
artifacts, installed dependencies and private qualification receipts stay ignored
under `.local/`; source and tests remain tracked in this repository.

Load-test the emitted package with the managed Pi SDK before replacing the old
npm source in the shared profile's `packages` setting with the absolute release
package path. Remove the old npm installation through Pi's package manager after
that switch. This preserves one configured source throughout adoption.
No global SDK, credentials, models, tools or compaction-protocol changes are needed.
New sessions use the selected release; already loaded sessions require `/reload`
while idle. Never reload an active user's session as part of installation.

## Validation boundary

Automatic compaction during an unfinished task restores one deterministic task
continuation after the checkpoint and completed maintenance output. Manual and
post-answer maintenance stay idle. Newer real user input follows the continuation.
The host execution loop owns retries and tool execution; the plugin starts no
additional turn. Existing v3 checkpoints without the continuation remain valid.

Deterministic SDK regressions establish ordering, persistence, cancellation and
tool execution counts. A bounded hosted smoke establishes the tested model's
observed continuation, not universal checkpoint recall or network reliability.
The inherited upstream repository gates remain `npm run check` and `npm test`.

The hosted smoke is explicitly opt-in:

```bash
node packages/pi-codex-compact/test/live-continuation.mjs --live
```

It uses the managed SDK and selected OpenAI ChatGPT credentials in an isolated
test session. It permits two normal requests, one compaction, one tool execution,
no automatic retry, and a four-minute deadline. The result receipt stays under
`.local/qualification/`; it never prompts or reloads a user's session. Stop after
one external/provider failure rather than rerunning the billed test automatically.

## Qualification on 2026-10-06

The local package's 377 tests pass. The six continuation regressions also pass
with the actually installed Pi SDK, including its generated runtime entrypoint.
They cover active automatic continuation, idle manual/post-answer compaction,
newer steering, cancellation and JSONL reload. The producer and reader regressions
failed against the original behavior before the repair. Package-owned build tests
also exercise generated imports and the lazily loaded settings menu.

`npm run check` passes. The full upstream monorepo suite reported 6,407 passing
and five failing tests: one old overflow-history assertion in this package was
updated and its affected checks pass; four failures belong to unchanged Starship,
Subagents, Typesafe Compact and runtime-builder tests. The latter is a five-second
timeout; the other diagnostics concern stderr warnings/length and root permission
semantics. All four reproduce against an unmodified checkout of the upstream
baseline in this environment. These failures are retained in ignored qualification
logs and do not qualify those unrelated modules.

The single hosted attempt timed out on its first normal request, before any tool
or compaction ran. Automatic continuation through a real hosted checkpoint remains
**HOLD**. Deterministic success does not clear that boundary. The failed receipt
is `.local/qualification/continuation-9UkwKX/result.json`; no retry was made.
