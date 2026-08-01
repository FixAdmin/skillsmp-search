# AIW Branding Implementation Plan

> **For agentic workers:** Execute this plan inline in the current task. The user explicitly declined reviewer subagents. Track each checkbox and keep every external GitHub action out of scope.

**Goal:** Brand the public presentation as **SkillsMP Research by AIW** while preserving every technical `skillsmp-search` identifier and the working Node.js release.

**Architecture:** Make a focused documentation edit and a deterministic text-layer update to the two existing PNG assets. Keep the current illustrations, palette, dimensions, file names, install commands, and runtime untouched.

**Tech Stack:** Markdown, PNG raster assets, Node.js 18+, Git.

---

### Task 1: Update the README first screen

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Update the public name and image description**

Change the image alt text to describe the renamed project, and change the H1 to:

```markdown
# SkillsMP Research by AIW
```

- [ ] **Step 2: Add the independent-project note**

After the short product introduction, add one restrained sentence:

```markdown
SkillsMP Research is an independent project that uses SkillsMP; it is not affiliated with or endorsed by SkillsMP.
```

- [ ] **Step 3: Review the first screen**

Run:

```powershell
Get-Content -LiteralPath README.md -TotalCount 35
```

Expected: one clear product name, one slogan, one factual introduction, and one affiliation clarification. Technical commands and paths remain `skillsmp-search`.

### Task 2: Update the hero and social preview

**Files:**

- Modify: `assets/hero.png`
- Modify: `assets/social-preview.png`

- [ ] **Step 1: Replace the title layer**

Replace `SKILLSMP SEARCH` with `SKILLSMP RESEARCH`, then add `by AIW` as a much smaller signature. Preserve the current workflow illustration and use the existing white, lime, cyan, and navy palette.

- [ ] **Step 2: Preserve asset contracts**

Keep these exact dimensions:

```text
assets/hero.png: 1774 x 887
assets/social-preview.png: 1280 x 640
```

- [ ] **Step 3: Inspect both files**

Open both PNGs at full resolution. Expected: `SKILLSMP RESEARCH` is legible at thumbnail size, `by AIW` is secondary, the existing illustration remains intact, and no personal information or unrelated content appears.

### Task 3: Validate the release package

**Files:**

- Verify: `README.md`
- Verify: `assets/hero.png`
- Verify: `assets/social-preview.png`
- Verify: `skills/skillsmp-search/SKILL.md`

- [ ] **Step 1: Run automated checks**

Run:

```powershell
npm test
npm run validate
```

Expected: all tests and repository validation pass.

- [ ] **Step 2: Run the installed skill validator**

Locate the installed validator from the skill-creator package and validate `skills/skillsmp-search`.

Expected: the skill passes with no schema or packaging errors.

- [ ] **Step 3: Check identifiers and the global install**

Confirm that package metadata, install commands, paths, and skill metadata still use `skillsmp-search`. Resolve the global junction and compare the relevant skill files with the release worktree.

Expected: the global installation points at the release package and contains identical files.

- [ ] **Step 4: Run privacy and release-writing gates**

Scan the tracked tree and reachable history for credential-shaped files or text, personal information, absolute home-directory paths, and private project data. Review public copy for prompt residue, repetitive claims, implementation trivia, and AI-shaped filler.

Expected: no unresolved high-risk findings, and every new public sentence changes a reader's understanding, action, or expectations.

- [ ] **Step 5: Commit the branding change**

Run:

```powershell
git add README.md assets/hero.png assets/social-preview.png
git commit -m "docs: brand SkillsMP Research by AIW"
```

Expected: one focused local commit. Do not push it.

