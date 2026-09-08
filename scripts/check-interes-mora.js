// Run with: node --env-file=.env scripts/check-interes-mora.js <facturaId>
//
// Diagnoses why a given Factura has no "interés de mora" line, by checking
// each gate LotesFacturacionService.construirPreview() applies BEFORE it
// pushes an interest line (see its own comments, module lotes.service.ts):
//   1. The coproperty must have a ConceptoCobro with kind: 'intereses'.
//   2. The Lote this Factura came from must have lateInterestRate > 0.
//   3. The unit's overdue balance (saldoTotal) must be > 0.
//   4. If the Lote has a lateInterestCap (a MINIMUM, not a ceiling),
//      saldoTotal must reach it.
//   5. round(saldoTotal * rate/100) must round to > 0 — a tiny balance at a
//      low rate can round down to zero and simply not be worth a line.
//   6. No manual override (adjustments: overrides:'interes') for this unit
//      set the interest to 0 for this Lote.
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI is not set. Run with: node --env-file=.env scripts/check-interes-mora.js <facturaId>');
  process.exit(1);
}

const facturaIdArg = process.argv[2];
if (!facturaIdArg) {
  console.error('Uso: node --env-file=.env scripts/check-interes-mora.js <facturaId>');
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const facturaId = new mongoose.Types.ObjectId(facturaIdArg);

  const factura = await db.collection('facturas').findOne({ _id: facturaId });
  if (!factura) {
    console.error(`No existe ninguna factura con _id ${facturaIdArg}`);
    process.exit(1);
  }

  console.log('Factura:', factura.fullNumber, '| status:', factura.status);
  console.log('  coPropertyId:', factura.coPropertyId.toString());
  console.log('  inmuebleId:', factura.inmuebleId.toString());
  console.log('  loteId:', factura.loteId ? factura.loteId.toString() : null);
  console.log('  periodo:', factura.periodStart, '→', factura.periodEnd);

  const lineaInteres = factura.lines.find((l) => l.source === 'interes');
  console.log(
    '\n¿Ya tiene línea de interés?',
    lineaInteres ? `SÍ — ${lineaInteres.totalAmount}` : 'NO',
  );
  if (lineaInteres) {
    console.log('(La factura SÍ tiene un cargo de intereses — revisa si el reclamo es sobre el MONTO, no sobre la ausencia de la línea.)');
  }

  console.log('\n--- Gate 1: concepto de intereses ---');
  const conceptoInteres = await db.collection('conceptos_cobro').findOne({
    coPropertyId: factura.coPropertyId,
    kind: 'intereses',
  });
  if (!conceptoInteres) {
    console.log('❌ Esta copropiedad NO tiene un cargo con tipo "intereses" en la tabla de Cargos. Sin ese concepto, NUNCA se calcula mora para nadie — esta es casi seguro la causa.');
  } else {
    console.log(`✅ Concepto de intereses: "${conceptoInteres.name}" (isSystem: ${conceptoInteres.isSystem})`);
  }

  console.log('\n--- Gate 2/4: parámetros del lote ---');
  let lote = null;
  if (factura.loteId) {
    // `Factura.loteId` is stored as a plain string in this database (every
    // factura is, not just this one — LotesFacturacionService.consolidar()
    // passes the raw `loteId: string` param straight into `.create()`
    // without wrapping it in `new Types.ObjectId(...)`), so match either
    // shape rather than assuming it was cast to ObjectId.
    lote = await db.collection('lotes_facturacion').findOne({
      _id: { $in: [factura.loteId, new mongoose.Types.ObjectId(factura.loteId)] },
    });
  }
  if (!lote) {
    console.log('⚠️  No se encontró el LoteFacturacion de esta factura (¿se purgó?) — no puedo leer la tasa/tope que se usó.');
  } else {
    console.log(`  lateInterestRate: ${lote.lateInterestRate}%`);
    console.log(`  lateInterestCap (saldo mínimo para cobrar mora): ${lote.lateInterestCap === null ? 'sin tope (siempre calcula si rate>0 y hay saldo)' : lote.lateInterestCap}`);
    if (!(lote.lateInterestRate > 0)) {
      console.log('❌ La tasa de interés de este lote es 0 (o no estaba configurada) — por eso no se calculó mora para NINGUNA unidad de este lote.');
    } else {
      console.log('✅ La tasa es > 0.');
    }

    const overrideInteres = (lote.adjustments || []).find(
      (n) =>
        n.overrides === 'interes' &&
        n.inmuebleId.toString() === factura.inmuebleId.toString() &&
        (!conceptoInteres || n.conceptoId.toString() === conceptoInteres._id.toString()),
    );
    console.log('\n--- Gate 6: override manual para esta unidad ---');
    if (overrideInteres) {
      console.log(`⚠️  Hay un override manual de mora para esta unidad en este lote: monto = ${overrideInteres.amount}.`);
      if (overrideInteres.amount === 0) {
        console.log('❌ El override está en 0 — alguien puso manualmente la mora en cero para esta unidad en este lote. Esa es la causa.');
      } else {
        console.log('El override tiene un monto distinto de cero — debería haber generado línea con ESE monto (no el calculado). Si la línea no aparece con ese valor, hay algo más raro.');
      }
    } else {
      console.log('✅ Sin override manual — se usó (o se debió usar) el cálculo automático.');
    }
  }

  console.log('\n--- Gate 3/5: saldo de la unidad al momento de facturar ---');
  // El saldo "congelado" de esta factura es la suma de balanceBefore de sus
  // propias líneas — es el read que LotesFacturacionService hizo ANTES de
  // construir cualquier línea de este mismo lote. Ojo: si algún concepto con
  // saldo pendiente no tuvo línea nueva este ciclo, su balanceBefore no queda
  // registrado acá, así que esto es un PISO, no el total exacto.
  const saldoCongeladoAprox = factura.lines.reduce((acc, l) => acc + (l.balanceBefore || 0), 0);
  console.log(`  Suma de balanceBefore de las líneas de ESTA factura (piso aproximado del saldo usado): ${saldoCongeladoAprox}`);

  const saldosActuales = await db.collection('saldos_cartera')
    .find({ coPropertyId: factura.coPropertyId, inmuebleId: factura.inmuebleId })
    .toArray();
  const saldoActualTotal = saldosActuales.reduce((acc, s) => acc + s.balance, 0);
  console.log(`  Saldo TOTAL ACTUAL de la unidad en saldos_cartera (hoy, puede haber cambiado desde el lote por pagos posteriores): ${saldoActualTotal}`);
  if (saldoCongeladoAprox <= 0 && saldoActualTotal <= 0) {
    console.log('❌ La unidad no tenía saldo pendiente (cartera al día) — sin saldo vencido no hay base para calcular mora.');
  }

  console.log('\n--- Unidad ---');
  const inmueble = await db.collection('inmuebles').findOne({ _id: factura.inmuebleId });
  if (!inmueble) {
    console.log('⚠️  No se encontró el inmueble (¿se eliminó?).');
  } else {
    console.log(`  holderId: ${inmueble.holderId ? inmueble.holderId.toString() : 'null'}`);
    if (!inmueble.holderId) {
      console.log('❌ La unidad no tiene propietario/holder asignado ACTUALMENTE — si esto ya era así al facturar, la unidad entera se hubiera saltado (no solo la mora). Si la factura ya existe, esto probablemente cambió DESPUÉS.');
    }
  }

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
