// src/modules/configuracion/cuentas-contables/cuentas-contables.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CuentaContable,
  CuentaContableDocument,
} from '../../../database/schemas/contabilidad/cuenta-contable.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../../database/schemas/conceptos/concepto-cobro.schema';
import {
  AsientoContable,
  AsientoContableDocument,
} from '../../../database/schemas/facturacion/asiento-contable.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../../database/schemas/copropiedades/copropiedad.schema';
import type { CuentaContableContract, Paginado } from '../../../contracts';
import { toCuentaContable } from './cuentas-contables.mapper';
import type { ListarCuentasDto } from './dto/listar-cuentas.dto';
import type {
  ActualizarCuentaDto,
  CrearCuentaDto,
} from './dto/guardar-cuenta.dto';
import type { ImportarCuentasDto } from './dto/importar-cuentas.dto';
import type { ResultadoImportacionCuentas } from '../../../contracts';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { escapeRegex } from '../../../common/utils/query.utils';

@Injectable()
export class CuentasContablesService {
  constructor(
    @InjectModel(CuentaContable.name)
    private readonly cuentas: Model<CuentaContableDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
    @InjectModel(AsientoContable.name)
    private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async findAll(
    query: ListarCuentasDto,
  ): Promise<Paginado<CuentaContableContract>> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { copropiedadId };

    if (query.estado !== 'todos') {
      filtro.activo = query.estado !== 'inactivo';
    }
    if (query.buscar) {
      const patron = { $regex: escapeRegex(query.buscar), $options: 'i' };
      filtro.$or = [{ codigo: patron }, { nombre: patron }];
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.cuentas
        .find(filtro)
        .sort({ codigo: 1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.cuentas.countDocuments(filtro).exec(),
    ]);

    return {
      items: documentos.map(toCuentaContable),
      total,
      pagina,
      porPagina,
    };
  }

  async findOne(id: string): Promise<CuentaContableContract> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const doc = await this.cuentas.findOne({ _id: id, copropiedadId }).exec();
    if (!doc) {
      throw new NotFoundException(`No se encontró la cuenta ${id}`);
    }
    return toCuentaContable(doc);
  }

  async create(dto: CrearCuentaDto): Promise<CuentaContableContract> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const yaExiste = await this.cuentas
      .exists({ copropiedadId, codigo: dto.codigo })
      .exec();
    if (yaExiste) {
      throw new ConflictException(
        `Ya existe una cuenta con el código ${dto.codigo}`,
      );
    }

    const creada = await this.cuentas.create({
      copropiedadId,
      codigo: dto.codigo,
      nombre: dto.nombre,
      requiereTercero: dto.requiereTercero ?? false,
      esBanco: dto.esBanco ?? false,
      flujoCaja: dto.flujoCaja ?? false,
      centroUtilidad: dto.centroUtilidad ?? false,
      centroDestino: dto.centroDestino ?? false,
      requiereDocumentoCruce: dto.requiereDocumentoCruce ?? false,
      aplicaImpuesto: dto.aplicaImpuesto ?? false,
      tasaImpuesto: dto.tasaImpuesto ?? 0,
    });

