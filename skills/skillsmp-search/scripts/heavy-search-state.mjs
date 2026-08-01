#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";

import { isMainModule } from "./cli-entry.mjs";

const SCHEMA_VERSION = 1;
const SEARCH_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const SORT_ORDERS = ["stars", "recent"];
const PHASES = new Set([
  "planned",
  "retrieval-stars",
  "retrieval-recent",
  "shortlist",
  "finalists",
  "acquisition",
  "review",
  "inspection",
  "scoring",
  "reporting",
  "completed",
]);
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const SECRET_PATTERNS = [
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\b(api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]"],
];

export class HeavySearchStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "HeavySearchStateError";
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function asString(value) {
  return value === null || value === undefined ? "" : String(value);
}

function asStars(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function redactHeavyText(value, limit = 4_000) {
  let text = asString(value).trim();
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  if (text.length > limit) text = `${text.slice(0, limit - 1).trimEnd()}…`;
  return text;
}

function requestFingerprint(request) {
  return sha256(request.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"));
}

export function normalizeComparablePath(value, platform = process.platform) {
  const normalized = normalize(asString(value));
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function validateSearchId(searchId) {
  if (!SEARCH_ID_PATTERN.test(asString(searchId))) {
    throw new HeavySearchStateError(`Invalid search id: ${JSON.stringify(searchId)}`);
  }
  return searchId;
}

function newSearchId(now, randomHex) {
  const date = new Date(now());
  if (Number.isNaN(date.getTime())) throw new HeavySearchStateError("Clock returned an invalid date.");
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomHex()}`;
}

function defaultStateRoot() {
  if (process.env.SKILLSMP_SEARCH_STATE_ROOT) {
    return resolve(process.env.SKILLSMP_SEARCH_STATE_ROOT);
  }
  if (process.env.CODEX_HOME) {
    return resolve(process.env.CODEX_HOME, "state", "skillsmp-search");
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return resolve(process.env.LOCALAPPDATA, "skillsmp-search", "state", "heavy-searches");
  }
  const stateBase = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return resolve(stateBase, "skillsmp-search", "heavy-searches");
}

function normalizeGithubUrl(value) {
  const raw = asString(value).trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.at(-1)?.toLocaleLowerCase("en-US") === "skill.md") {
      segments.pop();
      if (segments[2]?.toLocaleLowerCase("en-US") === "blob") segments[2] = "tree";
    }
    return `${url.protocol.toLocaleLowerCase("en-US")}//${url.host.toLocaleLowerCase("en-US")}/${segments.join("/")}`
      .toLocaleLowerCase("en-US")
      .replace(/\/$/, "");
  } catch {
    return raw.toLocaleLowerCase("en-US").replace(/\/$/, "");
  }
}

function candidateKey(candidate) {
  const url = normalizeGithubUrl(candidate?.githubUrl);
  if (url) return url;
  const id = asString(candidate?.id).trim();
  if (!id) throw new HeavySearchStateError("Candidate has neither githubUrl nor id.");
  return `id:${id.toLocaleLowerCase("en-US")}`;
}

function githubSkillIdentity(value) {
  const raw = asString(value).trim();
  if (!raw) return "";
  if (raw.toLocaleLowerCase("en-US").startsWith("github.com/")) {
    return raw.toLocaleLowerCase("en-US").replace(/\/$/, "");
  }
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return raw.toLocaleLowerCase("en-US").replace(/\/$/, "");
    const [owner, repository] = segments;
    let path = [];
    if (url.host.toLocaleLowerCase("en-US") === "raw.githubusercontent.com" && segments.length >= 4) {
      path = segments.slice(3);
    } else if (
      url.host.toLocaleLowerCase("en-US") === "github.com" &&
      segments.length >= 5 &&
      new Set(["tree", "blob", "raw"]).has(segments[2].toLocaleLowerCase("en-US"))
    ) {
      path = segments.slice(4);
    }
    if (path.at(-1)?.toLocaleLowerCase("en-US") === "skill.md") path.pop();
    return `github.com/${owner}/${repository}${path.length ? `/${path.join("/")}` : ""}`
      .toLocaleLowerCase("en-US")
      .replace(/\/$/, "");
  } catch {
    return raw.toLocaleLowerCase("en-US").replace(/\/$/, "");
  }
}

function repositoryIdentity(value) {
  const identity = githubSkillIdentity(value);
  const segments = identity.split("/");
  return segments.length >= 3 ? segments.slice(0, 3).join("/") : identity;
}

