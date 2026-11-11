// src/seed/claves-finanzas-latentes.ts
// MUST stay the first import: it sets the process DNS resolvers before the
// Mongo driver performs its SRV lookup. See common/dns-setup.ts.
import '../common/dns-setup';
// MUST stay the second import, before `../app.module`: it loads `.env.<name>`
// from `--env=<name>` before the config is validated. See load-script-env.ts.
import { confirmScriptEnv } from '../common/scripts/load-script-env';

import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { AppModule } from '../app.module';
import { Rol } from '../database/schemas/administracion/rol.schema';
import { Account } from '../database/schemas/cuentas/account.schema';
import { Asignacion } from '../database/schemas/cuentas/asignacion.schema';
import { Copropiedad } from '../database/schemas/copropiedades/copropiedad.schema';
import { EntidadAdministradora } from '../database/schemas/entidades/entidad-administradora.schema';
import {
  ejecutar,
  informe,
  leerModo,
  type AlmacenClaves,
  type AsignacionLeida,
  type ModoScript,
  type RolLeido,
} from './claves-finanzas-latentes.nucleo';

interface FilaAsignacion {
  _id: Types.ObjectId;
  accountId?: Types.ObjectId;
  perfil?: string | null;
  alcance?: string;
  copropiedadId?: Types.ObjectId | null;
  entidadId?: Types.ObjectId | null;
  estado?: string;
  permisos?: string[];
  roleIds?: Types.ObjectId[];
}

interface FilaRol {
  _id: Types.ObjectId;
  copropiedadId?: Types.ObjectId;
  nombre?: string;
  permisos?: string[];
}

interface FilaConCodigo {
  _id: Types.ObjectId;
  codigo?: string;
}

/**
 * The reads and the conditional write against the real collections. Raw
 * collections like the other conversions: only `permisos` is written, so
 * nothing else of the document (not even `updatedAt`) moves. The decisions
 * live in `claves-finanzas-latentes.nucleo.ts`; this file only moves data.
 */
function almacenMongo(app: INestApplicationContext): AlmacenClaves {
  const coleccion = (nombre: string) =>
    app.get<Model<unknown>>(getModelToken(nombre)).collection;
  const asignaciones = coleccion(Asignacion.name);
  const roles = coleccion(Rol.name);
  const cuentas = coleccion(Account.name);
  const copropiedades = coleccion(Copropiedad.name);
  const entidades = coleccion(EntidadAdministradora.name);

  let filas: FilaAsignacion[] | undefined;
  const leerFilas = async (): Promise<FilaAsignacion[]> => {
    filas ??= await asignaciones.find<FilaAsignacion>({}).toArray();
    return filas;
  };

  const clave = (id: Types.ObjectId | null | undefined) => id?.toString() ?? '';
  const mapa = async <T extends { _id: Types.ObjectId }, V>(
    lecturas: Promise<T[]>,
    valor: (fila: T) => V,
  ): Promise<Map<string, V>> =>
    new Map((await lecturas).map((fila) => [clave(fila._id), valor(fila)]));

  return {
    async leerAsignaciones(): Promise<AsignacionLeida[]> {
      const todas = await leerFilas();
      const unicos = (ids: Array<Types.ObjectId | null | undefined>) => [
        ...new Set(ids.filter((id): id is Types.ObjectId => Boolean(id))),
      ];
      const [emails, codigosCop, codigosEnt] = await Promise.all([
        mapa(
          cuentas
            .find<{ _id: Types.ObjectId; email?: string }>({
              _id: { $in: unicos(todas.map((f) => f.accountId)) },
            })
            .toArray(),
          (c) => c.email ?? '',
        ),
        mapa(
          copropiedades
            .find<FilaConCodigo>({
              _id: { $in: unicos(todas.map((f) => f.copropiedadId)) },
            })
            .toArray(),
          (c) => c.codigo ?? '',
        ),
        mapa(
          entidades
            .find<FilaConCodigo>({
              _id: { $in: unicos(todas.map((f) => f.entidadId)) },
            })
            .toArray(),
          (c) => c.codigo ?? '',
        ),
      ]);
      return todas.map((f) => ({
        id: clave(f._id),
        email: emails.get(clave(f.accountId)) ?? '(cuenta no encontrada)',
        perfil: f.perfil,
        alcance: f.alcance ?? '',
        destino:
          f.alcance === 'entidad'
            ? (codigosEnt.get(clave(f.entidadId)) ?? clave(f.entidadId))
            : (codigosCop.get(clave(f.copropiedadId)) ??
              clave(f.copropiedadId)),
        estado: f.estado ?? '',
        permisos: f.permisos ?? [],
      }));
    },

    async leerRoles(): Promise<RolLeido[]> {
      const todas = await leerFilas();
      const titulares = new Map<string, number>();
      for (const fila of todas) {
        if (fila.estado !== 'active' || fila.alcance !== 'copropiedad') {
          continue;
        }
        for (const rolId of fila.roleIds ?? []) {
          titulares.set(clave(rolId), (titulares.get(clave(rolId)) ?? 0) + 1);
        }
      }
      const delRol = await roles.find<FilaRol>({}).toArray();
      const codigos = await mapa(
        copropiedades
          .find<FilaConCodigo>({
            _id: {
              $in: [
                ...new Set(
                  delRol
                    .map((r) => r.copropiedadId)
                    .filter((id): id is Types.ObjectId => Boolean(id)),
                ),
              ],
            },
          })
          .toArray(),
        (c) => c.codigo ?? '',
      );
      return delRol.map((r) => ({
        id: clave(r._id),
        copropiedad: codigos.get(clave(r.copropiedadId)) ?? '',
        nombre: r.nombre ?? '',
        permisos: r.permisos ?? [],
        titularesActivos: titulares.get(clave(r._id)) ?? 0,
      }));
    },

    async reemplazarPermisos(tipo, id, esperadas, nuevas): Promise<boolean> {
      const destino = tipo === 'rol' ? roles : asignaciones;
      // Matches only while the array is exactly what was read: a document that
      // moved under the script is a conflict, never overwritten.
      const resultado = await destino.updateOne(
        { _id: new Types.ObjectId(id), permisos: [...esperadas] },
        { $set: { permisos: [...nuevas] } },
      );
      return resultado.matchedCount > 0;
    },
  };
}

