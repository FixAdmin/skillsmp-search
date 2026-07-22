# Standard search example

This illustrative run looks for skills that help write prompts and documentation. The counts show the normal workflow, not a performance benchmark.

## Request

> Find skills for writing prompts and developer documentation.

## Retrieval

The skill generates five short English queries:

```text
"prompt engineering"
prompt writing
developer documentation
technical writing
README authoring
```

It makes five SkillsMP API requests with `sortBy=stars`, merges repeated GitHub sources, and shortlists candidates by metadata.

## Inspection

Six finalists receive full source inspection. The evaluator reads each complete `SKILL.md`, follows relevant instruction links, lists useful bundled resources, and does not run candidate code.

## Result shape

```text
Primary recommendation
  prompt-engineer — 88/100
  Best for structured prompt iteration and evaluation.

Also useful
  github-readme — 82/100
  Best for onboarding flow and copy-pastable quickstarts.

  developer-marketing — 79/100
  Best for specific, evidence-backed developer writing.
```

Each recommendation includes the useful method delta, strongest source evidence, best use, and important limitation. A real run links to the inspected sources.
