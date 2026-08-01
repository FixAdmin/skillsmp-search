# Pipeline Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect batch acquisition to heavy-search state and give agents compact, bounded indexes for metadata and capsule review.

**Architecture:** Add a focused Node review-index module beside the existing extractor and make the inspector write it automatically. Extend the machine-local Python heavy-state adapter with mechanical candidate indexing, acquisition import, separate progress counters, and completion guards. Keep semantic judgments in the agent.

**Tech Stack:** Node.js 18 built-ins, Python 3 standard library, PowerShell wrapper, `node:test`, JSON state.

---

## File structure

- Create `skills/skillsmp-search/scripts/inspection/review.mjs`: build bounded review entries and an artifact manifest.
- Modify `skills/skillsmp-search/scripts/inspect-skillsmp.mjs`: derive and atomically write the review-index artifact.
- Modify `skills/skillsmp-search/scripts/inspect-skillsmp.ps1`: expose an optional review-index path while preserving automatic default behavior.
- Modify `tests/inspect-extract.test.mjs`: verify deterministic review entries and size limits.
- Modify `tests/inspect-pipeline.test.mjs`: verify automatic files, artifact classes, and every-candidate accounting.
- Modify `skills/skillsmp-search/SKILL.md` and `README.md`: route agents through review index before targeted capsule expansion.
- Modify `scripts/validate-repo.mjs`: require the review module.
- Modify local `<installed-skill>/scripts\heavy-search-state.py`: candidate index, acquisition import, counters, and completion guard.
- Modify local `<installed-skill>/references\heavy-mode.md`: one-command handoff from inspector to state.

### Task 1: Bounded review index

**Files:**
- Create: `skills/skillsmp-search/scripts/inspection/review.mjs`
- Modify: `tests/inspect-extract.test.mjs`

- [ ] **Step 1: Write failing review-index tests**

Import `buildReviewIndex` and assert that one entry contains identity, source coverage, bounded sections, workflow, signals, diverse evidence, and capsule/source artifact paths. Assert `JSON.stringify(entry).length <= 1800` and that terminal failures receive an entry without fabricated evidence.

- [ ] **Step 2: Run the focused test**

Run: `node --test tests/inspect-extract.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` or missing `buildReviewIndex`.

- [ ] **Step 3: Implement the pure review builder**

Export:

```js
export const REVIEW_INDEX_VERSION = "review-index-v1";
export function buildReviewEntry(candidateResult, options = {}) {}
export function buildReviewIndex(inspectionOutput, options = {}) {}
```

Use defaults of 1,800 characters per entry, eight headings, six workflow steps, and six evidence records. Select at least one validation, recovery, checkpoint, workflow, or heading item when present. Trim arrays before strings; throw only when the minimum identity cannot fit.

- [ ] **Step 4: Run the focused test**

Run: `node --test tests/inspect-extract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/skillsmp-search/scripts/inspection/review.mjs tests/inspect-extract.test.mjs
git commit -m "feat: build compact skill review index"
```

### Task 2: Automatic review artifact

**Files:**
- Modify: `skills/skillsmp-search/scripts/inspect-skillsmp.mjs`
- Modify: `skills/skillsmp-search/scripts/inspect-skillsmp.ps1`
- Modify: `tests/inspect-pipeline.test.mjs`

- [ ] **Step 1: Write failing CLI tests**

Run the cached offline fixture with `--output inspection.json`. Assert that `inspection.review-index.json` exists, contains every canonical candidate, satisfies the capsule/failure invariant, and appears in the receipt as `artifacts.reviewIndex` with `lifetime: "disposable_after_completion"`. Assert cache and run-state artifacts use `lifetime: "durable"`.

- [ ] **Step 2: Run the focused pipeline test**

Run: `node --test tests/inspect-pipeline.test.mjs`

Expected: FAIL because no review artifact exists.

- [ ] **Step 3: Write review output atomically**

Add `--review-index <file>` to `parseArgs`. When omitted with `--output`, derive `<basename>.review-index<ext>`. Build the index only after the inspection invariant passes. Write both artifacts atomically, then print one compact receipt with paths, lifetimes, metrics, and no candidate array.

- [ ] **Step 4: Forward the optional wrapper argument**

Add `[string]$ReviewIndexPath` and append `--review-index` as an argument vector. Keep Node.js version checks and exit propagation unchanged.

