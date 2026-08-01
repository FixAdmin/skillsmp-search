#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildCapsule,
  CAPSULE_VERSION,
  extractFacts,
  EXTRACTOR_VERSION,
} from "./inspection/extract.mjs";
import {
  canonicalizeCandidate,
  classifyFetchFailure,
  fetchSource,
  resolveSourceUrl,
} from "./inspection/source.mjs";
import {
  createStore,
  defaultCacheDir,
  defaultStateDir,
  sha256,
} from "./inspection/store.mjs";
import { buildReviewIndex } from "./inspection/review.mjs";

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    input: null,
    output: null,
    reviewIndex: null,
    runId: null,
    resume: false,
    cacheDir: null,
    stateDir: null,
    concurrency: 6,
    timeoutMs: 15_000,
    retries: 2,
    maxSourceBytes: 262_144,
    format: "json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--resume") {
      options.resume = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--input") options.input = value;
    else if (flag === "--output") options.output = value;
    else if (flag === "--review-index") options.reviewIndex = value;
    else if (flag === "--run-id") options.runId = value;
    else if (flag === "--cache-dir") options.cacheDir = value;
    else if (flag === "--state-dir") options.stateDir = value;
    else if (flag === "--concurrency") options.concurrency = boundedInteger(value, "concurrency", 1, 12);
    else if (flag === "--timeout-ms") options.timeoutMs = boundedInteger(value, "timeout-ms", 1_000, 120_000);
    else if (flag === "--retries") options.retries = boundedInteger(value, "retries", 0, 5);
    else if (flag === "--max-source-bytes") options.maxSourceBytes = boundedInteger(value, "max-source-bytes", 1_024, 1_048_576);
    else if (flag === "--format") {
      if (!new Set(["json", "jsonl"]).has(value)) throw new Error("format must be json or jsonl");
      options.format = value;
    } else throw new Error(`unknown argument: ${flag}`);
    index += 1;
  }

  if (!options.input) throw new Error("--input <file|-> is required");
  return options;
}

function inputCandidates(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.candidates)) return input.candidates;
  throw new TypeError("input must be an array or an object with a candidates array");
}

function stableInvalidKey(candidate, index) {
  let serialized;
  try {
    serialized = JSON.stringify(candidate);
  } catch {
    serialized = String(candidate);
  }
  return `invalid:${index}:${sha256(serialized).slice(0, 16)}`;
}

function canonicalWorkItems(candidates) {
  const records = new Map();
  let duplicates = 0;
  candidates.forEach((candidate, index) => {
    let normalized;
    try {
      normalized = canonicalizeCandidate(candidate);
    } catch (error) {
      normalized = {
        ...(candidate && typeof candidate === "object" ? candidate : { value: String(candidate) }),
        canonicalKey: stableInvalidKey(candidate, index),
        invalidError: error.message,
      };
    }
    if (records.has(normalized.canonicalKey)) {
      duplicates += 1;
      records.get(normalized.canonicalKey).aliases.push({
        id: candidate?.id ?? null,
        name: candidate?.name ?? null,
        githubUrl: candidate?.githubUrl ?? null,
      });
      return;
    }
    records.set(normalized.canonicalKey, { candidate: normalized, aliases: [] });
  });
  return { items: [...records.values()], duplicates };
}

async function mapConcurrent(values, concurrency, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, runWorker));
  return results;
}

function failureRecord(candidate, aliases, failure, artifacts = {}) {
  return {
    canonicalKey: candidate.canonicalKey,
    name: candidate.name ?? candidate.id ?? null,
    status: "terminal_failure",
    aliases,
    failure: {
      kind: failure.kind,
      status: failure.status ?? null,
      code: failure.code ?? null,
      message: failure.message,
      safeRetry: failure.kind === "transient" ? "resume the same run after the external condition clears" : null,
      stopCondition: failure.kind === "permanent" ? "do not retry unless the candidate source URL changes" : "stop after the configured retry budget",
    },
    artifacts,
  };
}

