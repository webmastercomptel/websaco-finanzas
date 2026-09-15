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
  NotaAnticipo,
  NotaAnticipoDocument,
} from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import {
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { fechaNotaCredito } from '../notas-credito/notas-credito.mapper';
import { fechaNotaContable } from '../notas-contables/notas-contables.mapper';
import { finDelDiaCorte } from './cartera-historica.util';
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
    @InjectModel(NotaAnticipo.name)
    private readonly notasAnticipo: Model<NotaAnticipoDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async findAll(
    query: ListarAuxiliarCarteraDto,
  ): Promise<RespuestaAuxiliarCartera> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const inmuebleId = new Types.ObjectId(query.inmuebleId);
    const desde = new Date(query.desde);
    // A bare "hasta" date, as the frontend defaults it to "today" in
    // Colombia local time, must extend to the end of that LOCAL day (see
    // `finDelDiaCorte`) — otherwise a Recibo applied this evening (whose
    // UTC timestamp already reads as "tomorrow") is excluded from `desde
    // hasta hasta`.
    const hasta = finDelDiaCorte(new Date(query.hasta));

    const inmueble = await this.inmuebles
      .findOne({ _id: inmuebleId, coPropertyId })
      .exec();
    const inmuebleCodigo = inmueble?.code ?? '';
    let propietario: string | null = null;
    if (inmueble?.holderId) {
      const tercero = await this.terceros
        .findOne({ _id: inmueble.holderId, coPropertyId })
        .exec();
      propietario = tercero?.name ?? null;
    }

    // Step 1: fetch all documents for this inmueble (no date filter — see §5)
    //
    // Facturas: NOT status-filtered, on purpose — this is a kardex, and an
    // anulada Factura's débito is a real historical event that still
    // happened (never physically deleted, per the audit law). Voiding it
    // today (via a Nota Crédito, see AnularFacturaService) posts its own
    // crédito row through the AplicacionCartera fetch below; excluding the
    // Factura here would leave that crédito with no matching débito to net
    // against — same reasoning Recibo/NotaCredito already follow (fetched
    // unfiltered right below).
    const [
      facturas,
      notasDebito,
      recibos,
      notasCredito,
      notasContables,
      notasAnticipo,
    ] = await Promise.all([
      this.facturas.find({ coPropertyId, inmuebleId }).exec(),
      this.notasDebito
        .find({ coPropertyId, inmuebleId, status: 'emitida' })
        .exec(),
      this.recibos.find({ coPropertyId, inmuebleId }).exec(),
      this.notasCredito.find({ coPropertyId, inmuebleId }).exec(),
      this.notasContables
        .find({ coPropertyId, inmuebleId, status: 'activo' })
        .exec(),
      this.notasAnticipo.find({ coPropertyId, inmuebleId }).exec(),
    ]);

    // Step 2: fetch active applications for the source documents (RC + NC + NA)
    const sourceIds = [
      ...recibos.map((r) => r._id),
      ...notasCredito.map((nc) => nc._id),
      ...notasAnticipo.map((na) => na._id),
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
    // Each carries the source document's own business date — never
    // `AplicacionCartera.appliedAt`, which is always `new Date()` at cruce
    // time (needed for the accounting entry, posted at the real instant)
    // and can land in a completely different period than the date the user
    // actually declared for the payment. Same reasoning/fix as
    // `estado-cuenta.service.ts`'s own `reciboMap`/`ncMap`.
    const reciboMap = new Map(
      recibos.map((r) => [
        r._id.toString(),
        { fullNumber: r.fullNumber, fecha: r.receivedDate },
      ]),
    );
    const ncMap = new Map(
      notasCredito.map((nc) => [
        nc._id.toString(),
        { fullNumber: nc.fullNumber, fecha: fechaNotaCredito(nc) },
      ]),
    );
    const naMap = new Map(
      notasAnticipo.map((na) => [
        na._id.toString(),
        { fullNumber: na.fullNumber, fecha: na.issueDate },
      ]),
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
    const mapaPorTipo: Record<
      'RC' | 'NC' | 'NA',
      {
        mapa: Map<string, { fullNumber: string; fecha: Date }>;
        etiqueta: string;
      }
    > = {
      RC: { mapa: reciboMap, etiqueta: 'Recibo' },
      NC: { mapa: ncMap, etiqueta: 'Nota Crédito' },
      NA: { mapa: naMap, etiqueta: 'Nota de Anticipo' },
    };
    for (const app of aplicaciones) {
      const sourceType = app.sourceType;
      const { mapa, etiqueta } = mapaPorTipo[sourceType];
      const origen = mapa.get(app.sourceId.toString());
      const sourceNumber = origen?.fullNumber ?? app.sourceId.toString();

      const targetMap = app.documentType === 'FV' ? facturaMap : ndMap;
      const refCruce = targetMap.get(app.documentId.toString()) ?? null;

      rows.push({
        fecha: origen?.fecha ?? app.appliedAt,
        tipo: sourceType,
        numeroCompleto: sourceNumber,
        concepto: `${etiqueta} ${sourceNumber}`,
        refCruce,
        debito: null,
        credito: app.amountApplied,
      });
    }

    // Notas Contables → TWO rows each (débito destino, crédito origen).
    // `fechaNotaContable` — never `createdAt` directly: that's the real
    // server instant the record was INSERTED, which can land in a
    // completely different month than the note's own declared business
    // date (bug real reportado: una nota fechada en junio apareció con
    // fecha de septiembre porque se guardó/editó ese día).
    for (const nc of notasContables) {
      const fecha = fechaNotaContable(nc);
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

    // Step 7: apply the date range for DISPLAY (saldo already correct)
    const movimientos = allMovimientos.filter(
      (m) => new Date(m.fecha) >= desde && new Date(m.fecha) <= hasta,
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
      inmuebleId: query.inmuebleId,
      inmuebleCodigo,
      propietario,
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
      saldoInicial,
      movimientos,
      totalDebitos,
      totalCreditos,
      saldoFinal,
    };
  }
}
