# Security policy

## Supported version

Security fixes target the latest release on `main`.

## Report a vulnerability

Please do not open a public issue for a vulnerability, credential leak, or unsafe installation path. Use GitHub's private vulnerability reporting from the repository's **Security** tab.

Include the affected file or workflow, impact, reproduction steps, and a suggested fix when you have one. Do not include live API keys or other secrets.

## Security boundaries

- `SKILLSMP_API_KEY` comes from the environment and must never appear in output, examples, tests, or committed files.
- Marketplace listings and candidate repositories are untrusted input.
- Evaluation reads candidate instructions but never runs candidate code.
- Installing a candidate requires an explicit user choice and approval.
- Project-local installation is the default. Global installation requires an explicit request.
