import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LoteRecibosService } from './lote-recibos.service';
import { CrearLoteRecibosDto } from './dto/crear-lote-recibos.dto';
import { CargarFilasLoteRecibosDto } from './dto/cargar-filas-lote-recibos.dto';
import type { LoteRecibos, ErrorAplicacionLoteRecibos } from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../../database/schemas/notas-debito/nota-debito.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import {
  CuentaContable,
  CuentaContableDocument,
} from '../../database/schemas/contabilidad/cuenta-contable.schema';
import {
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import {
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import { generarPdfRecibosLote } from '../../common/pdf/recibos-lote-pdf';
import { construirDatosImpresionRecibo } from './recibo-pdf-datos.util';

/** `subject: 'Recibo'` throughout — a Recibos-por-lote batch never touches
 *  cartera on its own, every row becomes a real Recibo through
 *  `RecibosService.crear()` unchanged, so it is gated by exactly the same
 *  permission a single Recibo already requires. */
@Controller('lotes-recibos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class LoteRecibosController {
  constructor(
    private readonly loteRecibos: LoteRecibosService,
    private readonly tenant: TenantContextService,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(CuentaContable.name)
    private readonly cuentasContables: Model<CuentaContableDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  findAll(): Promise<LoteRecibos[]> {
    return this.loteRecibos.findAll();
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  findOne(@Param('id') id: string): Promise<LoteRecibos> {
    return this.loteRecibos.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Recibo' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearLoteRecibosDto,
  ): Promise<LoteRecibos> {
    return this.loteRecibos.crear(user.accountId!, dto);
  }

  @Post(':id/cargar')
  @CheckAbility({ action: 'create', subject: 'Recibo' })
  cargar(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: CargarFilasLoteRecibosDto,
  ): Promise<LoteRecibos> {
    return this.loteRecibos.cargarArchivo(id, user.accountId!, dto);
  }

  @Post(':id/cancelar')
  @CheckAbility({ action: 'create', subject: 'Recibo' })
  async cancelar(@Param('id') id: string): Promise<{ ok: true }> {
    await this.loteRecibos.cancelar(id);
    return { ok: true };
  }

  @Post(':id/aplicar')
  @CheckAbility({ action: 'manage', subject: 'Recibo' })
  aplicar(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
  ): Promise<{ lote: LoteRecibos; errores: ErrorAplicacionLoteRecibos[] }> {
    return this.loteRecibos.aplicar(id, user.accountId!);
  }

  @Get(':id/pdf')
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  async generarPdf(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.loteRecibos.findOne(id);

    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new Error(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const reciboIds = lote.filas
      .map((f) => f.reciboId)
      .filter((rid): rid is string => rid !== null);
    const recibosDoc = await this.recibos
      .find({ coPropertyId, _id: { $in: reciboIds } })
      .exec();

    const datos = await Promise.all(
      recibosDoc.map(async (recibo) => {
        const aplicaciones = await this.aplicaciones
          .find({
            coPropertyId,
            sourceType: 'RC',
            sourceId: recibo._id,
            status: 'activa',
          })
          .sort({ appliedAt: 1 })
          .exec();
        return construirDatosImpresionRecibo(
          recibo,
          aplicaciones,
          copropiedad,
          coPropertyId,
          {
            facturas: this.facturas,
            notasDebito: this.notasDebito,
            inmuebles: this.inmuebles,
            terceros: this.terceros,
            cuentasContables: this.cuentasContables,
          },
        );
      }),
    );

    const bytes = await generarPdfRecibosLote(datos, copropiedad);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="lote-recibos-${lote.numero}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }
}