    return toCuentaContable(creada);
  }

  /**
   * Loads a chart-of-accounts file in one act: one row, one account. Reuses
   * `create` per row — same duplicate-code check, same field mapping — so
   * a bad row fails on its own without aborting the rest (mirrors
   * `InmueblesService.importar`'s per-row independence, though nothing here
   * is destructive the way that import's roster wipe is — see
   * `ValoresRecurrentesService.importarMasivo`'s own note on why a
   * `codigoCopropiedad` mismatch is checked per row instead of aborting the
   * whole file).
   */
  async importar(
    dto: ImportarCuentasDto,
  ): Promise<ResultadoImportacionCuentas> {
    const copropiedadId = this.tenant.resolveCoPropertyId();

    // `_id` IS the tenant id here — findById is correct, not the trap (see
    // backend/CLAUDE.md's own note on this exact mistake).
    const copropiedad = await this.copropiedades.findById(copropiedadId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${copropiedadId.toString()}`,
      );
    }

    const errores: ResultadoImportacionCuentas['errores'] = [];
    let creados = 0;

    for (const [indice, fila] of dto.filas.entries()) {
      try {
        if (fila.codigoCopropiedad !== copropiedad.code) {
          throw new Error(
            `El código de copropiedad "${fila.codigoCopropiedad}" no coincide con el de la copropiedad activa (${copropiedad.code})`,
          );
        }

        await this.create(fila);
        creados += 1;
      } catch (err) {
        errores.push({
          fila: indice + 1,
          codigo: fila.codigo ?? null,
          mensaje: err instanceof Error ? err.message : 'Error desconocido',
        });
      }
    }

    return { total: dto.filas.length, creados, errores };
  }

  async update(
    id: string,
    dto: ActualizarCuentaDto,
  ): Promise<CuentaContableContract> {
    const copropiedadId = this.tenant.resolveCoPropertyId();

    if (dto.codigo) {
      const choca = await this.cuentas
        .exists({ copropiedadId, codigo: dto.codigo, _id: { $ne: id } })
        .exec();
      if (choca) {
        throw new ConflictException(
          `Ya existe otra cuenta con el código ${dto.codigo}`,
        );
      }
    }

    const update: Record<string, unknown> = {};
    const set = (k: string, v: unknown): void => {
      if (v !== undefined) update[k] = v;
    };

    set('codigo', dto.codigo);
    set('nombre', dto.nombre);
    set('requiereTercero', dto.requiereTercero);
    set('esBanco', dto.esBanco);
    set('flujoCaja', dto.flujoCaja);
    set('centroUtilidad', dto.centroUtilidad);
    set('centroDestino', dto.centroDestino);
    set('requiereDocumentoCruce', dto.requiereDocumentoCruce);
    set('aplicaImpuesto', dto.aplicaImpuesto);
    set('tasaImpuesto', dto.tasaImpuesto);
    if (dto.activo !== undefined) {
      update.activo = dto.activo;
    }

    const actualizada = await this.cuentas
      .findOneAndUpdate(
        { _id: id, copropiedadId },
        { $set: update },
        { returnDocument: 'after' },
      )
      .exec();

    if (!actualizada) {
      throw new NotFoundException(`No se encontró la cuenta ${id}`);
    }
    return toCuentaContable(actualizada);
  }

  async delete(id: string): Promise<void> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const cuenta = await this.cuentas
      .findOne({ _id: id, copropiedadId })
      .exec();
    if (!cuenta) {
      throw new NotFoundException(`No se encontró la cuenta ${id}`);
    }

    const [enConceptos, enAsientos, enCopropiedad] = await Promise.all([
      this.conceptos
        .exists({
          copropiedadId,
          $or: [
            { cuentaDebitoId: cuenta._id },
            { cuentaCreditoId: cuenta._id },
          ],
        })
        .exec(),
      this.asientos
        .exists({ copropiedadId, 'entries.account': cuenta.codigo })
        .exec(),
      this.copropiedades
        .exists({
          _id: copropiedadId,
          $or: [
            { receivablesAccount: cuenta.codigo },
            { advancesAccount: cuenta.codigo },
            { creditNotesAccount: cuenta.codigo },
            { debitNotesAccount: cuenta.codigo },
            { defaultBankAccountCode: cuenta.codigo },
          ],
        })
        .exec(),
    ]);

    if (enConceptos) {
      throw new ConflictException(
        'Esta cuenta está asignada como cuenta débito o crédito de uno o más cargos',
      );
    }
    if (enAsientos) {
      throw new ConflictException(
        'Esta cuenta ya tiene movimientos contables registrados y no puede eliminarse',
      );
    }
    if (enCopropiedad) {
      throw new ConflictException(
        'Esta cuenta está configurada como cuenta predeterminada de la copropiedad',
      );
    }

    await this.cuentas.deleteOne({ _id: id, copropiedadId }).exec();
  }
}
