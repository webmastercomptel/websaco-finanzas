// Run with: node scripts/migrate-collection-status-al-dia-a-vigente.js
// (from the backend package root, with a .env file present — see below)
//
// WHY THIS EXISTS: `Inmueble.collectionStatus` was renamed from 'al_dia' to
// 'vigente' — the old name read as "no mora", but this status only ever
// meant "not escalated to jurídico or difícil recaudo"; a unit a few days
// overdue could already be `al_dia` under the old name, which misled anyone
// reading it at face value. See `inmueble.schema.ts`'s own docblock on
// `collectionStatus` for the corrected meaning.
//
// Every document written BEFORE this change still carries the literal
// string 'al_dia', which the new Mongoose enum (['vigente', 'juridico',
// 'dificil_recaudo']) no longer accepts — this one-time-updates those rows
// in place, same value, new name.
//
// SAFE TO RUN MULTIPLE TIMES: only touches documents where collectionStatus
// is still 'al_dia'; a second run matches nothing. No-op against a fresh/
// empty database.
'use strict';

const dns = require('node:dns');
const path = require('node:path');

// Same reasoning as src/common/dns-setup.ts: MongoDB Atlas (mongodb+srv://)
// needs an SRV lookup that some local / VPN / corporate resolvers refuse, and
// the driver honors dns.setServers() for resolveSrv. Must happen before the
// client connects.
dns.setServers(['8.8.8.8', '1.1.1.1']);

try {
  // dotenv ships with @nestjs/config; if it is somehow absent, the script
  // still works with MONGODB_URI exported in the environment.
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch {
  // Intentionally ignored — see above.
}

const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error(
    'MONGODB_URI is not set. Run with: node scripts/migrate-collection-status-al-dia-a-vigente.js (from the backend package root, with a .env file present).',
  );
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const resultado = await db
    .collection('inmuebles')
    .updateMany(
      { collectionStatus: 'al_dia' },
      { $set: { collectionStatus: 'vigente' } },
    );

  console.log(
    `inmuebles.collectionStatus: ${resultado.modifiedCount} actualizados de 'al_dia' a 'vigente'`,
  );

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
