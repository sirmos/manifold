import { GoogleGenAI } from "@google/genai";
import { config } from "./env.js";

const ai = new GoogleGenAI({
  vertexai: true,
  project: config.projectId,
  location: config.region,
});

const MODEL = "gemini-3.5-flash";

// Plain text prompt in, plain text answer out. Used for writing
// summaries and ranking causes.
export async function askGemini(prompt, systemInstruction) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: systemInstruction ? { systemInstruction } : undefined,
  });
  return response.text;
}

// Same as askGemini, but also sends an image (a photo of a logbook
// page, for example) alongside the text prompt.
export async function askGeminiWithImage(prompt, imageBase64, mimeType, systemInstruction) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: imageBase64 } },
          { text: prompt },
        ],
      },
    ],
    config: systemInstruction ? { systemInstruction } : undefined,
  });
  return response.text;
}

// Asks Gemini for JSON and parses it. Throws if the model does not
// return valid JSON, so a bad response fails loudly instead of
// quietly saving garbage to Firestore.
export async function askGeminiForJson(prompt, systemInstruction) {
  const raw = await askGemini(prompt, systemInstruction);
  const cleaned = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// Same as askGeminiForJson, but with an image attached to the prompt.
export async function askGeminiForJsonWithImage(prompt, imageBase64, mimeType, systemInstruction) {
  const raw = await askGeminiWithImage(prompt, imageBase64, mimeType, systemInstruction);
  const cleaned = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}
