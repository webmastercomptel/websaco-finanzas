// Run with: node scripts/migrate-lote-recibos-creado-en.js
// (from the backend package root, with a .env file present — see below)
//
// WHY THIS EXISTS: `LoteRecibos.creadoEn` was added as a required, own domain
// field (deliberately NOT Mongo's own `timestamps: true` bookkeeping, which
// the schema also carries but the API contract never exposes) — every
// `lotes_recibos` document created BEFORE that change has no `creadoEn` at
// all, and `toLoteRecibos()` crashes calling `.toISOString()` on it.
//
// This one-time-backfills those old documents using their own `createdAt`
// (from `timestamps: true`) as `creadoEn` — a legitimate use of Mongo's
// bookkeeping field: for a document that already exists, "when Mongo first
// saved it" and "when this batch was created" are the same moment. Every
// NEW document from here on gets `creadoEn` set explicitly by
// `LoteRecibosService.crear()`, never derived from `createdAt`.
//
// SAFE TO RUN MULTIPLE TIMES: only touches documents where `creadoEn` does
// not exist yet; a second run matches nothing. No-op against a fresh/empty
// database.
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
    'MONGODB_URI is not set. Run with: node scripts/migrate-lote-recibos-creado-en.js (from the backend package root, with a .env file present).',
  );
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  const cursor = db
    .collection('lotes_recibos')
    .find({ creadoEn: { $exists: false } })
    .project({ createdAt: 1 });

  const operaciones = [];
  for await (const doc of cursor) {
    // `createdAt` itself is guaranteed by `timestamps: true` on every
    // document Mongoose has ever written for this schema — nothing to
    // fall back to if it were somehow missing, so no defensive branch here.
    operaciones.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { creadoEn: doc.createdAt } },
      },
    });
  }

  if (operaciones.length > 0) {
    await db.collection('lotes_recibos').bulkWrite(operaciones);
  }

  console.log(`lotes_recibos.creadoEn: ${operaciones.length} backfilled`);

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
