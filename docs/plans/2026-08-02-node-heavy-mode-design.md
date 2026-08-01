# Portable Heavy Mode Design

## Problem

The public repository already has a cross-platform Node.js search CLI and a resumable batch source inspector. The tested heavy-search controller, however, exists only in the author's installed skill as a Python state CLI plus stateful PowerShell retrieval. A fresh GitHub install therefore cannot reproduce the tested checkpoint, compaction recovery, candidate indexing, acquisition accounting, semantic-review tracking, or completion guard.

Publishing the local controller unchanged would also break the repository's Node.js-only portability promise on systems without Python or PowerShell.

## Goals

- Make the tested heavy workflow available from a clean GitHub install on Windows, macOS, and Linux with Node.js 18 or newer.
- Activate heavy mode only after an explicit heavy or deep-search request.
- Save every successful SkillsMP response before the next request.
- Resume a partially completed sort pass without repeating completed API requests.
- Preserve the current source-inspection cache and zero-network inspection resume.
- Keep source acquisition, semantic review, and scoring as separate, truthful counters.
- Give the agent compact candidate and review indexes while retaining full source-grounded evidence for targeted expansion.
- Reject ordinary completion while required acquisition, review, or scoring work remains.
- Keep candidate source as untrusted text and never execute it.

## Non-goals

- Do not make a deterministic script choose semantic relevance, method delta, scores, or final recommendations.
- Do not run heavy mode automatically because a topic looks difficult.
- Do not add a new package dependency, daemon, database, or background cleanup job.
- Do not delete cached or state artifacts automatically.
- Do not publish or push GitHub changes without separate approval.

## Chosen architecture

Add one portable Node.js state CLI, `heavy-search-state.mjs`, and extend the existing Node search CLI with an optional `--heavy-search-id` argument. PowerShell remains a thin convenience wrapper that forwards arguments to Node; it is not part of the heavy-mode implementation.

The responsibilities stay intentionally narrow:

```text
search-skillsmp.mjs
  fetch one saved query at a time
  -> checkpoint the raw successful response
  -> merge completed responses into stars.json or recent.json

heavy-search-state.mjs
  own the durable search session
  -> query plan and retrieval progress
  -> merged pool and candidate index
  -> shortlist and finalists
  -> acquisition import
  -> semantic review and scores
  -> compact checkpoint and completion guard

inspect-skillsmp.mjs
  read finalist SKILL.md files as untrusted text
  -> cache source bytes and extracted facts
  -> emit capsules and a compact review index
  -> resume completed acquisition without network requests
```

This uses the minimum new surface that preserves the tested behavior. The state CLI is a local coordination adapter, not a semantic ranking engine.

## State and artifacts

The state root is selected in this order:

1. `SKILLSMP_SEARCH_STATE_ROOT` when explicitly set;
2. `CODEX_HOME/state/skillsmp-search` when `CODEX_HOME` is set;
3. the platform state location already used by the Node inspector, under a `heavy-searches` directory.

Each session uses an opaque ID such as `20260802T120000Z-1a2b3c4d` and owns:

```text
<state-root>/<search-id>/
  state.json
  checkpoint.md
  queries/stars/<query-hash>.json
  queries/recent/<query-hash>.json
  stars.json
  recent.json
  candidates.json
  candidate-index.json
  shortlist.json
  finalists.json
```

`state.json` remains schema version 1 so existing local benchmark state can be read without a destructive migration. Missing acquisition fields receive in-memory defaults and are written on the next successful mutation. Unknown schema versions fail closed before any API request.

The state records:

- request, request fingerprint, working directory, timestamps, status, phase, and next step;
- the immutable query plan;
- completed queries, artifacts, and counts for `stars` and `recent`;
- merged pool, shortlist, and finalist keys;
- acquisition artifact, review index, source-success keys, and terminal-failure keys;
- bounded semantic review records and scores keyed by saved finalist;
- sanitized notes and explicit incomplete-completion reason when used.

The checkpoint is a small Markdown projection regenerated after each mutation. `state.json` is canonical.

## Persistence and concurrency

All JSON and checkpoint writes use a same-directory temporary file followed by atomic rename. A per-session exclusive lock file serializes mutations. Lock acquisition has a bounded wait; a stale lock older than two minutes may be reclaimed. The lock stores only process metadata, never credentials or prompts.

A malformed `state.json` is renamed to a timestamped `.corrupt-*` file and the command fails closed. The CLI does not silently start a replacement session or issue network requests. Malformed noncanonical artifacts also fail without overwriting the last valid state.

## Resumable retrieval

`search-skillsmp.mjs --heavy-search-id <id>` loads the saved query plan and rejects a mismatched query set before network access. For the selected sort order it:

