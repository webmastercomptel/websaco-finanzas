// src/modules/integraciones-panel/integraciones-panel.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RegistroPanel } from '../../contracts';
import { escapeRegex } from '../../common/utils/query.utils';
import { normalizarId } from './id-registro';
import { toRegistroPanel } from './integraciones-panel.mapper';

/**
 * Panel system name → the Copropiedad field that stores that link. `finanzas`
 * and `nomina` are not here on purpose: this system IS Finanzas and keeps no
 * Nómina link. `administracion` is not here either: Administración is part of
 * this product now (a contracted module, not a separate system to link), so the
 * panel can no longer set that link. All of them answer 422.
 */
const CAMPO_POR_SISTEMA = {
  comptable: 'comptableEmpresaId',
} as const;

type Campo = (typeof CAMPO_POR_SISTEMA)[keyof typeof CAMPO_POR_SISTEMA];

const LIMITE_MAXIMO = 100;
const LIMITE_POR_DEFECTO = 50;

/**
 * What the integrations panel reads and writes of the coproperty catalogue:
 * the Comptable link field, nothing else. Like `CopropiedadesService` it is NOT
 * tenant-scoped — a coproperty IS the tenant — and the caller is a machine
 * authenticated by `FirmaPanelGuard`.
 *
 * Deliberately independent of `CopropiedadesService` (which Finanzas' own form
 * uses) and of `ComptableClient`: the panel already confirmed the other
 * system's record exists when the person picked it, so no network call is made
 * here. Uniqueness is the panel's rule; the partial unique indexes on both
 * fields stay as the safety net.
 */
@Injectable()
export class IntegracionesPanelService {
  constructor(
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
  ) {}

  /** Active coproperties only, stable order, text search escaped. */
  async listar(filtros: {
    q?: string;
    id?: string;
    pagina?: number;
    limite?: number;
  }): Promise<{ items: RegistroPanel[]; total: number }> {
    const filtro: Record<string, unknown> = { estado: 'active' };
    if (filtros.id) filtro._id = new Types.ObjectId(filtros.id);
    if (filtros.q) {
      const patron = { $regex: escapeRegex(filtros.q), $options: 'i' };
      filtro.$or = [{ codigo: patron }, { nombre: patron }, { nit: patron }];
    }

    const pagina = filtros.pagina ?? 1;
    const limite = Math.min(
      filtros.limite ?? LIMITE_POR_DEFECTO,
      LIMITE_MAXIMO,
    );

    const [documentos, total] = await Promise.all([
      this.copropiedades
        .find(filtro)
        .sort({ nombre: 1, _id: 1 })
        .skip((pagina - 1) * limite)
        .limit(limite)
        .lean()
        .exec(),
      this.copropiedades.countDocuments(filtro).exec(),
    ]);

    return { items: documentos.map(toRegistroPanel), total };
  }

