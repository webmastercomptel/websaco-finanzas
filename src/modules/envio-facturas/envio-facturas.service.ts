// src/modules/envio-facturas/envio-facturas.service.ts
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type {
  PaginadoEnviosFactura,
  ResultadoMarcadoEnvio,
  ResumenEnvioFacturas,
} from '../../contracts';
import {
  EnvioFactura,
  type EnvioFacturaDocument,
} from '../../database/schemas/facturacion/envio-factura.schema';
import {
  Factura,
  type FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { ListarEnviosFacturasDto } from './dto/listar-envios-facturas.dto';
import type { MarcarEnvioFacturasDto } from './dto/marcar-envio-facturas.dto';
import { contarCola, MAX_POR_PAGINA } from './envio-facturas.constantes';
import { toEnvioFactura } from './envio-facturas.mapper';

/** The account behind a request; a request without one cannot be attributed. */
export function cuentaDe(user: IRequestUser): Types.ObjectId {
  if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) {
    throw new ForbiddenException('No hay una cuenta asociada a esta sesión.');
  }
  return new Types.ObjectId(user.accountId);
}

/** The few invoice fields the queue copies. */
interface FacturaParaCola {
  _id: Types.ObjectId;
  inmuebleId: Types.ObjectId;
  codigoInmueble: string;
  numeroCompleto: string;
  loteId?: Types.ObjectId | null;
  estado: string;
}

/**
 * The staff side of the invoice send queue EXCEPT the processor: mark invoices
 * for sending, list the queue, count it. Marking only queues; it sends NOTHING
 * (delivery is `EnvioFacturasProcesoService`, reachable only from its own
 * explicit route), and no event, cron or setting calls either of them.
 *
 * Every lookup carries `copropiedadId`. A hand-picked list that names an invoice
 * of another coproperty (or one that does not exist) is refused as a whole with
 * the same 404, so ids cannot be probed and a half-valid list never half-applies.
 */
@Injectable()
export class EnvioFacturasService {
  constructor(
    @InjectModel(EnvioFactura.name)
    private readonly envios: Model<EnvioFacturaDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    private readonly tenant: TenantContextService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Queues invoices for sending (`generado -> pendiente_envio`). Idempotent: an
   * invoice already queued or already sent is left alone and counted, so a double
   * click or a retry after a cut request changes nothing. An invoice in `error`
   * is queued again (the retry is this explicit action) keeping the record of who
   * was already reached. Voided invoices are never queued.
   */
  async marcar(
    dto: MarcarEnvioFacturasDto,
    user: IRequestUser,
  ): Promise<ResultadoMarcadoEnvio> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const cuenta = cuentaDe(user);
    const porLote = dto.loteId !== undefined;
    const porLista = dto.facturaIds !== undefined;
    if (porLote === porLista) {
      throw new BadRequestException(
        'Indique el lote (loteId) o la lista de facturas (facturaIds), solo uno de los dos.',
      );
    }

    const facturas = porLote
      ? await this.facturasDelLote(copropiedadId, dto.loteId!)
      : await this.facturasDeLaLista(copropiedadId, dto.facturaIds!);

    const emitidas = facturas.filter((f) => f.estado === 'emitida');
    const omitidasAnuladas = facturas.length - emitidas.length;
    if (emitidas.length === 0) {
      return { marcadas: 0, yaPendientes: 0, yaEnviadas: 0, omitidasAnuladas };
    }

    const idsEmitidas = emitidas.map((f) => f._id);
    const existentes = await this.envios
      .find({ copropiedadId, facturaId: { $in: idsEmitidas } })
      .select('facturaId estado')
      .lean()
      .exec();
    const yaEnviadas = existentes.filter((e) => e.estado === 'enviado').length;
    const conFila = new Set(existentes.map((e) => e.facturaId.toString()));
    const nuevas = emitidas.filter((f) => !conFila.has(f._id.toString()));

    const ahora = new Date();
    const nombre = user.nombre ?? '';
    // Audited BEFORE anything is queued (as the send is): if the audit write
    // fails, no row exists without its `marcar-envio` entry. The label counts
    // what this call is about to queue; a concurrent mark of the same invoices
    // may leave the real number lower (the rows keep `marcadoPor` anyway).
    const aEncolar =
      nuevas.length + existentes.filter((e) => e.estado === 'error').length;
    if (aEncolar > 0) {
      await this.auditoria.registrar({
        actorAccountId: cuenta.toString(),
        actorNombre: nombre,
        accion: 'marcar-envio',
        entidadTipo: 'envio-factura',
        entidadId: porLote ? dto.loteId! : emitidas[0]._id.toString(),
        entidadEtiqueta: `Facturas marcadas para envío: ${aEncolar}`,
      });
    }
    // Insert-only upserts: if two requests race for the same invoice, the unique
    // index lets exactly one create the row and the other changes nothing.
    const insertadas = nuevas.length
      ? (
          await this.envios.bulkWrite(
            nuevas.map((f) => ({
              updateOne: {
                filter: { copropiedadId, facturaId: f._id },
                update: {
                  $setOnInsert: {
                    copropiedadId,
                    facturaId: f._id,
                    inmuebleId: f.inmuebleId,
                    codigoInmueble: f.codigoInmueble,
                    numeroCompleto: f.numeroCompleto,
                    loteId: f.loteId ?? null,
                    estado: 'pendiente_envio',
                    marcadoPorId: cuenta,
                    marcadoPorNombre: nombre,
                    marcadoEn: ahora,
                    procesadoPorId: null,
                    procesadoPorNombre: '',
                    ultimaCorridaId: null,
                    enviadoEn: null,
                    destinatariosTotal: 0,
                    notificadosIds: [],
                    correosEnviadosIds: [],
                    tokenEnvio: null,
                    envioIniciadoEn: null,
                    intentos: 0,
                    proximoIntentoEn: null,
                    ultimoError: null,
                  },
                },
                upsert: true,
              },
            })),
          )
        ).upsertedCount
      : 0;

    const reencoladas = (
      await this.envios
        .updateMany(
          { copropiedadId, facturaId: { $in: idsEmitidas }, estado: 'error' },
          {
            $set: {
              estado: 'pendiente_envio',
              intentos: 0,
              proximoIntentoEn: null,
              ultimoError: null,
              marcadoPorId: cuenta,
              marcadoPorNombre: nombre,
              marcadoEn: ahora,
            },
          },
        )
        .exec()
    ).modifiedCount;

    const marcadas = insertadas + reencoladas;

    return {
      marcadas,
      yaPendientes: Math.max(0, emitidas.length - marcadas - yaEnviadas),
      yaEnviadas,
      omitidasAnuladas,
    };
  }

