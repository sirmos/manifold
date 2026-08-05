import { PubSub } from "@google-cloud/pubsub";
import { config } from "./env.js";

const pubsub = new PubSub({ projectId: config.projectId });

export const topics = {
  newReading: "new-reading",
  readingStored: "reading-stored",
  anomalyDetected: "anomaly-detected",
  findingsReady: "findings-ready",
};

// Publishes a plain JS object as a Pub/Sub message. Every agent
// uses this instead of talking to the PubSub client directly.
export async function publishEvent(topicName, payload) {
  const dataBuffer = Buffer.from(JSON.stringify(payload));
  const messageId = await pubsub.topic(topicName).publishMessage({ data: dataBuffer });
  return messageId;
}

// Cloud Run push subscriptions deliver a body shaped like:
// { message: { data: "<base64>", messageId, publishTime }, subscription }
// This pulls the real payload back out.
export function decodePushBody(body) {
  const message = body && body.message;
  if (!message || !message.data) {
    throw new Error("Request body is not a valid Pub/Sub push message");
  }
  const json = Buffer.from(message.data, "base64").toString("utf8");
  return JSON.parse(json);
}
