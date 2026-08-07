import express from "express";
import { config } from "./lib/env.js";
import { db, collections } from "./lib/firestore.js";
import { publishEvent, topics, decodePushBody } from "./lib/pubsub.js";
import { askGeminiForJson } from "./lib/gemini.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const LOOKBACK_DAYS = 14;

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
Do not just repeat the numbers from the issue. Your job is to explain what likely caused it, using the maintenance records and past findings below.

Asset: ${assetId}
Issues found in the latest reading: ${JSON.stringify(issues)}
Reading metrics: ${JSON.stringify(reading.metrics)}

Maintenance records from the last ${LOOKBACK_DAYS} days, most recent first:
${maintenance.length ? JSON.stringify(maintenance) : "none on file, so a maintenance link cannot be the cause"}

Past findings for this asset:
${pastFindings.length ? JSON.stringify(pastFindings) : "none on file"}

Based only on the facts above, list the most likely causes, ranked from most to least likely.
If a maintenance record's date lines up with the timing of this issue, name that record directly in the reason, with its date and description. If nothing on file explains it, say so plainly instead of guessing.
Do not write a reason that only restates that the metric is off from its baseline. That much is already known.
Return only this JSON shape, with nothing outside the JSON:
{"causes": [{"cause": "short description", "confidence": "high, medium, or low", "reason": "one or two plain sentences, naming a specific maintenance record or past finding when it explains the timing"}]}`;
}

async function handleAnomaly({ assetId, readingId, issues }) {
  const readingDoc = await db.collection(collections.readings).doc(readingId).get();
  if (!readingDoc.exists) {
    throw new Error(`Reading ${readingId} was not found`);
  }
  const reading = readingDoc.data();

  const [maintenance, pastFindings] = await Promise.all([
    getRecentMaintenance(assetId),
    getPastFindings(assetId),
  ]);

  const prompt = buildPrompt({ assetId, reading, issues, maintenance, pastFindings });
  const result = await askGeminiForJson(prompt);

  const findingRecord = {
    assetId,
    readingId,
    issues,
    causes: result.causes || [],
    maintenanceConsidered: maintenance.map((m) => m.id),
    createdAt: new Date().toISOString(),
  };

  const docRef = await db.collection(collections.findings).add(findingRecord);

  console.log(`Findings ready for ${assetId} on reading ${readingId}:`, findingRecord.causes);

  await publishEvent(topics.findingsReady, { assetId, readingId, findingId: docRef.id });

  return { findingId: docRef.id, ...findingRecord };
}

app.get("/", (_req, res) => {
  res.json({ agent: "investigator", status: "ready" });
});

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
