# 🗜️ pi-codex-compact — Use Codex Remote Compaction in Pi

This is the locally maintained CoordExp fork; the npm badge identifies upstream.

[![npm](https://img.shields.io/npm/v/@narumitw/pi-codex-compact)](https://www.npmjs.com/package/@narumitw/pi-codex-compact) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Use Responses compaction in Pi through Remote Compaction V2, unary `responses/compact`, or opt-in streaming `context_management`.
The extension stores an opaque server-generated checkpoint and replays it in later compatible requests instead of generating a local plaintext summary.
Pi still decides when compaction runs and keeps its normal `/compact`, threshold, overflow, and session-publication behavior.

## ✨ Features

- Supports `openai-codex-responses`, `openai-responses`, and `azure-openai-responses`, plus explicitly profiled custom APIs.
- Uses Remote V2, same-origin unary `responses/compact`, or experimental Context Management through the active provider and credentials.
- Handles manual, threshold, and overflow compaction through Pi's existing lifecycle.
- Validates and persists one bounded opaque checkpoint that survives compatible reloads, resumes, and forks.
- Replays the latest checkpoint while preserving newer conversation and extension context.
- Supports repeated and cross-protocol compaction by carrying the previous checkpoint forward.
- Falls back to Pi-native compaction without a checkpoint; with a checkpoint, tries a checkpoint-aware plaintext summary or safely cancels.
- Pauses repeated attempts on a session route after an exact OAuth operation rejection, without disabling compatible replay.
- Provides `/codex-compact` for effective-route status, settings, and manual compaction.

**Context Management is experimental and requires explicit opt-in.** It makes a normal inference request and consumes the active route's quota or API usage; support depends on the backend, model, and account. Default routing is unchanged.

## 📦 Install

For this fork, release from the repository root with
`npm run release:codex-compact:local` and select the resulting versioned package
under `.local/releases/`. Source review, commit, validation and adoption are
documented in the repository's `docs/local-compaction.md`.
Install only the compaction package; loading the monorepo root enables its other extensions.

The unmodified upstream package is available from npm:

```bash
pi install npm:@narumitw/pi-codex-compact
```

Try the published package without installing:

```bash
pi -e npm:@narumitw/pi-codex-compact
```

Try a local checkout from the repository root:

```bash
npm --workspace @narumitw/pi-codex-compact run build
pi -e ./packages/pi-codex-compact
```

The package declares `dist/index.ts`, so build a local checkout before loading its package directory.
Loading the package enables automatic Responses compaction routing with the documented defaults.
Do not load a global npm installation and the local workspace at the same time.

Pi extensions run with your user permissions.
Review third-party extension source before installing it.

## 🚀 Quick start

1. Sign in through Pi's built-in OpenAI, OpenAI Codex, or Azure OpenAI provider, or configure a compatible custom provider.
2. Select a model using `openai-codex-responses`, `openai-responses`, or `azure-openai-responses`.
3. Work normally; Pi's automatic compaction and built-in `/compact` continue to operate.

Run `/codex-compact` when you want to inspect the effective route or choose **Compact now**.
After successful remote compaction, compatible requests replay the opaque checkpoint automatically.
Signing in does not guarantee compaction permission; see [ChatGPT OAuth rejection](#chatgpt-oauth-rejection) if the backend refuses the operation.

With the default `auto` protocol, Codex Responses uses Remote V2 while OpenAI and Azure OpenAI Responses use unary `responses/compact`.
When the active model uses another API, compaction remains Pi-native unless an active opaque checkpoint requires safe cancellation.
To opt in a compatible custom API, add it to `apiProfiles` as described below.

## 💬 Commands

Run `/codex-compact` to inspect the effective compaction path, change settings, or request manual compaction in TUI mode.
It accepts no arguments.
RPC reports the manual settings path without compacting; print and JSON modes reject the command.
Closing the menu with Escape or Ctrl+C does not compact the session. Menu rendering inherits Kit's minimum one-cell width; synthetic zero-column renders are clamped to one cell.

Manual compaction uses **Responses Remote V2**, **Responses Compact API**, opt-in **Responses Context Management**, or **Pi native**, as described in [Settings](#-settings).
Pi's built-in `/compact` remains available and follows the same extension hook.

## ⚙️ Settings

The extension has one optional, global-only JSON settings file:

```text
<getAgentDir()>/pi-codex-compact.json
```

The normal path is `~/.pi/agent/pi-codex-compact.json`.
There is no environment-variable or project-level override.

```json
{
  "enabled": true,
  "deferPostAnswerCompaction": false,
  "protocol": "auto",
  "apiProfiles": {
    "custom-responses": "codex-responses-v1"
  },
  "requestTimeoutMs": 300000,
  "maxRetries": 2,
  "replacementTokenBudget": 64000,
  "notifyOnFallback": true,
  "checkpointRecovery": "summarize"
}
```

| Setting | Default | Accepted values | Behavior | Recommendation |
| --- | ---: | --- | --- | --- |
| `enabled` | `true` | Boolean | Attempt a supported remote compaction route. | Keep enabled unless diagnosing provider behavior. |
| `deferPostAnswerCompaction` | `false` | Boolean | Experimental: defer threshold compaction after a completed answer until the next prompt's preflight. | Enable to let completed answers settle immediately; the next prompt waits for required compaction before inference. |
| `protocol` | `"auto"` | `"auto"`, `"remote-v2"`, `"responses-compact"`, or `"context-management"` | Select by API or force one remote protocol. | Keep `auto` for existing routing; explicitly select experimental Context Management only on a compatible backend. |
| `apiProfiles` | `{}` | Object mapping a custom API id to `"codex-responses-v1"` | Explicitly opts a non-built-in API into Codex-compatible request fields and replay. | Leave empty unless the provider documents Codex Responses compatibility. |
| `requestTimeoutMs` | `300000` | Integer from 30,000 to 600,000 ms | Bound one extension-owned remote request. | Keep five minutes; increase only for a consistently slow connection. |
| `maxRetries` | `2` | Integer from 0 to 2 | Retry transient provider transport failures before Pi fallback. | Keep two; use zero when diagnosing the first failure. |
| `replacementTokenBudget` | `64000` | Integer from 8,000 to 128,000 tokens | Bound approximate retained user-message text; for Context Management, bound serialized post-checkpoint output instead. | Keep 64K. Context Management fails closed rather than truncating an oversized suffix. |
| `notifyOnFallback` | `true` | Boolean | Warn on remote failure and unsuccessful checkpoint recovery. | Keep enabled so silent fallback does not hide protocol or entitlement problems. |
| `checkpointRecovery` | `"summarize"` | `"summarize"` or `"cancel"` | After remote failure with an active checkpoint, try a normal inference summary or cancel without an extra request. Summary failure always cancels. | Use `summarize` for recovery; use `cancel` to avoid summary quota and preserve the checkpoint. |

Missing fields use defaults.
Settings reload on every `session_start`, including `/reload`, resume, and fork.
Menu writes apply immediately, preserve unknown JSON fields, serialize within the current Pi process, and use a final conflict check plus same-directory atomic rename.
On Unix, temporary files use mode `0600`.

Malformed, invalid, oversized, or symlinked settings files remain unchanged.
Defaults stay active, and the menu remains read-only until the file is fixed and Pi is reloaded.
Separate Pi processes do not share a mutation lock; a detected concurrent edit is rejected so the user can reopen Settings and retry.

### Experimental completed-answer deferral

Enable **Defer post-answer compaction** in `/codex-compact` → **Settings**, or set `"deferPostAnswerCompaction": true` and reload Pi. A normally finished answer can settle without a threshold compaction request. The next prompt compacts first, before its normal model request; reopening the saved session preserves that ordering. This applies only to supported remote routes. Turning remote compaction off or selecting an unsupported model retains Pi-native scheduling.

Manual `/compact` still executes immediately and waits for the next prompt. Threshold compaction during active work, queued follow-ups, context-overflow recovery and cancellation retain their existing behavior. This scheduling policy is qualified with the installed Pi SDK; it does not change Pi's threshold or establish parity with every Codex configuration.

### Relationship to Codex configuration

This extension does **not** read `~/.codex/config.toml`.

| Codex setting | Extension behavior |
| --- | --- |
| `features.remote_compaction_v2` | Conceptually corresponds to `protocol: "remote-v2"`; it is not imported. |
| `model_auto_compact_token_limit` | Not duplicated. Pi's own compaction threshold remains authoritative. |
| `model_auto_compact_token_limit_scope` | Not supported; Pi extensions do not own Codex's compact-window lineage. |
| `compact_prompt` / `experimental_compact_prompt_file` | Not imported; opaque checkpoints are generated by the server. |
| `features.token_budget` | Not supported; token-budget context reset is a different experimental strategy. |

## ✅ Requirements and compatibility

- Pi APIs compatible with the package's declared peer dependencies.
- One of `openai-codex-responses`, `openai-responses`, or `azure-openai-responses` on the active model, or an explicit `apiProfiles` entry for a custom Codex-compatible API.
- A provider whose HTTP Responses adapter honors Pi's public `onPayload` and injected `fetch` options; Context Management also requires ordered `onProviderStreamEvent` observations.
- A backend supporting the selected protocol and opaque `compaction` replay.
- Working credentials and any required compaction entitlement.

| Model API | `auto` route | Other selectable route |
| --- | --- | --- |
| `openai-codex-responses` | Responses Remote V2 | Responses Compact API, experimental Context Management |
| `openai-responses` | Responses Compact API | Responses Remote V2, experimental Context Management |
| `azure-openai-responses` | Responses Compact API | Responses Remote V2, experimental Context Management |

The installed built-in adapters are covered by deterministic transport tests.
A custom provider or proxy is eligible when its model explicitly uses one of these APIs, but its backend still owns compatible routing, authentication, request transforms, and opaque replay.
For a custom API label, eligibility is opt-in: `apiProfiles` must map that exact non-built-in label to `"codex-responses-v1"`. The default is empty, and an unconfigured custom API remains Pi-native.
`codex-responses-v1` uses Remote V2 in `auto` mode. With `responses-compact` explicitly selected, it retains the Codex Compact request fields, including tools and reasoning. The provider must honor Pi's public `transport: "sse"`, `onPayload`, and injected `fetch` options, and its backend must support the selected compaction protocol and opaque item replay. The profile declares compatibility; it does not probe the backend.
The extension does not send a separate capability probe or automatically retry a failed billable request through the other protocol.
A failed remote attempt uses native fallback without a checkpoint and [checkpoint recovery](#checkpoint-recovery) otherwise. An ordinary request cannot transparently recover after an incompatible provider has already received an existing opaque checkpoint.
Provider provenance is stored for diagnosis but is not a replay gate.
Switching providers can replay a checkpoint only when the API label, compatibility profile, and exact model ID still match. Custom API checkpoints also require a current matching `apiProfiles` entry; removing or changing it leaves Pi's visible fallback marker plus retained recent messages in context.

### Experimental Context Management

For a backend supporting [server-side compaction](https://developers.openai.com/api/docs/guides/compaction), select **Context Management (experimental)** in `/codex-compact` → **Settings** → **Protocol**, or save this global setting and reload Pi:

```json
{
  "protocol": "context-management"
}
```

This route was verified with Pi's official **OpenAI → Sign in with ChatGPT**, `gpt-5.5`, and streaming `api.openai.com/v1/responses`: it produced a checkpoint and recovered an assistant-only synthetic fact when replaying without the original plaintext. This is not a guarantee for other accounts, models, Azure, Codex, or proxies. Built-in adapter tests verify request/event plumbing, not hosted entitlement.

Pi still decides when to compact. Only the extension-owned compaction request adds `context_management: [{"type":"compaction","compact_threshold":1024}]`, forces streaming with `store: false`, requests `reasoning.encrypted_content` while preserving other `include` fields and the provider's thinking effort, and appends a deterministic maintenance-only user message. Original instructions, history, and tool schemas remain provider-owned; `tool_choice: "none"` prevents new tool work. The request uses no `compaction_trigger`, server-side response ID, alternate credentials, or endpoint rewrite.

Successful completed-item events are authoritative: a stream can emit several checkpoints while omitting them from terminal response output. The extension persists the latest checkpoint and its exact completed assistant/reasoning suffix only after successful completion (`response.completed` or Codex's `response.done`). Post-checkpoint reasoning must have non-empty encrypted content for stateless replay; terminal output can supply missing encryption before publication, otherwise the request follows the documented fallback/recovery policy. It never executes generated tools or silently truncates that suffix. Missing checkpoints, malformed/unsafe output, exceeded bounds, permission errors, and unsupported capabilities follow the same fallback/recovery policy; very short history may not cross the 1,024-token server threshold. The normal inference can consume quota even if no checkpoint is returned, and fallback/recovery can make an additional summarization request. Safe generated output is retained as provider context, not displayed as new assistant work.

Ordinary requests do not enable server compaction or add maintenance instructions. To stop new Context Management attempts, select `auto` or another protocol while leaving the extension enabled for compatible replay. Older package versions do not understand this protocol's checkpoints; retain a version supporting Context Management for sessions containing them.

During an unfinished automatic task, the local fork persists one deterministic continuation instruction after the completed maintenance output. Pi's existing execution loop continues without an extra user prompt or an additional extension-started turn. Manual compaction and automatic maintenance after a finished answer wait for the next prompt; [completed-answer deferral](#experimental-completed-answer-deferral) can also postpone the maintenance request itself. Newer user instructions follow the continuation and remain authoritative; completed tools must be reconciled before further actions.
Existing checkpoints remain readable in this fork. Checkpoints containing the new continuation item require this fork's reader; the unmodified upstream reader does not accept that item.

### ChatGPT OAuth rejection

Pi's **OpenAI → Sign in with ChatGPT** uses official OAuth with `openai-responses` at `api.openai.com`.
This is distinct from the legacy **OpenAI Codex** provider using `openai-codex-responses` at `chatgpt.com/backend-api/codex`; permission on one route does not establish permission on the other.
API-key, Azure, and custom-provider routes retain their existing behavior and backend-specific requirements.

OpenAI documents [streaming Responses inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) for ChatGPT plan usage. General API documentation for compaction controls does not establish OAuth authorization for unary `responses/compact` or Remote V2's final `compaction_trigger`.
The backend can reject a compaction operation with:

```text
code=hardened_oauth_rule_missing
type=rejected_by_hardened_oauth_boundary
message=This ChatPass credential is not authorized for the requested operation.
```

The extension reports this operation-specific rejection and pauses that remote operation for the current session route. Without an active checkpoint, it returns control to Pi-native compaction. With a checkpoint, it applies [checkpoint recovery](#checkpoint-recovery). It does not automatically switch credentials, providers, or remote compaction protocols.
This does not prove the account is broken or ordinary chat is unavailable, and upgrading Pi alone is not a guaranteed fix.
See OpenAI's [errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) for route and grant checks; re-login is not a guaranteed remedy for an endpoint permission rejection.

Later compactions skip the rejected operation while compatible checkpoint replay remains enabled, even with fallback notifications off. Rejections are isolated by session manager and provider/model/API/profile/protocol plus the configured and dispatched endpoint origin/path (and Azure's `api-version`). Pi/provider authentication and request preparation still run to resolve the effective backend; rejected dispatches stop before network work. Changing the resolved compaction protocol (including selecting Context Management) or the backend permits a new attempt. Switching back remains paused.

Session start, `/reload`, resume, fork, replacement, and shutdown clear rejection state. The first 128 rejected identities are retained until reset; further identities follow ordinary failure handling without evicting earlier ones. The menu reports the last observed dispatch identity, which is rechecked at the next compaction. URL credentials and query secrets are excluded; non-Azure query routing changes, header-/body-only backend changes, and credentials on an otherwise unchanged route require `/reload` to retry. State is temporary, not a settings write or an entitlement cache.

For sessions without an existing opaque checkpoint, you may also turn **Remote compaction** off in `/codex-compact` → **Settings**, or set `"enabled": false` in the documented global settings file and reload Pi, to use native compaction directly.
**Disabling remote compaction also disables opaque checkpoint replay.** If a session already contains a checkpoint, leave the extension enabled to preserve compatible replay and allow checkpoint recovery on rejected attempts; disabling it exposes only the fallback marker and retained recent messages.
The selected route shown in the menu is not an entitlement check, and forcing Remote V2 is not a verified workaround for this rejection.

### Checkpoint recovery

Pi's native summary generator reads the checkpoint's plaintext placeholder, not its encrypted history. Handing a checkpoint-bearing session directly to that generator can lose older context when the new native summary replaces it.

On remote failure, **Checkpoint recovery → Summarize** (the default) makes a normal streaming inference request through the same compatible provider/model and Pi-managed authentication. It replays the encrypted checkpoint as real Responses input items, summarizes the projected history before Pi's retained cut point, and disables tool work. A completed, bounded plaintext summary replaces the opaque checkpoint in the active context; Pi retains the recent tail and file-operation metadata. Ordinary requests do not receive these summary instructions. Summaries are lossy: completion and transport validation cannot prove every prior fact was preserved.

This request consumes inference quota/API usage and can fail if inference, checkpoint replay, or the projected cut point is unsupported. Summary recovery also requires the provider's public `onProviderStreamEvent` callbacks for completion validation; adapters that omit them cancel safely. Malformed or unsupported metadata bearing this extension's checkpoint kind cancels before any remote or summary request instead of being mistaken for plaintext history. Missing, partial, unsafe, inconsistent, oversized, or stale results cancel compaction without publishing a replacement. Cancellation, session changes, and shutdown abort owned work. Model selection and completed tree navigation cancel in-flight compaction without clearing route pauses. **Checkpoint recovery → Cancel** skips the summary request entirely and preserves the existing history. Neither choice changes fallback without a checkpoint, and failure never falls through to text-only native summarization when an active checkpoint is present. If compaction is cancelled, switch to a supported protocol/model or reload after resolving authorization; a context-limit turn may remain blocked until compaction succeeds.

Disabling remote compaction still disables replay; the recovery setting does not override `enabled: false`. Keep the extension enabled when the active session needs its checkpoint. Hosted checkpoint-to-text recovery remains unverified; deterministic adapter tests establish request plumbing and safe publication, not hosted recall.

### Codex CLI routing comparison

The examined Codex CLI source uses Remote V2 on its resolved Responses route: ChatGPT/Codex OAuth defaults to the Codex backend, while API keys default to the OpenAI API. This extension already uses V2 for Codex-profile `auto` routes; OpenAI/Azure `auto` remains unary Compact API. Select Remote V2 explicitly to use that request form on a compatible API-key backend. Pi's newer OpenAI ChatGPT token-sharing OAuth is a different grant: neither an API label nor Codex CLI source establishes its compaction permission. No authentication-dependent automatic routing is added.

## 🧭 How it works

1. Pi prepares compaction and selects the recent message suffix it will retain.
2. If an earlier compatible checkpoint is present, the extension identifies its boundary from the summary persisted on the active `CompactionEntry` and validates the retained suffix fingerprints.
3. Remote V2 projects that checkpoint into a normal Responses SSE request and appends exactly one final `compaction_trigger`.
4. Unary compact captures the provider-built payload and authentication, rewrites only the same-origin `/responses` path to `/responses/compact`, and requests JSON without making a normal inference call.
5. Context Management makes a streaming inference request, selecting the latest completed checkpoint and all safe completed output after it in event order.
6. Remote V2 and unary compact require one bounded non-empty opaque `compaction` item; unary output may precede it only with user-role retained messages.
7. It stores bounded replacement history with Pi suffix fingerprints, the real API label, and the resolved compatibility profile in versioned `CompactionEntry.details`. Context Management stores checkpoint-first history with an exact output suffix; the other protocols keep bounded user history with the checkpoint last.
8. On later compatible requests, it replaces an exactly validated marker with the persisted replacement history immediately before provider dispatch.

The persisted entry remains the summary identity source, so replay does not depend on the wording generated by the currently installed extension version.
If persisted summary identity, fingerprints, model identity, payload shape, or marker count do not match exactly, the extension leaves Pi's visible fallback context unchanged instead of guessing.
Older v1 and v2 checkpoints are normalized to the current checkpoint format when read; their built-in API label determines the profile. They still replay only when the current route authorizes that API/profile/model combination.

## 🔒 Security and privacy

Remote compaction sends the active conversation context and system prompt to the configured Responses backend. Remote V2 and Context Management also send active tool schemas; Codex-profile unary requests retain provider-supported tools.
The Pi session stores the producing provider ID, encrypted compaction item, and bounded recent user-role Responses items, or Context Management's completed post-checkpoint reasoning/assistant output.
It does not store credentials, authorization headers, or request headers in checkpoint details.

| Boundary | Limit |
| --- | ---: |
| Observed SSE stream or unary JSON response | 8 MiB |
| Serialized opaque compaction item or retained output item | 2 MiB |
| Persisted replacement history | 8 MiB |
| Retained user text or serialized Context Management output suffix | 64K approximate tokens by default; configurable from 8K to 128K |
| Settings file | 64 KiB |
| Transport retries | At most 2 |
| Request timeout | At most 10 minutes |

An individually oversized media item is dropped rather than making the session entry unbounded.
The oldest fitting text item may be partially truncated to preserve newer context.
Context Management does not retain the original plaintext alongside its checkpoint and fails rather than truncating oversized post-checkpoint output.
These hard byte ceilings are intentionally not configurable.

## 🚧 Limitations

- Hosted compaction contracts and OAuth capability restrictions can change independently of Pi or this package; keep backups of important sessions.
- Full older history depends on this extension, the checkpoint API label and compatibility profile, the exact checkpoint model ID, and a provider route whose backend accepts the opaque item.
  Removing the extension exposes only the portability fallback marker and Pi-retained recent messages.
- The package does not reproduce Codex core's context-window UUID/number lineage, previous-model compatibility fallback, exact pre-turn ordering, or exact mid-turn model-session ownership.
- Pi's public `getAllTools()` metadata does not expose `constrainedSampling`; Remote V2 preserves active tool order, names, descriptions, and parameter schemas but cannot reproduce that optional field.
- Successful checkpoint recovery intentionally replaces active opaque history with a lossy plaintext summary; failed recovery preserves the checkpoint and cancels compaction. Raw session history can contain both opaque and plaintext compaction entries.
- Settings concurrency is coordinated only within one Pi process; separate processes rely on the final conflict check.

## 📊 Benchmark

The repository includes a seeded benchmark that compares uncompressed full context, Pi-native plaintext compaction, and this extension's Remote V2 path.
It keeps history length nearly fixed while varying information density across five state categories and ten history epochs.
Benchmark v3 uses repeated artifacts, isolated evaluator probes, seed-level paired statistics, one Pi SDK estimator for dry and live fixtures, and committed protocol manifests for confirmatory candidates.
It never treats nominal Pi 20K and Codex 20K settings as equal information capacity or automatically claims that protocol-conformant evidence was genuinely held out.

Preview its exploratory diagnostic without making a provider request:

```bash
npm run benchmark:codex-compact
```

A live run requires `--live`, review of the request and cost exposure, OpenAI Codex OAuth, and Remote V2 entitlement.
The repository preserves the explicitly labeled v2 matched-tail diagnostic and the v3 calibration evidence, while seeds 301–304 remain consumed and unavailable for future confirmatory protocols.
See the [benchmark guide](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-codex-compact/benchmark) for manifests, repetitions, commands, privacy, cost semantics, and interpretation limits.

## 🧪 Development

From the repository root:

```bash
npm --workspace @narumitw/pi-codex-compact run check
npm test
npm run package:pack -- codex-compact
```

See the [Codex compaction mechanism notes](https://github.com/narumiruna/pi-extensions/blob/main/docs/implementation-notes/codex-compaction-mechanism.md) for the underlying Codex mechanism research and the extension boundary.

## 🗂️ Package layout

```text
packages/pi-codex-compact/
├── src/                               # Authoritative implementation and helpers
│   ├── index.ts                       # Thin Pi entrypoint
│   └── codex-compact.ts               # Compaction routing, replay, and fallback
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── benchmark/                         # Repository-only benchmark and methodology
└── test/                              # Behavior and lifecycle coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🔎 Keywords

Pi extension, Pi coding agent, OpenAI Codex, ChatGPT OAuth, Azure OpenAI, custom provider, proxy, Remote Compaction V2, Responses Compact API, context management, opaque checkpoint, Responses API, context compaction.

## 📄 License

[MIT](LICENSE)