/** Flags are read before anything connects, so a typo stops the script cold. */
function leerModoODetener(): ModoScript {
  try {
    return leerModo(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
const modo = leerModoODetener();

/**
 * The per-environment conversion around the equipo-delegacion release (backend
 * rule 10, runbook `docs/runbooks/equipo-delegacion.md`). One script, read-only
 * by default:
 *
 *   - default: lists what the pre-deploy conversion would change; writes
 *     nothing; exit code 1 when something is pending, 0 when nothing is.
 *   - `--aplicar`: pre-deploy. Strips every Finanzas key from `personal`
 *     assignments (any scope, any estado) and from roles, expands each Finanzas
 *     `x.gestionar` additively on the other assignments (it stays), and removes
 *     a pre-existing dead `recibos.aprobar` from rows without
 *     `recibos.gestionar`. Run it BEFORE the backend deploy, never after.
 *   - `--retirar-gestionar`: preview (read-only) of the post-deploy cleanup;
 *     lists what would go and warns about rows that lack a real key of the
 *     `x.gestionar` they hold. Exit code 1 when something would be removed.
 *   - `--aplicar --retirar-gestionar`: after the deploy, once a rollback is no
 *     longer wanted; removes the leftover `x.gestionar` (flagged rows skipped).
 *
 * Every write is conditional on the array it read, so a row that changed under
 * the script is reported as a conflict, not overwritten. Idempotent. It also
 * reports, without touching them, Administración keys the catalog does not
 * offer. The rules are in `claves-finanzas-latentes.nucleo.ts`.
 *
 *   npm run revisar:claves-finanzas-latentes -- --env=<ambiente>
 *   npm run revisar:claves-finanzas-latentes -- --env=<ambiente> --aplicar
 *   npm run revisar:claves-finanzas-latentes -- --env=<ambiente> --retirar-gestionar
 *   npm run revisar:claves-finanzas-latentes -- --env=<ambiente> --aplicar --retirar-gestionar
 */
async function main(): Promise<void> {
  await confirmScriptEnv();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const resultado = await ejecutar(modo, almacenMongo(app));
    for (const linea of informe(resultado)) console.log(linea);
    process.exitCode = resultado.codigoSalida;
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
