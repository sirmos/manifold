// Adds a couple of sample maintenance records for one asset, so the
// Root Cause Investigation Agent has something real to look through.
//
// Usage: node scripts/seed_maintenance.js compressor-01

import { db, collections } from "../common/firestore.js";

const assetId = process.argv[2] || "compressor-01";

const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
const fourMonthsAgo = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();

const records = [
  {
    assetId,
    date: twoDaysAgo,
    description: "Routine service. Replaced air filter and checked seals.",
    technician: "J. Okon",
  },
  {
    assetId,
    date: fourMonthsAgo,
    description:
      "Full compressor overhaul. Efficiency dropped for about a week afterward before it returned to normal on its own.",
    technician: "A. Bassey",
  },
];

for (const record of records) {
  const docRef = await db.collection(collections.maintenance).add(record);
  console.log(`Added maintenance record ${docRef.id}:`);
  console.log(record);
}
