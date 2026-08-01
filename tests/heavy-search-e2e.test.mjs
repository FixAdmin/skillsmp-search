import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHeavySearchStore } from "../skills/skillsmp-search/scripts/heavy-search-state.mjs";
import { runInspection } from "../skills/skillsmp-search/scripts/inspect-skillsmp.mjs";
import { buildReviewIndex } from "../skills/skillsmp-search/scripts/inspection/review.mjs";
import { runSearch } from "../skills/skillsmp-search/scripts/search-skillsmp.mjs";

const candidates = [
  {
    id: "alpha",
    name: "Agent CLI",
    author: "fixture",
    description: "Builds resumable agent command line workflows.",
    githubUrl: "https://github.com/fixture/skills/tree/main/skills/agent-cli",
    stars: 10,
  },
  {
    id: "beta",
    name: "Pipeline Automation",
    author: "fixture",
    description: "Automates bounded tool pipelines.",
    githubUrl: "https://github.com/fixture/skills/tree/main/skills/pipeline-automation",
    stars: 7,
  },
];

test("explicit heavy workflow completes and then resumes with zero network calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "skillsmp-heavy-e2e-"));
  let tick = 0;
  const heavyStore = createHeavySearchStore({
    stateRoot: join(root, "heavy"),
    now: () => new Date(Date.UTC(2026, 7, 2, 14, 0, tick++)).toISOString(),
    randomHex: () => "e2e00001",
  });
  const queries = ["agent cli", "pipeline automation"];
  const { searchId } = await heavyStore.start({ request: "Find agent CLI automation", cwd: root, queries });

  const apiCalls = [];
  const apiFetch = async (url) => {
    apiCalls.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return { success: true, data: { skills: candidates } };
      },
    };
  };
  for (const sortBy of ["stars", "recent"]) {
    await runSearch(
      {
        queries,
        limitPerQuery: 50,
        sortBy,
        maxCandidates: 200,
        heavySearchId: searchId,
        retryAmbiguous: false,
      },
      { heavyStore, fetchImpl: apiFetch },
    );
  }
  assert.equal(apiCalls.length, 4);

  const index = await heavyStore.buildCandidateIndex({ searchId, limit: 40 });
  assert.equal(index.candidateCount, 2);
  const poolPath = join(heavyStore.stateRoot, searchId, "candidates.json");
  const pool = JSON.parse(await readFile(poolPath, "utf8"));
  const keys = pool.candidates.map((candidate) => candidate.key);
  await heavyStore.setCandidates({ searchId, stage: "shortlist", candidates: keys });
  await heavyStore.setCandidates({ searchId, stage: "finalists", candidates: keys });

  const sourceCalls = [];
  const sourceFetch = async (url) => {
    sourceCalls.push(String(url));
    const name = String(url).includes("agent-cli") ? "Agent CLI" : "Pipeline Automation";
    return new Response(
      `---\nname: ${name.toLowerCase().replaceAll(" ", "-")}\n---\n# ${name}\n## Workflow\n1. Save a checkpoint.\n2. Resume the same run.\n## Validation\nConfirm every selected item is accounted for.\n`,
      { status: 200 },
    );
  };
  const inspectionDependencies = {
    fetchImpl: sourceFetch,
    cacheDir: join(root, "cache"),
    stateDir: join(root, "inspection-state"),
    runId: searchId,
    retries: 0,
  };
  const finalistPath = join(heavyStore.stateRoot, searchId, "finalists.json");
  const finalistInput = JSON.parse(await readFile(finalistPath, "utf8"));
  const inspection = await runInspection(finalistInput, inspectionDependencies);
  const inspectionPath = join(heavyStore.stateRoot, searchId, "inspection.json");
  const reviewIndexPath = join(heavyStore.stateRoot, searchId, "inspection.review-index.json");
  inspection.artifacts.output = inspectionPath;
  inspection.artifacts.reviewIndex = reviewIndexPath;
  await writeFile(inspectionPath, JSON.stringify(inspection), "utf8");
  await writeFile(reviewIndexPath, JSON.stringify(buildReviewIndex(inspection)), "utf8");
  assert.equal(sourceCalls.length, 2);
  await heavyStore.recordAcquisition({ searchId, artifactPath: inspectionPath });

  await heavyStore.recordInspections({
    searchId,
    records: keys.map((candidateKey) => ({
      candidateKey,
      status: "inspected",
      summary: "Provides a concrete resumable workflow.",
      evidence: "The source saves progress and verifies accounting.",
      methodDelta: "Replaces manual restart with durable checkpoints.",
      limitations: "Fixture evidence only.",
    })),
  });
  await heavyStore.recordScores({
    searchId,
    records: keys.map((candidateKey, indexNumber) => ({
      candidateKey,
      total: 85 - indexNumber,
      rationale: "Direct workflow fit with validation.",
      confidence: "high",
    })),
  });
  await heavyStore.complete({ searchId, summary: "Two recommendations prepared." });

  apiCalls.length = 0;
  for (const sortBy of ["stars", "recent"]) {
    const receipt = await runSearch(
      {
        queries,
        limitPerQuery: 50,
        sortBy,
        maxCandidates: 200,
        heavySearchId: searchId,
        retryAmbiguous: false,
      },
      { heavyStore, fetchImpl: apiFetch },
    );
    assert.equal(receipt.skippedRequests, 2);
  }
  assert.equal(apiCalls.length, 0);

  sourceCalls.length = 0;
  const resumedInspection = await runInspection(finalistInput, {
    ...inspectionDependencies,
    resume: true,
  });
  assert.equal(sourceCalls.length, 0);
  assert.equal(resumedInspection.metrics.networkRequests, 0);
  assert.equal(resumedInspection.metrics.cacheHits, 2);

  const finalState = await heavyStore.load(searchId);
  assert.equal(finalState.status, "completed");
  assert.equal(finalState.acquisition.successes, 2);
  assert.equal(Object.keys(finalState.inspections).length, 2);
  assert.equal(Object.keys(finalState.scores).length, 2);
});
