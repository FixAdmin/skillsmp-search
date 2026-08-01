import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createHeavySearchStore,
  normalizeComparablePath,
} from "../skills/skillsmp-search/scripts/heavy-search-state.mjs";

async function fixtureStore() {
  const root = await mkdtemp(join(tmpdir(), "skillsmp-heavy-"));
  let tick = 0;
  const store = createHeavySearchStore({
    stateRoot: root,
    now: () => new Date(Date.UTC(2026, 7, 2, 12, 0, tick++)).toISOString(),
    randomHex: () => "1a2b3c4d",
    lockTimeoutMs: 100,
    staleLockMs: 20,
  });
  return { root, store };
}

async function startFixture(store, queries = ["agent cli", "agent automation"]) {
  return store.start({
    request: "Find agent CLI automation skills",
    cwd: process.cwd(),
    queries,
  });
}

function response(skills) {
  return { success: true, data: { skills } };
}

const alpha = {
  id: "alpha",
  name: "Agent CLI",
  author: "one",
  description: "Build agent command line workflows.",
  githubUrl: "https://github.com/one/toolbox/tree/main/skills/agent-cli",
  stars: 8,
};

const alphaLocalized = {
  ...alpha,
  id: "alpha-ja",
  githubUrl: "https://github.com/one/toolbox/tree/main/docs/ja-jp/agent-cli",
  stars: 9,
};

const sameNameOtherRepo = {
  ...alpha,
  id: "alpha-two",
  author: "two",
  githubUrl: "https://github.com/two/agents/tree/main/skills/agent-cli",
};

const beta = {
  id: "beta",
  name: "Pipeline Builder",
  author: "one",
  description: "Automates bounded tool pipelines.",
  githubUrl: "https://github.com/one/toolbox/tree/main/skills/pipeline-builder",
  stars: 5,
};

test("start writes portable schema-v1 state and a compact recovery checkpoint", async () => {
  const { root, store } = await fixtureStore();
  const started = await startFixture(store);

  assert.equal(started.searchId, "20260802T120000Z-1a2b3c4d");
  const state = await store.load(started.searchId);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.phase, "retrieval-stars");
  assert.deepEqual(state.queries, ["agent cli", "agent automation"]);
  assert.deepEqual(state.retrieval.stars.dispatchedQueries, []);

  const checkpoint = await readFile(join(root, started.searchId, "checkpoint.md"), "utf8");
  assert.match(checkpoint, /Do not create a new query plan/);
  assert.match(checkpoint, /stars:pending/);

  const resumed = await store.resume({ cwd: process.cwd() });
  assert.equal(resumed.searchId, started.searchId);
  assert.match(resumed.checkpoint, /Continue stars retrieval/);
});

test("query responses are durable and completed work is skipped on resume", async () => {
  const { store } = await fixtureStore();
  const { searchId } = await startFixture(store);

  assert.deepEqual(
    await store.prepareQueryDispatch({ searchId, sortBy: "stars", query: "agent cli" }),
    { status: "ready", retriedAmbiguous: false },
  );
  await store.recordQueryResponse({
    searchId,
    sortBy: "stars",
    query: "agent cli",
    payload: response([alpha]),
  });

  assert.equal(
    (await store.prepareQueryDispatch({ searchId, sortBy: "stars", query: "agent cli" })).status,
    "completed",
  );
  assert.deepEqual(await store.completedQueries(searchId, "stars"), ["agent cli"]);

  const state = await store.load(searchId);
  const artifact = state.retrieval.stars.queryArtifacts["agent cli"];
  assert.deepEqual(
    JSON.parse(await readFile(join(store.stateRoot, searchId, artifact), "utf8")),
    { query: "agent cli", response: response([alpha]) },
  );
});

test("a dispatched query is ambiguous after interruption and retries only explicitly", async () => {
  const { store } = await fixtureStore();
  const { searchId } = await startFixture(store);

  await store.prepareQueryDispatch({ searchId, sortBy: "stars", query: "agent cli" });
  assert.equal(
    (await store.prepareQueryDispatch({ searchId, sortBy: "stars", query: "agent cli" })).status,
    "ambiguous",
  );

  const retried = await store.prepareQueryDispatch({
    searchId,
    sortBy: "stars",
    query: "agent cli",
    retryAmbiguous: true,
  });
  assert.deepEqual(retried, { status: "ready", retriedAmbiguous: true });
  const state = await store.load(searchId);
  assert.equal(state.retrieval.stars.dispatchedQueries.includes("agent cli"), true);
  assert.match(state.notes.at(-1).text, /explicitly retried/i);
});

test("sort artifacts and the combined pool merge deterministically", async () => {
  const { store } = await fixtureStore();
  const queries = ["agent cli", "agent automation"];
  const { searchId } = await startFixture(store, queries);

  for (const sortBy of ["stars", "recent"]) {
    for (const query of queries) {
      await store.prepareQueryDispatch({ searchId, sortBy, query });
      await store.recordQueryResponse({
        searchId,
        sortBy,
        query,
        payload: response(
          query === "agent cli"
            ? [alpha, alphaLocalized, sameNameOtherRepo]
            : [alpha, beta],
        ),
      });
    }
    await store.finishRetrieval({ searchId, sortBy, maxCandidates: 200, limitPerQuery: 50 });
  }

  const state = await store.load(searchId);
  assert.equal(state.pool.candidateCount, 4);
  const pool = JSON.parse(await readFile(join(store.stateRoot, searchId, "candidates.json"), "utf8"));
  assert.equal(pool.candidates[0].matchCount, 2);
  assert.deepEqual(pool.candidates[0].sortOrders, ["recent", "stars"]);
});

