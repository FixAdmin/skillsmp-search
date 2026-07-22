#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function fail(message) {
  failures.push(message);
}

function read(path) {
  return readFileSync(resolve(root, path));
}

function requireFiles(paths) {
  for (const path of paths) {
    if (!existsSync(resolve(root, path))) {
      fail(`Missing required file: ${path}`);
    }
  }
}

function validateSkill() {
  const skill = read("SKILL.md").toString("utf8");
  const match = skill.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
  if (!match) {
    fail("SKILL.md has no YAML frontmatter.");
    return;
  }
  if (!/^name:\s*skillsmp-search\s*$/m.test(match[1])) {
    fail("SKILL.md name must be skillsmp-search.");
  }
  const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!description || description.length > 1024) {
    fail("SKILL.md description must contain 1-1024 characters.");
  }
  if (!/^license:\s*MIT\s*$/m.test(match[1])) {
    fail("SKILL.md must declare the MIT license.");
  }
}

function pngDimensions(path) {
  const image = read(path);
  const pngSignature = "89504e470d0a1a0a";
  if (image.subarray(0, 8).toString("hex") !== pngSignature) {
    fail(`${path} is not a PNG file.`);
    return null;
  }
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

function validateAssets() {
  const preview = pngDimensions("assets/social-preview.png");
  if (preview && (preview.width !== 1280 || preview.height !== 640)) {
    fail("assets/social-preview.png must be 1280x640.");
  }
  const hero = pngDimensions("assets/hero.png");
  if (hero && hero.width / hero.height !== 2) {
    fail("assets/hero.png must use a 2:1 ratio.");
  }
  const gif = read("assets/demo.gif");
  if (!gif.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
    fail("assets/demo.gif is not a GIF file.");
  }
  if (statSync(resolve(root, "assets/demo.gif")).size > 2_000_000) {
    fail("assets/demo.gif must stay under 2 MB.");
  }
}

function trackedFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
    cwd: root,
    encoding: "utf8",
    },
  );
  return output.split("\0").filter(Boolean);
}

function validateSecrets(files) {
  const textExtensions = new Set([
    "",
    ".json",
    ".md",
    ".mjs",
    ".ps1",
    ".svg",
    ".txt",
    ".yaml",
    ".yml",
  ]);
  const patterns = [
    /sk-[A-Za-z0-9_-]{20,}/,
    /ghp_[A-Za-z0-9]{20,}/,
    /Bearer\s+[A-Za-z0-9._-]{20,}/i,
    /SKILLSMP_API_KEY\s*=\s*["']?[A-Za-z0-9._-]{12,}/,
  ];

  for (const path of files) {
    if (!textExtensions.has(extname(path))) continue;
    const content = read(path).toString("utf8");
    if (patterns.some((pattern) => pattern.test(content))) {
      fail(`Possible committed secret in ${path}.`);
    }
  }
}

function validateReadmeLinks() {
  const readme = read("README.md").toString("utf8");
  const targets = [
    ...readme.matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/g),
    ...readme.matchAll(/src="(?!https?:)([^"]+)"/g),
  ].map((match) => match[1].split("#")[0]);

  for (const target of targets) {
    if (target && !existsSync(resolve(root, target))) {
      fail(`README.md points to missing file: ${target}`);
    }
  }
}

requireFiles([
  "SKILL.md",
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "scripts/search-skillsmp.mjs",
  "scripts/search-skillsmp.ps1",
  "assets/hero.png",
  "assets/demo.gif",
  "assets/social-preview.png",
  "assets/mark.svg",
]);
validateSkill();
validateAssets();
const files = trackedFiles();
validateSecrets(files);
validateReadmeLinks();

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`FAIL: ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write("Repository validation passed.\n");