  /** The queue, newest mark first. */
  async listar(
    filtros: ListarEnviosFacturasDto,
  ): Promise<PaginadoEnviosFactura> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const pagina = filtros.pagina ?? 1;
    const porPagina = Math.min(filtros.porPagina ?? 50, MAX_POR_PAGINA);
    const filtro: Record<string, unknown> = { copropiedadId };
    if (filtros.estado) filtro.estado = filtros.estado;
    if (filtros.loteId) filtro.loteId = new Types.ObjectId(filtros.loteId);

    const [documentos, total] = await Promise.all([
      this.envios
        .find(filtro)
        .sort({ marcadoEn: -1, _id: -1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.envios.countDocuments(filtro).exec(),
    ]);
    return { items: documentos.map(toEnvioFactura), total, pagina, porPagina };
  }

  /** Counts per state, with "pending" meaning exactly what the next processing call would take. */
  async resumen(): Promise<ResumenEnvioFacturas> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [cola, enviadas, conError] = await Promise.all([
      contarCola(this.envios, copropiedadId, new Date()),
      this.envios.countDocuments({ copropiedadId, estado: 'enviado' }).exec(),
      this.envios.countDocuments({ copropiedadId, estado: 'error' }).exec(),
    ]);
    return { ...cola, enviadas, conError };
  }

  private async facturasDelLote(
    copropiedadId: Types.ObjectId,
    loteId: string,
  ): Promise<FacturaParaCola[]> {
    const facturas = await this.facturas
      .find({ copropiedadId, loteId: new Types.ObjectId(loteId) })
      .select('inmuebleId codigoInmueble numeroCompleto loteId estado')
      .sort({ codigoInmueble: 1 })
      .lean()
      .exec();
    if (facturas.length === 0) {
      throw new NotFoundException('El lote no existe o no tiene facturas.');
    }
    return facturas;
  }

  private async facturasDeLaLista(
    copropiedadId: Types.ObjectId,
    ids: string[],
  ): Promise<FacturaParaCola[]> {
    const unicos = [...new Set(ids.map((id) => id.toLowerCase()))];
    const facturas = await this.facturas
      .find({
        copropiedadId,
        _id: { $in: unicos.map((id) => new Types.ObjectId(id)) },
      })
      .select('inmuebleId codigoInmueble numeroCompleto loteId estado')
      .lean()
      .exec();
    // One 404 for "missing" and "belongs to another coproperty": the caller cannot
    // tell them apart, and nothing is queued unless the whole list is theirs.
    if (facturas.length !== unicos.length) {
      throw new NotFoundException(
        'Alguna de las facturas no existe en esta copropiedad.',
      );
    }
    return facturas;
  }
}
