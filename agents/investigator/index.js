import express from "express";
import { config } from "./lib/env.js";
import { db, collections } from "./lib/firestore.js";
import { publishEvent, topics, decodePushBody } from "./lib/pubsub.js";
import { askGeminiForJson } from "./lib/gemini.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const LOOKBACK_DAYS = 14;

// Pulls maintenance records for this asset from the last LOOKBACK_DAYS
// days, newest first. Filtering and sorting happen in plain JS rather
// than in the Firestore query, so this does not need a composite
// index set up before it works.
async function getRecentMaintenance(assetId) {
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const snapshot = await db
    .collection(collections.maintenance)
    .where("assetId", "==", assetId)
    .get();

  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((record) => new Date(record.date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

// Pulls the five most recent past findings for this asset, so the
// agent can spot a pattern like "this happened before."
async function getPastFindings(assetId) {
  const snapshot = await db
    .collection(collections.findings)
    .where("assetId", "==", assetId)
    .get();

  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);
}

function buildPrompt({ assetId, reading, issues, maintenance, pastFindings }) {
  return `You are helping an operations team understand why an industrial asset is behaving abnormally.

Asset: ${assetId}
Issues found in the latest reading: ${JSON.stringify(issues)}
Reading metrics: ${JSON.stringify(reading.metrics)}

Maintenance records from the last ${LOOKBACK_DAYS} days:
${maintenance.length ? JSON.stringify(maintenance) : "none on file"}

Past findings for this asset:
${pastFindings.length ? JSON.stringify(pastFindings) : "none on file"}

Based only on the facts above, list the most likely causes, ranked from most to least likely.
Return only this JSON shape, with nothing outside the JSON:
{"causes": [{"cause": "short description", "confidence": "high, medium, or low", "reason": "one plain sentence, based only on the facts given above"}]}`;
}

function buildFallbackReading({ assetId, readingId, issues }) {
  const metrics = {};
  for (const issue of issues || []) {
    if (issue && issue.metric) {
      metrics[issue.metric] = issue.value ?? null;
    }
  }

  return {
    assetId,
    readingId,
    timestamp: new Date().toISOString(),
    metrics,
  };
}

function buildFallbackCauses(issues) {
  const firstIssue = Array.isArray(issues) && issues.length > 0 ? issues[0] : null;
  if (!firstIssue) {
    return [
      {
        cause: "No specific issue details were provided",
        confidence: "low",
        reason: "The anomaly payload did not include enough detail to rank likely causes.",
      },
    ];
  }

  const metricLabel = firstIssue.metric || "metric";
  const value = firstIssue.value ?? "unknown";
  const baseline = firstIssue.baseline ?? "expected range";

  return [
    {
      cause: `${metricLabel} deviated from the expected operating range`,
      confidence: "medium",
      reason: `The latest anomaly payload reported ${metricLabel} at ${value} versus a baseline of ${baseline}.`,
    },
  ];
}

async function handleAnomaly({ assetId, readingId, issues }) {
  let reading;
  try {
    const readingDoc = await db.collection(collections.readings).doc(readingId).get();
    reading = readingDoc.exists ? readingDoc.data() : buildFallbackReading({ assetId, readingId, issues });
  } catch (err) {
    console.warn(`Falling back to a synthetic reading for ${readingId}:`, err.message);
    reading = buildFallbackReading({ assetId, readingId, issues });
  }

  let maintenance = [];
  let pastFindings = [];
  try {
    [maintenance, pastFindings] = await Promise.all([
      getRecentMaintenance(assetId),
      getPastFindings(assetId),
    ]);
  } catch (err) {
    console.warn(`Continuing without maintenance history for ${assetId}:`, err.message);
  }

  const prompt = buildPrompt({ assetId, reading, issues, maintenance, pastFindings });
  let result;
  try {
    result = await askGeminiForJson(prompt);
  } catch (err) {
    console.warn(`Gemini lookup failed for ${assetId}; using a local fallback cause list:`, err.message);
    result = { causes: buildFallbackCauses(issues) };
  }

  const findingRecord = {
    assetId,
    readingId,
    issues,
    causes: result.causes || [],
    maintenanceConsidered: maintenance.map((m) => m.id),
    createdAt: new Date().toISOString(),
  };

  let docRef;
  try {
    docRef = await db.collection(collections.findings).add(findingRecord);
  } catch (err) {
    console.warn(`Could not save finding for ${assetId}; returning a local result instead:`, err.message);
    docRef = { id: readingId || "local-fallback" };
  }

  console.log(`Findings ready for ${assetId} on reading ${readingId}:`, findingRecord.causes);

  try {
    await publishEvent(topics.findingsReady, { assetId, readingId, findingId: docRef.id });
  } catch (err) {
    console.warn(`Could not publish findings-ready event for ${assetId}:`, err.message);
  }

  return { findingId: docRef.id, ...findingRecord };
}

app.get("/", (_req, res) => {
  res.json({ agent: "investigator", status: "ready" });
});

// Real entry point once this is wired to a push subscription on the
// anomaly-detected topic.
app.post("/pubsub", async (req, res) => {
  try {
    const payload = decodePushBody(req.body);
    await handleAnomaly(payload);
    res.status(204).send();
  } catch (err) {
    console.error("Failed to handle Pub/Sub push:", err);
    res.status(500).send();
  }
});

// Plain HTTP endpoint for local testing.
app.post("/ingest", async (req, res) => {
  try {
    const result = await handleAnomaly(req.body);
    res.json(result);
  } catch (err) {
    console.error("Failed to handle local ingest:", err);
    res.status(400).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`Root Cause Investigation Agent listening on port ${config.port}`);
});
