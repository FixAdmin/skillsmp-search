# Portable Node Heavy Mode Implementation Plan

> Implement locally through focused tests. Do not push or publish without separate approval.

**Goal:** Ship the tested checkpointed heavy-search workflow in the repository as a Node.js 18+ implementation that runs on Windows, macOS, and Linux.

**Architecture:** A new `heavy-search-state.mjs` module owns durable heavy-session state and exposes both imported functions and an agent-facing CLI. The existing `search-skillsmp.mjs` imports that module when `--heavy-search-id` is present, records dispatch before each request, checkpoints each successful response, and finalizes saved sort artifacts. The existing inspector remains the only source-acquisition component; semantic relevance and scoring remain agent judgments.

**Tech stack:** Node.js 18 built-ins, ECMAScript modules, `node:test`, JSON and Markdown artifacts, optional PowerShell wrappers.

---

## Task 1: State store, checkpoint, and recovery contract

**Files:**

- Create: `skills/skillsmp-search/scripts/heavy-search-state.mjs`
- Create: `tests/heavy-search-state.test.mjs`

- [ ] Write failing tests for state-root selection, session creation, request fingerprinting, query-plan deduplication, search-ID validation, and checkpoint rendering.
- [ ] Add tests that load a schema-v1 Python-created fixture with missing optional fields.
- [ ] Add corruption tests: malformed, oversized, wrong-schema, and ID-mismatched state must be quarantined or rejected before mutation.
- [ ] Add lock tests for exclusive acquisition, bounded wait, and stale-lock recovery.
- [ ] Implement state-root selection using `SKILLSMP_SEARCH_STATE_ROOT`, then `CODEX_HOME`, then the inspector's cross-platform state base.
- [ ] Implement atomic same-directory JSON/Markdown writes, bounded state size, and concise sanitized errors.
- [ ] Implement `start`, `resume`, `list`, `query-plan`, and `completed-queries` commands.
- [ ] Run `node --test tests/heavy-search-state.test.mjs`.

## Task 2: Query transaction states and resumable retrieval

**Files:**

- Modify: `skills/skillsmp-search/scripts/heavy-search-state.mjs`
- Modify: `skills/skillsmp-search/scripts/search-skillsmp.mjs`
- Modify: `skills/skillsmp-search/scripts/search-skillsmp.ps1`
- Modify: `tests/search-skillsmp.test.mjs`
- Modify: `tests/heavy-search-state.test.mjs`

- [ ] Write a failing test that interrupts after one successful query and verifies that only the pending query is fetched on resume.
- [ ] Write a query-plan mismatch test that proves zero fetch calls occur.
- [ ] Write a completed-pass resume test that proves zero fetch calls and a stable receipt.
- [ ] Add a write-ahead dispatch test: a query left in `dispatched` is reported as ambiguous and is not retried automatically.
- [ ] Add an explicit `--retry-ambiguous` test that clears only named ambiguous work and documents that it may repeat a request.
- [ ] Extend argument parsing with `--heavy-search-id` and `--retry-ambiguous`; preserve the standard-mode options and output shape.
- [ ] Implement `recordQueryDispatch`, `recordQueryResponse`, `recordQueryFailure`, and `finishRetrieval` as imported state operations.
- [ ] Save raw successful API envelopes as per-query immutable artifacts before marking the query complete.
- [ ] Merge every completed query into deterministic `stars.json` or `recent.json`; merge both into `candidates.json` capped at 250.
- [ ] Forward the heavy-search ID and retry flag from the PowerShell wrapper.
- [ ] Run focused search and state tests.

## Task 3: Candidate indexing and selection ancestry

**Files:**

- Modify: `skills/skillsmp-search/scripts/heavy-search-state.mjs`
- Modify: `tests/heavy-search-state.test.mjs`

- [ ] Write failing tests for same-repository/same-normalized-name grouping, primary `/skills/` preference, localized path fallback, input-order determinism, and preservation across repositories.
- [ ] Implement normalized GitHub identity and a versioned, conservative normalized-name function.
- [ ] Implement `candidate-index --limit 40..100` with bounded descriptions and no semantic score.
- [ ] Write tests that `set-candidates --stage shortlist` accepts only pool members and deduplicates keys.
- [ ] Write tests that finalists must come from a nonempty saved shortlist.
- [ ] Implement atomic `shortlist.json` and `finalists.json` artifacts and reset downstream acquisition/review/score state when finalists change.
- [ ] Run focused state tests.

## Task 4: Acquisition import, semantic records, and completion guard

**Files:**

- Modify: `skills/skillsmp-search/scripts/heavy-search-state.mjs`
- Modify: `tests/heavy-search-state.test.mjs`

