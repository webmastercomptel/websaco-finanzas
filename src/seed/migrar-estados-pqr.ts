// src/seed/migrar-estados-pqr.ts
// MUST stay the first import: it sets the process DNS resolvers before the
// Mongo driver performs its SRV lookup. See common/dns-setup.ts.
import '../common/dns-setup';
// MUST stay the second import, before `../app.module`: it loads `.env.<name>`
// from `--env=<name>` before the config is validated. See load-script-env.ts.
import { confirmScriptEnv } from '../common/scripts/load-script-env';

import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppModule } from '../app.module';
import {
  ESTADOS_PQR_LEGADOS,
  Pqr,
} from '../database/schemas/administracion/pqr.schema';
import {
  actualizacionPara,
  informe,
  leerModo,
  type ModoMigracionPqr,
} from './migrar-estados-pqr.nucleo';

/** Flags are read before anything connects, so a typo stops the script cold. */
function leerModoODetener(): ModoMigracionPqr {
  try {
    return leerModo(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
const modo = leerModoODetener();

/**
 * Converts the PQRS of the old five-state model to the four stages (runbook
 * `docs/runbooks/pqrs-etapas.md`, backend rule 10). Read-only by default: counts
 * the PQRS per legacy `estado`, writes nothing, exit code 1 when any is pending.
 * `--aplicar` runs one `updateMany` per legacy value; converted rows no longer
 * match, so it is idempotent. Readiness (`pqr-estados`) reports up with a `pendiente` note while
 * any is left; it never fails.
 *
 *   npm run migrar:estados-pqr -- --env=<ambiente>
 *   npm run migrar:estados-pqr -- --env=<ambiente> --aplicar
 */
async function main(): Promise<void> {
  await confirmScriptEnv();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const coleccion = app.get<Model<unknown>>(
      getModelToken(Pqr.name),
    ).collection;
    const conteos: Record<string, number> = {};
    for (const legado of ESTADOS_PQR_LEGADOS) {
      if (modo.aplicar) {
        const { modifiedCount } = await coleccion.updateMany(
          { estado: legado },
          actualizacionPara(legado),
        );
        conteos[legado] = modifiedCount;
      } else {
        conteos[legado] = await coleccion.countDocuments({ estado: legado });
      }
    }
    console.log(informe(conteos, modo.aplicar));
    const pendientes = Object.values(conteos).some((n) => n > 0);
    process.exitCode = !modo.aplicar && pendientes ? 1 : 0;
  } finally {
    await app.close();
  }
}

// Queue/Redis handles keep the event loop alive after app.close().
void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
