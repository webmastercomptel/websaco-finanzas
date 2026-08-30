// scripts/migrate-asiento-contable-facturaid-index.js
//
// WHEN TO RUN THIS: exactly once, BEFORE deploying the `feature/recibos-caja`
// branch to any environment whose `asientos_contables` collection already
// exists (i.e. anywhere Facturación has ever consolidated a lote). That branch
// changed the `facturaId` index on `AsientoContable` from a plain
// `{ unique: true }` to the same key plus a `partialFilterExpression`, which
// keeps MongoDB's auto-generated name `facturaId_1`. Mongoose's default
// `createIndexes` on boot will NOT rewrite an existing index that has the same
// name but different options — MongoDB rejects that as `IndexOptionsConflict`
// (code 85) and silently leaves the OLD strict unique index in place. Since
// every Recibo-driven journal entry is written with `facturaId: null`, and the
// old index treats `null` as a real duplicate-checkable value, the second
// Recibo ever created (or applied, or voided) in that environment would fail
// forever with a duplicate-key error (E11000). Dropping the old index lets
// Mongoose create the corrected partial one on the next boot. This script is
// idempotent and SAFE TO RUN TWICE, and it is a no-op against a fresh or empty
// database (no collection, or no such index, means nothing to drop).
//
// Usage (from the backend package root, with MONGODB_URI set — a .env file at
// the package root is picked up automatically when `dotenv` is installed):
//
//   node scripts/migrate-asiento-contable-facturaid-index.js
//
// Then deploy/boot the app normally: Mongoose creates the corrected partial
// index itself.

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

// The `mongodb` driver is not a direct dependency of this package, but
// mongoose re-exports the exact same driver it uses internally.
const { MongoClient } = require('mongoose').mongo;

const COLLECTION = 'asientos_contables';
const INDEX_NAME = 'facturaId_1';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'MONGODB_URI no está definida. Exportála, o poné un .env en la raíz del paquete backend.',
    );
  }

  const client = new MongoClient(uri);
  await client.connect();

  try {
    // The URI carries the database name (same one the app connects to via
    // MongooseModule.forRootAsync); db() with no argument honors it.
    const db = client.db();

    const colecciones = await db
      .listCollections({ name: COLLECTION }, { nameOnly: true })
      .toArray();
    if (colecciones.length === 0) {
      console.log(
        `[migrate] La colección "${COLLECTION}" no existe todavía — nada que hacer. ` +
          'Mongoose creará el índice parcial correcto en el primer arranque.',
      );
      return;
    }

    const indices = await db.collection(COLLECTION).indexes();
    const existente = indices.find((indice) => indice.name === INDEX_NAME);

    if (!existente) {
      console.log(
        `[migrate] No existe el índice "${INDEX_NAME}" en "${COLLECTION}" — nada que hacer.`,
      );
      return;
    }

    if (existente.partialFilterExpression) {
      console.log(
        `[migrate] El índice "${INDEX_NAME}" ya es parcial ` +
          `(${JSON.stringify(existente.partialFilterExpression)}) — ya migrado, nada que hacer.`,
      );
      return;
    }

    console.log(
      `[migrate] Encontrado el índice viejo "${INDEX_NAME}" sin partialFilterExpression ` +
        `(${JSON.stringify(existente)}). Eliminándolo…`,
    );
    await db.collection(COLLECTION).dropIndex(INDEX_NAME);
    console.log(
      `[migrate] Índice "${INDEX_NAME}" eliminado. Al próximo arranque de la app, ` +
        'Mongoose creará la versión parcial correcta.',
    );
  } catch (err) {
    // 27 = IndexNotFound. Only possible if something else dropped the index
    // between the listIndexes above and the dropIndex — still a success for us.
    if (err && (err.code === 27 || /index not found/i.test(err.message ?? ''))) {
      console.log(
        `[migrate] El índice "${INDEX_NAME}" ya no existía al momento de eliminarlo — nada que hacer.`,
      );
      return;
    }
    throw err;
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('[migrate] Falló la migración:', err);
  process.exitCode = 1;
});
