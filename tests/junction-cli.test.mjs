import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("all Node entry points run normally through a linked skill directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillsmp-linked-cli-"));
  const realSkill = resolve("skills", "skillsmp-search");
  const linkedSkill = join(root, "skillsmp-search");
  await symlink(
    realSkill,
    linkedSkill,
    process.platform === "win32" ? "junction" : "dir",
  );

  const cases = [
    {
      script: "search-skillsmp.mjs",
      args: ["--query", "x", "--sort-by", "invalid"],
      error: /^SkillsMP search failed:/,
    },
    {
      script: "inspect-skillsmp.mjs",
      args: ["--unknown", "x"],
      error: /^SkillsMP inspection failed:/,
    },
    {
      script: "heavy-search-state.mjs",
      args: ["unknown"],
      error: /^Heavy search failed:/,
    },
  ];

  for (const fixture of cases) {
    const result = spawnSync(
      process.execPath,
      [join(linkedSkill, "scripts", fixture.script), ...fixture.args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, fixture.script);
    assert.match(result.stderr, fixture.error, fixture.script);
  }
});
