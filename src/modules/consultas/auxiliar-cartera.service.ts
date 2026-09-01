import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
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
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type {
  MovimientoKardex,
  RespuestaAuxiliarCartera,
  TipoDocumentoKardex,
} from '../../contracts';
import type { ListarAuxiliarCarteraDto } from './dto/listar-auxiliar-cartera.dto';

type RowRaw = {
  fecha: Date;
  tipo: TipoDocumentoKardex;
  numeroCompleto: string;
  concepto: string;
  refCruce: string | null;
  debito: number | null;
  credito: number | null;
};

/**
 * Read-only kardex service: aggregates movements across all five financial
 * document types for a single inmueble. No persisted entity of its own —
 * only reads.
 */
@Injectable()
export class AuxiliarCarteraService {
  constructor(
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
    private readonly tenant: TenantContextService,
  ) {}

  async findAll(
    query: ListarAuxiliarCarteraDto,
  ): Promise<RespuestaAuxiliarCartera> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const inmuebleId = new Types.ObjectId(query.inmuebleId);
    const desde = new Date(query.desde);
    const hasta = new Date(query.hasta);
    const tiposFilter = query.tipos ?? [...TIPOS_VALIDOS];

    // Step 1: fetch all documents for this inmueble (no date filter — see §5)
    const [facturas, notasDebito, recibos, notasCredito, notasContables] =
      await Promise.all([
        this.facturas
          .find({ coPropertyId, inmuebleId, status: 'emitida' })
          .exec(),
        this.notasDebito
          .find({ coPropertyId, inmuebleId, status: 'emitida' })
          .exec(),
        this.recibos.find({ coPropertyId, inmuebleId }).exec(),
        this.notasCredito.find({ coPropertyId, inmuebleId }).exec(),
        this.notasContables
          .find({ coPropertyId, inmuebleId, status: 'activo' })
          .exec(),
      ]);

    // Step 2: fetch active applications for the source documents (RC + NC)
    const sourceIds = [
      ...recibos.map((r) => r._id),
      ...notasCredito.map((nc) => nc._id),
    ];
    const aplicaciones = sourceIds.length
      ? await this.aplicaciones
          .find({
            coPropertyId,
            sourceId: { $in: sourceIds },
            status: 'activa',
          })
          .exec()
      : [];

    // Step 3: build lookup maps for resolving target document numbers
    const facturaMap = new Map(
      facturas.map((f) => [f._id.toString(), f.fullNumber]),
    );
    const ndMap = new Map(
      notasDebito.map((nd) => [nd._id.toString(), nd.fullNumber]),
    );
    const reciboMap = new Map(
      recibos.map((r) => [r._id.toString(), r.fullNumber]),
    );
    const ncMap = new Map(
      notasCredito.map((nc) => [nc._id.toString(), nc.fullNumber]),
    );

    // Step 4: build raw rows
    const rows: RowRaw[] = [];

    // Facturas → Débito
    for (const f of facturas) {
      rows.push({
        fecha: f.issueDate,
        tipo: 'FC',
        numeroCompleto: f.fullNumber,
        concepto: 'Factura de Venta',
        refCruce: null,
        debito: f.total,
        credito: null,
      });
    }

    // Notas Débito → Débito
    for (const nd of notasDebito) {
      rows.push({
        fecha: nd.issueDate,
        tipo: 'ND',
        numeroCompleto: nd.fullNumber,
        concepto: nd.description ?? 'Nota Débito',
        refCruce: null,
        debito: nd.total,
        credito: null,
      });
    }

    // AplicacionCartera → Crédito
    for (const app of aplicaciones) {
      const sourceType = app.sourceType as TipoDocumentoKardex;
      const sourceNumber =
        sourceType === 'RC'
          ? (reciboMap.get(app.sourceId.toString()) ?? app.sourceId.toString())
          : (ncMap.get(app.sourceId.toString()) ?? app.sourceId.toString());

      const targetMap = app.documentType === 'FV' ? facturaMap : ndMap;
      const refCruce = targetMap.get(app.documentId.toString()) ?? null;

      rows.push({
        fecha: app.appliedAt,
        tipo: sourceType,
        numeroCompleto: sourceNumber,
        concepto: `${sourceType === 'RC' ? 'Recibo' : 'Nota Crédito'} ${sourceNumber}`,
        refCruce,
        debito: null,
        credito: app.amountApplied,
      });
    }

    // Notas Contables → TWO rows each (débito destino, crédito origen)
    // `createdAt` is added by Mongoose `timestamps: true` at runtime but
    // not reflected in the TypeScript type — cast needed.
    for (const nc of notasContables) {
      const fecha = (nc as unknown as { createdAt: Date }).createdAt;
      rows.push({
        fecha,
        tipo: 'NT',
        numeroCompleto: nc.fullNumber,
        concepto: nc.description,
        refCruce: null,
        debito: nc.monto,
        credito: null,
      });
      rows.push({
        fecha,
        tipo: 'NT',
        numeroCompleto: nc.fullNumber,
        concepto: nc.description,
        refCruce: null,
        debito: null,
        credito: nc.monto,
      });
    }

    // Step 5: sort by fecha ascending, then compute running saldo
    rows.sort((a, b) => a.fecha.getTime() - b.fecha.getTime());

    const allMovimientos: MovimientoKardex[] = rows.map((r) => ({
      fecha: r.fecha.toISOString(),
      tipo: r.tipo,
      numeroCompleto: r.numeroCompleto,
      concepto: r.concepto,
      refCruce: r.refCruce,
      debito: r.debito,
      credito: r.credito,
      saldo: 0, // placeholder, computed below
    }));

    let running = 0;
    for (const m of allMovimientos) {
      running += (m.debito ?? 0) - (m.credito ?? 0);
      m.saldo = running;
    }

    // Step 6: compute saldoInicial (sum of movements before `desde`)
    const saldoInicial = allMovimientos
      .filter((m) => new Date(m.fecha) < desde)
      .reduce((sum, m) => sum + (m.debito ?? 0) - (m.credito ?? 0), 0);

    // Step 7: apply date + tipo filters for DISPLAY (saldo already correct)
    const movimientos = allMovimientos.filter(
      (m) =>
        new Date(m.fecha) >= desde &&
        new Date(m.fecha) <= hasta &&
        tiposFilter.includes(m.tipo),
    );

    const totalDebitos = movimientos.reduce(
      (sum, m) => sum + (m.debito ?? 0),
      0,
    );
    const totalCreditos = movimientos.reduce(
      (sum, m) => sum + (m.credito ?? 0),
      0,
    );

    // saldoFinal = saldo of last movement on or before `hasta` (full set)
    const saldoFinal =
      allMovimientos.filter((m) => new Date(m.fecha) <= hasta).pop()?.saldo ??
      saldoInicial;

    return {
      saldoInicial,
      movimientos,
      totalDebitos,
      totalCreditos,
      saldoFinal,
    };
  }
}

const TIPOS_VALIDOS = ['FC', 'RC', 'NC', 'ND', 'NT'] as const;
