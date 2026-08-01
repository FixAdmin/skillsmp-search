# Batch Source Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a resumable, cross-platform source inspector that fetches every selected `SKILL.md` once and emits compact evidence capsules for agent review.

**Architecture:** Keep SkillsMP metadata search unchanged. A separate Node.js inspector accepts the complete selected candidate set, resolves and caches source bytes, scans each full file deterministically, writes atomic per-candidate checkpoints, and returns a stable agent-facing envelope. Semantic scoring remains with the agent.

**Tech Stack:** Node.js 18 built-ins, native `fetch`, `node:test`, PowerShell wrapper, JSON file state, SHA-256 content addressing.

---

## File structure

- Create `skills/skillsmp-search/scripts/inspection/source.mjs`: GitHub URL normalization, raw URL resolution, bounded fetch, retry, redirect policy.
- Create `skills/skillsmp-search/scripts/inspection/store.mjs`: cache roots, SHA-256 object storage, atomic JSON writes, candidate checkpoint files.
- Create `skills/skillsmp-search/scripts/inspection/extract.mjs`: full-file normalization, frontmatter/headings/signals, evidence selection, capsule construction.
- Create `skills/skillsmp-search/scripts/inspect-skillsmp.mjs`: CLI parsing, input validation, concurrency, resume, output envelope, metrics.
- Create `skills/skillsmp-search/scripts/inspect-skillsmp.ps1`: optional Windows wrapper that forwards arguments to Node.
- Create `tests/inspect-source.test.mjs`: resolver, fetch policy, deduplication, retry, and redirect tests.
- Create `tests/inspect-extract.test.mjs`: deterministic extraction, evidence, CRLF, untrusted-content tests.
- Create `tests/inspect-pipeline.test.mjs`: cache, resume, output invariant, CLI error tests.
- Modify `skills/skillsmp-search/SKILL.md`: make batch inspection mandatory after metadata selection.
- Modify `README.md`: document direct CLI use, cache/resume behavior, and quality invariant.
- Modify `scripts/validate-repo.mjs`: require the new entry points.

### Task 1: Source identity and retrieval

**Files:**
- Create: `skills/skillsmp-search/scripts/inspection/source.mjs`
- Create: `tests/inspect-source.test.mjs`

- [ ] **Step 1: Write failing resolver and fetch-policy tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeCandidate,
  fetchSource,
  resolveSourceUrl,
} from "../skills/skillsmp-search/scripts/inspection/source.mjs";

test("tree URL resolves to one canonical raw SKILL.md", () => {
  const candidate = canonicalizeCandidate({
    id: "x",
    githubUrl: "https://github.com/Owner/Repo/tree/main/skills/demo/",
  });
  assert.equal(candidate.canonicalKey, "github.com/owner/repo/skills/demo");
  assert.equal(
    resolveSourceUrl(candidate),
    "https://raw.githubusercontent.com/Owner/Repo/main/skills/demo/SKILL.md",
  );
});

test("fetchSource rejects redirects outside approved GitHub hosts", async () => {
  const fetchImpl = async () => ({
    status: 302,
    ok: false,
    headers: new Headers({ location: "https://example.com/SKILL.md" }),
  });
  await assert.rejects(
    fetchSource("https://raw.githubusercontent.com/o/r/main/SKILL.md", {
      fetchImpl,
      timeoutMs: 50,
      retries: 0,
      maxBytes: 1024,
    }),
    /redirect host is not allowed/,
  );
});
```

- [ ] **Step 2: Run the tests and confirm the module is missing**

Run: `node --test tests/inspect-source.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement canonicalization and bounded raw-first retrieval**

Export these stable functions:

```js
export function canonicalizeCandidate(candidate) {}
export function resolveSourceUrl(candidate) {}
export async function fetchSource(url, options) {}
export function classifyFetchFailure(error) {}
```

Implementation requirements:

- accept only public HTTPS GitHub and raw GitHub URLs;
- normalize owner, repository, and skill path for deduplication;
- preserve source casing for outbound raw URLs;
- try root repositories through `HEAD/SKILL.md`;
- allow at most three redirects among `github.com`,
  `raw.githubusercontent.com`, and `api.github.com`;
- stream the body and stop above 256 KiB;
- retry timeouts, `429`, and `5xx` at most twice;
- classify `404` and `410` as permanent;
- never send SkillsMP credentials to GitHub.

- [ ] **Step 4: Run source tests**

Run: `node --test tests/inspect-source.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/skillsmp-search/scripts/inspection/source.mjs tests/inspect-source.test.mjs
git commit -m "feat: resolve and fetch skill sources"
```

### Task 2: Immutable cache and resumable state

**Files:**
- Create: `skills/skillsmp-search/scripts/inspection/store.mjs`
- Modify: `tests/inspect-pipeline.test.mjs`

- [ ] **Step 1: Write failing cache and atomic-state tests**

```js
test("content object is immutable and source ref reuses it", async () => {
  const store = createStore({ cacheDir, stateDir, runId: "run-1" });
  const first = await store.putSource({ canonicalUrl: "u", bytes: Buffer.from("abc") });
  const second = await store.putSource({ canonicalUrl: "u", bytes: Buffer.from("abc") });
  assert.equal(first.sourceSha256, second.sourceSha256);
  assert.equal(second.cacheHit, true);
});

test("candidate checkpoint resumes at the next incomplete stage", async () => {
  const store = createStore({ cacheDir, stateDir, runId: "run-2" });
  await store.writeCandidate("candidate-a", { stage: "extracted", sourceSha256: "abc" });
  assert.equal((await store.readCandidate("candidate-a")).stage, "extracted");
});
```

- [ ] **Step 2: Run the tests and confirm failure**

Run: `node --test tests/inspect-pipeline.test.mjs`

Expected: FAIL because `createStore` is undefined.

- [ ] **Step 3: Implement the file-backed store**

Export:

```js
export function defaultCacheDir() {}
export function defaultStateDir() {}
export function createStore({ cacheDir, stateDir, runId }) {}
export function sha256(value) {}
export async function writeJsonAtomic(path, value) {}
```

Use content objects under `objects/sha256/<prefix>/<hash>`. Store URL mappings,
facts, and capsules in versioned JSON files. Store one atomic candidate record
per run. Never overwrite an immutable object. Quarantine invalid JSON by
renaming it with a `.corrupt-<timestamp>` suffix.

- [ ] **Step 4: Run cache tests**

Run: `node --test tests/inspect-pipeline.test.mjs`

Expected: PASS for cache and state cases.

- [ ] **Step 5: Commit**

```bash
git add skills/skillsmp-search/scripts/inspection/store.mjs tests/inspect-pipeline.test.mjs
git commit -m "feat: cache and resume source inspection"
```

### Task 3: Deterministic facts and evidence capsules

**Files:**
- Create: `skills/skillsmp-search/scripts/inspection/extract.mjs`
- Create: `tests/inspect-extract.test.mjs`

- [ ] **Step 1: Write failing extraction tests**

```js
test("extractFacts scans the full normalized source", () => {
  const source = "---\r\nname: demo\r\ndescription: Demo\r\n---\r\n# Demo\r\n## Workflow\r\n1. Fetch.\r\n2. Verify.\r\n## Recovery\r\nRetry twice, then stop.\r\n";
  const facts = extractFacts(source);
  assert.equal(facts.coverage.fullFileScanned, true);
  assert.deepEqual(facts.frontmatter, { name: "demo", description: "Demo" });
  assert.deepEqual(facts.headings.map((item) => item.text), ["Demo", "Workflow", "Recovery"]);
  assert.equal(facts.signals.validation.includes("verify"), true);
  assert.equal(facts.signals.recovery.includes("retry"), true);
});

test("capsule evidence stays bounded and line-addressable", () => {
  const capsule = buildCapsule(candidate, extractFacts(source), {
    maxEvidence: 16,
    excerptChars: 240,
    maxChars: 12000,
  });
  assert.ok(capsule.evidence.length <= 16);
  assert.ok(capsule.evidence.every((item) => item.lineStart <= item.lineEnd));
  assert.ok(JSON.stringify(capsule).length <= 12000);
});
```

