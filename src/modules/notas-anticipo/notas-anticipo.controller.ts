import {
  Body,
  Controller,
  Get,
  Param,
  Post,
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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotasAnticipoService } from './notas-anticipo.service';
import { CrearNotaAnticipoDto } from './dto/crear-nota-anticipo.dto';
import { AnularNotaAnticipoDto } from './dto/anular-nota-anticipo.dto';
import { ListarNotaAnticipoDto } from './dto/listar-nota-anticipo.dto';
import type {
  NotaAnticipo,
  NotaAnticipoDetalle,
  Paginado,
} from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { generarPdfRecibo } from '../../common/pdf/recibo-pdf';
import { construirDatosImpresionNotaAnticipo } from './nota-anticipo-pdf-datos.util';
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
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
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
import { TenantContextService } from '../../common/tenant/tenant-context.service';

/**
 * `subject: 'NotaAnticipo'` — its own CASL subject (module key
 * `notas-anticipo`), separate from `OtraNota` (Notas Débito): applying an
 * existing anticipo and creating a new debit charge are different enough
 * responsibilities that a role should be able to hold one without the
 * other. Actions: create, read, annul — no update, same reasoning as every
 * other financial document (immutable except for voiding).
 */
@Controller('notas-anticipo')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class NotasAnticipoController {
  constructor(
    private readonly notasAnticipo: NotasAnticipoService,
    private readonly tenant: TenantContextService,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(CuentaContable.name)
    private readonly cuentasContables: Model<CuentaContableDocument>,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'NotaAnticipo' })
  findAll(
    @Query() query: ListarNotaAnticipoDto,
  ): Promise<Paginado<NotaAnticipo>> {
    return this.notasAnticipo.findAll(query);
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'NotaAnticipo' })
  findOne(@Param('id') id: string): Promise<NotaAnticipoDetalle> {
    return this.notasAnticipo.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'NotaAnticipo' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearNotaAnticipoDto,
  ): Promise<NotaAnticipo> {
    return this.notasAnticipo.crear(user.accountId!, dto);
  }

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'NotaAnticipo' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularNotaAnticipoDto,
  ): Promise<NotaAnticipo> {
    return this.notasAnticipo.anular(id, dto, user.accountId!);
  }

  @Get(':id/pdf')
  @CheckAbility({ action: 'read', subject: 'NotaAnticipo' })
  async generarPdf(
    @Param('id') id: string,
    @Query('duplicado') duplicado: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const [nota, aplicaciones, copropiedad] = await Promise.all([
      this.notasAnticipo.findOneRaw(id),
      this.notasAnticipo.findAplicaciones(id),
      this.copropiedades.findById(coPropertyId).exec(),
    ]);

    if (!copropiedad) {
      throw new Error(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const datos = await construirDatosImpresionNotaAnticipo(
      nota,
      aplicaciones,
      copropiedad,
      coPropertyId,
      {
        facturas: this.facturas,
        notasDebito: this.notasDebito,
        recibos: this.recibos,
        inmuebles: this.inmuebles,
        terceros: this.terceros,
        cuentasContables: this.cuentasContables,
      },
    );

    const bytes = await generarPdfRecibo(datos, copropiedad, {
      duplicado: duplicado === 'true',
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${nota.fullNumber}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }
}