  /**
   * Sets or clears one link, in this order: unknown or inactive record (404),
   * unsupported system (422), same value (idempotent 200), `esperado` mismatch
   * on unlink (409), a different existing value without `forzar` (409), the id
   * already held by another coproperty (409).
   *
   * The write is conditional on the value just read, so two simultaneous
   * requests cannot overwrite each other: the loser matches nothing and gets
   * 409 with the value that won.
   *
   */
  async fijarVinculo(
    id: string,
    dto: {
      sistema: string;
      registroId: string | null;
      forzar?: boolean;
      esperado?: string | null;
    },
  ): Promise<{ sistema: string; registroId: string | null }> {
    const _id = new Types.ObjectId(id);
    const doc = await this.copropiedades
      .findOne({ _id, estado: 'active' })
      .lean()
      .exec();
    if (!doc) {
      throw new NotFoundException({
        code: 'REGISTRO_NO_ENCONTRADO',
        message: 'No existe esa copropiedad (o está inactiva).',
      });
    }

    const campo = this.campoDe(dto.sistema);
    const guardado: unknown = doc[campo];
    const actualCrudo = typeof guardado === 'string' ? guardado : null;
    const actual = actualCrudo === null ? null : normalizarId(actualCrudo);
    const nuevo = dto.registroId === null ? null : normalizarId(dto.registroId);
    const respuesta = { sistema: dto.sistema, registroId: nuevo };

    if (nuevo === actual) {
      return respuesta;
    } else {
      if (
        nuevo === null &&
        dto.esperado != null &&
        normalizarId(dto.esperado) !== actual
      ) {
        throw this.conflictoVinculo(actual);
      }
      if (nuevo !== null && actual !== null && !dto.forzar) {
        throw this.conflictoVinculo(actual);
      }
      if (nuevo !== null) {
        const ocupado = await this.copropiedades
          .exists({ [campo]: nuevo, _id: { $ne: _id } })
          .exec();
        if (ocupado) throw this.conflictoYaVinculado();
      }
    }

    const cambio: Record<string, unknown> = { [campo]: nuevo };

    // The condition is "the field still holds what I just read". Mongoose
    // runs the schema's `lowercase`/`trim` setters on query filters too, so a
    // stored value that is not already normalized would be cast to something
    // that never matches; `$expr` is not cast, so it compares the raw value.
    const condicion =
      actualCrudo === null
        ? { [campo]: null }
        : actualCrudo === actual
          ? { [campo]: actualCrudo }
          : { $expr: { $eq: [`$${campo}`, actualCrudo] } };

    let resultado: { matchedCount: number };
    try {
      resultado = await this.copropiedades
        .updateOne({ _id, estado: 'active', ...condicion }, { $set: cambio })
        .exec();
    } catch (error) {
      throw this.traducirDuplicado(error, campo);
    }

    if (resultado.matchedCount === 0) {
      const releido = await this.copropiedades.findOne({ _id }).lean().exec();
      if (!releido || releido.estado !== 'active') {
        throw new NotFoundException({
          code: 'REGISTRO_NO_ENCONTRADO',
          message: 'La copropiedad dejó de existir o fue inactivada.',
        });
      }
      const valor: unknown = releido[campo];
      const valorActual =
        typeof valor === 'string' ? normalizarId(valor) : null;
      // Lost the race against someone who wrote the very same value: done.
      if (valorActual === nuevo) return respuesta;
      throw this.conflictoVinculo(valorActual);
    }

    return respuesta;
  }

  private campoDe(sistema: string): Campo {
    if (!Object.prototype.hasOwnProperty.call(CAMPO_POR_SISTEMA, sistema)) {
      throw new UnprocessableEntityException({
        code: 'SISTEMA_NO_SOPORTADO',
        message: `Finanzas no guarda un vínculo con "${sistema}".`,
      });
    }
    return CAMPO_POR_SISTEMA[sistema as keyof typeof CAMPO_POR_SISTEMA];
  }

  private conflictoVinculo(valorActual: string | null): ConflictException {
    return new ConflictException({
      code: 'VINCULO_EXISTENTE',
      message: 'La copropiedad ya tiene un vínculo distinto con ese sistema.',
      valorActual,
    });
  }

  private conflictoYaVinculado(): ConflictException {
    return new ConflictException({
      code: 'REGISTRO_YA_VINCULADO',
      message: 'Ese registro ya está vinculado a otra copropiedad.',
    });
  }

  /**
   * A concurrent writer can pass the check above and lose at the unique index
   * (E11000 on the link field): the same business conflict, so 409. Any other
   * error — including an E11000 on another key such as `codigo` — comes back
   * untouched to be rethrown.
   */
  private traducirDuplicado(error: unknown, campo: Campo): unknown {
    const e = error as {
      code?: number;
      keyPattern?: Record<string, unknown>;
      message?: string;
    } | null;
    const esNuestraClave =
      e?.keyPattern?.[campo] !== undefined ||
      (e?.keyPattern === undefined && (e?.message ?? '').includes(campo));
    return e?.code === 11000 && esNuestraClave
      ? this.conflictoYaVinculado()
      : error;
  }
}
