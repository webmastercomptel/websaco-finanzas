import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ConsecutivoDocumento,
  ConsecutivoDocumentoDocument,
} from '../../database/schemas/numeracion/consecutivo-documento.schema';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import {
  NotaCredito,
  NotaCreditoDocument,
} from '../../database/schemas/notas-credito/nota-credito.schema';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../../database/schemas/notas-debito/nota-debito.schema';
import {
  NotaContable,
  NotaContableDocument,
} from '../../database/schemas/notas-contables/nota-contable.schema';
import {
  NotaAnticipo,
  NotaAnticipoDocument,
} from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import {
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { fechaNotaCredito } from '../notas-credito/notas-credito.mapper';
import { fechaNotaContable } from '../notas-contables/notas-contables.mapper';
import type { FilaConsecutivo, RespuestaConsecutivos } from '../../contracts';
import type { ConsultarConsecutivosDto } from './dto/consultar-consecutivos.dto';

/** One row before its `inmuebleId` is resolved to a código. */
type FilaInterna = Omit<FilaConsecutivo, 'inmuebleCodigo'> & {
  inmuebleId: Types.ObjectId;
  numero: number;
};

const sumarCargo = (
  cargos: Record<string, number>,
  conceptoId: string,
  monto: number,
): void => {
  cargos[conceptoId] = (cargos[conceptoId] ?? 0) + monto;
};

/**
 * "Consecutivos": every document of ONE type (a "código" from the
 * coproperty's own Tabla de Documentos, e.g. "RC", "NC", "ND", "NT" —
 * `ConsecutivoDocumento`), issued within one period, broken down by charge
 * concept. A sequential audit listing, not a cartera balance — voided
 * documents are excluded, same convention `ConsultaFacturacionService`
 * already uses for its own per-lote listing (a `status: 'anulada'` document
 * must not inflate these totals).
 *
 * Each document type resolves its own `cargosPorConcepto` from whichever
 * field already carries that breakdown at the model level — never a
 * reconstruction:
 *  - Nota Débito: its own single `conceptoId` + `total`.
 *  - Nota Crédito: its own `distribution` (how the credit corrects the
 *    anchor invoice's concepts).
 *  - Nota Contable: `conceptoOrigenId` (negative) / `conceptoDestinoId`
 *    (positive) — a reclassification, not a new charge, nets to zero.
 *  - Recibo: has no concept breakdown of its own — summed from every active
 *    `AplicacionCartera.detalleConceptos` where this Recibo is the source,
 *    the exact per-concepto split recorded when each application posted.
 *  - Factura (only reachable when a coproperty has no active
 *    ResolucionFacturacion and falls back to a plain `ConsecutivoDocumento`
 *    row for invoicing — see `NumeracionService.siguienteFactura`): its own
 *    `lines`.
 *
 * Category `NT` covers two DIFFERENT document collections sharing the one
 * closed-category type: a plain reclassification lands in `NotaContable`,
 * while a Nota de Anticipo (`CrearNotaAnticipoDto` explicitly reuses
 * category NT — see its own docblock) lands in `NotaAnticipo`. Nothing at
 * the `ConsecutivoDocumento` level says which collection a given código
 * feeds, so an `NT` lookup queries both by `prefix` and concatenates — only
 * one of the two ever actually matches a real código in practice. Missing
 * this was a real bug: a Nota de Anticipo's own código never appeared in
 * this report because only `NotaContable` was queried.
 */
@Injectable()
export class ConsecutivosService {
  constructor(
    @InjectModel(ConsecutivoDocumento.name)
    private readonly consecutivos: Model<ConsecutivoDocumentoDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(NotaCredito.name)
    private readonly notasCredito: Model<NotaCreditoDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(NotaContable.name)
    private readonly notasContables: Model<NotaContableDocument>,
    @InjectModel(NotaAnticipo.name)
    private readonly notasAnticipo: Model<NotaAnticipoDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptosCobro: Model<ConceptoCobroDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async findAll(
    query: ConsultarConsecutivosDto,
  ): Promise<RespuestaConsecutivos> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const desde = new Date(query.desde);
    const hasta = new Date(query.hasta);

    const consecutivo = await this.consecutivos
      .findOne({ copropiedadId, code: query.codigo })
      .exec();
    if (!consecutivo) {
      throw new NotFoundException(
        `No existe el tipo de documento "${query.codigo}" en la Tabla de Documentos de esta copropiedad.`,
      );
    }

    let filasInternas: FilaInterna[];
    switch (consecutivo.category) {
      case 'IN':
        filasInternas = await this.filasRecibos(
          copropiedadId,
          consecutivo.code,
          consecutivo.prefix,
          desde,
          hasta,
        );
        break;
      case 'NC':
        filasInternas = await this.filasNotasCredito(
          copropiedadId,
          consecutivo.code,
          consecutivo.prefix,
          desde,
          hasta,
        );
        break;
      case 'ND':
        filasInternas = await this.filasNotasDebito(
          copropiedadId,
          consecutivo.code,
          consecutivo.prefix,
          desde,
          hasta,
        );
        break;
      case 'NT':
        filasInternas = [
          ...(await this.filasNotasContables(
            copropiedadId,
            consecutivo.code,
            consecutivo.prefix,
            desde,
            hasta,
          )),
          ...(await this.filasNotasAnticipo(
            copropiedadId,
            consecutivo.code,
            consecutivo.prefix,
            desde,
            hasta,
          )),
        ];
        break;
      case 'FV':
        filasInternas = await this.filasFacturas(
          copropiedadId,
          consecutivo.code,
          consecutivo.prefix,
          desde,
          hasta,
        );
        break;
    }

    filasInternas.sort((a, b) => a.numero - b.numero);

    const inmuebleIds = [
      ...new Set(filasInternas.map((f) => f.inmuebleId.toString())),
    ].map((id) => new Types.ObjectId(id));
    const inmueblesDocs = inmuebleIds.length
      ? await this.inmuebles
          .find({ copropiedadId, _id: { $in: inmuebleIds } })
          .exec()
      : [];
    const codigoPorInmueble = new Map(
      inmueblesDocs.map((i) => [i._id.toString(), i.codigo]),
    );

    const conceptoIds = [
      ...new Set(
        filasInternas.flatMap((f) => Object.keys(f.cargosPorConcepto)),
      ),
    ].map((id) => new Types.ObjectId(id));
    const conceptosDocs = conceptoIds.length
      ? await this.conceptosCobro
          .find({ copropiedadId, _id: { $in: conceptoIds } })
          .sort({ orden: 1 })
          .exec()
      : [];

    const filas: FilaConsecutivo[] = filasInternas.map(
      ({ inmuebleId, numero: _numero, ...f }) => ({
        ...f,
        inmuebleCodigo: codigoPorInmueble.get(inmuebleId.toString()) ?? '',
      }),
    );

    return {
      conceptos: conceptosDocs.map((c) => ({
        conceptoId: c._id.toString(),
        nombre: c.nombre,
      })),
      filas,
    };
  }

  private async filasRecibos(
    copropiedadId: Types.ObjectId,
    codigo: string,
    prefix: string,
    desde: Date,
    hasta: Date,
  ): Promise<FilaInterna[]> {
    const recibos = await this.recibos
      .find({
        copropiedadId,
        prefijo: prefix,
        fechaRecibo: { $gte: desde, $lte: hasta },
      })
      .exec();
    if (recibos.length === 0) return [];

    const reciboIds = recibos.map((r) => r._id);
    const aplicaciones = await this.aplicaciones
      .find({
        copropiedadId,
        sourceType: 'RC',
        sourceId: { $in: reciboIds },
        estado: 'activa',
      })
      .exec();

    const cargosPorRecibo = new Map<string, Record<string, number>>();
    for (const app of aplicaciones) {
      const key = app.sourceId.toString();
      const cargos = cargosPorRecibo.get(key) ?? {};
      for (const detalle of app.detalleConceptos) {
        sumarCargo(cargos, detalle.conceptoId.toString(), detalle.monto);
      }
      cargosPorRecibo.set(key, cargos);
    }

    return recibos.map((r) => ({
      documentoId: r._id.toString(),
      tipoDocumento: codigo,
      numero: r.numero,
      numeroCompleto: r.numeroCompleto,
      inmuebleId: r.inmuebleId,
      fecha: r.fechaRecibo.toISOString(),
      valorTotal: r.montoRecibido,
      cargosPorConcepto: cargosPorRecibo.get(r._id.toString()) ?? {},
    }));
  }

  private async filasNotasCredito(
    copropiedadId: Types.ObjectId,
    codigo: string,
    prefix: string,
    desde: Date,
    hasta: Date,
  ): Promise<FilaInterna[]> {
    // `fecha` is nullable on documents that predate that field — fetch
    // by prefix/status alone and filter by the resolved date in JS, same
    // fallback `fechaNotaCredito` exists for.
    const notas = await this.notasCredito
      .find({ copropiedadId, prefijo: prefix, estado: 'activo' })
      .exec();

    return notas
      .map((n) => ({ nota: n, fecha: fechaNotaCredito(n) }))
      .filter(({ fecha }) => fecha >= desde && fecha <= hasta)
      .map(({ nota: n, fecha }) => {
        const cargosPorConcepto: Record<string, number> = {};
        for (const linea of n.distribucion) {
          sumarCargo(
            cargosPorConcepto,
            linea.conceptoId.toString(),
            linea.monto,
          );
        }
        return {
          documentoId: n._id.toString(),
          tipoDocumento: codigo,
          numero: n.numero,
          numeroCompleto: n.numeroCompleto,
          inmuebleId: n.inmuebleId,
          fecha: fecha.toISOString(),
          valorTotal: n.montoTotal,
          cargosPorConcepto,
        };
      });
  }

  private async filasNotasDebito(
    copropiedadId: Types.ObjectId,
    codigo: string,
    prefix: string,
    desde: Date,
    hasta: Date,
  ): Promise<FilaInterna[]> {
    const notas = await this.notasDebito
      .find({
        copropiedadId,
        prefijo: prefix,
        estado: 'emitida',
        fechaEmision: { $gte: desde, $lte: hasta },
      })
      .exec();

    return notas.map((n) => ({
      documentoId: n._id.toString(),
      tipoDocumento: codigo,
      numero: n.numero,
      numeroCompleto: n.numeroCompleto,
      inmuebleId: n.inmuebleId,
      fecha: n.fechaEmision.toISOString(),
      valorTotal: n.total,
      cargosPorConcepto: { [n.conceptoId.toString()]: n.total },
    }));
  }

  private async filasNotasContables(
    copropiedadId: Types.ObjectId,
    codigo: string,
    prefix: string,
    desde: Date,
    hasta: Date,
  ): Promise<FilaInterna[]> {
    const notas = await this.notasContables
      .find({ copropiedadId, prefijo: prefix, estado: 'activo' })
      .exec();

    return notas
      .map((n) => ({ nota: n, fecha: fechaNotaContable(n) }))
      .filter(({ fecha }) => fecha >= desde && fecha <= hasta)
      .map(({ nota: n, fecha }) => ({
        documentoId: n._id.toString(),
        tipoDocumento: codigo,
        numero: n.numero,
        numeroCompleto: n.numeroCompleto,
        inmuebleId: n.inmuebleId,
        fecha: fecha.toISOString(),
        valorTotal: n.monto,
        cargosPorConcepto: {
          [n.conceptoOrigenId.toString()]: -n.monto,
          [n.conceptoDestinoId.toString()]: n.monto,
        },
      }));
  }

  private async filasNotasAnticipo(
    copropiedadId: Types.ObjectId,
    codigo: string,
    prefix: string,
    desde: Date,
    hasta: Date,
  ): Promise<FilaInterna[]> {
    const notas = await this.notasAnticipo
      .find({
        copropiedadId,
        prefijo: prefix,
        estado: 'activo',
        fechaEmision: { $gte: desde, $lte: hasta },
      })
      .exec();
    if (notas.length === 0) return [];

    const notaIds = notas.map((n) => n._id);
    const aplicaciones = await this.aplicaciones
      .find({
        copropiedadId,
        sourceType: 'NA',
        sourceId: { $in: notaIds },
        estado: 'activa',
      })
      .exec();

    const cargosPorNota = new Map<string, Record<string, number>>();
    for (const app of aplicaciones) {
      const key = app.sourceId.toString();
      const cargos = cargosPorNota.get(key) ?? {};
      for (const detalle of app.detalleConceptos) {
        sumarCargo(cargos, detalle.conceptoId.toString(), detalle.monto);
      }
      cargosPorNota.set(key, cargos);
    }

    return notas.map((n) => ({
      documentoId: n._id.toString(),
      tipoDocumento: codigo,
      numero: n.numero,
      numeroCompleto: n.numeroCompleto,
      inmuebleId: n.inmuebleId,
      fecha: n.fechaEmision.toISOString(),
      valorTotal: n.montoAplicado,
      cargosPorConcepto: cargosPorNota.get(n._id.toString()) ?? {},
    }));
  }

  private async filasFacturas(
    copropiedadId: Types.ObjectId,
    codigo: string,
    prefix: string,
    desde: Date,
    hasta: Date,
  ): Promise<FilaInterna[]> {
    const facturas = await this.facturas
      .find({
        copropiedadId,
        prefijo: prefix,
        estado: 'emitida',
        fechaEmision: { $gte: desde, $lte: hasta },
      })
      .exec();

    return facturas.map((f) => {
      const cargosPorConcepto: Record<string, number> = {};
      for (const linea of f.lineas) {
        sumarCargo(
          cargosPorConcepto,
          linea.conceptoId.toString(),
          linea.valorTotal,
        );
      }
      return {
        documentoId: f._id.toString(),
        tipoDocumento: codigo,
        numero: f.numero,
        numeroCompleto: f.numeroCompleto,
        inmuebleId: f.inmuebleId,
        fecha: f.fechaEmision.toISOString(),
        valorTotal: f.total,
        cargosPorConcepto,
      };
    });
  }
}
