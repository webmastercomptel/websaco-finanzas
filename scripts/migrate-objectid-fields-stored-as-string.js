// Run with: node --env-file=.env scripts/migrate-objectid-fields-stored-as-string.js
//
// WHY THIS EXISTS: every `@Prop({ type: Types.ObjectId, ... })` in this
// codebase (`Types.ObjectId` = the BSON *value* class, imported from
// 'mongoose') was silently compiling to a `Mixed` schema path instead of a
// real ObjectId one — `@nestjs/mongoose`'s `DefinitionsFactory` only
// recognizes `mongoose.Schema.Types.ObjectId` (a `SchemaType` subclass) as
// "this is an ObjectId field"; `Types.ObjectId`'s prototype chain leads to
// `BSONValue`, not `SchemaType`, so it fails that check and falls through to
// Mixed. A `Mixed` path never casts, so anywhere application code passed a
// plain STRING id into `.create()`/`$set` (instead of a real ObjectId
// instance) that string got stored as-is — and any later query filtering by
// that field with a proper ObjectId (now that the schemas are fixed to use
// `SchemaTypes.ObjectId`, or that queries elsewhere pass a real ObjectId) will
// no longer match those old string-valued documents. The schema fix corrects
// every WRITE from now on; this script one-time-converts what already got
// written wrong before the fix landed.
//
// SAFE TO RUN MULTIPLE TIMES: only touches documents where the field is
// currently stored as a BSON string ($type: 'string'); once converted to a
// real ObjectId, a later run's filter no longer matches it, so nothing loops
// or double-converts. Also a no-op against a fresh/empty database.
//
// Found via `check-interes-mora.js` while investigating why a Lote's mora
// wasn't calculating — that turned out to be a different (now-fixed) bug in
// `LotesFacturacionService.construirPreview()`'s own SaldoCartera query, but
// digging into it surfaced this schema-wide casting problem underneath it.
'use strict';

const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error(
    'MONGODB_URI is not set. Run with: node --env-file=.env scripts/migrate-objectid-fields-stored-as-string.js',
  );
  process.exit(1);
}

/** One (collection, field) pair to convert. `field` may be a top-level path
 *  only — none of the affected fields found so far are nested. */
const OBJETIVOS = [
  { coleccion: 'facturas', campo: 'loteId' },
  { coleccion: 'asientos_contables', campo: 'loteId' },
  { coleccion: 'asientos_contables', campo: 'facturaId' },
  { coleccion: 'inmuebles', campo: 'holderId' },
];

async function migrarCampo(db, coleccion, campo) {
  const cursor = db
    .collection(coleccion)
    .find({ [campo]: { $type: 'string' } })
    .project({ [campo]: 1 });

  let convertidos = 0;
  let invalidos = 0;
  const operaciones = [];

  for await (const doc of cursor) {
    const valor = doc[campo];
    if (!mongoose.Types.ObjectId.isValid(valor)) {
      invalidos += 1;
      console.warn(
        `  ⚠️  ${coleccion}/${doc._id}: "${campo}" = "${valor}" no es un ObjectId válido — se deja intacto, revisar a mano.`,
      );
      continue;
    }
    operaciones.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { [campo]: new mongoose.Types.ObjectId(valor) } },
      },
    });
    convertidos += 1;
  }

  if (operaciones.length > 0) {
    await db.collection(coleccion).bulkWrite(operaciones);
  }

  console.log(
    `${coleccion}.${campo}: ${convertidos} convertidos${invalidos > 0 ? `, ${invalidos} inválidos (sin tocar)` : ''}`,
  );
}

async function run() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  for (const { coleccion, campo } of OBJETIVOS) {
    await migrarCampo(db, coleccion, campo);
  }

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
