import { createHash } from "node:crypto";

export const EXTRACTOR_VERSION = "facts-v2";
export const CAPSULE_VERSION = "capsule-v2";

const UNICODE_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const SIGNAL_TERMS = {
  validation: ["assert", "check", "eval", "evaluate", "test", "validate", "verify"],
  recovery: ["error", "fallback", "recover", "retry", "rollback", "stop"],
  checkpoint: ["checkpoint", "persist", "resume", "state"],
  sideEffects: ["delete", "execute", "install", "publish", "run", "send", "upload", "write"],
};
const TOOL_NAMES = [
  "bash",
  "bun",
  "curl",
  "docker",
  "git",
  "github",
  "gh",
  "node",
  "npm",
  "npx",
  "pnpm",
  "powershell",
  "python",
  "python3",
  "ruby",
  "uv",
  "wget",
  "yarn",
];

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function truncate(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function normalizeSourceText(value) {
  const original = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  const unicodeControls = [];
  for (const match of original.matchAll(UNICODE_CONTROLS)) {
    unicodeControls.push({ codePoint: `U+${match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`, index: match.index });
  }
  return {
    text: original.replace(/\r\n?/g, "\n"),
    changedLineEndings: /\r/.test(original),
    hadNul: original.includes("\0"),
    unicodeControls,
  };
}

function textSha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(lines) {
  if (lines[0]?.trim() !== "---") {
    return { data: {}, raw: "", endLine: 0, warnings: [] };
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) {
    return {
      data: {},
      raw: lines.join("\n"),
      endLine: 0,
      warnings: ["frontmatter_opening_without_closing_delimiter"],
    };
  }

  const data = {};
  const warnings = [];
  let listKey = null;
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (listItem && listKey) {
      data[listKey].push(parseScalar(listItem[1]));
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))$/);
    if (!pair || /^\s/.test(line)) {
      warnings.push(`unsupported_frontmatter_line:${index + 1}`);
      listKey = null;
      continue;
    }
    const [, key, rawValue] = pair;
    if (rawValue === "") {
      data[key] = [];
      listKey = key;
    } else if (["|", ">"].includes(rawValue.trim()) || rawValue.trim().startsWith("{")) {
      warnings.push(`unsupported_frontmatter_value:${index + 1}`);
      data[key] = rawValue.trim();
      listKey = null;
    } else {
      data[key] = parseScalar(rawValue);
      listKey = null;
    }
  }
  return {
    data,
    raw: lines.slice(0, closing + 1).join("\n"),
    endLine: closing + 1,
    warnings,
  };
}

function matchedTerms(line, terms) {
  const lower = line.toLowerCase();
  return terms.filter((term) => new RegExp(`\\b${term}(?:s|ed|ing)?\\b`, "i").test(lower));
}

