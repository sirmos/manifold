import { Firestore } from "@google-cloud/firestore";
import { config } from "./env.js";

export const db = new Firestore({ projectId: config.projectId });

// Collections used across the project, kept in one place so a name
// never gets typed two different ways in two different agents.
export const collections = {
  readings: "readings",
  baselines: "baselines",
  maintenance: "maintenance_records",
  findings: "findings",
  assets: "assets",
};
