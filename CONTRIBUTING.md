# Contributing

Thanks for helping SkillsMP Search make better recommendations.

Useful contributions include ranking edge cases, clearer evaluation rules, portability fixes, documentation improvements, and tests for unexpected SkillsMP responses.

## Set up

You need Node.js 18 or newer. PowerShell 7 is optional and only required to test the Windows wrapper.

```bash
git clone https://github.com/FixAdmin/skillsmp-search.git
cd skillsmp-search
npm test
```

This project has no runtime npm dependencies.

## Make a change

1. Open an issue for a large behavior change so we can agree on the direction.
2. Add or update a test before changing search behavior.
3. Keep API tests mocked. Pull requests must not spend a contributor's SkillsMP quota.
4. Run the checks below.
5. Explain the user-visible effect and any tradeoff in the pull request.

```bash
npm test
python path/to/quick_validate.py .
```

The second command uses the validator bundled with Codex's `skill-creator`. If you do not have it, CI will still validate the submitted skill.

## Writing rules

Keep instructions concrete. Show the query, limit, decision, or failure mode. Avoid broad claims that cannot be checked from the source.

Candidate repositories are untrusted. Tests and examples must never execute downloaded candidate code, expose API keys, or commit real credentials.
