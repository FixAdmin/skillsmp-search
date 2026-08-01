export const REVIEW_INDEX_VERSION = "review-index-v1";

function truncate(value, limit) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function diverseEvidence(evidence, limit) {
  const selected = [];
  const used = new Set();
  for (const item of evidence) {
    if (!used.has(item.category)) {
      selected.push(item);
      used.add(item.category);
    }
    if (selected.length === limit) return selected;
  }
  for (const item of evidence) {
    if (!selected.includes(item)) selected.push(item);
    if (selected.length === limit) break;
  }
  return selected.map((item) => ({
    category: item.category,
    lineStart: item.lineStart,
    lineEnd: item.lineEnd,
    excerpt: truncate(item.excerpt, 180),
  }));
}

export function buildReviewEntry(result, options = {}) {
  const maxEntryChars = options.maxEntryChars ?? 1_800;
  const success = result.status === "success" && result.capsule;
  const capsule = result.capsule ?? {};
  const entry = {
    canonicalKey: result.canonicalKey,
    name: result.name ?? capsule.candidate?.name ?? null,
    status: result.status,
    description: success ? truncate(capsule.candidate?.description, 360) : "",
    source: success ? capsule.source : null,
    coverage: success ? capsule.coverage : null,
    sections: success
      ? capsule.headings.slice(0, options.maxHeadings ?? 8).map((item) => ({
          text: truncate(item.text, 100),
          lineStart: item.lineStart,
          lineEnd: item.lineEnd,
        }))
      : [],
    workflow: success
      ? capsule.workflow.slice(0, options.maxWorkflow ?? 6).map((item) => ({
          text: truncate(item.text, 140),
          lineStart: item.lineStart,
          lineEnd: item.lineEnd,
        }))
      : [],
    signals: success ? capsule.signals : {},
    evidence: success
      ? diverseEvidence(capsule.evidence ?? [], options.maxEvidence ?? 6)
      : [],
    warnings: success ? (capsule.warnings ?? []).slice(0, 6) : [],
    failure: success ? null : result.failure ?? null,
    expand: {
      capsule: result.artifacts?.capsule ?? null,
      source: result.artifacts?.sourceObject ?? null,
    },
  };

  const trimTargets = ["evidence", "workflow", "sections", "warnings"];
  while (JSON.stringify(entry).length > maxEntryChars) {
    const target = trimTargets.find((key) => entry[key].length > 0);
    if (!target) break;
    entry[target].pop();
  }
  if (JSON.stringify(entry).length > maxEntryChars) {
    entry.description = truncate(entry.description, 100);
    entry.signals = {};
  }
  if (JSON.stringify(entry).length > maxEntryChars) {
    throw new RangeError(`review entry cannot fit within ${maxEntryChars} characters`);
  }
  return entry;
}

export function buildReviewIndex(inspectionOutput, options = {}) {
  const canonicalCandidates = inspectionOutput.metrics?.canonicalCandidates ?? 0;
  const successes = inspectionOutput.metrics?.successes ?? 0;
  const terminalFailures = inspectionOutput.metrics?.terminalFailures ?? 0;
  if (successes + terminalFailures !== canonicalCandidates) {
    throw new Error("review index requires a complete inspection invariant");
  }
  return {
    version: REVIEW_INDEX_VERSION,
    status: inspectionOutput.status,
    summary: `Review ${successes} source capsules; account for ${terminalFailures} terminal failures.`,
    next_actions: [
      "review every compact entry",
      "expand full capsules for plausible or uncertain candidates",
      "record semantic method delta separately",
    ],
    artifacts: inspectionOutput.artifacts,
    metrics: { canonicalCandidates, successes, terminalFailures },
    entries: inspectionOutput.candidates.map((result) => buildReviewEntry(result, options)),
  };
}
