// Run with: node --env-file=.env scripts/check-cargos.js
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('MONGODB_URI is not set. Run with: node --env-file=.env scripts/check-cargos.js');
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  const docs = await db.collection('conceptos_cobro')
    .find({ coPropertyId: new mongoose.Types.ObjectId('6a99c1602a21f712fb8c6f8e') })
    .toArray();
  console.log('Conceptos:', docs.length);
  docs.forEach(d => console.log(' -', d.name, '| isSystem:', d.isSystem));
  await mongoose.disconnect();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
