# Pipeline Polish Design

## Problem

The batch inspector fetches and extracts selected `SKILL.md` files quickly, but the heavy-search state does not know that acquisition finished. The benchmark produced 24 capsules and one terminal failure, while `checkpoint.md` still reported `Inspected: 0/25`. Metadata review also required reading a broad candidate file, and the full inspection artifact was too large for one efficient model read.

## Goals

- Separate source acquisition, semantic review, and scoring in heavy state.
- Give the agent one compact index for metadata selection and one compact index for capsule review.
- Preserve the complete capsule and cached source for targeted expansion.
- Keep semantic relevance and method-delta decisions with the agent.
- Preserve zero-network resume for completed acquisition.
- Mark durable and disposable artifacts without adding automatic deletion.

## Non-goals

- Do not let a lexical script choose the final recommendations.
- Do not execute candidate code or linked installers.
- Do not add automatic cache deletion, retention timers, or background jobs.
- Do not push GitHub changes.

## Chosen approach

Keep the portable Node inspector and the local heavy-state adapter separate. The inspector owns source bytes, deterministic facts, capsules, and a compact review index. The heavy-state CLI owns search progress and semantic decisions. A new import command validates the inspector artifact and records acquisition counts without claiming that the agent reviewed or scored the candidates.

This boundary avoids the benchmark failure in which a keyword scorer treated incidental phrases such as “telephone game” as domain evidence. Scripts reduce and organize evidence; the agent decides meaning.

## Data flow

```text
SkillsMP retrieval
→ candidate-index.json
→ agent metadata shortlist/finalists
→ batch inspector
→ inspection.json + review-index.json
→ heavy-state acquisition import
→ agent semantic review
→ scoring
→ recommendations
```

### Candidate index

The heavy-state CLI writes `candidate-index.json` after merged retrieval. It groups mechanical duplicates within the same repository and normalized skill name, prefers primary English skill paths over localized documentation copies, and bounds descriptions. It does not assign task relevance or discard distinct repositories that use the same skill name.

The checkpoint points to this index. The agent reads it once, selects 40–60 plausible candidates, then selects 20–25 finalists. No generic keyword scorer becomes canonical state.

### Review index

When `--output inspection.json` is present, the inspector also writes `inspection.review-index.json`. Each entry contains:

- candidate identity and terminal status;
- bounded discovery description;
- source snapshot and coverage;
- section names and workflow steps;
- validation, recovery, checkpoint, and side-effect signals;
- a small, category-diverse evidence set;
- paths to the complete capsule and cached source.

The index targets about 1,500 characters per candidate. The agent reads all index entries in one bounded call, then opens full capsules or cached ranges for candidates that remain plausible or uncertain.

### Heavy-state acquisition

Add `record-acquisition --search-id <id> --artifact <inspection.json>`. The command:

1. reads the artifact as untrusted JSON;
2. verifies `successes + terminalFailures == canonicalCandidates`;
3. maps every result to a saved finalist by normalized GitHub identity;
4. records capsule count, terminal failures, artifact paths, and metrics;
5. advances the phase to semantic review without creating inspection records.

The checkpoint renders three independent counters:

```text
Sources acquired: 24/25; 1 terminal failure
Semantically reviewed: 0/24
Scored: 0/24
```

`record-inspection` accepts only source-success candidates. `record-score` still requires a successful semantic inspection. `complete` refuses ordinary completion while review or scoring remains incomplete; an explicit benchmark or abandonment path remains separate.

## Artifact lifetime

Every output envelope labels artifacts:

- `durable`: cache objects, active checkpoints, semantic records, and scores;
- `disposable_after_completion`: rendered inspection output and review indexes that can be regenerated from durable cache objects.

The skill never deletes either class automatically. An agent may remove disposable artifacts after a completed search when the user or normal workspace policy permits it.

## Error handling

- Reject an acquisition artifact whose invariant fails.
- Reject candidates outside the saved finalist set.
- Preserve the previous valid acquisition record when import fails.
- Quarantine malformed JSON through the existing store behavior where applicable.
- Keep permanent source failures separate from semantic rejections.
- Resume transient source failures under the same run ID.

## Verification

Tests must prove:

- review-index size remains bounded and all canonical candidates appear;
- full capsules and source paths remain available for expansion;
- acquisition import records 24 successes and one failure without increasing semantic-review count;
- resume after import performs zero network requests;
- checkpoint counters and next actions match the saved phase;
- duplicate/localized metadata entries collapse mechanically without merging distinct repositories;
- completion rejects unfinished semantic work;
- no candidate instruction executes;
- installed and repository inspector files remain byte-identical.

Run the existing 35-test suite, add focused tests for the new index, replay the saved 25-candidate benchmark without new SkillsMP requests, and validate the installed skill. Do not use reviewer subagents.