test("candidate index groups only same-repository and normalized-name families", async () => {
  const { store } = await fixtureStore();
  const { searchId } = await startFixture(store, ["agent cli"]);
  for (const sortBy of ["stars", "recent"]) {
    await store.prepareQueryDispatch({ searchId, sortBy, query: "agent cli" });
    await store.recordQueryResponse({
      searchId,
      sortBy,
      query: "agent cli",
      payload: response([alphaLocalized, sameNameOtherRepo, alpha, beta]),
    });
    await store.finishRetrieval({ searchId, sortBy, maxCandidates: 200, limitPerQuery: 50 });
  }

  const receipt = await store.buildCandidateIndex({ searchId, limit: 40 });
  assert.equal(receipt.sourceCandidates, 4);
  assert.equal(receipt.families, 3);
  const index = JSON.parse(await readFile(receipt.artifactPath, "utf8"));
  assert.equal(index.candidates.length, 3);
  assert.ok(index.candidates.some((item) => item.githubUrl === alpha.githubUrl));
  assert.ok(index.candidates.some((item) => item.githubUrl === sameNameOtherRepo.githubUrl));
  assert.equal(index.candidates.some((item) => item.githubUrl === alphaLocalized.githubUrl), false);
});

test("acquisition, semantic review, scoring, and completion stay separate", async () => {
  const { store } = await fixtureStore();
  const { searchId } = await startFixture(store, ["agent cli"]);
  for (const sortBy of ["stars", "recent"]) {
    await store.prepareQueryDispatch({ searchId, sortBy, query: "agent cli" });
    await store.recordQueryResponse({ searchId, sortBy, query: "agent cli", payload: response([alpha, beta]) });
    await store.finishRetrieval({ searchId, sortBy, maxCandidates: 200, limitPerQuery: 50 });
  }
  const pool = JSON.parse(await readFile(join(store.stateRoot, searchId, "candidates.json"), "utf8"));
  const keys = pool.candidates.map((item) => item.key);
  await store.setCandidates({ searchId, stage: "shortlist", candidates: keys });
  await assert.rejects(
    store.setCandidates({ searchId, stage: "finalists", candidates: ["missing"] }),
    /not in the merged pool/,
  );
  await store.setCandidates({ searchId, stage: "finalists", candidates: keys });

  const inspectionPath = join(store.stateRoot, searchId, "inspection.json");
  await writeFile(
    inspectionPath,
    JSON.stringify({
      metrics: { canonicalCandidates: 2, successes: 1, terminalFailures: 1 },
      artifacts: { reviewIndex: join(store.stateRoot, searchId, "inspection.review-index.json") },
      candidates: [
        {
          canonicalKey: "github.com/one/toolbox/skills/agent-cli",
          status: "success",
          capsule: { candidate: { githubUrl: alpha.githubUrl } },
        },
        {
          canonicalKey: "github.com/one/toolbox/skills/pipeline-builder",
          status: "terminal_failure",
          capsule: { candidate: { githubUrl: beta.githubUrl } },
        },
      ],
    }),
    "utf8",
  );
  await store.recordAcquisition({ searchId, artifactPath: inspectionPath });

  let checkpoint = await readFile(join(store.stateRoot, searchId, "checkpoint.md"), "utf8");
  assert.match(checkpoint, /Sources acquired: \*\*1\/2\*\*; terminal failures: \*\*1\*\*/);
  assert.match(checkpoint, /Semantically reviewed: \*\*0\/1\*\*/);
  assert.match(checkpoint, /Scored: \*\*0\/1\*\*/);
  await assert.rejects(store.complete({ searchId }), /unreviewed or unscored/);

  await store.recordInspection({
    searchId,
    record: {
      candidateKey: keys.find((key) => key.includes("agent-cli")),
      status: "inspected",
      summary: "Uses a resumable CLI state machine.",
      evidence: "Records each completed query.",
    },
  });
  await store.recordScore({
    searchId,
    record: {
      candidateKey: keys.find((key) => key.includes("agent-cli")),
      total: 86,
      rationale: "Direct fit with concrete recovery.",
      confidence: "high",
    },
  });
  await store.complete({ searchId, summary: "One recommendation prepared." });
  const state = await store.load(searchId);
  assert.equal(state.status, "completed");
  assert.equal(Object.keys(state.inspections).length, 1);
  assert.equal(Object.keys(state.scores).length, 1);
});

test("corrupt state is quarantined and never silently replaced", async () => {
  const { root, store } = await fixtureStore();
  const { searchId } = await startFixture(store);
  await writeFile(join(root, searchId, "state.json"), "{broken", "utf8");

  await assert.rejects(store.load(searchId), /quarantined/);
  const names = await readdir(join(root, searchId));
  assert.ok(names.some((name) => name.startsWith("state.json.corrupt-")));
  assert.equal(names.includes("state.json"), false);
});

test("path comparison can model Windows case folding and POSIX case sensitivity", () => {
  assert.equal(normalizeComparablePath("C:\\Work\\Repo", "win32"), "c:\\work\\repo");
  assert.notEqual(normalizeComparablePath("/Work/Repo", "linux"), normalizeComparablePath("/work/repo", "linux"));
});
