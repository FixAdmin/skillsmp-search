import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  parseArgs,
  runInspection,
} from "../skills/skillsmp-search/scripts/inspect-skillsmp.mjs";

import {
  createStore,
  sha256,
} from "../skills/skillsmp-search/scripts/inspection/store.mjs";

const execFileAsync = promisify(execFile);
const inspectorPath = join(
  process.cwd(),
  "skills",
  "skillsmp-search",
  "scripts",
  "inspect-skillsmp.mjs",
);

async function temporaryStore(runId = "fixture") {
  const root = await mkdtemp(join(tmpdir(), "skillsmp-inspect-"));
  return {
    root,
    store: createStore({
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      runId,
    }),
  };
}

test("content object is immutable and source ref reuses it", async () => {
  const { store } = await temporaryStore("run-1");
  const bytes = Buffer.from("abc");
  const first = await store.putSource({ canonicalUrl: "https://example.test/a", bytes });
  const second = await store.putSource({ canonicalUrl: "https://example.test/a", bytes });

  assert.equal(first.sourceSha256, sha256(bytes));
  assert.equal(first.cacheHit, false);
  assert.equal(second.sourceSha256, first.sourceSha256);
  assert.equal(second.cacheHit, true);
  assert.deepEqual((await store.getSource("https://example.test/a")).bytes, bytes);
});

test("candidate checkpoint resumes at the recorded stage", async () => {
  const { store } = await temporaryStore("run-2");
  await store.writeCandidate("candidate-a", {
    stage: "extracted",
    sourceSha256: "abc",
  });

  assert.deepEqual(await store.readCandidate("candidate-a"), {
    version: 1,
    canonicalKey: "candidate-a",
    stage: "extracted",
    sourceSha256: "abc",
  });
});

test("invalid checkpoint JSON is quarantined and treated as absent", async () => {
  const { store } = await temporaryStore("run-3");
  await store.writeCandidate("candidate-a", { stage: "fetched" });
  const path = store.paths.candidate("candidate-a");
  await writeFile(path, "{broken", "utf8");

  assert.equal(await store.readCandidate("candidate-a"), null);
  const directory = store.paths.candidateDirectory;
  const names = await import("node:fs/promises").then(({ readdir }) => readdir(directory));
  assert.ok(names.some((name) => name.includes(".corrupt-")));
});

test("facts and capsules are versioned and reusable", async () => {
  const { store } = await temporaryStore("run-4");
  await store.putFacts("source-hash", "facts-v1", { headings: [] });
  await store.putCapsule("source-hash", "capsule-v1", "candidate-a", {
    evidence: [],
  });

  assert.deepEqual(await store.getFacts("source-hash", "facts-v1"), {
    headings: [],
  });
  assert.deepEqual(
    await store.getCapsule("source-hash", "capsule-v1", "candidate-a"),
    { evidence: [] },
  );

  const stored = JSON.parse(
    await readFile(store.paths.facts("source-hash", "facts-v1"), "utf8"),
  );
  assert.equal(stored.version, "facts-v1");
});

const candidateA = {
  id: "a",
  name: "Alpha",
  githubUrl: "https://github.com/owner/repo/tree/main/skills/alpha",
};
const duplicateA = {
  id: "a-copy",
  name: "Alpha copy",
  githubUrl: "https://github.com/OWNER/REPO/blob/main/skills/alpha/SKILL.md",
};
const candidateB = {
  id: "b",
  name: "Beta",
  githubUrl: "https://raw.githubusercontent.com/owner/repo/main/skills/beta/SKILL.md",
};
const missingCandidate = {
  id: "missing",
  name: "Missing",
  githubUrl: "https://github.com/owner/repo/tree/main/skills/missing",
};

function fixtureFetch(calls) {
  return async (url) => {
    calls.push(String(url));
    if (String(url).includes("/missing/")) {
      return new Response("missing", { status: 404 });
    }
    const name = String(url).includes("/alpha/") ? "Alpha" : "Beta";
    return new Response(
      `---\nname: ${name.toLowerCase()}\n---\n# ${name}\n## Workflow\n1. Inspect the full source.\n2. Verify evidence.\n## Recovery\nRetry once, then stop.\n`,
      { status: 200 },
    );
  };
}

test("runInspection accounts for every canonical candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillsmp-run-"));
  const calls = [];
  const output = await runInspection(
    { candidates: [candidateA, duplicateA, candidateB, missingCandidate] },
    {
      fetchImpl: fixtureFetch(calls),
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      runId: "fixture",
      retries: 0,
    },
  );

  assert.equal(output.status, "partial");
  assert.equal(output.metrics.inputCandidates, 4);
  assert.equal(output.metrics.canonicalCandidates, 3);
  assert.equal(output.metrics.duplicates, 1);
  assert.equal(output.metrics.successes, 2);
  assert.equal(output.metrics.terminalFailures, 1);
  assert.equal(output.metrics.successes + output.metrics.terminalFailures, 3);
  assert.equal(output.metrics.networkRequests, 3);
  assert.equal(calls.length, 3);
  assert.ok(output.candidates.filter((item) => item.status === "success").every((item) => item.capsule.coverage.fullFileScanned));
});

