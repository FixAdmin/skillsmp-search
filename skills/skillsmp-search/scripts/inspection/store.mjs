import { createHash, randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeSegment(value, label) {
  const text = String(value ?? "").trim();
  if (!text || !/^[a-zA-Z0-9._-]+$/.test(text)) {
    throw new TypeError(`${label} contains unsupported characters`);
  }
  return text;
}

export function defaultCacheDir() {
  if (process.env.SKILLSMP_CACHE_DIR) return process.env.SKILLSMP_CACHE_DIR;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "skillsmp-search", "cache");
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "skillsmp-search");
}

export function defaultStateDir() {
  if (process.env.SKILLSMP_STATE_DIR) return process.env.SKILLSMP_STATE_DIR;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "skillsmp-search", "state");
  }
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "skillsmp-search",
  );
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    try {
      await import("node:fs/promises").then(({ rm }) => rm(temporary, { force: true }));
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

async function quarantineInvalidJson(path) {
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    await rename(path, `${path}.corrupt-${suffix}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function readJsonOrNull(path) {
  let body;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(body);
  } catch {
    await quarantineInvalidJson(path);
    return null;
  }
}

export function createStore({
  cacheDir = defaultCacheDir(),
  stateDir = defaultStateDir(),
  runId,
}) {
  const safeRunId = safeSegment(runId, "run-id");
  const objectPath = (hash) => join(cacheDir, "objects", "sha256", hash.slice(0, 2), hash);
  const sourceRefPath = (canonicalUrl) =>
    join(cacheDir, "refs", "sources", `${sha256(canonicalUrl)}.json`);
  const factsPath = (sourceHash, version) =>
    join(
      cacheDir,
      "facts",
      safeSegment(version, "facts version"),
      `${safeSegment(sourceHash, "source hash")}.json`,
    );
  const capsulePath = (sourceHash, version, canonicalKey) =>
    join(
      cacheDir,
      "capsules",
      safeSegment(version, "capsule version"),
      safeSegment(sourceHash, "source hash"),
      `${sha256(canonicalKey)}.json`,
    );
  const candidateDirectory = join(stateDir, "runs", safeRunId, "candidates");
  const candidatePath = (canonicalKey) => join(candidateDirectory, `${sha256(canonicalKey)}.json`);

  return {
    cacheDir,
    stateDir,
    runId: safeRunId,
    paths: {
      candidate: candidatePath,
      candidateDirectory,
      capsule: capsulePath,
      facts: factsPath,
      object: objectPath,
      runDirectory: join(stateDir, "runs", safeRunId),
      sourceRef: sourceRefPath,
    },

    async putSource({ canonicalUrl, bytes, metadata = {} }) {
      if (typeof canonicalUrl !== "string" || !canonicalUrl) {
        throw new TypeError("canonicalUrl is required");
      }
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const sourceSha256 = sha256(buffer);
      const object = objectPath(sourceSha256);
      const cacheHit = await pathExists(object);
      if (!cacheHit) {
        await mkdir(dirname(object), { recursive: true });
        try {
          await writeFile(object, buffer, { flag: "wx" });
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      await writeJsonAtomic(sourceRefPath(canonicalUrl), {
        version: 1,
        canonicalUrl,
        sourceSha256,
        byteLength: buffer.length,
        metadata,
      });
      return { sourceSha256, objectPath: object, byteLength: buffer.length, cacheHit };
    },

    async getSource(canonicalUrl) {
      const ref = await readJsonOrNull(sourceRefPath(canonicalUrl));
      if (!ref?.sourceSha256) return null;
      try {
        const bytes = await readFile(objectPath(ref.sourceSha256));
        if (sha256(bytes) !== ref.sourceSha256) {
          throw new Error("cached source hash does not match its content");
        }
        return { ...ref, bytes, objectPath: objectPath(ref.sourceSha256) };
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },

    async putFacts(sourceHash, version, facts) {
      await writeJsonAtomic(factsPath(sourceHash, version), { version, facts });
      return factsPath(sourceHash, version);
    },

    async getFacts(sourceHash, version) {
      const stored = await readJsonOrNull(factsPath(sourceHash, version));
      return stored?.version === version ? stored.facts : null;
    },

    async putCapsule(sourceHash, version, canonicalKey, capsule) {
      await writeJsonAtomic(capsulePath(sourceHash, version, canonicalKey), {
        version,
        capsule,
      });
      return capsulePath(sourceHash, version, canonicalKey);
    },

    async getCapsule(sourceHash, version, canonicalKey) {
      const stored = await readJsonOrNull(capsulePath(sourceHash, version, canonicalKey));
      return stored?.version === version ? stored.capsule : null;
    },

    async writeCandidate(canonicalKey, record) {
      const value = { version: 1, canonicalKey, ...record };
      await writeJsonAtomic(candidatePath(canonicalKey), value);
      return value;
    },

    async readCandidate(canonicalKey) {
      const value = await readJsonOrNull(candidatePath(canonicalKey));
      if (!value || value.version !== 1 || value.canonicalKey !== canonicalKey) return null;
      return value;
    },
  };
}
