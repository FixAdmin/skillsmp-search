# SkillsMP Search Open-Source Launch Design

## Goal

Publish `skillsmp-search` as a friendly, trustworthy Agent Skill that works on Windows, macOS, and Linux. The repository must help a visitor understand the value, install the skill, and run a first search within one minute.

## Audience and promise

The primary audience is people who use coding agents and want either to explore a topic or assemble the right set of skills for a task.

The opening promise is:

> Need to explore a topic or build the right skill stack for a task? This skill is for you.

The README will explain the practical difference: marketplace metadata finds candidates; `skillsmp-search` reads the source, compares methods, removes duplicates, and reports limitations.

## Identity

The visual concept is **Skill Arcade**. Search results appear as arcade cards moving through an inspection machine. Strong candidates receive evidence-backed scores. Duplicates, stale sources, and shallow instructions drop out of the result.

The style uses a dark navy base, acid green as the main accent, cyan for search activity, and coral for rejected candidates. It should feel playful and memorable without looking childish.

Planned assets:

- a README hero;
- a short search animation;
- a 1280 x 640 GitHub social preview;
- a small magnifying-glass and skill-card mark.

## README story

The README will answer questions in this order:

1. Who is this for?
2. What problem does it solve?
3. How do I install it?
4. What does a search look like?
5. How do standard and heavy modes differ?
6. Why should I trust the recommendations?
7. What are the API and runtime limits?
8. How can I contribute?

The copy will use short paragraphs, concrete examples, and honest limits. It will avoid inflated claims and unsupported compatibility badges.

## Cross-platform runtime

Node.js 18 or newer will become the canonical runtime because the recommended `npx skills add` installation path already requires Node.js. The search implementation will use only built-in Node APIs.

`scripts/search-skillsmp.mjs` will own query execution, result normalization, deduplication, ranking, and JSON output. `scripts/search-skillsmp.ps1` will remain as a thin Windows-compatible wrapper that forwards arguments to the Node script. This preserves the familiar PowerShell entry point without maintaining two search implementations.

Installation of a selected third-party skill will use the cross-platform `skills` CLI. The skill will still require explicit user approval before installation and will default to project scope.

## Modes

Standard mode remains the default:

- three to five short queries;
- one `stars` retrieval pass;
- up to forty merged candidates;
- six to eight source-inspected finalists;
- three to five recommendations.

Heavy mode runs only after an explicit request:

- ten to twelve queries;
- separate `stars` and `recent` passes;
- twenty to twenty-four API requests;
- up to 250 unique candidates after merging;
- twenty to twenty-five fully inspected finalists;
- five to eight recommendations.

The Node port must preserve these limits and the existing JSON shape.

## Repository layout

```text
skillsmp-search/
|-- SKILL.md
|-- agents/openai.yaml
|-- scripts/
|   |-- search-skillsmp.mjs
|   |-- search-skillsmp.ps1
|   `-- install-project-skill.ps1
|-- tests/
|-- examples/
|-- assets/
|-- .github/workflows/validate.yml
|-- README.md
|-- CONTRIBUTING.md
|-- SECURITY.md
|-- CHANGELOG.md
`-- LICENSE
```

The root-level `SKILL.md` keeps the repository discoverable by the `skills` CLI and compatible with the Agent Skills specification.

## Installation and compatibility

The primary installation command will be:

```bash
npx skills add OWNER/skillsmp-search
```

The README will also show an explicit Codex installation and a manual fallback. Compatibility claims will distinguish the portable Agent Skills format from tested runtime support.

The first release will claim:

- Agent Skills specification compatible;
- tested with Codex on Windows;
- automatically tested on Windows, macOS, and Linux with supported Node versions.

It will not claim that every agent implements every optional skill feature.

## Errors and safety

The search script will fail with a non-zero exit code and a concise message when arguments are invalid, the API rejects a request, the response shape is invalid, or Node is too old. It will never print the API key.

The API key will come from `SKILLSMP_API_KEY`. Anonymous searches remain available within the lower public rate limits. Heavy-mode documentation will state its twenty-to-twenty-four-request cost.

Candidate repositories remain untrusted input. The skill will continue to forbid running candidate code during evaluation. Installation requires explicit selection and approval.

## Verification

Tests will cover argument parsing, query encoding, deduplication, ranking, candidate caps, missing stars, unsuccessful API responses, and secret-safe error output. HTTP calls will use a mocked transport so automated tests consume no SkillsMP quota.

GitHub Actions will run on Windows, macOS, and Linux. CI will validate the skill structure, run Node tests, parse the PowerShell wrapper, scan tracked files for common secret patterns, and avoid live API calls.

Before release, a local smoke test will run a small standard search against the live API. Heavy behavior will be verified with mocked responses and the successful manual run already completed during development.

## Release

The first public release will be `v0.1.0` under the MIT License. It will include the skill, cross-platform runtime, examples, visual assets, contribution and security guidance, and a short release note focused on what users can do.

## Non-goals

The first release will not add a separate package manager, hosted service, GUI, analytics, or automatic background updates. The repository will rely on the existing Agent Skills ecosystem and `npx skills update`.
