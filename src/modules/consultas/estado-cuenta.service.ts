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
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type {
  MovimientoEstadoCuenta,
  PeriodoFacturado,
  RespuestaEstadoCuenta,
  TipoDocumentoKardex,
} from '../../contracts';
import type { ConsultarEstadoCuentaDto } from './dto/consultar-estado-cuenta.dto';

type RowRaw = {
  fecha: Date;
  tipo: TipoDocumentoKardex;
  numeroCompleto: string;
  concepto: string;
  cargo: number | null;
  abono: number | null;
  categoria: 'pago' | 'descuento' | null;
};

/**
 * Read-only owner's statement service. Generates a document-shaped statement
 * for one inmueble and one billing period, intended to be printed or saved as
 * PDF and handed to a propietario.
 */
@Injectable()
export class EstadoCuentaService {
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
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Every distinct (periodStart, periodEnd) pair from that inmueble's
   * Facturas, sorted most-recent-first.
   */
  async findPeriodos(inmuebleId: string): Promise<PeriodoFacturado[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const oid = new Types.ObjectId(inmuebleId);

    const facturas = await this.facturas
      .find({ coPropertyId, inmuebleId: oid, status: 'emitida' })
      .sort({ periodoDesde: -1 })
      .exec();

    // Deduplicate by (periodStart, periodEnd) — at most one per lote run
    const seen = new Set<string>();
    const result: PeriodoFacturado[] = [];
    for (const f of facturas) {
      const key = `${f.periodStart.toISOString()}|${f.periodEnd.toISOString()}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          periodStart: f.periodStart.toISOString(),
          periodEnd: f.periodEnd.toISOString(),
        });
      }
    }
    return result;
  }

  /**
   * Full owner's statement for one inmueble and one billing period.
   */
  async findAll(query: ConsultarEstadoCuentaDto): Promise<RespuestaEstadoCuenta> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const inmuebleId = new Types.ObjectId(query.inmuebleId);
    const desde = new Date(query.periodStart);
    const hasta = new Date(query.periodEnd);

    // Fetch inmueble for code + holderId
    const inmueble = await this.inmuebles.findById(inmuebleId).exec();
    const inmuebleCodigo = inmueble?.code ?? '';
    const holderId = inmueble?.holderId ?? null;

    // Resolve propietario name
    let propietario: string | null = null;
    if (holderId) {
      const tercero = await this.terceros.findById(holderId).exec();
      propietario = tercero?.name ?? null;
    }

    // Fetch copropiedad for contact info
    const copropiedad = await this.copropiedades
      .findById(coPropertyId)
      .exec();
    const copropiedadTelefono = copropiedad?.phone ?? null;
    const copropiedadEmail = copropiedad?.email ?? null;

    // Find the period's own Factura for fechaEmision/vencimiento
    const facturaPeriodo = await this.facturas
      .findOne({
        coPropertyId,
        inmuebleId,
        status: 'emitida',
        periodoDesde: desde,
        periodoHasta: hasta,
      })
      .exec();

    const fechaEmision = facturaPeriodo?.issueDate?.toISOString() ?? desde.toISOString();
    const vencimiento = facturaPeriodo?.dueDate?.toISOString() ?? hasta.toISOString();

    // Step 1: fetch all documents for this inmueble (no date filter — see spec §5)
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

    // Step 2: fetch active applications for RC + NC sources
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

    // Step 3: build lookup maps
    const reciboMap = new Map(
      recibos.map((r) => [r._id.toString(), r.fullNumber]),
    );
    const ncMap = new Map(
      notasCredito.map((nc) => [nc._id.toString(), nc.fullNumber]),
    );

    // Step 4: build raw rows
    const rows: RowRaw[] = [];

    // Facturas → débito
    for (const f of facturas) {
      rows.push({
        fecha: f.issueDate,
        tipo: 'FC',
        numeroCompleto: f.fullNumber,
        concepto: 'Factura de Venta',
        cargo: f.total,
        abono: null,
        categoria: null,
      });
    }

    // Notas Débito → débito
    for (const nd of notasDebito) {
      rows.push({
        fecha: nd.issueDate,
        tipo: 'ND',
        numeroCompleto: nd.fullNumber,
        concepto: nd.description ?? 'Nota Débito',
        cargo: nd.total,
        abono: null,
        categoria: null,
      });
    }

    // AplicacionCartera → crédito with categoria
    for (const app of aplicaciones) {
      const sourceType = app.sourceType as TipoDocumentoKardex;
      const sourceNumber =
        sourceType === 'RC'
          ? (reciboMap.get(app.sourceId.toString()) ?? app.sourceId.toString())
          : (ncMap.get(app.sourceId.toString()) ?? app.sourceId.toString());

      rows.push({
        fecha: app.appliedAt,
        tipo: sourceType,
        numeroCompleto: sourceNumber,
        concepto: `${sourceType === 'RC' ? 'Recibo' : 'Nota Crédito'} ${sourceNumber}`,
        cargo: null,
        abono: app.amountApplied,
        categoria: sourceType === 'RC' ? 'pago' : 'descuento',
      });
    }

    // Notas Contables → TWO rows each (débito + crédito, net zero)
    for (const nc of notasContables) {
      const fecha = (nc as unknown as { createdAt: Date }).createdAt;
      rows.push({
        fecha,
        tipo: 'NT',
        numeroCompleto: nc.fullNumber,
        concepto: nc.description,
        cargo: nc.monto,
        abono: null,
        categoria: null,
      });
      rows.push({
        fecha,
        tipo: 'NT',
        numeroCompleto: nc.fullNumber,
        concepto: nc.description,
        cargo: null,
        abono: nc.monto,
        categoria: null,
      });
    }

    // Step 5: sort by fecha ascending
    rows.sort((a, b) => a.fecha.getTime() - b.fecha.getTime());

    // Step 6: saldoAnterior — sum of movements strictly before periodStart
    const saldoAnterior = rows
      .filter((r) => r.fecha < desde)
      .reduce((sum, r) => sum + (r.cargo ?? 0) - (r.abono ?? 0), 0);

    // Step 7: movements within [periodStart, periodEnd]
    const movimientosEnPeriodo = rows.filter(
      (r) => r.fecha >= desde && r.fecha <= hasta,
    );

    // Step 8: bucket into summary numbers
    const cargosDelMes = movimientosEnPeriodo.reduce(
      (sum, r) => sum + (r.cargo ?? 0),
      0,
    );
    const pagosRecibidos = movimientosEnPeriodo
      .filter((r) => r.categoria === 'pago')
      .reduce((sum, r) => sum + (r.abono ?? 0), 0);
    const descuentosAjustes = movimientosEnPeriodo
      .filter((r) => r.categoria === 'descuento')
      .reduce((sum, r) => sum + (r.abono ?? 0), 0);

    const saldoActual =
      saldoAnterior + cargosDelMes - pagosRecibidos - descuentosAjustes;

    // Step 9: estado derivation (three-state)
    let estado: 'al_dia' | 'pendiente' | 'vencido';
    if (saldoActual <= 0) {
      estado = 'al_dia';
    } else if (new Date(vencimiento) > new Date()) {
      estado = 'pendiente';
    } else {
      estado = 'vencido';
    }

    // Step 10: build movimientos for API response
    const movimientos: MovimientoEstadoCuenta[] = movimientosEnPeriodo.map(
      (r) => ({
        fecha: r.fecha.toISOString(),
        concepto: r.concepto,
        cargo: r.cargo,
        abono: r.abono,
        categoria: r.categoria,
      }),
    );

    return {
      inmuebleCodigo,
      propietario,
      copropiedadTelefono,
      copropiedadEmail,
      periodStart: desde.toISOString(),
      periodEnd: hasta.toISOString(),
      fechaEmision,
      vencimiento,
      saldoAnterior,
      cargosDelMes,
      pagosRecibidos,
      descuentosAjustes,
      saldoActual,
      estado,
      movimientos,
    };
  }
}
