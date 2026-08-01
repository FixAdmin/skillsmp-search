const ALLOWED_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "api.github.com",
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class SourceFetchError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SourceFetchError";
    Object.assign(this, details);
  }
}

function candidateUrl(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("candidate must be an object");
  }

  const value =
    candidate.githubUrl ??
    candidate.github_url ??
    candidate.sourceUrl ??
    candidate.source_url ??
    candidate.url;
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("candidate must include a GitHub URL");
  }
  return value.trim();
}

function cleanSkillPath(parts) {
  const cleaned = parts.filter(Boolean);
  if (cleaned.at(-1)?.toLowerCase() === "skill.md") cleaned.pop();
  return cleaned.join("/");
}

export function canonicalizeCandidate(candidate) {
  let parsed;
  try {
    parsed = new URL(candidateUrl(candidate));
  } catch {
    throw new TypeError("candidate source must be a valid HTTPS GitHub URL");
  }

  if (parsed.protocol !== "https:") {
    throw new TypeError("candidate source must be an HTTPS GitHub URL");
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "raw.githubusercontent.com") {
    throw new TypeError(`unsupported GitHub host: ${parsed.hostname}`);
  }

  const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length < 2) {
    throw new TypeError("GitHub URL must include an owner and repository");
  }

  const owner = segments[0];
  const repository = segments[1].replace(/\.git$/i, "");
  if (!owner || !repository) {
    throw new TypeError("GitHub URL must include an owner and repository");
  }

  let requestedRef = "HEAD";
  let pathParts = [];
  if (host === "raw.githubusercontent.com") {
    if (segments.length < 3) {
      throw new TypeError("raw GitHub URL must include a ref");
    }
    requestedRef = segments[2];
    pathParts = segments.slice(3);
  } else if (["tree", "blob", "raw"].includes(segments[2])) {
    if (segments.length < 4) {
      throw new TypeError("GitHub source URL must include a ref");
    }
    requestedRef = segments[3];
    pathParts = segments.slice(4);
  } else if (segments.length > 2) {
    throw new TypeError("GitHub URL must point to a repository, tree, blob, or raw file");
  }

  const skillPath = cleanSkillPath(pathParts);
  const canonicalPath = skillPath ? `/${skillPath.toLowerCase()}` : "";
  return {
    ...candidate,
    owner,
    repository,
    requestedRef,
    skillPath,
    canonicalKey: `github.com/${owner.toLowerCase()}/${repository.toLowerCase()}${canonicalPath}`,
  };
}

function encodePath(value) {
  return value
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function resolveSourceUrl(candidate) {
  const normalized = candidate?.canonicalKey
    ? candidate
    : canonicalizeCandidate(candidate);
  const owner = encodeURIComponent(normalized.owner);
  const repository = encodeURIComponent(normalized.repository);
  const ref = encodePath(normalized.requestedRef || "HEAD");
  const skillPath = encodePath(normalized.skillPath || "");
  const suffix = skillPath ? `${skillPath}/SKILL.md` : "SKILL.md";
  return `https://raw.githubusercontent.com/${owner}/${repository}/${ref}/${suffix}`;
}

function validateFetchUrl(value, context = "source") {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new SourceFetchError(`${context} URL is invalid`, { kind: "permanent" });
  }
  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new SourceFetchError(`${context} host is not allowed`, { kind: "permanent" });
  }
  return parsed;
}

async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SourceFetchError(`source exceeds ${maxBytes} bytes`, {
      kind: "permanent",
      code: "source_too_large",
    });
  }

  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      try {
        await response.body.cancel();
      } catch {
        // The stream may already be closed; the size error remains authoritative.
      }
      throw new SourceFetchError(`source exceeds ${maxBytes} bytes`, {
        kind: "permanent",
        code: "source_too_large",
      });
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function transientStatus(status) {
  return status === 429 || status >= 500;
}

function retryDelay(attempt, response) {
  const retryAfter = response?.headers?.get("retry-after");
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 2_000);
}

export async function fetchSource(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = options.retries ?? 2;
  const maxBytes = options.maxBytes ?? 262_144;
  const maxRedirects = options.maxRedirects ?? 3;

  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  const initialUrl = validateFetchUrl(url).href;
  let networkRequests = 0;
  let redirects = 0;
  let lastError;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    attemptsMade = attempt;
    let currentUrl = initialUrl;
    redirects = 0;
    try {
      while (true) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          networkRequests += 1;
          const response = await fetchImpl(currentUrl, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              accept: "text/plain, text/markdown;q=0.9, */*;q=0.1",
              "user-agent": "skillsmp-search-source-inspector/1",
            },
          });

          if (REDIRECT_STATUSES.has(response.status)) {
            if (redirects >= maxRedirects) {
              throw new SourceFetchError(`source exceeded ${maxRedirects} redirects`, {
                kind: "permanent",
                status: response.status,
              });
            }
            const location = response.headers.get("location");
            if (!location) {
              throw new SourceFetchError("source redirect is missing a location", {
                kind: "permanent",
                status: response.status,
              });
            }
            const next = new URL(location, currentUrl);
            validateFetchUrl(next.href, "redirect");
            try {
              await response.body?.cancel();
            } catch {
              // A redirect body is never used.
            }
            currentUrl = next.href;
            redirects += 1;
            continue;
          }

          if (!response.ok) {
            const kind = transientStatus(response.status) ? "transient" : "permanent";
            try {
              await response.body?.cancel();
            } catch {
              // The status remains the useful failure signal.
            }
            throw new SourceFetchError(`source request failed with HTTP ${response.status}`, {
              kind,
              status: response.status,
            });
          }

          const bytes = await readBoundedBody(response, maxBytes);
          return {
            bytes,
            url: currentUrl,
            status: response.status,
            etag: response.headers.get("etag"),
            lastModified: response.headers.get("last-modified"),
            attempts: attempt,
            networkRequests,
            redirects,
          };
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (error) {
      const aborted = error?.name === "AbortError";
      lastError = aborted
        ? new SourceFetchError(`source request timed out after ${timeoutMs} ms`, {
            kind: "transient",
            code: "timeout",
          })
        : error;
      const classification = classifyFetchFailure(lastError);
      if (classification.kind !== "transient" || attempt > retries) break;
      await sleepImpl(retryDelay(attempt, lastError?.response));
    }
  }

  if (lastError && typeof lastError === "object") {
    lastError.attempts ??= attemptsMade;
    lastError.networkRequests ??= networkRequests;
  }
  throw lastError;
}

export function classifyFetchFailure(error) {
  if (error?.kind === "permanent" || error?.kind === "transient") {
    return {
      kind: error.kind,
      status: error.status ?? null,
      code: error.code ?? null,
      message: error.message,
    };
  }
  if (error?.name === "AbortError" || error instanceof TypeError) {
    return {
      kind: "transient",
      status: null,
      code: error?.name === "AbortError" ? "timeout" : "network_error",
      message: error.message,
    };
  }
  return {
    kind: "permanent",
    status: error?.status ?? null,
    code: error?.code ?? "unknown_error",
    message: error?.message ?? String(error),
  };
}
