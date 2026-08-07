import express from "express";
import { config } from "./lib/env.js";
import { db, collections } from "./lib/firestore.js";
import { decodePushBody } from "./lib/pubsub.js";
import { askGemini } from "./lib/gemini.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Plain, template-based summary. Used if Gemini is not reachable yet
// (for example, before billing is set up), so a report still goes
// out either way.
function buildFallbackSummary({ assetId, reading, causes }) {
  const lines = [];
  lines.push(`Manifold report for ${assetId}`);
  lines.push("");
  lines.push("Latest reading:");
  lines.push(`  Efficiency: ${reading.metrics.efficiency}`);
  lines.push(`  Pressure: ${reading.metrics.pressure}`);
  lines.push(`  Temperature: ${reading.metrics.temperature}`);
  lines.push("");
  if (causes.length > 0) {
    lines.push("Likely cause:");
    for (const cause of causes) {
      lines.push(`  ${cause.cause} (${cause.confidence} confidence)`);
      lines.push(`  ${cause.reason}`);
    }
  } else {
    lines.push("No specific cause was found on file yet.");
  }
  return lines.join("\n");
}

// Asks Gemini to turn the raw finding into a short, plain report.
// Falls back to a template if Gemini is not reachable, so a report
// still goes out either way.
async function composeSummary({ assetId, reading, causes }) {
  const prompt = `Write a short report for an operations manager about an industrial asset.
Asset: ${assetId}
Reading: ${JSON.stringify(reading.metrics)}
Likely causes, most likely first: ${JSON.stringify(causes)}

Write four to six plain sentences, no headers, no bullet points. Say what is happening, the most likely cause and why, and one clear next step. Do not use technical jargon a non-engineer would not understand.`;

  try {
    return await askGemini(prompt);
  } catch (err) {
    console.warn("Gemini summary failed, sending a plain-text report instead:", err.message);
    return buildFallbackSummary({ assetId, reading, causes });
  }
}

async function sendTelegram(text) {
  if (!config.telegramToken || !config.telegramChatId) {
    console.warn("Telegram is not configured. Skipping send.");
    return { sent: false, reason: "not_configured" };
  }
  const url = `https://api.telegram.org/bot${config.telegramToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.telegramChatId, text }),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram send failed: ${JSON.stringify(data)}`);
  }
  return { sent: true, messageId: data.result.message_id };
}

async function handleFindingsReady({ assetId, readingId, findingId }) {
  const [readingDoc, findingDoc] = await Promise.all([
    db.collection(collections.readings).doc(readingId).get(),
    db.collection(collections.findings).doc(findingId).get(),
  ]);

  if (!readingDoc.exists) throw new Error(`Reading ${readingId} was not found`);
  if (!findingDoc.exists) throw new Error(`Finding ${findingId} was not found`);

  const reading = readingDoc.data();
  const finding = findingDoc.data();

  const summary = await composeSummary({ assetId, reading, causes: finding.causes || [] });
  const telegramResult = await sendTelegram(summary);

  const reportRecord = {
    assetId,
    readingId,
    findingId,
    summary,
    telegram: telegramResult,
    createdAt: new Date().toISOString(),
  };

  const docRef = await db.collection(collections.reports).add(reportRecord);

  console.log(`Report ${docRef.id} sent for ${assetId}. Telegram sent: ${telegramResult.sent}`);

  return { reportId: docRef.id, ...reportRecord };
}

app.get("/", (_req, res) => {
  res.json({ agent: "reporter", status: "ready" });
});

app.post("/pubsub", async (req, res) => {
  try {
    const payload = decodePushBody(req.body);
    await handleFindingsReady(payload);
    res.status(204).send();
  } catch (err) {
    console.error("Failed to handle Pub/Sub push:", err);
    res.status(500).send();
  }
});

app.post("/ingest", async (req, res) => {
  try {
    const result = await handleFindingsReady(req.body);
    res.json(result);
  } catch (err) {
    console.error("Failed to handle local ingest:", err);
    res.status(400).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`Reporting and Notification Agent listening on port ${config.port}`);
});
