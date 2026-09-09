// Run with: node --env-file=.env scripts/clonar-copropiedad-test.js
//
// WHY THIS EXISTS: clones one real coproperty's MASTER data (terceros,
// inmuebles, cuentas contables, conceptos de cobro, valores recurrentes,
// resolución de facturación, consecutivos de documento) into a brand-new
// "TEST SANTIAGO" coproperty, for safe hands-on testing — WITHOUT any
// facturación transactional/historical data (lotes, facturas, recibos,
// notas, asientos contables, saldos de cartera, períodos contables) and
// WITHOUT any access grant carried over (no `Asignacion` rows, and
// `managingEntityId` is nulled out on the clone — leaving it set would let
// anyone with entity-level access to the source's managing company also
// reach the test tenant, which defeats the "empty access" intent).
//
// ONE-SHOT, not idempotent: aborts if a coproperty named "TEST SANTIAGO"
// already exists, rather than silently creating a second one or
// overwriting the first — delete the old one by hand first if you want to
// re-run this from scratch.
'use strict';

// This machine's default DNS resolver doesn't answer SRV queries (needed to
// resolve a `mongodb+srv://` URI) even though it resolves everything else
// fine — forcing a public resolver here is what makes the connection work.
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error(
    'MONGODB_URI is not set. Run with: node --env-file=.env scripts/clonar-copropiedad-test.js',
  );
  process.exit(1);
}

const SOURCE_ID = '6a99c1602a21f712fb8c6f8e';
const NUEVO_NOMBRE = 'TEST SANTIAGO';

/** Mirrors `CopropiedadesService.pisoActual()`/`siguienteCodigo()` exactly —
 *  same self-healing floor logic, so this can never collide with an
 *  existing code even if one was typed by hand outside the counter. */
async function siguienteCodigo(db) {
  const [maximo] = await db
    .collection('copropiedades')
    .find({ code: /^\d+$/ })
    .collation({ locale: 'en_US', numericOrdering: true })
    .sort({ code: -1 })
    .limit(1)
    .toArray();
  const pisoCopropiedades = maximo ? parseInt(maximo.code, 10) : 0;

  const contadorActual = await db
    .collection('contadores_copropiedades')
    .findOne({});
  const pisoContador = contadorActual?.valor ?? 0;
  const piso = Math.max(pisoCopropiedades, pisoContador);

  await db
    .collection('contadores_copropiedades')
    .updateOne({}, { $max: { valor: piso } }, { upsert: true });
  await db
    .collection('contadores_copropiedades')
    .updateOne({}, { $inc: { valor: 1 } }, { upsert: true });

  const actualizado = await db
    .collection('contadores_copropiedades')
    .findOne({});
  return String(actualizado.valor).padStart(4, '0');
}

/** Strips the fields every clone must never literally copy — its own
 *  identity, and timestamps that belong to the NEW row, not the old one. */
function sinIdentidad(doc, ...camposExtra) {
  const copia = { ...doc };
  delete copia._id;
  delete copia.createdAt;
  delete copia.updatedAt;
  for (const campo of camposExtra) delete copia[campo];
  return copia;
}

