// Run with: node --env-file=.env scripts/seed-cargos.js
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI is not set. Run with: node --env-file=.env scripts/seed-cargos.js');
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const r = await db.collection('conceptos_cobro').insertMany([
    {
      copropiedadId: new mongoose.Types.ObjectId('6a99c1602a21f712fb8c6f8e'),
      nombre: 'Administración',
      tipo: 'administracion',
      tasaImpuesto: 0,
      orden: 1,
      accountingIncomeAccount: null,
      cargaXls: false,
      active: true,
      sistema: true,
    },
    {
      copropiedadId: new mongoose.Types.ObjectId('6a99c1602a21f712fb8c6f8e'),
      nombre: 'Intereses por Mora',
      tipo: 'intereses',
      tasaImpuesto: 0,
      orden: 2,
      accountingIncomeAccount: null,
      cargaXls: false,
      active: true,
      sistema: true,
    },
    {
      copropiedadId: new mongoose.Types.ObjectId('6a99c1602a21f712fb8c6f8e'),
      nombre: 'Multas',
      tipo: 'otro',
      tasaImpuesto: 0,
      orden: 3,
      accountingIncomeAccount: null,
      cargaXls: false,
      active: true,
      sistema: true,
    },
  ]);
  console.log(r.insertedCount, 'cargos de sistema insertados');
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
