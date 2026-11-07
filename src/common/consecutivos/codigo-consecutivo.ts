// src/common/consecutivos/codigo-consecutivo.ts
import type { Model } from 'mongoose';
import type { ConsecutivoAdministracionDocument } from '../../database/schemas/administracion/consecutivo-administracion.schema';

/**
 * Next number of the sequence stored under `clave`. One `findOneAndUpdate` with
 * `$inc` + `upsert`, so concurrent callers never get the same number. A number
 * is not recycled if the caller later fails to save its record: a gap in a
 * support-ticket code is harmless, a duplicate is not.
 */
export async function siguienteNumero(
  consecutivos: Model<ConsecutivoAdministracionDocument>,
  clave: string,
): Promise<number> {
  const consecutivo = await consecutivos
    .findOneAndUpdate(
      { clave },
      { $inc: { valor: 1 } },
      { upsert: true, new: true },
    )
    .exec();
  return consecutivo.valor;
}

/**
 * Next human-readable code for a prefix (`PQR-007`), from the sequence stored
 * under that same prefix. For a sequence keyed differently from the prefix it
 * prints (e.g. one per coproperty), use `siguienteNumero` and format it.
 */
export async function siguienteCodigo(
  consecutivos: Model<ConsecutivoAdministracionDocument>,
  prefijo: string,
  ancho = 3,
): Promise<string> {
  const numero = await siguienteNumero(consecutivos, prefijo);
  return `${prefijo}-${String(numero).padStart(ancho, '0')}`;
}

/**
 * Parks a prefix's counter at `minimo` or above, never lowering it (`$max`).
 * Used when importing records that already carry codes, so new records do not
 * collide with them.
 */
export async function asegurarConsecutivoMinimo(
  consecutivos: Model<ConsecutivoAdministracionDocument>,
  prefijo: string,
  minimo: number,
): Promise<void> {
  await consecutivos
    .updateOne(
      { clave: prefijo },
      { $max: { valor: minimo } },
      { upsert: true },
    )
    .exec();
}
