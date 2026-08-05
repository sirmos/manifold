// Writes a baseline document for one asset, so the Operations
// Monitoring Agent has a normal range to compare new readings against.
// Run it once per asset before testing the pipeline.
//
// Usage: node scripts/seed_baseline.js compressor-01

import { db, collections } from "../common/firestore.js";

const assetId = process.argv[2] || "compressor-01";

const baseline = {
  assetId,
  efficiencyBaseline: 92,
  pressureBaseline: 550,
  temperatureBaseline: 60,
  tolerancePercent: 8,
  seeded: true,
  seededAt: new Date().toISOString(),
};

const result = await db.collection(collections.baselines).doc(assetId).set(baseline);
console.log(`Baseline seeded for ${assetId}:`);
console.log(baseline);
