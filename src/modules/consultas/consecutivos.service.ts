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
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const desde = new Date(query.desde);
    const hasta = new Date(query.hasta);

    const consecutivo = await this.consecutivos
      .findOne({ coPropertyId, code: query.codigo })
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
          coPropertyId,
          consecutivo.code,
          consecutivo.prefix,
          desde,
          hasta,
        );
        break;
      case 'NC':
        filasInternas = await this.filasNotasCredito(
          coPropertyId,
          consecutivo.code,
          consecutivo.prefix,
          desde,
          hasta,
        );
        break;
      case 'ND':
        filasInternas = await this.filasNotasDebito(
          coPropertyId,
          consecutivo.code,
          consecutivo.prefix,
          desde,
          hasta,
        );
        break;
      case 'NT':
        filasInternas = await this.filasNotasContables(
          coPropertyId,
          consecutivo.code,
          consecutivo.prefix,
          desde,
          hasta,
        );
        break;
      case 'FV':
        filasInternas = await this.filasFacturas(
          coPropertyId,
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
          .find({ coPropertyId, _id: { $in: inmuebleIds } })
          .exec()
      : [];
    const codigoPorInmueble = new Map(
      inmueblesDocs.map((i) => [i._id.toString(), i.code]),
    );

    const conceptoIds = [
      ...new Set(
        filasInternas.flatMap((f) => Object.keys(f.cargosPorConcepto)),
      ),
    ].map((id) => new Types.ObjectId(id));
    const conceptosDocs = conceptoIds.length
      ? await this.conceptosCobro
          .find({ coPropertyId, _id: { $in: conceptoIds } })
          .sort({ sortOrder: 1 })
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
        nombre: c.name,
      })),
      filas,
    };
  }

  private async filasRecibos(
    coPropertyId: Types.ObjectId,
    codigo: string,
    prefix: string,
    desde: Date,
    hasta: Date,
  ): Promise<FilaInterna[]> {
    const recibos = await this.recibos
      .find({
        coPropertyId,
        prefix,
        receivedDate: { $gte: desde, $lte: hasta },
      })
      .exec();
    if (recibos.length === 0) return [];

    const reciboIds = recibos.map((r) => r._id);
    const aplicaciones = await this.aplicaciones
      .find({
        coPropertyId,
        sourceType: 'RC',
        sourceId: { $in: reciboIds },
        status: 'activa',
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
      numero: r.number,
      numeroCompleto: r.fullNumber,
      inmuebleId: r.inmuebleId,
      fecha: r.receivedDate.toISOString(),
      valorTotal: r.receivedAmount,
      cargosPorConcepto: cargosPorRecibo.get(r._id.toString()) ?? {},
    }));
  }

  private async filasNotasCredito(
    coPropertyId: Types.ObjectId,
    codigo: string,
    prefix: string,
    desde: Date,
    hasta: Date,
  ): Promise<FilaInterna[]> {
    // `issueDate` is nullable on documents that predate that field — fetch
    // by prefix/status alone and filter by the resolved date in JS, same
    // fallback `fechaNotaCredito` exists for.
    const notas = await this.notasCredito
      .find({ coPropertyId, prefix, status: 'activo' })
      .exec();

    return notas
      .map((n) => ({ nota: n, fecha: fechaNotaCredito(n) }))
      .filter(({ fecha }) => fecha >= desde && fecha <= hasta)
      .map(({ nota: n, fecha }) => {
        const cargosPorConcepto: Record<string, number> = {};
        for (const linea of n.distribution) {
          sumarCargo(
            cargosPorConcepto,
            linea.conceptoId.toString(),
            linea.amount,
          );
        }
        return {
          documentoId: n._id.toString(),
          tipoDocumento: codigo,
          numero: n.number,
          numeroCompleto: n.fullNumber,
          inmuebleId: n.inmuebleId,
          fecha: fecha.toISOString(),
          valorTotal: n.totalAmount,
          cargosPorConcepto,
        };
      });
  }

  private async filasNotasDebito(
    coPropertyId: Types.ObjectId,
    codigo: string,
    prefix: string,
    desde: Date,
    hasta: Date,
  ): Promise<FilaInterna[]> {
    const notas = await this.notasDebito
      .find({
        coPropertyId,
        prefix,
        status: 'emitida',
        issueDate: { $gte: desde, $lte: hasta },
      })
      .exec();

    return notas.map((n) => ({
      documentoId: n._id.toString(),
      tipoDocumento: codigo,
      numero: n.number,
      numeroCompleto: n.fullNumber,
      inmuebleId: n.inmuebleId,
      fecha: n.issueDate.toISOString(),
      valorTotal: n.total,
      cargosPorConcepto: { [n.conceptoId.toString()]: n.total },
    }));
  }

  private async filasNotasContables(
    coPropertyId: Types.ObjectId,
    codigo: string,
    prefix: string,
    desde: Date,
    hasta: Date,
  ): Promise<FilaInterna[]> {
    const notas = await this.notasContables
      .find({ coPropertyId, prefix, status: 'activo' })
      .exec();

    return notas
      .map((n) => ({ nota: n, fecha: fechaNotaContable(n) }))
      .filter(({ fecha }) => fecha >= desde && fecha <= hasta)
      .map(({ nota: n, fecha }) => ({
        documentoId: n._id.toString(),
        tipoDocumento: codigo,
        numero: n.number,
        numeroCompleto: n.fullNumber,
        inmuebleId: n.inmuebleId,
        fecha: fecha.toISOString(),
        valorTotal: n.monto,
        cargosPorConcepto: {
          [n.conceptoOrigenId.toString()]: -n.monto,
          [n.conceptoDestinoId.toString()]: n.monto,
        },
      }));
  }

  private async filasFacturas(
    coPropertyId: Types.ObjectId,
    codigo: string,
    prefix: string,
    desde: Date,
    hasta: Date,
  ): Promise<FilaInterna[]> {
    const facturas = await this.facturas
      .find({
        coPropertyId,
        prefix,
        status: 'emitida',
        issueDate: { $gte: desde, $lte: hasta },
      })
      .exec();

    return facturas.map((f) => {
      const cargosPorConcepto: Record<string, number> = {};
      for (const linea of f.lines) {
        sumarCargo(
          cargosPorConcepto,
          linea.conceptoId.toString(),
          linea.totalAmount,
        );
      }
      return {
        documentoId: f._id.toString(),
        tipoDocumento: codigo,
        numero: f.number,
        numeroCompleto: f.fullNumber,
        inmuebleId: f.inmuebleId,
        fecha: f.issueDate.toISOString(),
        valorTotal: f.total,
        cargosPorConcepto,
      };
    });
  }
}
