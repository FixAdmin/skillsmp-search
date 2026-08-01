#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createHeavySearchStore } from "./heavy-search-state.mjs";

const BASE_URL = "https://skillsmp.com/api/v1/skills/search";

function parseInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return parsed;
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value);
}

function asStars(value) {
  const stars = Number(value ?? 0);
  return Number.isFinite(stars) ? stars : 0;
}

export function normalizeCandidateKey(skill) {
  const source = asString(skill.githubUrl || skill.id).trim();
  if (!source) {
    return "";
  }

  return source
    .replace(/\/SKILL\.md\/?$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

export function buildSearchUrl(query, limitPerQuery, sortBy) {
  const queryString = [
    `q=${encodeURIComponent(query)}`,
    "page=1",
    `limit=${encodeURIComponent(String(limitPerQuery))}`,
    `sortBy=${encodeURIComponent(sortBy)}`,
  ].join("&");

  return `${BASE_URL}?${queryString}`;
}

export function parseArgs(argv) {
  const options = {
    queries: [],
    limitPerQuery: 20,
    sortBy: "stars",
    maxCandidates: 40,
    heavySearchId: null,
    retryAmbiguous: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--retry-ambiguous") {
      options.retryAmbiguous = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}.`);
    }

    if (flag === "--query" || flag === "-q") {
      if (!value.trim()) {
        throw new Error("Query cannot be empty.");
      }
      options.queries.push(value.trim());
    } else if (flag === "--limit-per-query") {
      options.limitPerQuery = parseInteger(
        value,
        "limit-per-query",
        1,
        100,
      );
    } else if (flag === "--sort-by") {
      if (!["stars", "recent"].includes(value)) {
        throw new Error("sort-by must be stars or recent.");
      }
      options.sortBy = value;
    } else if (flag === "--max-candidates") {
      options.maxCandidates = parseInteger(
        value,
        "max-candidates",
        1,
        200,
      );
    } else if (flag === "--heavy-search-id") {
      options.heavySearchId = value;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }

    index += 1;
  }

  if (options.queries.length === 0) {
    throw new Error("At least one --query is required.");
  }

  return options;
}

export function mergeSearchResponses(responses, maxCandidates) {
  const records = new Map();

  for (const response of responses) {
    response.skills.forEach((skill, index) => {
      const key = normalizeCandidateKey(skill);
      if (!key) {
        return;
      }

      if (!records.has(key)) {
        records.set(key, {
          id: asString(skill.id),
          name: asString(skill.name),
          author: asString(skill.author),
          description: asString(skill.description),
          githubUrl: asString(skill.githubUrl),
          skillUrl: asString(skill.skillUrl),
          stars: asStars(skill.stars),
          updatedAt: asString(skill.updatedAt),
          matchedQueries: [],
          bestRank: index + 1,
        });
      }

      const record = records.get(key);
      if (!record.matchedQueries.includes(response.query)) {
        record.matchedQueries.push(response.query);
      }
      record.bestRank = Math.min(record.bestRank, index + 1);
    });
  }

  return [...records.values()]
    .map((record) => ({
      ...record,
      matchCount: record.matchedQueries.length,
    }))
    .sort(
      (left, right) =>
        right.matchCount - left.matchCount ||
        left.bestRank - right.bestRank ||
        right.stars - left.stars ||
        left.name.localeCompare(right.name),
    )
    .slice(0, maxCandidates);
}

export async function runSearch(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const apiKey =
    dependencies.apiKey ?? process.env.SKILLSMP_API_KEY ?? "";
  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const sanitize = (message) =>
    apiKey
      ? String(message).split(apiKey).join("[REDACTED]")
      : String(message);
  const responses = [];
  const heavyStore = options.heavySearchId
    ? dependencies.heavyStore ?? createHeavySearchStore()
    : null;
  let completedThisRun = 0;
  let skippedRequests = 0;
  let retriedAmbiguous = 0;

  if (heavyStore) {
    await heavyStore.assertPlan(options.heavySearchId, options.queries);
  }

  for (const query of options.queries) {
    if (heavyStore) {
      const dispatch = await heavyStore.prepareQueryDispatch({
        searchId: options.heavySearchId,
        sortBy: options.sortBy,
        query,
        retryAmbiguous: options.retryAmbiguous,
      });
      if (dispatch.status === "completed") {
        skippedRequests += 1;
        continue;
      }
      if (dispatch.status === "ambiguous") {
        throw new Error(
          `Query "${query}" has an unresolved prior dispatch. No request was made. ` +
          "Use --retry-ambiguous only if a possible duplicate API request is acceptable.",
        );
      }
      if (dispatch.retriedAmbiguous) retriedAmbiguous += 1;
    }

    try {
      const response = await fetchImpl(
        buildSearchUrl(query, options.limitPerQuery, options.sortBy),
        { headers },
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (!payload?.success || !Array.isArray(payload?.data?.skills)) {
        throw new Error("SkillsMP returned an invalid response.");
      }

      if (heavyStore) {
        await heavyStore.recordQueryResponse({
          searchId: options.heavySearchId,
          sortBy: options.sortBy,
          query,
          payload,
        });
        completedThisRun += 1;
      } else {
        responses.push({ query, skills: payload.data.skills });
      }
    } catch (error) {
      const message = error?.message ?? error;
      if (heavyStore) {
        await heavyStore.recordQueryFailure({
          searchId: options.heavySearchId,
          sortBy: options.sortBy,
          query,
          message: sanitize(message),
        });
      }
      throw new Error(
        `Request failed for query "${query}": ${sanitize(message)}`,
      );
    }
  }

  if (heavyStore) {
    const finished = await heavyStore.finishRetrieval({
      searchId: options.heavySearchId,
      sortBy: options.sortBy,
      maxCandidates: options.maxCandidates,
      limitPerQuery: options.limitPerQuery,
    });
    return {
      mode: "heavy",
      searchId: options.heavySearchId,
      sortBy: options.sortBy,
      completedThisRun,
      skippedRequests,
      retriedAmbiguous,
      candidateCount: finished.candidateCount,
      artifactPath: finished.artifactPath,
      checkpointPath: finished.checkpointPath,
      nextStep: finished.nextStep,
    };
  }

  const candidates = mergeSearchResponses(
    responses,
    options.maxCandidates,
  );
  return {
    generatedAt: new Date().toISOString(),
    queries: options.queries,
    sortBy: options.sortBy,
    limitPerQuery: options.limitPerQuery,
    candidateCount: candidates.length,
    candidates,
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  if (Number(process.versions.node.split(".")[0]) < 18) {
    process.stderr.write(
      "SkillsMP search failed: Node.js 18 or newer is required.\n",
    );
    process.exitCode = 1;
  } else {
    try {
      const options = parseArgs(process.argv.slice(2));
      runSearch(options)
        .then((output) =>
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`),
        )
        .catch((error) => {
          process.stderr.write(`SkillsMP search failed: ${error.message}\n`);
          process.exitCode = 1;
        });
    } catch (error) {
      process.stderr.write(`SkillsMP search failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
