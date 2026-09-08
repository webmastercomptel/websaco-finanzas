import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  LoteFacturacion,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import {
  AsientoContable,
  AsientoContableDocument,
} from '../../database/schemas/facturacion/asiento-contable.schema';
import {
  SaldoCartera,
  SaldoCarteraDocument,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
import {
  ConsecutivoLote,
  ConsecutivoLoteDocument,
} from '../../database/schemas/facturacion/consecutivo-lote.schema';
import {
  ConsecutivoDocumento,
  ConsecutivoDocumentoDocument,
} from '../../database/schemas/numeracion/consecutivo-documento.schema';
import {
  ResolucionFacturacion,
  ResolucionFacturacionDocument,
} from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import {
  NotaCredito,
  NotaCreditoDocument,
} from '../../database/schemas/notas-credito/nota-credito.schema';
import {
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { ResultadoReinicioCiclo } from '../../contracts';

/**
 * The ONE coproperty this operation is allowed to touch, hardcoded on
 * purpose — never read from config, never overridable per-request. This is
 * the demo/sandbox building used to show prospective clients the billing
 * cycle end to end; it is never where real customer data lives.
 */
const CODIGO_COPROPIEDAD_PRUEBA = '0001';

/**
 * Wipes every Lote/Factura (and what facturación itself derived from them —
 * asientos contables, saldos de cartera) for the one hardcoded test
 * coproperty, and rewinds its FV/Lote numbering back to the start, so the
 * billing cycle can be demoed from zero as many times as needed.
 *
 * This is a deliberate, narrow exception to "nothing financial is ever
 * deleted" (see backend/CLAUDE.md's audit law) — never a template for
 * anything else. Three independent guards keep it from ever touching real
 * data: (1) the hardcoded coproperty-code check below, enforced here
 * regardless of who holds the permission or which building is active on the
 * caller's screen; (2) the `CicloFacturacionPrueba`/`reiniciar` CASL pair,
 * which is its own subject/action, never `Factura`'s; (3) the frontend's
 * own type-to-confirm step. Losing any one of the three still leaves the
 * other two standing.
 */
@Injectable()
export class ReiniciarCicloService {
  constructor(
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(LoteFacturacion.name)
    private readonly lotes: Model<LoteFacturacionDocument>,
    @InjectModel(AsientoContable.name)
    private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldos: Model<SaldoCarteraDocument>,
    @InjectModel(ConsecutivoLote.name)
    private readonly consecutivoLote: Model<ConsecutivoLoteDocument>,
    @InjectModel(ConsecutivoDocumento.name)
    private readonly consecutivoDocumento: Model<ConsecutivoDocumentoDocument>,
    @InjectModel(ResolucionFacturacion.name)
    private readonly resoluciones: Model<ResolucionFacturacionDocument>,
    @InjectModel(NotaCredito.name)
    private readonly notasCredito: Model<NotaCreditoDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async reiniciar(): Promise<ResultadoReinicioCiclo> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    // `_id` IS the tenant id here — findById is correct, not the trap.
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad || copropiedad.code !== CODIGO_COPROPIEDAD_PRUEBA) {
      throw new ForbiddenException(
        'Esta operación solo está disponible en la copropiedad de pruebas.',
      );
    }

    const facturaIds = await this.facturas
      .find({ coPropertyId })
      .distinct('_id')
      .exec();

    if (facturaIds.length > 0) {
      const [notaCreditoRef, aplicacionRef] = await Promise.all([
        this.notasCredito.exists({ facturaId: { $in: facturaIds } }),
        this.aplicaciones.exists({
          documentType: 'FV',
          documentId: { $in: facturaIds },
        }),
      ]);
      if (notaCreditoRef || aplicacionRef) {
        throw new ConflictException(
          'No se puede reiniciar: hay notas crédito o recibos aplicados ' +
            'contra facturas de esta copropiedad. Anúlalos primero.',
        );
      }
    }

    const [asientosEliminados, saldosEliminados] = await Promise.all([
      this.asientos
        .deleteMany({ coPropertyId, facturaId: { $ne: null } })
        .exec(),
      this.saldos.deleteMany({ coPropertyId }).exec(),
    ]);

    const facturasEliminadas = await this.facturas
      .deleteMany({ coPropertyId })
      .exec();
    const lotesEliminados = await this.lotes
      .deleteMany({ coPropertyId })
      .exec();

    // 0, not 1: siguienteLote/siguienteDocumento increment BEFORE reading
    // (`{ new: true }`), so a row left at 1 would hand out 2 as the first
    // number after reset. 0 is what a brand-new row starts at (missing
    // field + $inc on upsert), so the next call returns 1.
    await this.consecutivoLote
      .updateOne({ coPropertyId }, { $set: { nextNumber: 0 } })
      .exec();
    await this.consecutivoDocumento
      .updateOne({ coPropertyId, category: 'FV' }, { $set: { nextNumber: 0 } })
      .exec();
    const resolucionActiva = await this.resoluciones
      .findOne({ coPropertyId, status: 'active' })
      .exec();
    if (resolucionActiva) {
      await this.resoluciones
        .updateOne(
          { _id: resolucionActiva._id },
          { $set: { nextNumber: resolucionActiva.rangeFrom } },
        )
        .exec();
    }

    return {
      lotesEliminados: lotesEliminados.deletedCount,
      facturasEliminadas: facturasEliminadas.deletedCount,
      asientosEliminados: asientosEliminados.deletedCount,
      saldosEliminados: saldosEliminados.deletedCount,
    };
  }
}
