# Maintained Pi Codex compaction fork

## Ownership and scope

- Fork: <https://github.com/Pein2017/pi-codex-compaction>, a GitHub fork of
  <https://github.com/narumiruna/pi-extensions>.
- Retain upstream MIT license, authorship, package names and history. Fork ownership
  does not transfer the `@narumitw` npm namespace.
- Primary maintenance scope: `packages/pi-codex-compact`, its required shared
  libraries, tests and local release tooling. Other extensions remain inherited
  upstream source; their presence is not a support or runtime qualification claim.
- Canonical existing checkout: `/data/CoordExp/codex-tools/pi-extensions`.
  Do not relocate it merely to match the GitHub name: selected runtime releases
  and recovery pointers already refer to this physical root.
- Default maintained branch: `main`; local `main` tracks `origin/main`.
  The former inherited `main` is preserved as
  `history/main-before-unification-20261007`, not merged into maintained source.
- Consequential future changes and upstream integration plans belong to this
  repository's local `openspec/`, not its parent CoordExp checkout. Small fixes
  need no retrospective planning artifacts.

This is a Pi extension for compatible Codex/Responses backends, not a fork of
OpenAI's Codex backend. Repository bootstrap does not change endpoint, protocol,
model, authentication or currently selected runtime settings. Backend acceptance
must be checked separately from checkpoint fidelity and task continuation.

## Remotes and synchronization

Use `origin` for Pein2017 and `upstream` for the original author. Disable upstream
pushes and set the default push destination explicitly in each checkout:

```bash
git clone https://github.com/Pein2017/pi-codex-compaction.git
cd pi-codex-compaction
git remote add upstream https://github.com/narumiruna/pi-extensions.git
git remote set-url --push upstream no_push://narumiruna/pi-extensions
git config remote.pushDefault origin
git branch --set-upstream-to=origin/main main
```

Name the repository explicitly in GitHub CLI operations; do not rely on implicit
fork/upstream selection. Fetching updates neither source nor a running session:

```bash
git fetch --no-tags upstream main
git log --oneline HEAD..upstream/main
git diff --stat HEAD...upstream/main
```

Save only authorized local work before integration. Never automatically stash,
reset, force-sync or rebase published development history. For a clean checkout,
prepare a reviewed merge on a separate branch:

```bash
git fetch --no-tags origin main
git merge --ff-only origin/main
git switch -c sync/upstream-YYYYMMDD
git merge --no-ff upstream/main
# Resolve contracts explicitly; validate affected package and real SDK consumers.
# Push/open a PR only under the applicable authorization:
gh pr create --repo Pein2017/pi-codex-compaction --base main
```

A broad upstream merge is not automatically qualified by upstream CI. Preserve
checkpoint replay, strict omission/replacement handling, cancellation, task
continuation, prompt-prefix behavior and release provenance. Do not choose all
"theirs" for conflicts or use `gh repo sync --force`. No periodic fetch,
automatic merge or unattended deployment is installed.

## Publication and runtime boundaries

GitHub Actions are disabled for this fork at bootstrap. In addition, the inherited
npm publication workflow is restricted to the original upstream repository, so
future CI enablement cannot publish the upstream namespace from this fork.
Re-enabling CI, changing package identity, npm publication, tags and GitHub releases
require separate scope. Source pushes are not npm publication or runtime adoption.

[Local compaction ownership](local-compaction.md) remains the release owner.
Publish reviewed clean committed source through its immutable local release
script; validate the extracted package with the installed SDK before changing the
shared profile pointer. Keep predecessor releases for rollback. Existing sessions
need user-controlled idle `/reload`; never restart or reload active sessions as a
side effect of source synchronization.

Keep `.local/`, dependencies, credentials, profiles, private session JSONL and
runtime artifacts out of Git. A GitHub clone is not a backup of private sessions
or a turnkey provisioned runtime.

## Bootstrap boundary

The maintained branch starts from local repair commit `6eeaae46`, preserving all
five local commits since baseline `87f29eaf`. At bootstrap, fetched upstream
`63dc5ec6` contains 106 commits absent from that baseline. They are retained via
`upstream/main` and the fork's preserved historical branch, but are **not
integrated or qualified** by this bootstrap. A separate reviewed merge is required.

On 2026-10-07, the user authorized main-branch unification. GitHub branch rename
preserved upstream tip `63dc5ec6` under
`history/main-before-unification-20261007` and renamed maintained `coordexp/main`
to `main`, retaining tip `6c6adab7` without merge or force-push. Local `main` now
tracks `origin/main`. Historical receipts describing the earlier branch remain
unchanged.

The already selected local compaction release remains unchanged. Its package and
installed-SDK checks do not establish hosted reliability or a passing complete
monorepo suite; retain the prior qualification limitations.