test("resume performs no completed or permanent fetch again", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillsmp-resume-"));
  const calls = [];
  const dependencies = {
    fetchImpl: fixtureFetch(calls),
    cacheDir: join(root, "cache"),
    stateDir: join(root, "state"),
    runId: "resume-fixture",
    retries: 0,
  };
  const input = { candidates: [candidateA, candidateB, missingCandidate] };
  await runInspection(input, dependencies);
  calls.length = 0;
  const resumed = await runInspection(input, { ...dependencies, resume: true });

  assert.equal(resumed.metrics.networkRequests, 0);
  assert.equal(resumed.metrics.cacheHits, 2);
  assert.equal(resumed.metrics.resumedCandidates, 3);
  assert.equal(calls.length, 0);
  assert.equal(resumed.metrics.successes + resumed.metrics.terminalFailures, 3);
});

test("one corrupt cached candidate does not discard unrelated results", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillsmp-isolation-"));
  const cacheDir = join(root, "cache");
  const stateDir = join(root, "state");
  const store = createStore({ cacheDir, stateDir, runId: "isolation" });
  const seeded = await store.putSource({
    canonicalUrl: "https://raw.githubusercontent.com/owner/repo/main/skills/alpha/SKILL.md",
    bytes: Buffer.from("# Alpha\n"),
  });
  await writeFile(seeded.objectPath, "tampered", "utf8");
  await store.writeCandidate("github.com/owner/repo/skills/alpha", {
    stage: "fetched",
    sourceSha256: seeded.sourceSha256,
  });

  const output = await runInspection(
    { candidates: [candidateA, candidateB] },
    {
      fetchImpl: fixtureFetch([]),
      cacheDir,
      stateDir,
      runId: "isolation",
      retries: 0,
      resume: true,
    },
  );

  assert.equal(output.status, "partial");
  assert.equal(output.metrics.successes, 1);
  assert.equal(output.metrics.terminalFailures, 1);
  assert.equal(
    output.candidates.find((item) => item.canonicalKey.endsWith("/alpha")).failure.code,
    "candidate_processing_error",
  );
  assert.equal(
    output.candidates.find((item) => item.canonicalKey.endsWith("/beta")).status,
    "success",
  );
});

test("a new run refreshes mutable branch URLs instead of trusting stale refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillsmp-refresh-"));
  const cacheDir = join(root, "cache");
  const stateDir = join(root, "state");
  const seed = createStore({ cacheDir, stateDir, runId: "old-run" });
  await seed.putSource({
    canonicalUrl: "https://raw.githubusercontent.com/owner/repo/main/skills/alpha/SKILL.md",
    bytes: Buffer.from("# Stale\n"),
  });
  const calls = [];
  const output = await runInspection(
    { candidates: [candidateA] },
    {
      fetchImpl: fixtureFetch(calls),
      cacheDir,
      stateDir,
      runId: "new-run",
      retries: 0,
      resume: true,
    },
  );

  assert.equal(output.status, "success");
  assert.equal(output.metrics.networkRequests, 1);
  assert.equal(output.metrics.cacheHits, 0);
  assert.equal(calls.length, 1);
  assert.equal(output.candidates[0].capsule.candidate.name, "Alpha");
});

test("parseArgs validates bounded agent-facing options", () => {
  assert.deepEqual(
    parseArgs(["--input", "-", "--resume", "--concurrency", "4", "--format", "jsonl"]),
    {
      input: "-",
      output: null,
      reviewIndex: null,
      runId: null,
      resume: true,
      cacheDir: null,
      stateDir: null,
      concurrency: 4,
      timeoutMs: 15_000,
      retries: 2,
      maxSourceBytes: 262_144,
      format: "jsonl",
    },
  );
  assert.throws(() => parseArgs(["--input", "-", "--concurrency", "99"]), /concurrency/);
  assert.throws(() => parseArgs([]), /--input/);
});

test("CLI argument failures stay concise and omit stack traces", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [inspectorPath, "--unknown", "x"]),
    (error) => {
      assert.match(error.stderr, /^SkillsMP inspection failed: unknown argument: --unknown\r?\n$/);
      assert.doesNotMatch(error.stderr, /\n\s+at\s/);
      return true;
    },
  );
});

test("CLI emits valid JSON from a fully cached offline source", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillsmp-cli-"));
  const cacheDir = join(root, "cache");
  const stateDir = join(root, "state");
  const inputPath = join(root, "input.json");
  const outputPath = join(root, "inspection.json");
  const rawUrl = "https://raw.githubusercontent.com/owner/repo/main/skills/alpha/SKILL.md";
  const store = createStore({ cacheDir, stateDir, runId: "offline" });
  const seeded = await store.putSource({
    canonicalUrl: rawUrl,
    bytes: Buffer.from("# Alpha\n## Workflow\n1. Verify the result.\n"),
  });
  await store.writeCandidate("github.com/owner/repo/skills/alpha", {
    stage: "fetched",
    sourceSha256: seeded.sourceSha256,
  });
  await writeFile(inputPath, JSON.stringify({ candidates: [candidateA] }), "utf8");

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    inspectorPath,
    "--input", inputPath,
    "--output", outputPath,
    "--cache-dir", cacheDir,
    "--state-dir", stateDir,
    "--run-id", "offline",
    "--resume",
  ]);
  const output = JSON.parse(stdout);
  const reviewPath = join(root, "inspection.review-index.json");
  assert.equal(stderr, "");
  assert.equal(output.status, "success");
  assert.equal(output.metrics.networkRequests, 0);
  assert.equal(output.metrics.cacheHits, 1);
  assert.equal(output.artifacts.reviewIndex, reviewPath);
  assert.equal(output.artifact_lifetimes.reviewIndex, "disposable_after_completion");
  assert.equal(output.artifact_lifetimes.cacheDir, "durable");
  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  assert.equal(review.entries.length, 1);
  assert.equal(review.entries[0].status, "success");
});
