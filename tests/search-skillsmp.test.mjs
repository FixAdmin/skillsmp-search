import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildSearchUrl,
  mergeSearchResponses,
  normalizeCandidateKey,
  parseArgs,
  runSearch,
} from "../skills/skillsmp-search/scripts/search-skillsmp.mjs";

test("parseArgs accepts repeated queries and defaults", () => {
  assert.deepEqual(
    parseArgs([
      "--query",
      "prompt docs",
      "--query",
      "technical writing",
    ]),
    {
      queries: ["prompt docs", "technical writing"],
      limitPerQuery: 20,
      sortBy: "stars",
      maxCandidates: 40,
    },
  );
});

test("parseArgs validates ranges and sort order", () => {
  assert.throws(
    () => parseArgs(["--query", "x", "--limit-per-query", "101"]),
    /1 to 100/,
  );
  assert.throws(
    () => parseArgs(["--query", "x", "--sort-by", "popular"]),
    /stars or recent/,
  );
  assert.throws(() => parseArgs([]), /At least one --query/);
});

test("buildSearchUrl encodes query text", () => {
  const url = buildSearchUrl("prompt docs & writing", 20, "stars");
  assert.match(url, /q=prompt%20docs%20%26%20writing/);
  assert.match(url, /limit=20/);
  assert.match(url, /sortBy=stars/);
});

test("normalizeCandidateKey normalizes equivalent GitHub source URLs", () => {
  assert.equal(
    normalizeCandidateKey({
      githubUrl:
        "HTTPS://GITHUB.COM/Owner/Repo/tree/main/skill/SKILL.md/",
    }),
    "https://github.com/owner/repo/tree/main/skill",
  );
});

test("normalizeCandidateKey falls back to the candidate id", () => {
  assert.equal(normalizeCandidateKey({ id: "Candidate-1" }), "candidate-1");
});

test("mergeSearchResponses merges matches and ranks deterministically", () => {
  const responses = [
    {
      query: "one",
      skills: [
        {
          id: "a",
          name: "A",
          githubUrl: "https://github.com/o/a",
          stars: 2,
        },
      ],
    },
    {
      query: "two",
      skills: [
        {
          id: "a2",
          name: "A",
          githubUrl: "https://github.com/o/a/",
          stars: 2,
        },
        {
          id: "b",
          name: "B",
          githubUrl: "https://github.com/o/b",
          stars: null,
        },
      ],
    },
  ];

  const candidates = mergeSearchResponses(responses, 1);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, "A");
  assert.equal(candidates[0].matchCount, 2);
  assert.deepEqual(candidates[0].matchedQueries, ["one", "two"]);
});

test("runSearch returns the existing JSON shape without exposing headers", async () => {
  const calls = [];
  const output = await runSearch(
    {
      queries: ["prompt docs"],
      limitPerQuery: 5,
      sortBy: "recent",
      maxCandidates: 3,
    },
    {
      apiKey: "test-key",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              data: {
                skills: [
                  {
                    id: "docs",
                    name: "docs-skill",
                    author: "author",
                    description: "Writes docs",
                    githubUrl: "https://github.com/o/docs",
                    skillUrl: "https://skillsmp.com/skills/docs",
                    stars: 7,
                    updatedAt: "2026-01-01T00:00:00Z",
                  },
                ],
              },
            };
          },
        };
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
  assert.equal(output.candidateCount, 1);
  assert.deepEqual(output.queries, ["prompt docs"]);
  assert.equal(output.candidates[0].bestRank, 1);
  assert.equal(JSON.stringify(output).includes("test-key"), false);
});

test("runSearch redacts an API key from request failures", async () => {
  const secret = "secret-test-key";

  await assert.rejects(
    runSearch(
      {
        queries: ["x"],
        limitPerQuery: 20,
        sortBy: "stars",
        maxCandidates: 40,
      },
      {
        apiKey: secret,
        fetchImpl: async () => {
          throw new Error(`network failed near ${secret}`);
        },
      },
    ),
    (error) =>
      error.message.includes("[REDACTED]") &&
      !error.message.includes(secret),
  );
});

test("runSearch rejects unsuccessful and malformed responses", async () => {
  const options = {
    queries: ["x"],
    limitPerQuery: 20,
    sortBy: "stars",
    maxCandidates: 40,
  };

  await assert.rejects(
    runSearch(options, {
      fetchImpl: async () => ({ ok: false, status: 429 }),
    }),
    /HTTP 429/,
  );

  await assert.rejects(
    runSearch(options, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { success: true, data: {} };
        },
      }),
    }),
    /invalid response/,
  );
});

test("CLI argument failures stay concise", () => {
  const script = fileURLToPath(
    new URL(
      "../skills/skillsmp-search/scripts/search-skillsmp.mjs",
      import.meta.url,
    ),
  );
  const result = spawnSync(
    process.execPath,
    [script, "--query", "x", "--sort-by", "invalid"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^SkillsMP search failed:/);
  assert.equal(result.stderr.includes("    at "), false);
});