- [ ] Write a three-finalist inspection fixture with two successes and one permanent source failure.
- [ ] Test that `record-acquisition` rejects broken accounting, extra results, missing finalists, and duplicate mappings without changing valid state.
- [ ] Test the checkpoint immediately after import: acquired `2/3`, failures `1`, reviewed `0/2`, scored `0/2`.
- [ ] Test that inspection records require a source-success finalist and allow `inspected`, `rejected`, or retryable `failed` status.
- [ ] Test that scores require `inspected` status and a total from 0 through 100.
- [ ] Derive review and score counters from records rather than incrementing independent counters.
- [ ] Test that `complete` rejects missing acquisition, semantic review, or scores.
- [ ] Test that explicit incomplete finalization requires a reason and records it in state and checkpoint.
- [ ] Implement `record-acquisition`, `record-inspection`, `record-score`, `set-phase`, `note`, `complete`, and `abandon` commands.
- [ ] Run focused state tests.

## Task 5: Portable heavy-mode instructions

**Files:**

- Create: `skills/skillsmp-search/references/heavy-mode.md`
- Modify: `skills/skillsmp-search/SKILL.md`
- Modify: `README.md`
- Modify: `examples/heavy-search.md`
- Modify: `scripts/validate-repo.mjs`

- [ ] Route explicit heavy requests to the reference; standard requests must not load or create heavy state.
- [ ] Document `resume` as the first heavy action after context compaction and show only cross-platform `node` commands in the canonical path.
- [ ] Document stars and recent retrieval through the same search CLI and search ID.
- [ ] Document candidate index, shortlist, finalists, one batch-inspector call, acquisition import, semantic review records, scoring, and completion.
- [ ] Explain ambiguous dispatched queries and the explicit retry trade-off without elevating internal plumbing into README feature copy.
- [ ] Keep public copy friendly and remove implementation trivia, prompt residue, and unsupported promises.
- [ ] Require the new state CLI and heavy reference in repository validation.
- [ ] Run docs link and repository validation.

## Task 6: End-to-end fixture and saved benchmark replay

**Files:**

- Create or modify: `tests/heavy-search-e2e.test.mjs`
- Use without modifying: local benchmark state `20260801T052116Z-e863796a`

- [ ] Build a fake SkillsMP fetcher and run standard mode; assert bounded calls and unchanged output shape.
- [ ] Start a heavy session, run a partial stars pass, simulate interruption, then resume; assert no completed query repeats.
- [ ] Complete stars and recent passes, build the index, save shortlist/finalists, run cached inspection, import acquisition, record semantic decisions and scores, and complete the session.
- [ ] Repeat both retrieval commands and inspector resume; assert zero network requests.
- [ ] Copy the saved Python-created benchmark state to an isolated state root.
- [ ] Load it with the Node state CLI, rebuild artifacts from the 20 saved stars/recent query responses, and verify 20/20 completed requests, 250 merged candidates, 50 shortlisted, 25 finalists, 24 acquired sources, and one terminal failure without a SkillsMP request.
- [ ] Run `npm test` twice.

## Task 7: Installation and release readiness

**Files:**

- Modify as needed: `.github/workflows/validate.yml`
- Sync after repository validation: `<installed-skill>/`

- [ ] Ensure CI parses both PowerShell wrappers and runs all tests on Windows, macOS, and Linux with supported Node versions.
- [ ] Run `npm run validate` and the official skill validator from `skill-creator`.
- [ ] Create a temporary clean checkout and follow the documented install and first-use path without relying on the author's home-directory files.
- [ ] Run the repository's current-tree secret/PII/path scan and a separate reachable-history scan without printing secret values.
- [ ] Inspect images and metadata for usernames, local paths, private tabs, or embedded personal information.
- [ ] Review every changed user-facing sentence through the serious-release significance gate.
- [ ] Sync repository skill files into the global installed skill, remove the obsolete Python controller from the installed copy, and verify SHA-256 equality for all packaged files.
- [ ] Run one installed standard fixture and one installed heavy/resume fixture.
- [ ] Confirm `git status`, branch divergence, remote owner, license, and no unapproved external mutation.
- [ ] Report local deployment readiness and wait for explicit push authorization.

## Acceptance conditions

- Standard search still works through the documented Node and PowerShell commands.
- Heavy mode is impossible to enter without an explicit heavy-state start and search ID.
- Every completed query response is durable before the next query begins.
- Resuming completed work performs zero repeat SkillsMP or GitHub requests.
- An ambiguous crash window never causes an automatic duplicate request.
- A clean GitHub install needs only Node.js 18 or newer; Python and PowerShell are optional.
- All acquired source successes are semantically reviewed and all accepted reviews are scored before ordinary completion.
- Candidate code never executes.
- Tests pass twice, validation passes, install smoke passes, and privacy/history review has no unresolved release blocker.
- No push, release, visibility change, or metadata mutation occurs without separate approval.
