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
      coPropertyId: new mongoose.Types.ObjectId('6a99c1602a21f712fb8c6f8e'),
      name: 'Administración',
      kind: 'administracion',
      taxRate: 0,
      sortOrder: 1,
      accountingIncomeAccount: null,
      availableAsNovedad: false,
      active: true,
      isSystem: true,
    },
    {
      coPropertyId: new mongoose.Types.ObjectId('6a99c1602a21f712fb8c6f8e'),
      name: 'Intereses por Mora',
      kind: 'intereses',
      taxRate: 0,
      sortOrder: 2,
      accountingIncomeAccount: null,
      availableAsNovedad: false,
      active: true,
      isSystem: true,
    },
    {
      coPropertyId: new mongoose.Types.ObjectId('6a99c1602a21f712fb8c6f8e'),
      name: 'Multas',
      kind: 'otro',
      taxRate: 0,
      sortOrder: 3,
      accountingIncomeAccount: null,
      availableAsNovedad: false,
      active: true,
      isSystem: true,
    },
  ]);
  console.log(r.insertedCount, 'cargos de sistema insertados');
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
