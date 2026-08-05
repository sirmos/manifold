import express from "express";
import { config } from "./lib/env.js";
import { db, collections } from "./lib/firestore.js";
import { publishEvent, topics, decodePushBody } from "./lib/pubsub.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const DEFAULT_TOLERANCE_PERCENT = 10;

// Reads the normal range for one asset. In a full build this would be
// learned from months of history. For this submission it is a simple
// document you seed by hand with scripts/seed_baseline.js.
async function getBaseline(assetId) {
  const doc = await db.collection(collections.baselines).doc(assetId).get();
  if (doc.exists) {
    return doc.data();
  }
  // No baseline yet. Return an empty one so the pipeline still runs,
  // but nothing will be flagged until the asset is set up properly.
  return {
    assetId,
    efficiencyBaseline: null,
    pressureBaseline: null,
    temperatureBaseline: null,
    tolerancePercent: DEFAULT_TOLERANCE_PERCENT,
    seeded: false,
  };
}

// How far below (or above) a baseline a value sits, as a percent.
// A positive number means the value is below the baseline.
function percentBelowBaseline(value, baseline) {
  if (value === null || value === undefined || !baseline) return 0;
  return ((baseline - value) / baseline) * 100;
}

// Compares one reading to the asset's baseline and returns a list of
// anything that looks off. An empty list means the reading looks normal.
function checkForAnomalies(metrics, baseline) {
  const issues = [];
  const tolerance = baseline.tolerancePercent ?? DEFAULT_TOLERANCE_PERCENT;

  if (baseline.efficiencyBaseline) {
    const drop = percentBelowBaseline(metrics.efficiency, baseline.efficiencyBaseline);
    if (drop > tolerance) {
      issues.push({
        metric: "efficiency",
        value: metrics.efficiency,
        baseline: baseline.efficiencyBaseline,
        percentBelowBaseline: Number(drop.toFixed(1)),
      });
    }
  }

  if (baseline.pressureBaseline) {
    const off = percentBelowBaseline(metrics.pressure, baseline.pressureBaseline);
    if (Math.abs(off) > tolerance) {
      issues.push({
        metric: "pressure",
        value: metrics.pressure,
        baseline: baseline.pressureBaseline,
        percentOffBaseline: Number(off.toFixed(1)),
      });
    }
  }

  if (baseline.temperatureBaseline) {
    const rise = -percentBelowBaseline(metrics.temperature, baseline.temperatureBaseline);
    if (rise > tolerance) {
      issues.push({
        metric: "temperature",
        value: metrics.temperature,
        baseline: baseline.temperatureBaseline,
        percentAboveBaseline: Number(rise.toFixed(1)),
      });
    }
  }

  return issues;
}

async function handleReadingStored({ assetId, readingId }) {
  const readingDoc = await db.collection(collections.readings).doc(readingId).get();
  if (!readingDoc.exists) {
    throw new Error(`Reading ${readingId} was not found`);
  }
  const reading = readingDoc.data();

  const baseline = await getBaseline(assetId);
  const issues = checkForAnomalies(reading.metrics, baseline);

  await db.collection(collections.readings).doc(readingId).update({
    checkedAt: new Date().toISOString(),
    anomalyIssues: issues,
  });

  if (issues.length > 0) {
    console.log(`Anomaly found for ${assetId} on reading ${readingId}:`, issues);
    await publishEvent(topics.anomalyDetected, { assetId, readingId, issues });
  } else {
    console.log(`Reading ${readingId} for ${assetId} looks normal.`);
  }

  return { assetId, readingId, issues };
}

app.get("/", (_req, res) => {
  res.json({ agent: "monitor", status: "ready" });
});

// Real entry point once this is wired to a push subscription on the
// reading-stored topic.
app.post("/pubsub", async (req, res) => {
  try {
    const payload = decodePushBody(req.body);
    await handleReadingStored(payload);
    res.status(204).send();
  } catch (err) {
    console.error("Failed to handle Pub/Sub push:", err);
    res.status(500).send();
  }
});

// Plain HTTP endpoint for local testing.
app.post("/ingest", async (req, res) => {
  try {
    const result = await handleReadingStored(req.body);
    res.json(result);
  } catch (err) {
    console.error("Failed to handle local ingest:", err);
    res.status(400).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`Operations Monitoring Agent listening on port ${config.port}`);
});