- [ ] **Step 2: Run the tests and confirm failure**

Run: `node --test tests/inspect-extract.test.mjs`

Expected: FAIL with missing exports.

- [ ] **Step 3: Implement full-file scanning and capsule construction**

Export:

```js
export const EXTRACTOR_VERSION = "facts-v1";
export const CAPSULE_VERSION = "capsule-v1";
export function normalizeSourceText(value) {}
export function extractFacts(sourceText) {}
export function buildCapsule(candidate, facts, options) {}
```

Extract frontmatter scalars and simple lists, headings with ranges, fenced code
blocks, ordered workflow steps, tools, environment variables, URLs, relative
files, and validation/recovery/checkpoint/side-effect signals. Preserve raw
frontmatter and warn on unsupported YAML. Report Unicode controls, NUL bytes,
and omitted evidence counts. Treat every source instruction as data.

- [ ] **Step 4: Run extraction tests**

Run: `node --test tests/inspect-extract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/skillsmp-search/scripts/inspection/extract.mjs tests/inspect-extract.test.mjs
git commit -m "feat: extract evidence capsules from skills"
```

### Task 4: Agent-facing inspection CLI

**Files:**
- Create: `skills/skillsmp-search/scripts/inspect-skillsmp.mjs`
- Modify: `tests/inspect-pipeline.test.mjs`

- [ ] **Step 1: Write failing pipeline and invariant tests**

```js
test("runInspection accounts for every canonical candidate", async () => {
  const output = await runInspection(
    { candidates: [candidateA, duplicateA, candidateB] },
    { fetchImpl, cacheDir, stateDir, runId: "fixture" },
  );
  assert.equal(output.metrics.canonicalCandidates, 2);
  assert.equal(
    output.metrics.successes + output.metrics.terminalFailures,
    output.metrics.canonicalCandidates,
  );
  assert.equal(output.metrics.networkRequests, 2);
});

test("resume performs no completed fetch again", async () => {
  await runInspection(input, dependencies);
  const resumed = await runInspection(input, { ...dependencies, resume: true });
  assert.equal(resumed.metrics.networkRequests, 0);
  assert.equal(resumed.metrics.cacheHits, 2);
});
```

- [ ] **Step 2: Run the tests and confirm failure**

Run: `node --test tests/inspect-pipeline.test.mjs`

Expected: FAIL because the CLI module is missing.

- [ ] **Step 3: Implement CLI parsing and bounded orchestration**

Support:

```text
--input <file|->
--output <file>
--run-id <id>
--resume
--cache-dir <dir>
--state-dir <dir>
--concurrency <1..12>
--timeout-ms <1000..120000>
--retries <0..5>
--max-source-bytes <1024..1048576>
--format <json|jsonl>
```

Defaults are concurrency 6, timeout 15000 ms, retries 2, source limit 262144
bytes, and JSON output. The output must always contain `status`, `summary`,
`next_actions`, `artifacts`, `metrics`, and `candidates`. Candidate failures do
not fail unrelated candidates. Exit nonzero only for invalid invocation or a
broken run invariant.

- [ ] **Step 4: Run all Node tests**

Run: `npm test`

Expected: all search and inspection tests pass.

- [ ] **Step 5: Commit**

```bash
git add skills/skillsmp-search/scripts/inspect-skillsmp.mjs tests/inspect-pipeline.test.mjs
git commit -m "feat: add batch skill inspection CLI"
```

### Task 5: PowerShell wrapper and agent workflow

**Files:**
- Create: `skills/skillsmp-search/scripts/inspect-skillsmp.ps1`
- Modify: `skills/skillsmp-search/SKILL.md`
- Modify: `README.md`
- Modify: `scripts/validate-repo.mjs`