1. loads the completed-query set;
2. skips every completed query;
3. records a write-ahead `dispatched` marker for the next pending query;
4. fetches that query;
5. validates the response envelope;
6. saves the response artifact and marks the query complete atomically;
7. continues only after the checkpoint write succeeds;
8. finalizes the sort artifact when every saved query is present.

The command's receipt reports completed requests, skipped requests, candidate count, artifact path, checkpoint path, and next step. Repeating a completed command performs zero SkillsMP requests.

If the process disappears after dispatch but before a durable response exists, the state cannot know whether the server counted the request. On resume, that query is reported as ambiguous and is not repeated automatically. An explicit retry flag may clear the marker, with a warning that the request can be counted twice. This makes the zero-automatic-duplicates guarantee honest instead of hiding the unavoidable crash window.

The state module exposes functions directly to the search CLI and a command-line interface for agents. This avoids spawning a child process per query while keeping one canonical implementation of state validation.

## Candidate index and agent judgment

After both sort passes finish, the state CLI merges candidates by normalized source URL and caps the combined pool at 250. `candidate-index` then groups only mechanical copies with both:

- the same GitHub owner/repository; and
- the same normalized skill name.

Within a family it prefers a primary `/skills/` path over localized documentation paths, then uses query coverage and rank. Same-name skills from different repositories remain separate. The index truncates discovery descriptions and contains no semantic score.

The agent reads the candidate index, saves a shortlist, saves finalists drawn from that shortlist, and invokes the existing batch inspector once. It reads every review-index entry and expands full capsules or cached source only for plausible or uncertain candidates.

## Acquisition, review, and scoring invariants

`record-acquisition` accepts only an inspector artifact satisfying:

```text
successes + terminalFailures = canonicalCandidates
```

Every artifact result must map to exactly one saved finalist, and all finalists must be accounted for. A failed import leaves previous state unchanged.

The checkpoint reports independent progress:

```text
Sources acquired: 24/25; terminal failures: 1
Semantically reviewed: 0/24
Scored: 0/24
```

`record-inspection` accepts only source-success finalists. Rejected semantic mismatches count as reviewed but are not score targets. `record-score` accepts only successfully inspected finalists. Ordinary `complete` requires acquisition and all relevant review and scoring work. `--allow-incomplete` requires a sanitized reason and records it visibly.

## Safety and privacy

- API keys stay in environment variables and request headers only.
- Error messages redact known bearer, token, password, secret, and API-key forms.
- Requests, notes, summaries, and checkpoint cells are length-bounded and sanitized.
- Candidate source is parsed as text; no candidate command, script, hook, or installer runs.
- Search IDs and run IDs are validated before constructing filesystem paths.
- Public docs use portable placeholders and contain no machine-specific paths.

## Compatibility

The implementation uses Node.js 18 built-ins only. Paths are built with `node:path`; path comparisons use resolved paths and case folding only on Windows. CLI examples use `node` and POSIX-compatible line continuation where possible, with PowerShell shown only as an optional Windows convenience.

The PowerShell search wrapper gains `-HeavySearchId` and forwards it to the same Node entry point. Existing standard invocations and output shape remain unchanged.

## Verification

Focused tests must prove:

- checkpoint creation and resume by working directory, request, and explicit ID;
- an interruption after any successful query leaves that query durable;
- a resumed sort pass performs zero repeated requests;
- a dispatched query without a durable response is never retried implicitly;
- explicit ambiguous retry is narrow and visible;
- stars and recent artifacts merge deterministically;
- query-plan mismatch stops before network access;
- candidate families collapse only within one repository and normalized name;
- shortlist/finalist ancestry is enforced;
- acquisition accounting and finalist mapping are exact;
- acquired, reviewed, and scored counters remain separate;
- completion rejects unfinished work and requires a reason for explicit incomplete completion;
- malformed state is quarantined and never replaced implicitly;
- Windows and POSIX path comparisons behave as intended;
- errors remain concise and do not expose an API key;
- standard mode retains its current JSON shape.

End-to-end verification will replay the saved 24-request benchmark from persisted query artifacts without new SkillsMP calls, run the inspector resume with zero source requests, and run isolated live-like fixtures for standard, interrupted-heavy, completed-heavy, and resumed-heavy behavior. The repository test matrix remains Windows, macOS, and Linux on Node.js 18 and 22.

## Deployment boundary

Local preparation includes documentation, tests, repository validation, a clean-install smoke test, current-tree and reachable-history privacy checks, and synchronization of the installed skill. Pushing commits, changing repository metadata, or publishing a release remains a separate externally visible action requiring explicit approval.