export async function runInspection(input, dependencies = {}) {
  const startedAt = Date.now();
  const candidates = inputCandidates(input);
  const { items, duplicates } = canonicalWorkItems(candidates);
  if (items.length === 0) throw new TypeError("input candidates array must not be empty");

  const runId = dependencies.runId || `inspect-${sha256(JSON.stringify(items.map((item) => item.candidate.canonicalKey).sort())).slice(0, 16)}`;
  const cacheDir = dependencies.cacheDir ?? defaultCacheDir();
  const stateDir = dependencies.stateDir ?? defaultStateDir();
  const concurrency = dependencies.concurrency ?? 6;
  const timeoutMs = dependencies.timeoutMs ?? 15_000;
  const retries = dependencies.retries ?? 2;
  const maxSourceBytes = dependencies.maxSourceBytes ?? 262_144;
  const resume = dependencies.resume ?? false;
  const store = createStore({ cacheDir, stateDir, runId });
  const counters = {
    networkRequests: 0,
    cacheHits: 0,
    bytesDownloaded: 0,
    resumedCandidates: 0,
    retries: 0,
  };

  const results = await mapConcurrent(items, concurrency, async ({ candidate, aliases }) => {
    try {
    if (candidate.invalidError) {
      const failure = { kind: "permanent", code: "invalid_candidate", message: candidate.invalidError };
      await store.writeCandidate(candidate.canonicalKey, { stage: "terminal", failure });
      return failureRecord(candidate, aliases, failure);
    }

    const rawUrl = resolveSourceUrl(candidate);
    let checkpoint = null;
    if (resume) {
      checkpoint = await store.readCandidate(candidate.canonicalKey);
      if (checkpoint?.stage === "complete" && checkpoint.sourceSha256) {
        const capsule = await store.getCapsule(checkpoint.sourceSha256, CAPSULE_VERSION, candidate.canonicalKey);
        if (capsule) {
          counters.cacheHits += 1;
          counters.resumedCandidates += 1;
          return {
            canonicalKey: candidate.canonicalKey,
            name: candidate.name ?? candidate.id ?? null,
            status: "success",
            aliases,
            sourceSha256: checkpoint.sourceSha256,
            sourceUrl: rawUrl,
            capsule,
            artifacts: checkpoint.artifacts,
          };
        }
      }
      if (checkpoint?.stage === "terminal" && checkpoint.failure?.kind === "permanent") {
        counters.resumedCandidates += 1;
        return failureRecord(candidate, aliases, checkpoint.failure, checkpoint.artifacts);
      }
    }

    const commitPinned = /^[0-9a-f]{40}$/i.test(candidate.requestedRef ?? "");
    const mayReuseSource = commitPinned || Boolean(checkpoint?.sourceSha256);
    let source = mayReuseSource ? await store.getSource(rawUrl) : null;
    let sourceSha256;
    let sourceObjectPath;
    if (source) {
      counters.cacheHits += 1;
      sourceSha256 = source.sourceSha256;
      sourceObjectPath = source.objectPath;
    } else {
      let fetched;
      try {
        fetched = await fetchSource(rawUrl, {
          fetchImpl: dependencies.fetchImpl,
          sleepImpl: dependencies.sleepImpl,
          timeoutMs,
          retries,
          maxBytes: maxSourceBytes,
          maxRedirects: dependencies.maxRedirects ?? 3,
        });
      } catch (error) {
        counters.networkRequests += error?.networkRequests ?? 0;
        counters.retries += Math.max(0, (error?.attempts ?? 1) - 1);
        const failure = classifyFetchFailure(error);
        const artifacts = { sourceUrl: rawUrl };
        await store.writeCandidate(candidate.canonicalKey, { stage: "terminal", failure, artifacts });
        return failureRecord(candidate, aliases, failure, artifacts);
      }
      counters.networkRequests += fetched.networkRequests;
      counters.retries += Math.max(0, fetched.attempts - 1);
      counters.bytesDownloaded += fetched.bytes.length;
      const stored = await store.putSource({
        canonicalUrl: rawUrl,
        bytes: fetched.bytes,
        metadata: {
          resolvedUrl: fetched.url,
          etag: fetched.etag,
          lastModified: fetched.lastModified,
        },
      });
      source = { ...stored, bytes: fetched.bytes };
      sourceSha256 = stored.sourceSha256;
      sourceObjectPath = stored.objectPath;
    }

    const fetchedArtifacts = { sourceUrl: rawUrl, sourceObject: sourceObjectPath };
    await store.writeCandidate(candidate.canonicalKey, {
      stage: "fetched",
      sourceSha256,
      artifacts: fetchedArtifacts,
    });

    let facts = await store.getFacts(sourceSha256, EXTRACTOR_VERSION);
    if (!facts) {
      facts = extractFacts(source.bytes.toString("utf8"));
      await store.putFacts(sourceSha256, EXTRACTOR_VERSION, facts);
    }
    await store.writeCandidate(candidate.canonicalKey, {
      stage: "extracted",
      sourceSha256,
      artifacts: fetchedArtifacts,
    });

    let capsule = await store.getCapsule(sourceSha256, CAPSULE_VERSION, candidate.canonicalKey);
    if (!capsule) {
      capsule = buildCapsule(
        { ...candidate, sourceSha256 },
        facts,
        dependencies.capsuleOptions,
      );
      await store.putCapsule(sourceSha256, CAPSULE_VERSION, candidate.canonicalKey, capsule);
    }
    const artifacts = {
      ...fetchedArtifacts,
      facts: store.paths.facts(sourceSha256, EXTRACTOR_VERSION),
      capsule: store.paths.capsule(sourceSha256, CAPSULE_VERSION, candidate.canonicalKey),
    };
    await store.writeCandidate(candidate.canonicalKey, {
      stage: "complete",
      sourceSha256,
      artifacts,
    });
    return {
      canonicalKey: candidate.canonicalKey,
      name: candidate.name ?? candidate.id ?? null,
      status: "success",
      aliases,
      sourceSha256,
      sourceUrl: rawUrl,
      capsule,
      artifacts,
    };
    } catch (error) {
      const failure = {
        kind: "permanent",
        code: "candidate_processing_error",
        status: null,
        message: `candidate processing failed: ${error?.message ?? String(error)}`,
      };
      await store.writeCandidate(candidate.canonicalKey, { stage: "terminal", failure });
      return failureRecord(candidate, aliases, failure);
    }
  });

  const successes = results.filter((item) => item.status === "success").length;
  const terminalFailures = results.filter((item) => item.status === "terminal_failure").length;
  if (successes + terminalFailures !== items.length) {
    throw new Error("inspection invariant failed: not every canonical candidate reached a terminal state");
  }
  const status = terminalFailures === 0 ? "success" : successes === 0 ? "failed" : "partial";
  const metrics = {
    inputCandidates: candidates.length,
    canonicalCandidates: items.length,
    duplicates,
    successes,
    terminalFailures,
    networkRequests: counters.networkRequests,
    cacheHits: counters.cacheHits,
    bytesDownloaded: counters.bytesDownloaded,
    resumedCandidates: counters.resumedCandidates,
    retries: counters.retries,
    elapsedMs: Date.now() - startedAt,
  };
  return {
    status,
    summary: `Inspected ${items.length} canonical candidates: ${successes} capsules, ${terminalFailures} terminal failures.`,
    next_actions: [
      "review every successful evidence capsule",
      "expand only named cached source ranges or required linked resources",
      "judge useful method delta and semantic scores separately from deterministic facts",
      ...(results.some((item) => item.failure?.kind === "transient") ? ["resume the same run after transient failures clear"] : []),
    ],
    artifacts: {
      runId,
      cacheDir,
      stateDir,
      runDirectory: store.paths.runDirectory,
    },
    metrics,
    candidates: results,
  };
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function writeTextAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

function serialize(output, format) {
  if (format === "json") return `${JSON.stringify(output, null, 2)}\n`;
  const { candidates, ...header } = output;
  return [
    JSON.stringify({ type: "run", ...header }),
    ...candidates.map((candidate) => JSON.stringify({ type: "candidate", candidate })),
    JSON.stringify({ type: "complete", status: output.status, metrics: output.metrics }),
    "",
  ].join("\n");
}

function defaultReviewIndexPath(outputPath) {
  const extension = extname(outputPath);
  return extension
    ? `${outputPath.slice(0, -extension.length)}.review-index${extension}`
    : `${outputPath}.review-index.json`;
}

async function main(argv) {
  const options = parseArgs(argv);
  const body = options.input === "-" ? await readStandardInput() : await readFile(options.input, "utf8");
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    throw new Error("input is not valid JSON");
  }
  const output = await runInspection(input, {
    runId: options.runId,
    resume: options.resume,
    cacheDir: options.cacheDir ?? undefined,
    stateDir: options.stateDir ?? undefined,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    maxSourceBytes: options.maxSourceBytes,
  });
  const reviewIndexPath = options.reviewIndex ??
    (options.output ? defaultReviewIndexPath(options.output) : null);
  if (options.output) {
    output.artifacts.output = resolve(options.output);
    if (reviewIndexPath) output.artifacts.reviewIndex = resolve(reviewIndexPath);
    output.artifact_lifetimes = {
      cacheDir: "durable",
      stateDir: "durable",
      runDirectory: "durable",
      output: "disposable_after_completion",
      reviewIndex: "disposable_after_completion",
    };
    await writeTextAtomic(options.output, serialize(output, options.format));
    if (reviewIndexPath) {
      await writeTextAtomic(
        reviewIndexPath,
        `${JSON.stringify(buildReviewIndex(output), null, 2)}\n`,
      );
    }
    const { candidates, ...receipt } = output;
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } else {
    if (reviewIndexPath) {
      output.artifacts.reviewIndex = resolve(reviewIndexPath);
      await writeTextAtomic(
        reviewIndexPath,
        `${JSON.stringify(buildReviewIndex(output), null, 2)}\n`,
      );
    }
    process.stdout.write(serialize(output, options.format));
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  if (Number(process.versions.node.split(".")[0]) < 18) {
    process.stderr.write("SkillsMP inspection failed: Node.js 18 or newer is required.\n");
    process.exitCode = 1;
  } else {
    main(process.argv.slice(2)).catch((error) => {
      process.stderr.write(`SkillsMP inspection failed: ${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