- [ ] **Step 5: Run all Node tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/skillsmp-search/scripts/inspect-skillsmp.mjs skills/skillsmp-search/scripts/inspect-skillsmp.ps1 tests/inspect-pipeline.test.mjs
git commit -m "feat: emit review index with inspection"
```

### Task 3: Heavy-state acquisition import

**Files:**
- Modify local: `<installed-skill>/scripts\heavy-search-state.py`
- Modify local: `<installed-skill>/references\heavy-mode.md`

- [ ] **Step 1: Create an isolated state fixture**

Set `SKILLSMP_SEARCH_STATE_ROOT` to a temporary directory. Start a three-candidate session, seed merged candidates, shortlist, and finalists through existing commands, then prepare an inspection artifact with two successes and one permanent failure.

- [ ] **Step 2: Confirm the import command is missing**

Run:

```powershell
python heavy-search-state.py record-acquisition --search-id $id --artifact $inspection
```

Expected: exit 2 with an invalid-command error.

- [ ] **Step 3: Add acquisition state and migration**

Add an `acquisition` mapping with `status`, `artifact`, `reviewIndex`, `canonicalCandidates`, `successes`, `terminalFailures`, `metrics`, `successKeys`, and `failureKeys`. When loading schema v1 state, supply the empty mapping without discarding existing retrieval, inspections, or scores.

- [ ] **Step 4: Implement `record-acquisition`**

Read the artifact, validate its top-level envelope and invariant, normalize each result URL with the existing candidate identity function, require exact finalist accounting, then save acquisition atomically. Set the phase to `review` and point `nextStep` to the review index.

- [ ] **Step 5: Separate progress and guard transitions**

Render source acquisition, semantic review, and scoring counters separately. Restrict `record-inspection` to `successKeys`. Make `complete` reject unreviewed or unscored source-success candidates unless `--allow-incomplete` and `--reason` are both present.

- [ ] **Step 6: Generate a compact candidate index**

Add `candidate-index --search-id <id> --limit <40..100>`. Group only same-repository, same-normalized-name candidates; prefer non-localized `/skills/` paths; truncate descriptions to 360 characters; preserve distinct repositories with the same name. Write `candidate-index.json` and return its path and counts.

- [ ] **Step 7: Update the heavy-mode reference**

Replace the duplicate inspection sentence. After the inspector command, call `record-acquisition` once. Instruct the agent to read `candidate-index.json`, then `inspection.review-index.json`, then expand named full capsules only where needed.

- [ ] **Step 8: Exercise the isolated fixture**

Assert acquisition `2/3`, semantic review `0/2`, scoring `0/2`, completion rejection, one successful review transition, and preservation after `resume`.

### Task 4: Agent workflow and validation

**Files:**
- Modify: `skills/skillsmp-search/SKILL.md`
- Modify: `README.md`
- Modify: `scripts/validate-repo.mjs`

- [ ] **Step 1: Update the agent workflow**

Tell the agent to read the compact review index for every source-success candidate, expand full capsules for plausible or uncertain candidates, and record semantic review separately. Preserve the source/failure invariant and explicit heavy trigger.

- [ ] **Step 2: Document artifact lifetimes**

Explain that cache and checkpoints are durable; rendered inspection and review indexes can be regenerated. State that the tool never deletes them automatically.

- [ ] **Step 3: Extend validation**

Require `inspection/review.mjs` and include it in the existing secret scan.

- [ ] **Step 4: Run repository checks twice**

Run: `npm test && npm test && npm run validate`

Expected:  all tests pass twice and validation prints `Repository validation passed.`

- [ ] **Step 5: Commit**

```bash
git add README.md scripts/validate-repo.mjs skills/skillsmp-search/SKILL.md
git commit -m "docs: streamline agent review workflow"
```

### Task 5: Replay and local synchronization

**Files:**
- Sync local: `<installed-skill>/`

- [ ] **Step 1: Sync portable inspector files**

Copy the review module, inspector, wrapper, and approved SKILL sections. Verify SHA-256 equality. Preserve the heavy-state script, heavy-mode reference, project installer, and resumable search wrapper.

- [ ] **Step 2: Replay the saved benchmark without SkillsMP calls**

Use search ID `20260801T052116Z-e863796a`. Regenerate the review index from cached capsules, import acquisition, and confirm no GitHub request occurs. Do not change the completed benchmark state directly; clone it into an isolated state root before migration testing.

- [ ] **Step 3: Run an installed two-source smoke test**

First run: two successes. Resume: zero network requests and two cache hits. Confirm the review index contains two entries and the receipt classifies artifact lifetimes.

- [ ] **Step 4: Validate privacy and repository state**

Run the skill validator and scan text files for user paths, API keys, bearer tokens, GitHub tokens, and OpenAI-style secrets. Confirm zero matches. Run `git status --short --branch`; do not push.

## Self-review

- Spec coverage: candidate index, review index, acquisition import, independent counters, transition guards, artifact lifetimes, resume, docs, tests, and local sync all map to tasks.
- Placeholder scan: no `TBD`, `TODO`, or unspecified error-handling step remains.
- Type consistency: `reviewIndex`, `canonicalCandidates`, `successes`, `terminalFailures`, `successKeys`, and `failureKeys` keep the same names across artifacts and state.
