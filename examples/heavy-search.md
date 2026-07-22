# Heavy search example

Heavy mode runs only after an explicit request such as `heavy`, `deep search`, or `максимально тщательно`. The counts below illustrate the maximum configured workflow.

## Request

> Use heavy mode to find skills for designing and evaluating production AI agents.

## Retrieval

The skill creates twelve queries that cover the canonical capability, synonyms, outcomes, platform terms, evaluation, observability, and likely gaps. It runs the complete set twice:

```text
12 queries x sortBy=stars  = 12 requests
12 queries x sortBy=recent = 12 requests
Total                      = 24 requests
```

The two passes are normalized by GitHub URL, deduplicated by skill family, and capped at 250 unique candidates.

## Inspection

The evaluator reduces the pool to 40–60 plausible candidates, then fully inspects 20–25 finalists. It compares the leaders pairwise so one family of near-identical skills cannot dominate the result.

## Result shape

```text
Confidence: high
Requests completed: 24
Unique candidates: 217
Finalists inspected: 25
Recommendations: 7

Top three
  1. agent-evaluation — 92/100
  2. agent-architecture-audit — 89/100
  3. multi-agent-orchestration — 84/100
```

Confidence falls to `medium` or `low` when rate limits, stale sources, or missing repository content reduce the inspected pool. The report always states the actual request, candidate, and finalist counts.
