import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeCandidate,
  classifyFetchFailure,
  fetchSource,
  resolveSourceUrl,
} from "../skills/skillsmp-search/scripts/inspection/source.mjs";

function response(body, init = {}) {
  return new Response(body, init);
}

test("tree URL resolves to one canonical raw SKILL.md", () => {
  const candidate = canonicalizeCandidate({
    id: "x",
    githubUrl: "https://github.com/Owner/Repo/tree/main/skills/demo/",
  });

  assert.equal(candidate.canonicalKey, "github.com/owner/repo/skills/demo");
  assert.equal(candidate.owner, "Owner");
  assert.equal(candidate.repository, "Repo");
  assert.equal(candidate.requestedRef, "main");
  assert.equal(candidate.skillPath, "skills/demo");
  assert.equal(
    resolveSourceUrl(candidate),
    "https://raw.githubusercontent.com/Owner/Repo/main/skills/demo/SKILL.md",
  );
});

test("blob and raw URLs normalize a terminal SKILL.md", () => {
  const blob = canonicalizeCandidate({
    githubUrl: "https://github.com/Owner/Repo/blob/main/skills/demo/SKILL.md",
  });
  const raw = canonicalizeCandidate({
    githubUrl: "https://raw.githubusercontent.com/Owner/Repo/main/skills/demo/SKILL.md",
  });

  assert.equal(blob.canonicalKey, raw.canonicalKey);
  assert.equal(blob.skillPath, "skills/demo");
  assert.equal(raw.skillPath, "skills/demo");
});

test("repository root resolves through HEAD", () => {
  const candidate = canonicalizeCandidate({
    githubUrl: "https://github.com/Owner/Repo",
  });

  assert.equal(candidate.requestedRef, "HEAD");
  assert.equal(candidate.skillPath, "");
  assert.equal(
    resolveSourceUrl(candidate),
    "https://raw.githubusercontent.com/Owner/Repo/HEAD/SKILL.md",
  );
});

test("canonicalizeCandidate rejects non-GitHub and non-HTTPS sources", () => {
  assert.throws(
    () => canonicalizeCandidate({ githubUrl: "http://github.com/o/r" }),
    /HTTPS GitHub URL/,
  );
  assert.throws(
    () => canonicalizeCandidate({ githubUrl: "https://example.com/o/r" }),
    /unsupported GitHub host/,
  );
});

test("fetchSource rejects redirects outside approved GitHub hosts", async () => {
  const fetchImpl = async () =>
    response(null, {
      status: 302,
      headers: { location: "https://example.com/SKILL.md" },
    });

  await assert.rejects(
    fetchSource("https://raw.githubusercontent.com/o/r/main/SKILL.md", {
      fetchImpl,
      timeoutMs: 50,
      retries: 0,
      maxBytes: 1024,
    }),
    /redirect host is not allowed/,
  );
});

test("fetchSource follows a bounded GitHub redirect", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return response(null, {
        status: 302,
        headers: {
          location: "https://raw.githubusercontent.com/o/r/main/SKILL.md",
        },
      });
    }
    return response("skill source", { status: 200, headers: { etag: "abc" } });
  };

  const result = await fetchSource("https://github.com/o/r/raw/main/SKILL.md", {
    fetchImpl,
    timeoutMs: 50,
    retries: 0,
    maxBytes: 1024,
  });

  assert.equal(result.bytes.toString("utf8"), "skill source");
  assert.equal(result.networkRequests, 2);
  assert.equal(result.redirects, 1);
  assert.equal(result.etag, "abc");
});

test("fetchSource retries transient responses and stops on success", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return attempts === 1
      ? response("busy", { status: 503 })
      : response("ok", { status: 200 });
  };

  const result = await fetchSource(
    "https://raw.githubusercontent.com/o/r/main/SKILL.md",
    {
      fetchImpl,
      sleepImpl: async () => {},
      timeoutMs: 50,
      retries: 2,
      maxBytes: 1024,
    },
  );

  assert.equal(attempts, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.networkRequests, 2);
});

test("fetchSource timeout covers a stalled response body", async () => {
  const fetchImpl = async (_url, options) => {
    const body = new ReadableStream({
      start(controller) {
        options.signal.addEventListener("abort", () => {
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
    });
    return new Response(body, { status: 200 });
  };

  await assert.rejects(
    fetchSource("https://raw.githubusercontent.com/o/r/main/SKILL.md", {
      fetchImpl,
      timeoutMs: 10,
      retries: 0,
      maxBytes: 1024,
    }),
    (error) => classifyFetchFailure(error).code === "timeout",
  );
});

test("fetchSource classifies permanent missing and oversized files", async () => {
  await assert.rejects(
    fetchSource("https://raw.githubusercontent.com/o/r/main/SKILL.md", {
      fetchImpl: async () => response("missing", { status: 404 }),
      timeoutMs: 50,
      retries: 2,
      maxBytes: 1024,
    }),
    (error) => classifyFetchFailure(error).kind === "permanent",
  );

  await assert.rejects(
    fetchSource("https://raw.githubusercontent.com/o/r/main/SKILL.md", {
      fetchImpl: async () => response("12345", { status: 200 }),
      timeoutMs: 50,
      retries: 0,
      maxBytes: 4,
    }),
    /exceeds 4 bytes/,
  );
});