- [ ] **Step 1: Add a thin PowerShell wrapper**

The wrapper must require Node.js 18+, resolve `inspect-skillsmp.mjs` beside
itself, pass input/output/run/cache/state/concurrency arguments as an argument
vector, and return the Node exit code without reproducing inspector logic.

- [ ] **Step 2: Replace manual GitHub inspection instructions**

Update `SKILL.md` so the agent:

1. performs the metadata shortlist;
2. passes the complete set to `inspect-skillsmp.mjs` once;
3. reads every capsule;
4. expands only named cached ranges or required linked resources;
5. records semantic method delta and scores separately;
6. never reopens a source URL already present in the cache artifact.

State the quality invariant and require actual capsule/failure counts in the
final report.

- [ ] **Step 3: Document direct CLI use and cache semantics**

Add a README example that writes search JSON, selects candidates, runs the
inspector, resumes the same run, and explains that full source is cached while
stdout stays bounded.

- [ ] **Step 4: Extend repository validation**

Require both inspector entry points and scan their content for secrets with the
existing validation logic.

- [ ] **Step 5: Run validation**

Run: `npm run validate`

Expected: `Repository validation passed.`

- [ ] **Step 6: Commit**

```bash
git add README.md scripts/validate-repo.mjs skills/skillsmp-search/SKILL.md skills/skillsmp-search/scripts/inspect-skillsmp.mjs skills/skillsmp-search/scripts/inspect-skillsmp.ps1
git commit -m "docs: route agents through batch inspection"
```

### Task 6: Behavioral and cross-platform acceptance

**Files:**
- Modify: `tests/inspect-pipeline.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add an offline end-to-end fixture**

Create three fake SkillsMP candidates: two duplicate GitHub URLs, one valid
distinct source, and one permanent missing source. Assert deterministic output,
the capsule/failure invariant, cache reuse, metrics, and stable evidence.

- [ ] **Step 2: Add concise CLI smoke tests**

Spawn the inspector with invalid input and assert one-line stderr without a
stack trace. Spawn it with fixture input and assert valid JSON stdout.

- [ ] **Step 3: Run the full suite twice**

Run: `npm test && npm test && npm run validate`

Expected: both test runs and repository validation pass.

- [ ] **Step 4: Run a live public-source smoke test**

Pass two known public skill URLs through the inspector with an isolated cache
and state directory. Run the same command with `--resume`. Confirm the first
run fetches each unique source once and the second run reports zero network
requests.

- [ ] **Step 5: Run skill-comply dry-run**

Run from `<skill-comply-root>`:

```powershell
uv run python -m scripts.run --dry-run "<installed-skill>"
```

Expected: the generated spec and scenarios include mandatory batch inspection,
every-candidate accounting, cache/resume, and no candidate code execution.

- [ ] **Step 6: Commit**

```bash
git add package.json tests/inspect-pipeline.test.mjs
git commit -m "test: verify resumable source inspection"
```

### Task 7: Local installed-skill synchronization

**Files:**
- Update local directory: `<installed-skill>/`

- [ ] **Step 1: Compare source and installed skill trees**

Preserve local-only heavy-mode state files unless the repository version now
contains an intentional replacement. Copy only the new inspector modules,
wrapper, and approved `SKILL.md` sections.

- [ ] **Step 2: Validate the installed entry point**

Run the installed inspector against the same two-candidate fixture and isolated
cache. Confirm its output matches the repository version.

- [ ] **Step 3: Confirm repository state**

Run: `git status --short --branch`

Expected: `main` is ahead only by the local design and implementation commits;
no unrelated files are modified. Do not push.

## Self-review

- Spec coverage: acquisition, cache, extraction, capsules, resume, error
  handling, metrics, docs, behavioral validation, and local synchronization all
  map to tasks above.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation step remains.
- Type consistency: `canonicalKey`, `sourceSha256`, `coverage.fullFileScanned`,
  `metrics.successes`, and `metrics.terminalFailures` use the same names across
  tests and output requirements.
