import express from "express";
import { parse } from "csv-parse/sync";
import { config } from "./lib/env.js";
import { db, collections } from "./lib/firestore.js";
import { publishEvent, topics, decodePushBody } from "./lib/pubsub.js";
import { askGeminiForJson, askGeminiForJsonWithImage } from "./lib/gemini.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

const REQUIRED_METRICS = ["efficiency", "pressure", "temperature"];

// Turns a CSV reading into a plain object with the fields we care
// about. Expects a header row with columns like timestamp, efficiency,
// pressure, temperature.
function readFromCsv(csvText) {
  const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  if (rows.length === 0) {
    throw new Error("CSV had no data rows");
  }
  // Take the most recent row if more than one was sent.
  const row = rows[rows.length - 1];
  return {
    timestamp: row.timestamp,
    efficiency: Number(row.efficiency),
    pressure: Number(row.pressure),
    temperature: Number(row.temperature),
  };
}

// Uses Gemini to read a photo of a field logbook page and pull out
// the same fields a clean CSV row would have.
async function readFromPhoto(imageBase64, mimeType) {
  const prompt = `This is a photo of a handwritten or printed field logbook page from an industrial site.
Find the most recent compressor reading on the page and return only this JSON shape, with numbers as plain numbers, not strings:
{"timestamp": "ISO 8601 date and time, guess the year if not shown", "efficiency": number (percent), "pressure": number (kPa), "temperature": number (Celsius)}
If a value is not on the page, use null for that field. Do not add any explanation, only the JSON.`;
  return askGeminiForJsonWithImage(prompt, imageBase64, mimeType);
}

// Basic checks so a bad reading gets flagged instead of silently
// stored as if it were normal data.
function validate(reading) {
  const flags = [];
  for (const field of REQUIRED_METRICS) {
    const value = reading[field];
    if (value === null || value === undefined || Number.isNaN(value)) {
      flags.push(`missing_${field}`);
    }
  }
  if (reading.temperature !== undefined && reading.temperature !== null) {
    if (reading.temperature < -50 || reading.temperature > 200) {
      flags.push("temperature_out_of_plausible_range");
    }
  }
  if (reading.efficiency !== undefined && reading.efficiency !== null) {
    if (reading.efficiency < 0 || reading.efficiency > 100) {
      flags.push("efficiency_out_of_plausible_range");
    }
  }
  return flags;
}

// The main pipeline step: turn a raw payload into a clean, saved
// reading, and let the next agent know it is ready.
async function handleReading(payload) {
  const { assetId, source } = payload;
  if (!assetId) {
    throw new Error("payload.assetId is required");
  }

  let reading;
  if (source === "csv") {
    reading = readFromCsv(payload.csvText);
  } else if (source === "photo") {
    reading = await readFromPhoto(payload.imageBase64, payload.imageMimeType || "image/jpeg");
  } else if (source === "manual") {
    reading = payload.fields;
  } else {
    throw new Error(`Unknown source type: ${source}`);
  }

  const flags = validate(reading);

  const record = {
    assetId,
    source,
    timestamp: reading.timestamp || new Date().toISOString(),
    metrics: {
      efficiency: reading.efficiency ?? null,
      pressure: reading.pressure ?? null,
      temperature: reading.temperature ?? null,
    },
    flags,
    receivedAt: new Date().toISOString(),
  };

  const docRef = await db.collection(collections.readings).add(record);

  if (flags.length > 0) {
    console.warn(`Reading ${docRef.id} for ${assetId} saved with flags:`, flags);
  }

  await publishEvent(topics.readingStored, { assetId, readingId: docRef.id });

  return { readingId: docRef.id, ...record };
}

app.get("/", (_req, res) => {
  res.json({ agent: "collector", status: "ready" });
});

// Real entry point once this is deployed and wired to a Pub/Sub
// push subscription on the new-reading topic.
app.post("/pubsub", async (req, res) => {
  try {
    const payload = decodePushBody(req.body);
    const result = await handleReading(payload);
    console.log(`Stored reading ${result.readingId} for ${result.assetId}`);
    res.status(204).send();
  } catch (err) {
    console.error("Failed to handle Pub/Sub push:", err);
    // Returning 200 here would tell Pub/Sub the message was handled
    // when it was not, so a real failure is reported as an error.
    res.status(500).send();
  }
});

// A plain HTTP endpoint for local testing, so you can try the agent
// without setting up a Pub/Sub push subscription first.
app.post("/ingest", async (req, res) => {
  try {
    const result = await handleReading(req.body);
    res.json(result);
  } catch (err) {
    console.error("Failed to handle local ingest:", err);
    res.status(400).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`Data Collection Agent listening on port ${config.port}`);
});
