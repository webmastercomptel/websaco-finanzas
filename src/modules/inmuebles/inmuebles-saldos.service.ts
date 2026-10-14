// src/modules/inmuebles/inmuebles-saldos.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../../database/schemas/notas-debito/nota-debito.schema';
import {
  SaldoInicial,
  SaldoInicialDocument,
} from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';
import {
  SaldoTotalDocumento,
  SaldoTotalDocumentoDocument,
} from '../../database/schemas/facturacion/saldo-total-documento.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { SaldoInmueble } from '../../contracts';
import type { ConsultarSaldosInmueblesDto } from './dto/consultar-saldos-inmuebles.dto';

/** Rounds a money sum to 2 decimals so float noise never reaches the wire. */
const redondear2 = (valor: number): number =>
  Math.round((valor + Number.EPSILON) * 100) / 100;

/**
 * Outstanding balance of a handful of units at once — what a picker needs to
 * show "owes $X" beside each candidate without opening each unit's cartera.
 *
 * Same document-based rule as `saldoTotalCartera` in
 * `CarteraPorInmuebleService.findOne` (emitted Facturas + emitted Notas
 * Débito + active Saldos Iniciales, each at its live
 * `SaldoTotalDocumento.saldoPendiente`, floored at 0 per document) so both
 * screens agree on the same unit. Deliberately NOT counted: anticipos, notas
 * contables and anuladas. One divergence by design: a document with no saldo
 * row counts 0 here, whereas the cartera view falls back to recomputing it
 * from its applications — a picker hint should not pay that per-document cost,
 * and every consolidated document gets its row.
 *
 * Kept apart from `InmueblesService` (like the report/elimination siblings) so
 * that service's positional constructor and its specs stay untouched.
 */
@Injectable()
export class InmueblesSaldosService {
  constructor(
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(SaldoInicial.name)
    private readonly saldosIniciales: Model<SaldoInicialDocument>,
    @InjectModel(SaldoTotalDocumento.name)
    private readonly saldoTotalDocumento: Model<SaldoTotalDocumentoDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * One entry per id that belongs to the active coproperty (0 when nothing is
   * owed). An id of another coproperty — or one that does not exist — yields
   * NO entry at all, so the endpoint cannot be used to probe foreign ids.
   */
  async consultar(dto: ConsultarSaldosInmueblesDto): Promise<SaldoInmueble[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const pedidos = [...new Set(dto.ids)].map((id) => new Types.ObjectId(id));

    // Tenancy: only ids this coproperty owns are ever answered or queried below.
    const propios = await this.inmuebles
      .find({ copropiedadId, _id: { $in: pedidos } }, { _id: 1 })
      .lean()
      .exec();
    if (propios.length === 0) return [];
    const inmuebleIds = propios.map((i) => i._id);

    const filtroDe = <E extends string>(estado: E) => ({
      copropiedadId,
      inmuebleId: { $in: inmuebleIds },
      estado,
    });
    const proyeccion = { inmuebleId: 1 };
    const [facturas, notasDebito, saldosIniciales] = await Promise.all([
      this.facturas.find(filtroDe('emitida'), proyeccion).lean().exec(),
      this.notasDebito.find(filtroDe('emitida'), proyeccion).lean().exec(),
      this.saldosIniciales.find(filtroDe('activo'), proyeccion).lean().exec(),
    ]);

    const documentos = [...facturas, ...notasDebito, ...saldosIniciales];
    const inmueblePorDocumento = new Map(
      documentos.map((d) => [d._id.toString(), d.inmuebleId.toString()]),
    );

    const saldos = documentos.length
      ? await this.saldoTotalDocumento
          .find(
            {
              copropiedadId,
              documentoId: { $in: documentos.map((d) => d._id) },
            },
            { documentoId: 1, saldoPendiente: 1 },
          )
          .lean()
          .exec()
      : [];

    const porInmueble = new Map<string, number>();
    for (const s of saldos) {
      const inmuebleId = inmueblePorDocumento.get(s.documentoId.toString());
      if (!inmuebleId) continue;
      porInmueble.set(
        inmuebleId,
        (porInmueble.get(inmuebleId) ?? 0) + Math.max(0, s.saldoPendiente),
      );
    }

    return inmuebleIds.map((id) => ({
      inmuebleId: id.toString(),
      saldoPendiente: redondear2(porInmueble.get(id.toString()) ?? 0),
    }));
  }
}
