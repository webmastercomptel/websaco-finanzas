// src/seed/sembrar-consecutivos.ts
// MUST stay the first import: it sets the process DNS resolvers before the
// Mongo driver performs its SRV lookup. See common/dns-setup.ts.
import '../common/dns-setup';

import mongoose from 'mongoose';
import {
  ConsecutivoDocumento,
  ConsecutivoDocumentoSchema,
} from '../database/schemas/numeracion/consecutivo-documento.schema';
import { DOCUMENTOS_SISTEMA } from '../modules/copropiedades/documentos-sistema';

/**
 * One-off backfill (owner, 2026-10-02): `CopropiedadesService` seeds the six
 * system document types when a coproperty is created, but coproperties that
 * predate that seeding have none (or only the ones created by hand). Inserts
 * every default type a coproperty is missing, matched by `codigo`.
 *
 * It only ever INSERTS. An existing row — whatever its name, prefix or
 * `siguienteNumero` — is left exactly as it is: that counter is the last
 * document number actually issued, and resetting it would hand out a number
 * that already exists (audit law). Idempotent: a second run finds nothing to
 * add. Dry run by default — `--aplicar` requires an explicit `--db=<name>`.
 *
 * Connects with Mongoose only (not `AppModule`) so it does not open a Redis
 * client: the Redis plan has a low connection cap.
 *
 *   npm run sembrar:consecutivos -- --db=production
 *   npm run sembrar:consecutivos -- --db=production --aplicar
 */
async function sembrar(): Promise<void> {
  const aplicar = process.argv.includes('--aplicar');
  const dbNombre = process.argv
    .find((a) => a.startsWith('--db='))
    ?.slice('--db='.length);
  if (aplicar && !dbNombre) {
    throw new Error('--aplicar requires an explicit --db=<name>');
  }

  process.loadEnvFile('.env');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in .env');

  // `autoIndex: false`: this script must not create or alter any index.
  await mongoose.connect(uri, {
    autoIndex: false,
    ...(dbNombre ? { dbName: dbNombre } : {}),
  });
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error('No database handle after connect');
    console.log(`Base de datos: ${db.databaseName}`);
    if (db.databaseName !== 'production') {
      console.warn('  (no es "production" — revisá que sea la que querés)');
    }

    const Consecutivo = mongoose.connection.model(
      ConsecutivoDocumento.name,
      ConsecutivoDocumentoSchema,
    );
    const copropiedades = await db
      .collection('copropiedades')
      .find({}, { projection: { codigo: 1, nombre: 1 } })
      .toArray();

    let total = 0;
    for (const copropiedad of copropiedades) {
      const existentes = new Set(
        (
          await Consecutivo.find({ copropiedadId: copropiedad._id })
            .select('codigo')
            .lean()
            .exec()
        ).map((c) => c.codigo),
      );
      const faltantes = DOCUMENTOS_SISTEMA.filter(
        (doc) => !existentes.has(doc.codigo),
      );
      const etiqueta = `${String(copropiedad.codigo)} ${String(copropiedad.nombre)}`;
      console.log(
        `${etiqueta}: tiene [${[...existentes].join(', ') || 'ninguno'}], ` +
          `${aplicar ? 'agrega' : 'agregaría'} [${faltantes.map((d) => d.codigo).join(', ') || 'nada'}]`,
      );
      total += faltantes.length;

      if (aplicar && faltantes.length > 0) {
        await Consecutivo.insertMany(
          faltantes.map((doc) => ({
            copropiedadId: copropiedad._id,
            categoria: doc.categoria,
            codigo: doc.codigo,
            prefijo: doc.codigo,
            nombreDocumento: doc.nombreDocumento,
            comprobanteContable: doc.comprobanteContable,
            siguienteNumero: 0,
          })),
        );
      }
    }
    console.log(
      `${aplicar ? 'Insertados' : 'Por insertar'}: ${total} consecutivos en ${copropiedades.length} copropiedades.`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

void sembrar()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
