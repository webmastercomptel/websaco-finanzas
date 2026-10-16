// scripts/migrate-copropiedad-websaco3-id-index.js
//
// WHEN TO RUN THIS: BEFORE deploying the change that makes
// `Copropiedad.websaco3CopropiedadId` unique (branch
// `feat/holders-unique-websaco3-id`, change `sincronizar-propietarios-websaco3`),
// against every environment whose `copropiedades` collection already exists.
//
// WHY A SCRIPT AND NOT JUST THE SCHEMA: Mongoose builds the unique index on
// boot (autoIndex is on), but when duplicates already exist the build FAILS
// SILENTLY — the app boots green, the index is simply missing, and nobody
// notices. This script is the visible gate: it LISTS the duplicates so a human
// can fix them, refuses to build the index while any exist, and builds it
// deterministically once the data is clean.
//
// WHAT IT DOES (and nothing else — it never inserts, updates or deletes a
// document):
//   1. Groups the coproperties that hold a string `websaco3CopropiedadId` by
//      its trimmed, lowercased value and prints every group with more than one
//      member (id, codigo, nombre, raw stored value).
//   2. Prints, as information, the stored values that are not normalized
//      (surrounding spaces or uppercase). They are not blockers by themselves.
//   3. If any duplicate group exists: creates NO index and exits with code 1.
//   4. Otherwise creates the index `websaco3CopropiedadId_1` — unique, partial
//      on `{ websaco3CopropiedadId: { $type: 'string' } }`, the exact name and
//      options declared in `copropiedad.schema.ts`. Idempotent: a second run
//      reports "ya existe" and changes nothing.
//
// Usage (from the backend package root, with MONGODB_URI set — a .env file at
// the package root is picked up automatically when `dotenv` is installed):
//
//   node scripts/migrate-copropiedad-websaco3-id-index.js --listar   # read-only
//   node scripts/migrate-copropiedad-websaco3-id-index.js            # list + build
//
// Exit codes: 0 = clean (index present, or listing only); 1 = duplicates found,
// an index with the same name but different options exists, or the run failed.

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

const COLLECTION = 'copropiedades';
const CAMPO = 'websaco3CopropiedadId';
// Must match the schema's default name for `{ websaco3CopropiedadId: 1 }`.
const INDEX_NAME = 'websaco3CopropiedadId_1';
// Must match `CopropiedadSchema.index(...)` in copropiedad.schema.ts.
const INDEX_OPTIONS = {
  name: INDEX_NAME,
  unique: true,
  partialFilterExpression: { [CAMPO]: { $type: 'string' } },
};

/** Duplicate groups: same trimmed, lowercased id held by 2+ coproperties. */
function pipelineDuplicados() {
  return [
    { $match: { [CAMPO]: { $type: 'string' } } },
    {
      $group: {
        _id: { $toLower: { $trim: { input: `$${CAMPO}` } } },
        total: { $sum: 1 },
        copropiedades: {
          $push: {
            _id: '$_id',
            codigo: '$codigo',
            nombre: '$nombre',
            valor: `$${CAMPO}`,
          },
        },
      },
    },
    { $match: { total: { $gt: 1 } } },
    { $sort: { _id: 1 } },
  ];
}

/** Stored values that are not already trimmed + lowercase. */
function pipelineNoNormalizados() {
  return [
    { $match: { [CAMPO]: { $type: 'string' } } },
    {
      $match: {
        $expr: {
          $ne: [`$${CAMPO}`, { $toLower: { $trim: { input: `$${CAMPO}` } } }],
        },
      },
    },
    { $project: { codigo: 1, nombre: 1, valor: `$${CAMPO}` } },
    { $sort: { codigo: 1 } },
  ];
}

function mismasOpciones(existente) {
  return (
    existente.unique === true &&
    JSON.stringify(existente.partialFilterExpression) ===
      JSON.stringify(INDEX_OPTIONS.partialFilterExpression) &&
    JSON.stringify(existente.key) === JSON.stringify({ [CAMPO]: 1 })
  );
}

async function main() {
  const soloListar = process.argv.includes('--listar');

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
        `[migrate] La colección "${COLLECTION}" no existe todavía — no hay duplicados posibles.`,
      );
      if (soloListar) return;
    }

    const coleccion = db.collection(COLLECTION);

    // Read-only from here to the createIndex below.
    const duplicados = await coleccion
      .aggregate(pipelineDuplicados())
      .toArray();
    const noNormalizados = await coleccion
      .aggregate(pipelineNoNormalizados())
      .toArray();

    if (noNormalizados.length > 0) {
      console.log(
        `[migrate] Valores guardados sin normalizar (espacios o mayúsculas): ${noNormalizados.length}. ` +
          'No bloquean el índice por sí solos; se informan para que los corrijas.',
      );
      for (const c of noNormalizados) {
        console.log(
          `  - ${c.codigo} · ${c.nombre} · ${JSON.stringify(c.valor)} (_id ${c._id})`,
        );
      }
    }

    if (duplicados.length > 0) {
      console.error(
        `[migrate] DUPLICADOS: ${duplicados.length} ID(s) de WebSaco3 están asignados a más de una copropiedad.`,
      );
      for (const grupo of duplicados) {
        console.error(`  ID ${grupo._id} (${grupo.total} copropiedades):`);
        for (const c of grupo.copropiedades) {
          console.error(
            `    - ${c.codigo} · ${c.nombre} · valor guardado ${JSON.stringify(c.valor)} (_id ${c._id})`,
          );
        }
      }
      console.error(
        '[migrate] No se creó ningún índice. Corregí los duplicados (dejá cada ID en una sola ' +
          'copropiedad) y volvé a correr el script.',
      );
      process.exitCode = 1;
      return;
    }

    console.log('[migrate] Sin duplicados de websaco3CopropiedadId.');

    if (soloListar) {
      console.log('[migrate] --listar: no se crea ningún índice.');
      return;
    }

    const indices = colecciones.length === 0 ? [] : await coleccion.indexes();
    const existente = indices.find((indice) => indice.name === INDEX_NAME);
    if (existente) {
      if (mismasOpciones(existente)) {
        console.log(
          `[migrate] El índice "${INDEX_NAME}" ya existe con las opciones correctas — nada que hacer.`,
        );
        return;
      }
      console.error(
        `[migrate] Ya existe un índice "${INDEX_NAME}" con OTRAS opciones (${JSON.stringify(existente)}). ` +
          'No se tocó. Revisalo a mano antes de continuar.',
      );
      process.exitCode = 1;
      return;
    }

    try {
      await coleccion.createIndex({ [CAMPO]: 1 }, INDEX_OPTIONS);
    } catch (err) {
      // 85 = IndexOptionsConflict, 86 = IndexKeySpecsConflict: something with
      // the same name or key but other options appeared between the
      // listIndexes above and now.
      if (err && (err.code === 85 || err.code === 86)) {
        console.error(
          `[migrate] Conflicto de índice (código ${err.code}): ${err.message}. No se modificó nada.`,
        );
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    console.log(
      `[migrate] Índice "${INDEX_NAME}" creado (único, parcial sobre ${CAMPO} de tipo string).`,
    );
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('[migrate] Falló la migración:', err);
  process.exitCode = 1;
});