function findRelativeFiles(line) {
  const values = [];
  const markdownLink = /\]\((?!https?:|#|mailto:)([^)\s]+)\)/gi;
  const inlinePath = /`((?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)`/g;
  for (const match of line.matchAll(markdownLink)) values.push(match[1]);
  for (const match of line.matchAll(inlinePath)) values.push(match[1]);
  return values;
}

export function extractFacts(sourceText) {
  const normalized = normalizeSourceText(sourceText);
  const lines = normalized.text.split("\n");
  const frontmatter = parseFrontmatter(lines);
  const headings = [];
  const codeBlocks = [];
  const workflow = [];
  const environmentVariables = [];
  const urls = [];
  const relativeFiles = [];
  const tools = [];
  const signals = Object.fromEntries(Object.keys(SIGNAL_TERMS).map((key) => [key, []]));
  const evidenceCandidates = [];
  let openFence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const fence = line.match(/^\s*(```+|~~~+)\s*([^\s`]*)/);
    if (fence) {
      if (!openFence) {
        openFence = { marker: fence[1][0], length: fence[1].length, language: fence[2] || "", lineStart: lineNumber };
      } else if (fence[1][0] === openFence.marker && fence[1].length >= openFence.length) {
        codeBlocks.push({ language: openFence.language, lineStart: openFence.lineStart, lineEnd: lineNumber });
        openFence = null;
      }
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      headings.push({ level: heading[1].length, text: heading[2], lineStart: lineNumber, lineEnd: lineNumber });
      evidenceCandidates.push({ category: "heading", lineStart: lineNumber, lineEnd: lineNumber, excerpt: line.trim() });
    }

    const step = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (step) {
      workflow.push({ number: Number(step[1]), text: step[2].trim(), lineStart: lineNumber, lineEnd: lineNumber });
      evidenceCandidates.push({ category: "workflow", lineStart: lineNumber, lineEnd: lineNumber, excerpt: line.trim() });
    }

    for (const [category, terms] of Object.entries(SIGNAL_TERMS)) {
      const matches = matchedTerms(line, terms);
      signals[category].push(...matches);
      if (matches.length > 0) {
        evidenceCandidates.push({ category, lineStart: lineNumber, lineEnd: lineNumber, excerpt: line.trim() });
      }
    }

    for (const name of TOOL_NAMES) {
      if (new RegExp(`\\b${name}\\b`, "i").test(line)) tools.push(name);
    }
    for (const match of line.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) environmentVariables.push(match[0]);
    for (const match of line.matchAll(/https?:\/\/[^\s)>\]"']+/g)) urls.push(match[0].replace(/[.,;:]$/, ""));
    relativeFiles.push(...findRelativeFiles(line));
  }

  if (openFence) {
    codeBlocks.push({ language: openFence.language, lineStart: openFence.lineStart, lineEnd: lines.length, unclosed: true });
  }
  for (let index = 0; index < headings.length; index += 1) {
    headings[index].lineEnd = (headings[index + 1]?.lineStart ?? lines.length + 1) - 1;
  }
  for (const key of Object.keys(signals)) signals[key] = uniqueSorted(signals[key]);

  const warnings = [...frontmatter.warnings];
  if (normalized.hadNul) warnings.push("nul_byte_present");
  if (normalized.unicodeControls.length) warnings.push("unicode_directional_controls_present");
  if (codeBlocks.some((block) => block.unclosed)) warnings.push("unclosed_code_fence");

  return {
    extractorVersion: EXTRACTOR_VERSION,
    frontmatter: frontmatter.data,
    frontmatterRaw: frontmatter.raw,
    headings,
    codeBlocks,
    workflow,
    tools: uniqueSorted(tools),
    environmentVariables: uniqueSorted(environmentVariables),
    urls: uniqueSorted(urls),
    relativeFiles: uniqueSorted(relativeFiles),
    signals,
    warnings,
    controls: {
      hadNul: normalized.hadNul,
      unicodeControls: normalized.unicodeControls,
    },
    coverage: {
      fullFileScanned: true,
      normalizedLineEndings: normalized.changedLineEndings,
      lineCount: lines.length,
      characterCount: normalized.text.length,
      normalizedTextSha256: textSha256(normalized.text),
      frontmatterEndLine: frontmatter.endLine,
    },
    evidenceCandidates: evidenceCandidates.slice(0, 1_024),
    omittedEvidenceCandidates: Math.max(0, evidenceCandidates.length - 1_024),
  };
}

function candidateSummary(candidate) {
  return {
    id: truncate(candidate.id, 200),
    name: truncate(candidate.name, 240),
    author: truncate(candidate.author, 160),
    description: truncate(candidate.description, 800),
    githubUrl: truncate(candidate.githubUrl ?? candidate.sourceUrl, 800),
    canonicalKey: truncate(candidate.canonicalKey, 800),
    matchedQueries: Array.isArray(candidate.matchedQueries)
      ? candidate.matchedQueries.slice(0, 20).map((item) => truncate(item, 120))
      : [],
  };
}

