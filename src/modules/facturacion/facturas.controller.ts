// src/modules/facturacion/facturas.controller.ts
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { FacturasService } from './facturas.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { PlantillaDocumentoService } from '../../common/documentos/plantilla-documento.service';
import { toPlantilla } from '../plantillas-documento/plantillas-documento.mapper';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { ListarFacturasDto } from './dto/listar-facturas.dto';
import type { DocumentoFactura, Factura, Paginado } from '../../contracts';

/**
 * Read-only: invoices are only ever created via a Lote's consolidación
 * (LotesController). There is no create/update/delete here, and there must
 * not be one — a Factura's fields are frozen by design.
 *
 * `POST /facturas/:id/anular` (the `annul` exception "the audit law" always
 * allows) is NOT here — see `AnularFacturaController`
 * (`modules/notas-credito/`) for why it lives in that module instead despite
 * the route path.
 */
@Controller('facturas')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class FacturasController {
  constructor(
    private readonly facturas: FacturasService,
    private readonly tenant: TenantContextService,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly plantillas: PlantillaDocumentoService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Factura' })
  findAll(@Query() query: ListarFacturasDto): Promise<Paginado<Factura>> {
    return this.facturas.findAll(query);
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  findOne(@Param('id') id: string): Promise<Factura> {
    return this.facturas.findOne(id);
  }

  /**
   * A live-computed view of one Factura's PDF content — the current `FV`
   * template plus this invoice's own already-frozen `datos`
   * (`FacturasService.datosPlantilla`), recomputed on every call, no stored
   * file involved. A Factura is batch-only: its lote's invoice run produces
   * ONE combined PDF (one page per invoice, anchored on the Lote's own id —
   * see `LotesController.solicitarGeneracionFacturas`/`:id/url-lectura`).
   * Reading that combined file to show a single invoice would leak every
   * other unit's invoice to whoever is only entitled to see their own, so
   * this route never touches it — same reasoning, and the same live
   * computation, as `LotesController`'s Prefactura routes. Same `read`
   * action as `findOne` above.
   */
  @Get(':id/documento')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async obtenerDocumento(@Param('id') id: string): Promise<DocumentoFactura> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const factura = await this.facturas.findOneRaw(id);

    const [copropiedad, plantilla] = await Promise.all([
      this.copropiedades.findById(coPropertyId).exec(),
      this.plantillas.findOne('FV'),
    ]);
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    return {
      plantilla: toPlantilla(plantilla),
      datos: await this.facturas.datosPlantilla(factura, copropiedad),
    };
  }
}