async function run() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const ahora = new Date();
  const sourceId = new ObjectId(SOURCE_ID);

  const yaExiste = await db
    .collection('copropiedades')
    .findOne({ name: NUEVO_NOMBRE });
  if (yaExiste) {
    throw new Error(
      `Ya existe una copropiedad llamada "${NUEVO_NOMBRE}" (${yaExiste._id}) — borrala primero si querés reclonar.`,
    );
  }

  const origen = await db.collection('copropiedades').findOne({ _id: sourceId });
  if (!origen) {
    throw new Error(`No se encontró la copropiedad de origen ${SOURCE_ID}`);
  }

  const code = await siguienteCodigo(db);
  const nuevaCopropiedadId = new ObjectId();

  await db.collection('copropiedades').insertOne({
    _id: nuevaCopropiedadId,
    ...sinIdentidad(origen, 'code', 'name', 'managingEntityId', 'status'),
    code,
    name: NUEVO_NOMBRE,
    // See file header: nulled out so entity-level access to the source's
    // managing company doesn't silently reach this test tenant too.
    managingEntityId: null,
    status: 'active',
    createdAt: ahora,
    updatedAt: ahora,
  });
  console.log(`Copropiedad creada: ${nuevaCopropiedadId} (code ${code}) — "${NUEVO_NOMBRE}"`);

  // 1) Terceros — no cross-collection FK.
  const idsTerceros = new Map();
  const terceros = await db
    .collection('terceros')
    .find({ coPropertyId: sourceId })
    .toArray();
  if (terceros.length > 0) {
    const nuevos = terceros.map((t) => {
      const nuevoId = new ObjectId();
      idsTerceros.set(t._id.toString(), nuevoId);
      return {
        _id: nuevoId,
        ...sinIdentidad(t, 'coPropertyId'),
        coPropertyId: nuevaCopropiedadId,
        createdAt: ahora,
        updatedAt: ahora,
      };
    });
    await db.collection('terceros').insertMany(nuevos);
  }
  console.log(`Terceros clonados: ${terceros.length}`);

  // 2) Inmuebles — holderId -> Tercero.
  const idsInmuebles = new Map();
  const inmuebles = await db
    .collection('inmuebles')
    .find({ coPropertyId: sourceId })
    .toArray();
  if (inmuebles.length > 0) {
    const nuevos = inmuebles.map((i) => {
      const nuevoId = new ObjectId();
      idsInmuebles.set(i._id.toString(), nuevoId);
      return {
        _id: nuevoId,
        ...sinIdentidad(i, 'coPropertyId', 'holderId'),
        coPropertyId: nuevaCopropiedadId,
        holderId: i.holderId ? (idsTerceros.get(i.holderId.toString()) ?? null) : null,
        createdAt: ahora,
        updatedAt: ahora,
      };
    });
    await db.collection('inmuebles').insertMany(nuevos);
  }
  console.log(`Inmuebles clonados: ${inmuebles.length}`);

  // 3) Cuentas contables — no cross-collection FK.
  const idsCuentas = new Map();
  const cuentas = await db
    .collection('cuentas_contables')
    .find({ coPropertyId: sourceId })
    .toArray();
  if (cuentas.length > 0) {
    const nuevos = cuentas.map((c) => {
      const nuevoId = new ObjectId();
      idsCuentas.set(c._id.toString(), nuevoId);
      return {
        _id: nuevoId,
        ...sinIdentidad(c, 'coPropertyId'),
        coPropertyId: nuevaCopropiedadId,
        createdAt: ahora,
        updatedAt: ahora,
      };
    });
    await db.collection('cuentas_contables').insertMany(nuevos);
  }
  console.log(`Cuentas contables clonadas: ${cuentas.length}`);

  // 4) Conceptos de cobro — cuentaDebitoId/cuentaCreditoId/cuentaImpuestoId -> CuentaContable.
  const idsConceptos = new Map();
  const conceptos = await db
    .collection('conceptos_cobro')
    .find({ coPropertyId: sourceId })
    .toArray();
  if (conceptos.length > 0) {
    const remapCuenta = (id) => (id ? (idsCuentas.get(id.toString()) ?? null) : null);
    const nuevos = conceptos.map((c) => {
      const nuevoId = new ObjectId();
      idsConceptos.set(c._id.toString(), nuevoId);
      return {
        _id: nuevoId,
        ...sinIdentidad(
          c,
          'coPropertyId',
          'cuentaDebitoId',
          'cuentaCreditoId',
          'cuentaImpuestoId',
        ),
        coPropertyId: nuevaCopropiedadId,
        cuentaDebitoId: remapCuenta(c.cuentaDebitoId),
        cuentaCreditoId: remapCuenta(c.cuentaCreditoId),
        cuentaImpuestoId: remapCuenta(c.cuentaImpuestoId),
        createdAt: ahora,
        updatedAt: ahora,
      };
    });
    await db.collection('conceptos_cobro').insertMany(nuevos);
  }
  console.log(`Conceptos de cobro clonados: ${conceptos.length}`);

  // 5) Valores recurrentes — inmuebleId -> Inmueble, conceptoId -> ConceptoCobro.
  const valores = await db
    .collection('valores_recurrentes')
    .find({ coPropertyId: sourceId })
    .toArray();
  let valoresClonados = 0;
  if (valores.length > 0) {
    const nuevos = [];
    for (const v of valores) {
      const nuevoInmuebleId = idsInmuebles.get(v.inmuebleId.toString());
      const nuevoConceptoId = idsConceptos.get(v.conceptoId.toString());
      if (!nuevoInmuebleId || !nuevoConceptoId) {
        console.warn(
          `  ⚠️  valor_recurrente ${v._id}: referencia huérfana (inmueble o concepto no clonado) — se omite.`,
        );
        continue;
      }
      nuevos.push({
        _id: new ObjectId(),
        ...sinIdentidad(v, 'coPropertyId', 'inmuebleId', 'conceptoId'),
        coPropertyId: nuevaCopropiedadId,
        inmuebleId: nuevoInmuebleId,
        conceptoId: nuevoConceptoId,
        createdAt: ahora,
        updatedAt: ahora,
      });
    }
    if (nuevos.length > 0) await db.collection('valores_recurrentes').insertMany(nuevos);
    valoresClonados = nuevos.length;
  }
  console.log(`Valores recurrentes clonados: ${valoresClonados} de ${valores.length}`);

  // 6) Resolución de facturación — nextNumber reinicia a rangeFrom: un
  // tenant de prueba no debe heredar la posición real de numeración.
  const resoluciones = await db
    .collection('resoluciones_facturacion')
    .find({ coPropertyId: sourceId })
    .toArray();
  if (resoluciones.length > 0) {
    const nuevos = resoluciones.map((r) => ({
      _id: new ObjectId(),
      ...sinIdentidad(r, 'coPropertyId', 'nextNumber'),
      coPropertyId: nuevaCopropiedadId,
      nextNumber: r.rangeFrom,
      createdAt: ahora,
      updatedAt: ahora,
    }));
    await db.collection('resoluciones_facturacion').insertMany(nuevos);
  }
  console.log(
    `Resoluciones de facturación clonadas: ${resoluciones.length} (nextNumber reiniciado a rangeFrom)`,
  );

  // 7) Consecutivos de documento — nextNumber reinicia a 1, misma razón.
  const consecutivos = await db
    .collection('consecutivos_documento')
    .find({ coPropertyId: sourceId })
    .toArray();
  if (consecutivos.length > 0) {
    const nuevos = consecutivos.map((c) => ({
      _id: new ObjectId(),
      ...sinIdentidad(c, 'coPropertyId', 'nextNumber'),
      coPropertyId: nuevaCopropiedadId,
      nextNumber: 1,
      createdAt: ahora,
      updatedAt: ahora,
    }));
    await db.collection('consecutivos_documento').insertMany(nuevos);
  }
  console.log(
    `Consecutivos de documento clonados: ${consecutivos.length} (nextNumber reiniciado a 1)`,
  );

  await mongoose.disconnect();
  console.log(`\nListo — "${NUEVO_NOMBRE}" (${nuevaCopropiedadId}) creada sin accesos ni histórico contable.`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
