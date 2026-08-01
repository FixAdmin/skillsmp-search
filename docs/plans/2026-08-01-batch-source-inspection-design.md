# Batch source inspection design

## Problem

SkillsMP Search retrieves and ranks marketplace metadata, but the agent still
opens every finalist on GitHub, resolves `SKILL.md`, reads it, and reconstructs
the same evidence after a resume or context compaction. This preserves quality
but wastes network calls, elapsed time, and model context.

The new workflow must keep the current quality bar: every selected candidate
must receive a complete source scan and an evidence-based semantic review. It
must reduce acquisition and context cost without replacing judgment with a
shallow deterministic score.

## Goals

- Fetch each unique source once, then reuse it across runs.
- Scan the complete `SKILL.md` for every selected candidate.
- Give the agent a compact, stable review capsule with evidence line ranges.
- Preserve the full source locally for targeted expansion without another
  GitHub request.
- Resume after interruption without repeating completed candidate stages.
- Return deterministic, schema-shaped output with recovery guidance.
- Work on Windows, macOS, and Linux with Node.js 18+ and no runtime packages.
- Treat all candidate content as inert, untrusted data.

## Non-goals

- The CLI will not assign the final content score or choose the winner.
- The CLI will not execute candidate commands, scripts, hooks, or installers.
- The first release will not require a GitHub token, GraphQL, SQLite, or a
  model API.
- The inspector will not silently choose a top-N subset. The agent must pass the
  complete metadata shortlist or finalist set.

## Architecture

Keep discovery and inspection separate:

```text
search-skillsmp.mjs
  -> metadata pool
  -> agent metadata shortlist
  -> inspect-skillsmp.mjs
       -> canonical source identity
       -> raw-first bounded fetch
       -> content-addressed cache
       -> deterministic full-file extraction
       -> evidence-bounded review capsules
       -> atomic per-candidate checkpoint
  -> agent semantic review and rubric score
  -> recommendations
```

`search-skillsmp.mjs` remains backward-compatible and metadata-only.
`inspect-skillsmp.mjs` accepts a JSON array or an object with `candidates` on
stdin or through `--input`. The inspector processes every canonical candidate.

## Source acquisition

The resolver normalizes public GitHub URLs and derives an exact `SKILL.md`
source when the URL identifies a repository tree or blob. It prefers ordinary
HTTPS retrieval from GitHub's raw host. REST is a fallback for an unresolved
root repository or a missing direct path.

Default limits:

- concurrency: 6;
- timeout: 15 seconds;
- transient retries: 2;
- maximum `SKILL.md`: 256 KiB;
- redirects: HTTPS GitHub hosts only;
- candidate code execution: never.

The first valid bytes are frozen for the run. Each source records exact byte
SHA-256, normalized-text SHA-256, byte count, line count, retrieval method,
cache status, and snapshot strength. Mutable branch content is labeled
`content_frozen`; a commit-addressed source is labeled `commit_pinned`.

## Cache and run state

The cache stores immutable bytes separately from resumable run state:

```text
<cache>/v1/
  objects/sha256/<prefix>/<content-sha>
  source-refs/<canonical-url-sha>.json
  facts/<content-sha>.<extractor-version>.json
  capsules/<content-sha>.<capsule-version>.json

<state>/runs/<run-id>/
  manifest.json
  candidates/<candidate-id>.json
  output/inspection.json
```

Writes use temporary-file-plus-rename. A candidate advances through:

```text
queued -> canonicalized -> fetched -> validated -> extracted -> emitted
```

A terminal fetch or parse failure is stored explicitly. The quality invariant
is:

```text
successful capsules + terminal failures == canonical selected candidates
```

Changing extraction or capsule versions recomputes only the affected local
stage. It never refetches unchanged source bytes.

## Deterministic extraction

The extractor scans the complete normalized file and records facts, not quality
claims:

- frontmatter scalars and simple lists;
- heading hierarchy and line ranges;
- ordered workflow stages;
- fenced command blocks and declared languages;
- tools, environment variables, URLs, and referenced local files;
- installation, mutation, execution, deletion, and network signals;
- validation, testing, rollback, failure recovery, and checkpoint signals;
- Unicode controls, NUL bytes, oversized sections, and parser warnings.

Unsupported YAML remains raw and receives a warning. The extractor never
labels a skill safe, complete, current, or useful.

## Review capsule

Each capsule contains:

```json
{
  "identity": {},
  "discovery": {},
  "source": {},
  "digest": {},
  "methodSignals": {},
  "evidence": [],
  "coverage": {},
  "terminalFailure": null
}
```

Evidence entries include category, claim, heading, start line, end line, and a
bounded excerpt. The default capsule contains at most 16 evidence records, 240
characters per excerpt, and 12,000 characters total. Safety-critical and
task-relevant evidence precedes descriptive evidence.

The capsule exposes the cached full-source path. If the agent lacks evidence
for method delta or a limitation, it reads a named cached range or asks the
inspector to expand required linked files. It does not reopen GitHub manually.

## Agent-facing output

The top-level envelope follows one stable contract:

```json
{
  "status": "success|warning|error",
  "summary": "one-line result",
  "next_actions": [],
  "artifacts": {},
  "metrics": {},
  "candidates": []
}
```

Metrics include selected candidates, canonical candidates, successes,
terminal failures, cache hits, network requests, downloaded bytes, retries,
and elapsed milliseconds. Errors include a root-cause hint, safe retry action,
and stop condition.

## Skill workflow changes

Standard mode keeps three to five SkillsMP calls, then passes all six to eight
metadata finalists to the inspector in one invocation. Heavy mode passes all
20 to 25 finalists and uses the heavy search ID as the inspection run ID.

The agent reviews capsules in bounded batches. It still performs semantic
method-delta analysis and rubric scoring for every successful finalist. Source
acquisition, facts, and evidence survive compaction outside model context.

## Failure handling

- `404` and `410` become terminal source failures for the run.
- Timeouts, `429`, and transient `5xx` receive bounded retries.
- Rate-limit responses lower concurrency and preserve completed candidates.
- An oversized, binary, or unsafe redirect target fails before storage.
- One candidate failure never discards other completed candidates.
- A corrupt candidate checkpoint is quarantined and recomputed alone.
- Secrets and authorization headers never enter cache metadata or logs.

## Verification

Unit and integration tests must prove:

- duplicate marketplace records cause one source fetch;
- a resumed cached run performs no completed fetch again;
- every selected candidate yields a capsule or terminal failure;
- LF and CRLF sources produce identical facts and line references;
- repeated runs produce byte-identical facts and capsules;
- extractor or capsule version changes do not refetch source;
- redirects outside approved GitHub hosts fail closed;
- timeout, retry, `429`, `5xx`, `404`, and oversized-body outcomes are stable;
- source instructions cannot alter configuration, schema, or state;
- no referenced command or script executes;
- Windows, macOS, and Linux tests pass on Node 18 and a current LTS.

The behavioral acceptance test compares the existing manual workflow with the
new capsule workflow on the same search fixture. The new workflow must inspect
the same candidates, preserve source-grounded conclusions, reduce repeated
network requests, and reduce review-context size. Token reduction alone does
not count as success if recommendation quality changes.

## Rollout

Implement the raw-first, file-backed inspector now. Keep fetch, cache, extract,
and checkpoint logic behind small interfaces. Add authenticated GraphQL only
after measurements show that source request count is the bottleneck. Add
SQLite only if concurrent workers or large historical inventories make atomic
JSON state insufficient.