function selectEvidence(facts, maxEvidence, excerptChars) {
  const priority = { sideEffects: 0, recovery: 1, validation: 2, checkpoint: 3, workflow: 4, heading: 5 };
  const byLine = new Map();
  for (const item of facts.evidenceCandidates) {
    const key = `${item.lineStart}:${item.lineEnd}`;
    const existing = byLine.get(key);
    if (!existing || (priority[item.category] ?? 9) < (priority[existing.category] ?? 9)) {
      byLine.set(key, item);
    }
  }
  return [...byLine.values()]
    .sort((left, right) => (priority[left.category] ?? 9) - (priority[right.category] ?? 9) || left.lineStart - right.lineStart)
    .slice(0, maxEvidence)
    .map((item) => ({ ...item, excerpt: truncate(item.excerpt, excerptChars) }));
}

export function buildCapsule(candidate, facts, options = {}) {
  const maxEvidence = options.maxEvidence ?? 16;
  const excerptChars = options.excerptChars ?? 240;
  const maxChars = options.maxChars ?? 12_000;
  const evidence = selectEvidence(facts, maxEvidence, excerptChars);
  const uniqueEvidenceLines = new Set(facts.evidenceCandidates.map((item) => `${item.lineStart}:${item.lineEnd}`)).size;
  const capsule = {
    capsuleVersion: CAPSULE_VERSION,
    trust: "untrusted_source_data",
    candidate: candidateSummary(candidate),
    source: {
      sourceSha256: candidate.sourceSha256 ?? null,
      requestedRef: candidate.requestedRef ?? null,
      snapshotStrength: /^[0-9a-f]{40}$/i.test(candidate.requestedRef ?? "")
        ? "commit_pinned"
        : "content_frozen",
    },
    coverage: facts.coverage,
    frontmatter: facts.frontmatter,
    headings: facts.headings.slice(0, 60),
    workflow: facts.workflow.slice(0, 60),
    codeBlocks: facts.codeBlocks.slice(0, 40),
    tools: facts.tools.slice(0, 60),
    environmentVariables: facts.environmentVariables.slice(0, 60),
    urls: facts.urls.slice(0, 60),
    relativeFiles: facts.relativeFiles.slice(0, 60),
    signals: facts.signals,
    warnings: facts.warnings,
    evidence,
    omitted: {
      evidence: facts.omittedEvidenceCandidates + Math.max(0, uniqueEvidenceLines - evidence.length),
      headings: Math.max(0, facts.headings.length - 60),
      workflow: Math.max(0, facts.workflow.length - 60),
      codeBlocks: Math.max(0, facts.codeBlocks.length - 40),
      tools: Math.max(0, facts.tools.length - 60),
      environmentVariables: Math.max(0, facts.environmentVariables.length - 60),
      urls: Math.max(0, facts.urls.length - 60),
      relativeFiles: Math.max(0, facts.relativeFiles.length - 60),
    },
  };

  const trimTargets = [
    "evidence",
    "workflow",
    "headings",
    "urls",
    "relativeFiles",
    "codeBlocks",
    "environmentVariables",
    "tools",
  ];
  while (JSON.stringify(capsule).length > maxChars) {
    const target = trimTargets.find((key) => capsule[key].length > 0);
    if (!target) break;
    capsule[target].pop();
    if (target in capsule.omitted) capsule.omitted[target] += 1;
    if (target === "evidence") capsule.omitted.evidence += 1;
  }

  if (JSON.stringify(capsule).length > maxChars) {
    capsule.candidate.description = truncate(capsule.candidate.description, 120);
    capsule.frontmatter = {};
    capsule.signals = Object.fromEntries(Object.entries(capsule.signals).map(([key, values]) => [key, values.slice(0, 8)]));
    capsule.warnings = capsule.warnings.slice(0, 8);
  }
  if (JSON.stringify(capsule).length > maxChars) {
    throw new RangeError(`capsule metadata cannot fit within ${maxChars} characters`);
  }
  return capsule;
}
