// src/seed/migrar-nombre-propio.ts
// MUST stay the first import: it sets the process DNS resolvers before the
// Mongo driver performs its SRV lookup. See common/dns-setup.ts.
import '../common/dns-setup';

import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { AnyBulkWriteOperation, Model } from 'mongoose';
import { AppModule } from '../app.module';
import { nombrePropio } from '../common/utils/nombre-propio';
import { EntidadAdministradora } from '../database/schemas/entidades/entidad-administradora.schema';
import { Copropiedad } from '../database/schemas/copropiedades/copropiedad.schema';
import { CuentaContable } from '../database/schemas/contabilidad/cuenta-contable.schema';
import { ConceptoCobro } from '../database/schemas/conceptos/concepto-cobro.schema';
import { ConsecutivoDocumento } from '../database/schemas/numeracion/consecutivo-documento.schema';
import { Tercero } from '../database/schemas/terceros/tercero.schema';

interface Coleccion {
  modelo: string;
  campos: readonly string[];
  /** Fields that, with the name, form a unique index — two rows that only
   *  differed by case would collide once normalized. */
  unicoCon?: readonly string[];
}

/** Every field that carries the schema's `comoNombrePropio` setter. */
const COLECCIONES: readonly Coleccion[] = [
  { modelo: EntidadAdministradora.name, campos: ['nombre'] },
  { modelo: Copropiedad.name, campos: ['nombre'] },
  { modelo: CuentaContable.name, campos: ['nombre'] },
  {
    modelo: ConceptoCobro.name,
    campos: ['nombre'],
    unicoCon: ['copropiedadId'],
  },
  { modelo: ConsecutivoDocumento.name, campos: ['nombreDocumento'] },
  {
    modelo: Tercero.name,
    campos: [
      'nombre',
      'primerNombre',
      'segundoNombre',
      'primerApellido',
      'segundoApellido',
      'razonSocial',
    ],
  },
];
const LOTE = 500;

/**
 * One-off migration (owner, 2026-10-01): rewrites names already stored as
 * Nombre Propio, the rule the schemas' setters apply to every new write.
 * Writes through the raw collection, only the fields that change, so it is
 * idempotent. Issued documents keep their frozen copies untouched (audit
 * law). A cargo whose new name would collide with another in the same
 * coproperty is skipped and listed, never merged. `--simular` only counts.
 *
 *   npm run migrar:nombre-propio -- --simular
 *   npm run migrar:nombre-propio
 */
async function migrar(): Promise<void> {
  const simular = process.argv.includes('--simular');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    for (const { modelo, campos, unicoCon } of COLECCIONES) {
      const coleccion = app.get<Model<unknown>>(
        getModelToken(modelo),
      ).collection;
      const proyeccion = Object.fromEntries(
        [...campos, ...(unicoCon ?? [])].map((c) => [c, 1]),
      );
      const docs = await coleccion
        .find({}, { projection: proyeccion })
        .toArray();

      // Unique-index guard: count how many rows end up on each key.
      const claveDe = (d: Record<string, unknown>) =>
        [
          ...(unicoCon ?? []).map((c) => String(d[c])),
          ...campos.map((c) => {
            const v = d[c];
            return typeof v === 'string' ? nombrePropio(v) : '';
          }),
        ].join('|');
      const porClave = new Map<string, number>();
      if (unicoCon) {
        for (const d of docs) {
          const k = claveDe(d);
          porClave.set(k, (porClave.get(k) ?? 0) + 1);
        }
      }

      let cambiados = 0;
      const ejemplos: string[] = [];
      const omitidos: string[] = [];
      let lote: AnyBulkWriteOperation[] = [];
      const escribir = async () => {
        if (!simular && lote.length > 0) {
          await coleccion.bulkWrite(lote as never, { ordered: false });
        }
        lote = [];
      };

      for (const d of docs) {
        const cambio: Record<string, string> = {};
        for (const campo of campos) {
          const valor: unknown = d[campo];
          if (typeof valor !== 'string') continue;
          const nuevo = nombrePropio(valor);
          if (nuevo !== valor) cambio[campo] = nuevo;
        }
        if (Object.keys(cambio).length === 0) continue;
        if (unicoCon && (porClave.get(claveDe(d)) ?? 0) > 1) {
          omitidos.push(
            `${String(d._id)} "${campos.map((c) => String(d[c])).join(' ')}"`,
          );
          continue;
        }
        cambiados += 1;
        if (ejemplos.length < 8) {
          for (const [campo, nuevo] of Object.entries(cambio)) {
            ejemplos.push(`${String(d[campo])} → ${nuevo}`);
          }
        }
        lote.push({
          updateOne: { filter: { _id: d._id }, update: { $set: cambio } },
        });
        if (lote.length >= LOTE) await escribir();
      }
      await escribir();

      console.log(
        `${simular ? '[simulación] ' : ''}${modelo}: revisados ${docs.length}, ${simular ? 'por cambiar' : 'cambiados'} ${cambiados}.`,
      );
      if (simular) ejemplos.forEach((e) => console.log(`    ${e}`));
      if (omitidos.length > 0) {
        console.warn(
          `  Omitidos por nombre duplicado (corregir a mano): ${omitidos.join(', ')}`,
        );
      }
    }
  } finally {
    await app.close();
  }
}

// Queue/Redis handles keep the event loop alive after app.close().
void migrar()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