function normalizedSkillName(value) {
  return asString(value)
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function queryArtifact(sortBy, query) {
  return join("queries", sortBy, `${sha256(query).slice(0, 16)}.json`);
}

function normalizeRetrievalItem(value, queries, sortBy) {
  const item = value && typeof value === "object" ? value : {};
  const completedQueries = Array.isArray(item.completedQueries)
    ? item.completedQueries.filter((query) => queries.includes(query))
    : [];
  const queryArtifacts = item.queryArtifacts && typeof item.queryArtifacts === "object"
    ? { ...item.queryArtifacts }
    : {};
  for (const query of completedQueries) {
    queryArtifacts[query] ??= queryArtifact(sortBy, query);
  }
  return {
    status: item.status ?? "pending",
    completedQueries,
    dispatchedQueries: Array.isArray(item.dispatchedQueries)
      ? item.dispatchedQueries.filter((query) => queries.includes(query) && !completedQueries.includes(query))
      : [],
    queryArtifacts,
    candidateCount: Number(item.candidateCount ?? 0),
    artifact: item.artifact ?? null,
    limitPerQuery: item.limitPerQuery ?? null,
    errors: item.errors && typeof item.errors === "object" ? item.errors : {},
  };
}

function normalizeLoadedState(state, searchId) {
  if (!state || typeof state !== "object") throw new HeavySearchStateError("State root must be a JSON object.");
  if (state.schemaVersion !== SCHEMA_VERSION) {
    throw new HeavySearchStateError(`Unsupported state schema for ${searchId}: ${JSON.stringify(state.schemaVersion)}`);
  }
  if (state.searchId !== searchId) throw new HeavySearchStateError(`State id mismatch for ${searchId}.`);
  if (!Array.isArray(state.queries) || state.queries.length === 0) {
    throw new HeavySearchStateError(`State ${searchId} has no query plan.`);
  }
  state.retrieval ??= {};
  for (const sortBy of SORT_ORDERS) {
    state.retrieval[sortBy] = normalizeRetrievalItem(state.retrieval[sortBy], state.queries, sortBy);
  }
  state.pool ??= { candidateCount: 0, artifact: null };
  state.shortlist ??= { keys: [], artifact: null };
  state.finalists ??= { keys: [], artifact: null };
  state.candidateIndex ??= { candidateCount: 0, artifact: null };
  state.acquisition ??= {
    status: "pending",
    artifact: null,
    reviewIndex: null,
    canonicalCandidates: 0,
    successes: 0,
    terminalFailures: 0,
    metrics: {},
    successKeys: [],
    failureKeys: [],
  };
  state.inspections ??= {};
  state.scores ??= {};
  state.notes ??= [];
  return state;
}

function mergeQueryPayloads(queryPayloads, sortBy, maxCandidates) {
  const records = new Map();
  for (const { query, skills } of queryPayloads) {
    skills.forEach((skill, index) => {
      if (!skill || typeof skill !== "object") return;
      let key;
      try {
        key = candidateKey(skill);
      } catch {
        return;
      }
      if (!records.has(key)) {
        records.set(key, {
          key,
          id: asString(skill.id),
          name: asString(skill.name),
          author: asString(skill.author),
          description: asString(skill.description),
          githubUrl: asString(skill.githubUrl),
          skillUrl: asString(skill.skillUrl),
          stars: asStars(skill.stars),
          updatedAt: asString(skill.updatedAt),
          matchedQueries: [],
          sortOrders: [],
          bestRank: index + 1,
        });
      }
      const record = records.get(key);
      if (!record.matchedQueries.includes(query)) record.matchedQueries.push(query);
      if (!record.sortOrders.includes(sortBy)) record.sortOrders.push(sortBy);
      record.bestRank = Math.min(record.bestRank, index + 1);
      record.stars = Math.max(record.stars, asStars(skill.stars));
    });
  }
  return [...records.values()]
    .map((record) => ({ ...record, matchCount: record.matchedQueries.length }))
    .sort((left, right) =>
      right.matchCount - left.matchCount ||
      left.bestRank - right.bestRank ||
      right.stars - left.stars ||
      left.name.localeCompare(right.name))
    .slice(0, maxCandidates);
}

function mergeSortCandidates(payloads, maxCandidates = 250) {
  const records = new Map();
  for (const { sortBy, candidates } of payloads) {
    for (const candidate of candidates) {
      const key = candidate.key || candidateKey(candidate);
      if (!records.has(key)) {
        records.set(key, {
          key,
          id: asString(candidate.id),
          name: asString(candidate.name),
          author: asString(candidate.author),
          description: asString(candidate.description),
          githubUrl: asString(candidate.githubUrl),
          skillUrl: asString(candidate.skillUrl),
          stars: asStars(candidate.stars),
          updatedAt: asString(candidate.updatedAt),
          matchedQueries: [],
          sortOrders: [],
          bestRank: Number(candidate.bestRank ?? 1_000_000),
        });
      }
      const record = records.get(key);
      for (const query of candidate.matchedQueries ?? []) {
        if (!record.matchedQueries.includes(query)) record.matchedQueries.push(query);
      }
      for (const order of candidate.sortOrders ?? [sortBy]) {
        if (!record.sortOrders.includes(order)) record.sortOrders.push(order);
      }
      record.bestRank = Math.min(record.bestRank, Number(candidate.bestRank ?? 1_000_000));
      record.stars = Math.max(record.stars, asStars(candidate.stars));
    }
  }
  return [...records.values()]
    .map((record) => ({
      ...record,
      matchCount: record.matchedQueries.length,
      sortOrders: record.sortOrders.sort(),
    }))
    .sort((left, right) =>
      right.matchCount - left.matchCount ||
      left.bestRank - right.bestRank ||
      right.stars - left.stars ||
      left.name.localeCompare(right.name))
    .slice(0, maxCandidates);
}

function markdownCell(value) {
  return redactHeavyText(value, 500).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function createHeavySearchStore(options = {}) {
  const stateRoot = resolve(options.stateRoot ?? defaultStateRoot());
  const now = options.now ?? (() => new Date().toISOString());
  const randomHex = options.randomHex ?? (() => randomBytes(4).toString("hex"));
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  const staleLockMs = options.staleLockMs ?? 120_000;

  const sessionDirectory = (searchId) => join(stateRoot, validateSearchId(searchId));
  const statePath = (searchId) => join(sessionDirectory(searchId), "state.json");
  const checkpointPath = (searchId) => join(sessionDirectory(searchId), "checkpoint.md");

  async function renameWithRetry(from, to) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await rename(from, to);
        return;
      } catch (error) {
        lastError = error;
        if (!new Set(["EPERM", "EBUSY", "EACCES"]).has(error?.code) || attempt === 3) throw error;
        await sleep(15 * (attempt + 1));
      }
    }
    throw lastError;
  }

  async function writeTextAtomic(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await renameWithRetry(temporary, path);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function writeJsonAtomic(path, value) {
    await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function quarantine(path) {
    const suffix = now().replace(/[:.]/g, "-");
    const target = `${path}.corrupt-${suffix}-${randomBytes(3).toString("hex")}`;
    try {
      await renameWithRetry(path, target);
      return target;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function readJson(path, { quarantineCorrupt = false } = {}) {
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (error?.code === "ENOENT") throw new HeavySearchStateError(`JSON artifact not found: ${path}`);
      throw error;
    }
    if (info.size > MAX_STATE_BYTES) {
      const moved = quarantineCorrupt ? await quarantine(path) : null;
      throw new HeavySearchStateError(
        moved ? `Oversized JSON was quarantined at ${moved}.` : `JSON artifact is too large: ${path}`,
      );
    }
    let body;
    try {
      body = await readFile(path, "utf8");
      return JSON.parse(body);
    } catch (error) {
      if (error instanceof HeavySearchStateError) throw error;
      if (quarantineCorrupt) {
        const moved = await quarantine(path);
        throw new HeavySearchStateError(`Corrupt state was quarantined at ${moved}.`);
      }
      throw new HeavySearchStateError(`Cannot read JSON artifact ${path}: ${error.message}`);
    }
  }

  async function load(searchId) {
    validateSearchId(searchId);
    let state;
    try {
      state = await readJson(statePath(searchId), { quarantineCorrupt: true });
    } catch (error) {
      if (error instanceof HeavySearchStateError) throw error;
      throw new HeavySearchStateError(`Cannot read state ${searchId}: ${error.message}`);
    }
    return normalizeLoadedState(state, searchId);
  }

  async function acquireLock(directory) {
    await mkdir(directory, { recursive: true });
    const path = join(directory, ".lock");
    const deadline = Date.now() + lockTimeoutMs;
    while (true) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`, "utf8");
        await handle.sync();
        return { handle, path };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const age = Date.now() - (await stat(path)).mtimeMs;
          if (age > staleLockMs) {
            await rm(path, { force: true });
            continue;
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() >= deadline) {
          throw new HeavySearchStateError(`State is busy: ${directory.split(/[\\/]/).at(-1)}`);
        }
        await sleep(25);
      }
    }
  }

  async function withLock(searchId, operation) {
    const directory = sessionDirectory(searchId);
    const lock = await acquireLock(directory);
    try {
      return await operation();
    } finally {
      await lock.handle.close().catch(() => {});
      await rm(lock.path, { force: true }).catch(() => {});
    }
  }

  async function poolMap(state) {
    if (!state.pool?.artifact) return new Map();
    const payload = await readJson(join(sessionDirectory(state.searchId), state.pool.artifact));
    return new Map((payload.candidates ?? []).filter((item) => item.key).map((item) => [item.key, item]));
  }

  async function renderCheckpoint(state) {
    const candidates = await poolMap(state);
    const finalistKeys = state.finalists?.keys ?? [];
    const successKeys = state.acquisition?.successKeys ?? [];
    const reviewed = successKeys.filter((key) => ["inspected", "rejected"].includes(state.inspections?.[key]?.status));
    const scored = successKeys.filter((key) => Object.hasOwn(state.scores ?? {}, key));
    const lines = [
      "# SkillsMP Heavy Search Checkpoint",
      "",
      "> Resume this search. Do not create a new query plan or repeat completed API requests.",
      "",
      `- Search ID: \`${state.searchId}\``,
      `- Status: \`${state.status}\``,
      `- Phase: \`${state.phase}\``,
      `- Updated: \`${state.updatedAt}\``,
      `- Working directory: \`${state.workingDirectory}\``,
      `- Request: ${redactHeavyText(state.request, 1_200)}`,
      "",
      "## Retrieval",
      "",
      "| Sort | Status | API responses | Ambiguous dispatches | Candidates | Artifact |",
      "|---|---:|---:|---:|---:|---|",
    ];
    for (const sortBy of SORT_ORDERS) {
      const item = state.retrieval[sortBy];
      lines.push(`| ${sortBy} | ${item.status} | ${item.completedQueries.length}/${state.queries.length} | ${item.dispatchedQueries.length} | ${item.candidateCount} | ${item.artifact ? `\`${item.artifact}\`` : "—"} |`);
    }
    lines.push("", `Combined pool: **${state.pool?.candidateCount ?? 0}** (\`${state.pool?.artifact ?? "not built"}\`)`, "", "## Query plan", "");
    for (const query of state.queries) {
      const marks = SORT_ORDERS.map((sortBy) => {
        const item = state.retrieval[sortBy];
        const status = item.completedQueries.includes(query)
          ? "done"
          : item.dispatchedQueries.includes(query) ? "ambiguous" : "pending";
        return `${sortBy}:${status}`;
      });
      lines.push(`- \`${markdownCell(query)}\` — ${marks.join(", ")}`);
    }
    for (const stage of ["shortlist", "finalists"]) {
      const keys = state[stage]?.keys ?? [];
      lines.push("", `## ${stage[0].toUpperCase()}${stage.slice(1)} (${keys.length})`, "");
      if (keys.length === 0) lines.push("Not set.");
      else {
        for (const key of keys.slice(0, stage === "shortlist" ? 15 : keys.length)) {
          const candidate = candidates.get(key);
          lines.push(`- ${markdownCell(candidate?.name || candidate?.id || key)}`);
        }
        if (stage === "shortlist" && keys.length > 15) lines.push(`- … ${keys.length - 15} more in \`${state[stage].artifact}\``);
      }
    }
    lines.push(
      "",
      "## Analysis progress",
      "",
      `- Sources acquired: **${state.acquisition?.successes ?? 0}/${finalistKeys.length}**; terminal failures: **${state.acquisition?.terminalFailures ?? 0}**`,
      `- Semantically reviewed: **${reviewed.length}/${successKeys.length}**`,
      `- Scored: **${scored.length}/${successKeys.length}**`,
    );
    if (state.notes?.length) {
      lines.push("", "## Recent notes", "");
      for (const note of state.notes.slice(-10)) lines.push(`- ${note.at}: ${markdownCell(note.text)}`);
    }
    lines.push("", "## Next step", "", redactHeavyText(state.nextStep || "No next step; the search is complete."), "", `State: \`${statePath(state.searchId)}\``, "");
    return lines.join("\n");
  }

  async function saveState(state) {
    state.updatedAt = now();
    await writeJsonAtomic(statePath(state.searchId), state);
    await writeTextAtomic(checkpointPath(state.searchId), await renderCheckpoint(state));
  }

  async function start({ request, cwd = process.cwd(), queries }) {
    const uniqueQueries = [];
    for (const raw of queries ?? []) {
      const query = asString(raw).trim();
      if (query && !uniqueQueries.includes(query)) uniqueQueries.push(query);
    }
    if (uniqueQueries.length === 0) throw new HeavySearchStateError("At least one query is required.");
    const safeRequest = redactHeavyText(request, 8_000);
    const searchId = newSearchId(now, randomHex);
    const directory = sessionDirectory(searchId);
    try {
      await mkdir(stateRoot, { recursive: true });
      await mkdir(directory, { recursive: false });
    } catch (error) {
      if (error?.code === "EEXIST") throw new HeavySearchStateError(`Heavy-search state already exists: ${searchId}`);
      throw error;
    }
    const state = {
      schemaVersion: SCHEMA_VERSION,
      searchId,
      mode: "heavy",
      status: "active",
      phase: "retrieval-stars",
      request: safeRequest,
      requestFingerprint: requestFingerprint(safeRequest),
      workingDirectory: resolve(cwd),
      createdAt: now(),
      updatedAt: now(),
      queries: uniqueQueries,
      retrieval: Object.fromEntries(SORT_ORDERS.map((sortBy) => [sortBy, normalizeRetrievalItem({}, uniqueQueries, sortBy)])),
      pool: { candidateCount: 0, artifact: null },
      candidateIndex: { candidateCount: 0, artifact: null },
      shortlist: { keys: [], artifact: null },
      finalists: { keys: [], artifact: null },
      acquisition: {
        status: "pending", artifact: null, reviewIndex: null, canonicalCandidates: 0,
        successes: 0, terminalFailures: 0, metrics: {}, successKeys: [], failureKeys: [],
      },
      inspections: {},
      scores: {},
      notes: [],
      nextStep: "Continue stars retrieval with this search ID.",
    };
    await saveState(state);
    return {
      searchId,
      statePath: statePath(searchId),
      checkpointPath: checkpointPath(searchId),
      nextStep: state.nextStep,
    };
  }

  async function list({ cwd, includeAll = false } = {}) {
    let names;
    try {
      names = await readdir(stateRoot);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const expected = cwd ? normalizeComparablePath(resolve(cwd)) : null;
    const states = [];
    for (const name of names) {
      if (!SEARCH_ID_PATTERN.test(name)) continue;
      try {
        const state = await load(name);
        if (!includeAll && state.status !== "active") continue;
        if (expected && normalizeComparablePath(state.workingDirectory) !== expected) continue;
        states.push(state);
      } catch {
        // A damaged unrelated session must not hide valid resumable work.
      }
    }
    return states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async function resume({ searchId, request, cwd = process.cwd() } = {}) {
    let state;
    if (searchId) state = await load(searchId);
    else {
      let matches = await list({ cwd, includeAll: false });
      if (request) {
        const fingerprint = requestFingerprint(redactHeavyText(request, 8_000));
        matches = matches.filter((item) => item.requestFingerprint === fingerprint);
      }
      if (matches.length === 0) throw new HeavySearchStateError("No resumable heavy search matches this request and directory.");
      if (matches.length > 1) throw new HeavySearchStateError("Multiple active searches match; resume one with --search-id.");
      [state] = matches;
    }
    const checkpoint = await renderCheckpoint(state);
    await writeTextAtomic(checkpointPath(state.searchId), checkpoint);
    return { searchId: state.searchId, state, checkpoint };
  }

  async function assertPlan(searchId, queries) {
    const state = await load(searchId);
    const supplied = [...new Set((queries ?? []).map((item) => asString(item).trim()).filter(Boolean))];
    if (supplied.length !== state.queries.length || supplied.some((query) => !state.queries.includes(query))) {
      throw new HeavySearchStateError("The supplied heavy-search queries do not match the saved query plan. No API requests were made.");
    }
    return state.queries;
  }

  async function completedQueries(searchId, sortBy) {
    if (!SORT_ORDERS.includes(sortBy)) throw new HeavySearchStateError("sortBy must be stars or recent.");
    return [...(await load(searchId)).retrieval[sortBy].completedQueries];
  }

  async function prepareQueryDispatch({ searchId, sortBy, query, retryAmbiguous = false }) {
    if (!SORT_ORDERS.includes(sortBy)) throw new HeavySearchStateError("sortBy must be stars or recent.");
    return withLock(searchId, async () => {
      const state = await load(searchId);
      const trimmed = asString(query).trim();
      if (!state.queries.includes(trimmed)) throw new HeavySearchStateError(`Query is not in the saved query plan: ${trimmed}`);
      const retrieval = state.retrieval[sortBy];
      if (retrieval.completedQueries.includes(trimmed)) return { status: "completed", retriedAmbiguous: false };
      if (state.status !== "active") throw new HeavySearchStateError("Cannot dispatch a pending query in an inactive search.");
      if (retrieval.dispatchedQueries.includes(trimmed)) {
        const artifact = join(sessionDirectory(searchId), queryArtifact(sortBy, trimmed));
        try {
          const saved = await readJson(artifact);
          if (saved?.query === trimmed && saved?.response?.success && Array.isArray(saved?.response?.data?.skills)) {
            retrieval.dispatchedQueries = retrieval.dispatchedQueries.filter((item) => item !== trimmed);
            retrieval.completedQueries.push(trimmed);
            retrieval.queryArtifacts[trimmed] = queryArtifact(sortBy, trimmed);
            await saveState(state);
            return { status: "completed", retriedAmbiguous: false };
          }
        } catch {
          // No committed response means dispatch outcome is genuinely ambiguous.
        }
        if (!retryAmbiguous) return { status: "ambiguous", retriedAmbiguous: false };
        state.notes.push({
          at: now(),
          text: redactHeavyText(`Ambiguous ${sortBy} query explicitly retried: ${trimmed}`, 2_000),
        });
        state.notes = state.notes.slice(-100);
        await saveState(state);
        return { status: "ready", retriedAmbiguous: true };
      }
      retrieval.dispatchedQueries.push(trimmed);
      retrieval.status = "in-progress";
      state.phase = `retrieval-${sortBy}`;
      state.nextStep = `Finish the dispatched ${sortBy} query, then continue retrieval.`;
      await saveState(state);
      return { status: "ready", retriedAmbiguous: false };
    });
  }

  async function recordQueryResponse({ searchId, sortBy, query, payload }) {
    if (!SORT_ORDERS.includes(sortBy)) throw new HeavySearchStateError("sortBy must be stars or recent.");
    if (!payload?.success || !Array.isArray(payload?.data?.skills)) {
      throw new HeavySearchStateError("Cannot checkpoint an invalid SkillsMP response.");
    }
    return withLock(searchId, async () => {
      const state = await load(searchId);
      const trimmed = asString(query).trim();
      const retrieval = state.retrieval[sortBy];
      if (retrieval.completedQueries.includes(trimmed)) return { status: "already-recorded", query: trimmed };
      if (!retrieval.dispatchedQueries.includes(trimmed)) {
        throw new HeavySearchStateError(`Query was not recorded as dispatched: ${trimmed}`);
      }
      const artifact = queryArtifact(sortBy, trimmed);
      await writeJsonAtomic(join(sessionDirectory(searchId), artifact), { query: trimmed, response: payload });
      retrieval.dispatchedQueries = retrieval.dispatchedQueries.filter((item) => item !== trimmed);
      retrieval.completedQueries.push(trimmed);
      retrieval.queryArtifacts[trimmed] = artifact;
      delete retrieval.errors[trimmed];
      const remaining = state.queries.length - retrieval.completedQueries.length;
      state.nextStep = remaining
        ? `Continue ${sortBy} retrieval; ${remaining} queries remain.`
        : `Finalize ${sortBy} retrieval.`;
      await saveState(state);
      return { status: "recorded", query: trimmed, remaining, artifact };
    });
  }

  async function recordQueryFailure({ searchId, sortBy, query, message }) {
    return withLock(searchId, async () => {
      const state = await load(searchId);
      const retrieval = state.retrieval[sortBy];
      retrieval.errors[query] = { at: now(), message: redactHeavyText(message, 1_000) };
      state.nextStep = `The ${sortBy} query dispatch is ambiguous. Retry only with explicit authorization.`;
      await saveState(state);
    });
  }

  async function finishRetrieval({ searchId, sortBy, maxCandidates = 200, limitPerQuery = 50 }) {
    if (!SORT_ORDERS.includes(sortBy)) throw new HeavySearchStateError("sortBy must be stars or recent.");
    return withLock(searchId, async () => {
      const state = await load(searchId);
      const retrieval = state.retrieval[sortBy];
      if (state.status !== "active" && retrieval.status === "completed") {
        return {
          searchId,
          sortBy,
          candidateCount: retrieval.candidateCount,
          artifactPath: join(sessionDirectory(searchId), retrieval.artifact),
          checkpointPath: checkpointPath(searchId),
          nextStep: state.nextStep,
        };
      }
      const pending = state.queries.filter((query) => !retrieval.completedQueries.includes(query));
      if (pending.length) throw new HeavySearchStateError(`Cannot finish ${sortBy}; pending or ambiguous queries: ${pending.join(", ")}`);
      const queryPayloads = [];
      for (const query of state.queries) {
        const artifact = retrieval.queryArtifacts[query] ?? queryArtifact(sortBy, query);
        const saved = await readJson(join(sessionDirectory(searchId), artifact));
        if (saved?.query !== query || !Array.isArray(saved?.response?.data?.skills)) {
          throw new HeavySearchStateError(`Invalid saved response artifact for query: ${query}`);
        }
        queryPayloads.push({ query, skills: saved.response.data.skills });
      }
      const candidates = mergeQueryPayloads(queryPayloads, sortBy, maxCandidates);
      const artifact = `${sortBy}.json`;
      await writeJsonAtomic(join(sessionDirectory(searchId), artifact), {
        generatedAt: now(), queries: state.queries, sortBy, limitPerQuery,
        candidateCount: candidates.length, candidates,
      });
      Object.assign(retrieval, {
        status: "completed",
        candidateCount: candidates.length,
        artifact,
        limitPerQuery,
      });
      if (SORT_ORDERS.every((order) => state.retrieval[order].status === "completed")) {
        const payloads = [];
        for (const order of SORT_ORDERS) {
          const saved = await readJson(join(sessionDirectory(searchId), state.retrieval[order].artifact));
          payloads.push({ sortBy: order, candidates: saved.candidates ?? [] });
        }
        const combined = mergeSortCandidates(payloads, 250);
        await writeJsonAtomic(join(sessionDirectory(searchId), "candidates.json"), {
          generatedAt: now(), candidateCount: combined.length, candidates: combined,
        });
        state.pool = { candidateCount: combined.length, artifact: "candidates.json" };
        state.phase = "shortlist";
        state.nextStep = "Build candidate-index.json, then save a 40–60 candidate shortlist.";
      } else if (sortBy === "stars") {
        state.phase = "retrieval-recent";
        state.nextStep = "Continue recent retrieval with the same search ID.";
      } else {
        state.phase = "retrieval-stars";
        state.nextStep = "Finish the stars retrieval with the same search ID.";
      }
      await saveState(state);
      return {
        searchId, sortBy, candidateCount: candidates.length,
        artifactPath: join(sessionDirectory(searchId), artifact),
        checkpointPath: checkpointPath(searchId), nextStep: state.nextStep,
      };
    });
  }

  async function buildCandidateIndex({ searchId, limit = 80 }) {
    if (!Number.isInteger(limit) || limit < 40 || limit > 100) {
      throw new HeavySearchStateError("candidate-index limit must be between 40 and 100.");
    }
    return withLock(searchId, async () => {
      const state = await load(searchId);
      if (state.status !== "active") throw new HeavySearchStateError("Cannot rebuild a candidate index for an inactive search.");
      const candidates = [...(await poolMap(state)).values()];
      if (!candidates.length) throw new HeavySearchStateError("Combined candidate pool is not available.");
      const groups = new Map();
      for (const candidate of candidates) {
        const repository = repositoryIdentity(candidate.githubUrl) || candidate.key;
        const name = normalizedSkillName(candidate.name) || candidate.key;
        const family = `${repository}\0${name}`;
        if (!groups.has(family)) groups.set(family, []);
        groups.get(family).push(candidate);
      }
      const preference = (left, right) => {
        const score = (item) => {
          const path = asString(item.githubUrl).toLocaleLowerCase("en-US");
          const localized = /\/(docs\/)?(ja-jp|zh-cn|ko-kr|fr-fr|de-de|es-es)\//.test(path);
          const primary = path.includes("/skills/") && !path.includes("/docs/");
          return [primary ? 0 : 1, localized ? 1 : 0, -Number(item.matchCount ?? 0), Number(item.bestRank ?? 1_000_000)];
        };
        const a = score(left);
        const b = score(right);
        for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
        return left.key.localeCompare(right.key);
      };
      const representatives = [...groups.values()].map((items) => [...items].sort(preference)[0]);
      representatives.sort((left, right) =>
        Number(right.matchCount ?? 0) - Number(left.matchCount ?? 0) ||
        Number(left.bestRank ?? 1_000_000) - Number(right.bestRank ?? 1_000_000) ||
        Number(right.stars ?? 0) - Number(left.stars ?? 0) ||
        left.key.localeCompare(right.key));
      const entries = representatives.slice(0, limit).map((candidate) => ({
        key: candidate.key,
        name: asString(candidate.name),
        author: asString(candidate.author),
        description: redactHeavyText(candidate.description, 360),
        githubUrl: asString(candidate.githubUrl),
        matchCount: Number(candidate.matchCount ?? 0),
        bestRank: Number(candidate.bestRank ?? 0),
        stars: Number(candidate.stars ?? 0),
      }));
      const artifact = "candidate-index.json";
      await writeJsonAtomic(join(sessionDirectory(searchId), artifact), {
        version: 1,
        nameNormalizerVersion: 1,
        generatedAt: now(),
        sourceCandidates: candidates.length,
        families: groups.size,
        candidateCount: entries.length,
        candidates: entries,
      });
      state.candidateIndex = { artifact, candidateCount: entries.length };
      state.phase = "shortlist";
      state.nextStep = "Read candidate-index.json and save a 40–60 candidate shortlist.";
      await saveState(state);
      return {
        artifactPath: join(sessionDirectory(searchId), artifact),
        candidateCount: entries.length,
        sourceCandidates: candidates.length,
        families: groups.size,
      };
    });
  }

  async function extractCandidateKeys(input, candidates) {
    const items = Array.isArray(input) ? input : input?.candidates ?? input?.keys;
    if (!Array.isArray(items)) throw new HeavySearchStateError("Candidate input must be an array or an object with candidates/keys.");
    const keys = [];
    for (const item of items) {
      const key = typeof item === "string" ? item : item?.key || candidateKey(item);
      if (!candidates.has(key)) throw new HeavySearchStateError(`Candidate is not in the merged pool: ${key}`);
      if (!keys.includes(key)) keys.push(key);
    }
    return keys;
  }

  async function setCandidates({ searchId, stage, candidates }) {
    if (!new Set(["shortlist", "finalists"]).has(stage)) throw new HeavySearchStateError("stage must be shortlist or finalists.");
    return withLock(searchId, async () => {
      const state = await load(searchId);
      const pool = await poolMap(state);
      if (!pool.size) throw new HeavySearchStateError("Combined candidate pool is not available.");
      const keys = await extractCandidateKeys(candidates, pool);
      if (stage === "finalists") {
        if (!state.shortlist.keys.length) throw new HeavySearchStateError("Save a shortlist before finalists.");
        const outside = keys.filter((key) => !state.shortlist.keys.includes(key));
        if (outside.length) throw new HeavySearchStateError(`Finalists must come from the saved shortlist: ${outside.join(", ")}`);
      }
      const artifact = `${stage}.json`;
      await writeJsonAtomic(join(sessionDirectory(searchId), artifact), {
        generatedAt: now(), candidateCount: keys.length, candidates: keys.map((key) => pool.get(key)),
      });
      state[stage] = { keys, artifact };
      if (stage === "shortlist") {
        state.phase = "finalists";
        state.nextStep = "Reduce the shortlist to 20–25 finalists for complete source inspection.";
      } else {
        state.acquisition = {
          status: "pending", artifact: null, reviewIndex: null, canonicalCandidates: 0,
          successes: 0, terminalFailures: 0, metrics: {}, successKeys: [], failureKeys: [],
        };
        state.inspections = Object.fromEntries(Object.entries(state.inspections).filter(([key]) => keys.includes(key)));
        state.scores = Object.fromEntries(Object.entries(state.scores).filter(([key]) => keys.includes(key)));
        state.phase = "acquisition";
        state.nextStep = "Run batch source acquisition, then import inspection.json.";
      }
      await saveState(state);
      return { stage, candidateCount: keys.length, artifactPath: join(sessionDirectory(searchId), artifact), nextStep: state.nextStep };
    });
  }

  async function recordAcquisition({ searchId, artifactPath }) {
    const absoluteArtifact = resolve(artifactPath);
    const payload = await readJson(absoluteArtifact);
    const metrics = payload?.metrics;
    const results = payload?.candidates;
    if (!metrics || typeof metrics !== "object" || !Array.isArray(results)) {
      throw new HeavySearchStateError("Inspection artifact has no metrics or candidates array.");
    }
    const canonical = Number(metrics.canonicalCandidates ?? 0);
    const successes = Number(metrics.successes ?? 0);
    const failures = Number(metrics.terminalFailures ?? 0);
    if (successes + failures !== canonical || results.length !== canonical) {
      throw new HeavySearchStateError("Inspection artifact violates candidate accounting invariant.");
    }
    return withLock(searchId, async () => {
      const state = await load(searchId);
      if (state.status !== "active") throw new HeavySearchStateError("Cannot import acquisition into an inactive search.");
      const pool = await poolMap(state);
      const finalistKeys = state.finalists.keys;
      const aliases = new Map();
      for (const key of finalistKeys) {
        aliases.set(key, key);
        aliases.set(githubSkillIdentity(pool.get(key)?.githubUrl), key);
      }
      const successKeys = [];
      const failureKeys = [];
      const seen = new Set();
      for (const result of results) {
        const capsuleUrl = result?.capsule?.candidate?.githubUrl;
        const identity = githubSkillIdentity(capsuleUrl || result?.canonicalKey);
        const key = aliases.get(identity);
        if (!key) throw new HeavySearchStateError(`Inspection result is not a saved finalist: ${identity}`);
        if (seen.has(key)) throw new HeavySearchStateError(`Inspection artifact maps more than one result to finalist: ${key}`);
        seen.add(key);
        (result.status === "success" ? successKeys : failureKeys).push(key);
      }
      if (seen.size !== finalistKeys.length || finalistKeys.some((key) => !seen.has(key))) {
        throw new HeavySearchStateError("Inspection artifact does not account for every saved finalist.");
      }
      const reviewIndex = payload?.artifacts?.reviewIndex || null;
      state.acquisition = {
        status: "complete",
        artifact: absoluteArtifact,
        reviewIndex,
        canonicalCandidates: canonical,
        successes,
        terminalFailures: failures,
        metrics,
        successKeys,
        failureKeys,
      };
      state.phase = "review";
      state.nextStep = `Review ${reviewIndex || absoluteArtifact} and checkpoint semantic judgments.`;
      await saveState(state);
      return { status: "recorded", successes, terminalFailures: failures, reviewIndex };
    });
  }

  function cleanRecord(record, allowed) {
    const output = {};
    for (const key of allowed) {
      const value = record[key];
      if (value === undefined || value === null) continue;
      output[key] = typeof value === "string" ? redactHeavyText(value) : value;
    }
    return output;
  }

  async function recordInspections({ searchId, records }) {
    if (!Array.isArray(records) || records.length === 0 || records.some((record) => !record || typeof record !== "object")) {
      throw new HeavySearchStateError("Inspection records must be a nonempty JSON array of objects.");
    }
    return withLock(searchId, async () => {
      const state = await load(searchId);
      const updates = [];
      const seen = new Set();
      for (const record of records) {
        const key = asString(record.candidateKey || record.key).trim() || candidateKey(record);
        if (seen.has(key)) throw new HeavySearchStateError(`Duplicate inspection record: ${key}`);
        seen.add(key);
        if (!state.finalists.keys.includes(key)) throw new HeavySearchStateError(`Candidate is not a finalist: ${key}`);
        if (!state.acquisition.successKeys.includes(key)) throw new HeavySearchStateError(`Candidate has no successful source acquisition: ${key}`);
        const status = asString(record.status || "inspected");
        if (!new Set(["inspected", "rejected", "failed"]).has(status)) throw new HeavySearchStateError(`Invalid inspection status: ${status}`);
        updates.push([key, {
          ...cleanRecord(record, ["summary", "evidence", "methodDelta", "limitations", "sourceUrl", "sourceAccessible"]),
          status,
          updatedAt: now(),
        }]);
      }
      for (const [key, value] of updates) state.inspections[key] = value;
      const pending = state.acquisition.successKeys.filter((candidate) => !["inspected", "rejected"].includes(state.inspections[candidate]?.status));
      if (pending.length) {
        state.phase = "review";
        state.nextStep = `Continue semantic review; ${pending.length} acquired finalists remain.`;
      } else {
        state.phase = "scoring";
        state.nextStep = "Score inspected finalists with the SkillsMP rubric.";
      }
      await saveState(state);
      return { recorded: updates.length, remaining: pending.length };
    });
  }

  async function recordInspection({ searchId, record }) {
    const result = await recordInspections({ searchId, records: [record] });
    return {
      candidateKey: asString(record?.candidateKey || record?.key).trim() || candidateKey(record),
      status: asString(record?.status || "inspected"),
      remaining: result.remaining,
    };
  }

  async function recordScores({ searchId, records }) {
    if (!Array.isArray(records) || records.length === 0 || records.some((record) => !record || typeof record !== "object")) {
      throw new HeavySearchStateError("Score records must be a nonempty JSON array of objects.");
    }
    return withLock(searchId, async () => {
      const state = await load(searchId);
      const updates = [];
      const seen = new Set();
      for (const record of records) {
        const key = asString(record.candidateKey || record.key).trim() || candidateKey(record);
        if (seen.has(key)) throw new HeavySearchStateError(`Duplicate score record: ${key}`);
        seen.add(key);
        if (state.inspections[key]?.status !== "inspected") throw new HeavySearchStateError(`Candidate has no successful inspection: ${key}`);
        const total = Number(record.total);
        if (!Number.isFinite(total) || total < 0 || total > 100) throw new HeavySearchStateError("Score total must be between 0 and 100.");
        updates.push([key, {
          ...cleanRecord(record, ["components", "rationale", "confidence"]),
          total,
          updatedAt: now(),
        }]);
      }
      for (const [key, value] of updates) state.scores[key] = value;
      const targets = state.acquisition.successKeys.filter((candidate) => state.inspections[candidate]?.status === "inspected");
      const pending = targets.filter((candidate) => !Object.hasOwn(state.scores, candidate));
      if (pending.length) {
        state.phase = "scoring";
        state.nextStep = `Continue scoring; ${pending.length} inspected finalists remain.`;
      } else {
        state.phase = "reporting";
        state.nextStep = "Compare the leaders pairwise and write the final recommendations.";
      }
      await saveState(state);
      return { recorded: updates.length, remaining: pending.length };
    });
  }

  async function recordScore({ searchId, record }) {
    const result = await recordScores({ searchId, records: [record] });
    return {
      candidateKey: asString(record?.candidateKey || record?.key).trim() || candidateKey(record),
      total: Number(record?.total),
      remaining: result.remaining,
    };
  }

  async function setPhase({ searchId, phase, nextStep }) {
    if (!PHASES.has(phase)) throw new HeavySearchStateError(`Invalid phase: ${phase}`);
    return withLock(searchId, async () => {
      const state = await load(searchId);
      state.phase = phase;
      state.nextStep = redactHeavyText(nextStep);
      await saveState(state);
      return renderCheckpoint(state);
    });
  }

  async function addNote({ searchId, text }) {
    return withLock(searchId, async () => {
      const state = await load(searchId);
      state.notes.push({ at: now(), text: redactHeavyText(text, 2_000) });
      state.notes = state.notes.slice(-100);
      await saveState(state);
      return { searchId, notes: state.notes.length };
    });
  }

  async function complete({ searchId, summary, allowIncomplete = false, reason } = {}) {
    return withLock(searchId, async () => {
      const state = await load(searchId);
      if (state.finalists.keys.length && state.acquisition.status !== "complete" && !allowIncomplete) {
        throw new HeavySearchStateError("Cannot complete before source acquisition finishes.");
      }
      const successKeys = state.acquisition.successKeys;
      const unreviewed = successKeys.filter((key) => !["inspected", "rejected"].includes(state.inspections[key]?.status));
      const scoreTargets = successKeys.filter((key) => state.inspections[key]?.status === "inspected");
      const unscored = scoreTargets.filter((key) => !Object.hasOwn(state.scores, key));
      if ((unreviewed.length || unscored.length) && !allowIncomplete) {
        throw new HeavySearchStateError(`Cannot complete; ${new Set([...unreviewed, ...unscored]).size} acquired candidates remain unreviewed or unscored.`);
      }
      if (allowIncomplete && !asString(reason).trim()) {
        throw new HeavySearchStateError("--allow-incomplete requires --reason.");
      }
      state.status = allowIncomplete ? "finalized-incomplete" : "completed";
      state.phase = "completed";
      state.completedAt = now();
      state.completionSummary = summary ? redactHeavyText(summary, 4_000) : "";
      if (allowIncomplete) state.completionReason = redactHeavyText(reason, 2_000);
      state.nextStep = null;
      await saveState(state);
      return { state, checkpoint: await renderCheckpoint(state) };
    });
  }

  async function abandon({ searchId, reason }) {
    if (!asString(reason).trim()) throw new HeavySearchStateError("Abandonment requires a reason.");
    return withLock(searchId, async () => {
      const state = await load(searchId);
      state.status = "abandoned";
      state.abandonedAt = now();
      state.abandonReason = redactHeavyText(reason, 4_000);
      state.nextStep = null;
      await saveState(state);
      return { state, checkpoint: await renderCheckpoint(state) };
    });
  }

  return {
    stateRoot,
    paths: { sessionDirectory, state: statePath, checkpoint: checkpointPath },
    start,
    load,
    list,
    resume,
    assertPlan,
    completedQueries,
    prepareQueryDispatch,
    recordQueryResponse,
    recordQueryFailure,
    finishRetrieval,
    buildCandidateIndex,
    setCandidates,
    recordAcquisition,
    recordInspection,
    recordInspections,
    recordScore,
    recordScores,
    setPhase,
    addNote,
    complete,
    abandon,
    renderCheckpoint,
  };
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new HeavySearchStateError("A command is required.");
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (new Set(["--all", "--allow-incomplete"]).has(flag)) {
      booleans.add(flag);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined) throw new HeavySearchStateError(`Missing value for ${flag}.`);
    if (!values.has(flag)) values.set(flag, []);
    values.get(flag).push(value);
    index += 1;
  }
  const one = (flag, fallback = undefined) => values.get(flag)?.at(-1) ?? fallback;
  const many = (flag) => values.get(flag) ?? [];
  return { command, one, many, has: (flag) => booleans.has(flag) };
}

async function inputJson(path) {
  let raw;
  if (path && path !== "-") raw = await readFile(resolve(path), "utf8");
  else {
    raw = "";
    for await (const chunk of process.stdin) raw += chunk;
  }
  if (!raw.trim()) throw new HeavySearchStateError("Expected JSON on stdin.");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new HeavySearchStateError(`Invalid JSON on stdin: ${error.message}`);
  }
}

async function runCli(argv) {
  const args = parseCli(argv);
  const store = createHeavySearchStore();
  const required = (flag) => {
    const value = args.one(flag);
    if (value === undefined) throw new HeavySearchStateError(`${flag} is required.`);
    return value;
  };
  let result;
  if (args.command === "start") {
    result = await store.start({ request: required("--request"), cwd: args.one("--cwd", process.cwd()), queries: args.many("--query") });
  } else if (args.command === "resume") {
    result = await store.resume({ searchId: args.one("--search-id"), request: args.one("--request"), cwd: args.one("--cwd", process.cwd()) });
    process.stdout.write(`${result.checkpoint}\n`);
    return;
  } else if (args.command === "list") {
    result = await store.list({ cwd: args.one("--cwd"), includeAll: args.has("--all") });
  } else if (args.command === "query-plan") {
    result = (await store.load(required("--search-id"))).queries;
  } else if (args.command === "completed-queries") {
    result = await store.completedQueries(required("--search-id"), required("--sort-by"));
  } else if (args.command === "candidate-index") {
    result = await store.buildCandidateIndex({ searchId: required("--search-id"), limit: Number(args.one("--limit", 80)) });
  } else if (args.command === "set-candidates") {
    result = await store.setCandidates({ searchId: required("--search-id"), stage: required("--stage"), candidates: await inputJson(args.one("--input")) });
  } else if (args.command === "record-acquisition") {
    result = await store.recordAcquisition({ searchId: required("--search-id"), artifactPath: required("--artifact") });
  } else if (args.command === "record-inspection") {
    result = await store.recordInspection({ searchId: required("--search-id"), record: await inputJson(args.one("--input")) });
  } else if (args.command === "record-inspections") {
    const payload = await inputJson(args.one("--input"));
    result = await store.recordInspections({ searchId: required("--search-id"), records: Array.isArray(payload) ? payload : payload.inspections });
  } else if (args.command === "record-score") {
    result = await store.recordScore({ searchId: required("--search-id"), record: await inputJson(args.one("--input")) });
  } else if (args.command === "record-scores") {
    const payload = await inputJson(args.one("--input"));
    result = await store.recordScores({ searchId: required("--search-id"), records: Array.isArray(payload) ? payload : payload.scores });
  } else if (args.command === "set-phase") {
    result = await store.setPhase({ searchId: required("--search-id"), phase: required("--phase"), nextStep: required("--next-step") });
  } else if (args.command === "note") {
    result = await store.addNote({ searchId: required("--search-id"), text: required("--text") });
  } else if (args.command === "complete") {
    result = await store.complete({ searchId: required("--search-id"), summary: args.one("--summary"), allowIncomplete: args.has("--allow-incomplete"), reason: args.one("--reason") });
    process.stdout.write(`${result.checkpoint}\n`);
    return;
  } else if (args.command === "abandon") {
    result = await store.abandon({ searchId: required("--search-id"), reason: required("--reason") });
    process.stdout.write(`${result.checkpoint}\n`);
    return;
  } else {
    throw new HeavySearchStateError(`Unknown command: ${args.command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  if (Number(process.versions.node.split(".")[0]) < 18) {
    process.stderr.write("Heavy search failed: Node.js 18 or newer is required.\n");
    process.exitCode = 1;
  } else {
    runCli(process.argv.slice(2)).catch((error) => {
      process.stderr.write(`Heavy search failed: ${redactHeavyText(error?.message ?? error)}\n`);
      process.exitCode = 1;
    });
  }
}
