// src/modules/facturacion/facturas.controller.ts
import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { FacturasService } from './facturas.service';
import { ListarFacturasDto } from './dto/listar-facturas.dto';
import type { Factura, Paginado } from '../../contracts';
import { generarPdfFactura } from '../../common/pdf/factura-pdf';
import {
  ResolucionFacturacion,
  ResolucionFacturacionDocument,
} from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';

/**
 * Read-only: invoices are only ever created via a Lote's consolidación
 * (LotesController). There is no create/update/delete here, and there must
 * not be one — a Factura's fields are frozen by design.
 */
@Controller('facturas')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class FacturasController {
  constructor(
    private readonly facturas: FacturasService,
    private readonly tenant: TenantContextService,
    @InjectModel(ResolucionFacturacion.name)
    private readonly resoluciones: Model<ResolucionFacturacionDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
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

  @Get(':id/pdf')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async generarPdf(
    @Param('id') id: string,
    @Query('duplicado') duplicado: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const factura = await this.facturas.findOneRaw(id);

    const [resolucion, copropiedad] = await Promise.all([
      this.resoluciones
        .findOne({ _id: factura.resolucionId, coPropertyId })
        .exec(),
      this.copropiedades.findById(coPropertyId).exec(),
    ]);

    if (!resolucion) {
      throw new Error(
        `No se encontró la resolución de facturación ${factura.resolucionId.toString()}`,
      );
    }
    if (!copropiedad) {
      throw new Error(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const bytes = await generarPdfFactura(factura, resolucion, copropiedad, {
      duplicado: duplicado === 'true',
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${factura.fullNumber}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }
}
