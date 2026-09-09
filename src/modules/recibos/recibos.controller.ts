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
import { RecibosService } from './recibos.service';
import { CrearReciboDto } from './dto/crear-recibo.dto';
import { AnularReciboDto } from './dto/anular-recibo.dto';
import { ListarRecibosDto } from './dto/listar-recibos.dto';
import type { Paginado, Recibo, ReciboDetalle } from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { generarPdfRecibo } from '../../common/pdf/recibo-pdf';
import { construirDatosImpresionRecibo } from './recibo-pdf-datos.util';
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
import { TenantContextService } from '../../common/tenant/tenant-context.service';

/**
 * `subject: 'Recibo'` throughout, `create`/`read`/`annul` per action — same
 * one-subject-for-the-whole-lifecycle choice LotesController already made
 * for `'Factura'` (design §5). There is deliberately no `/aplicar` route —
 * a Recibo left with a pending anticipo (`unappliedAmount > 0`) is applied
 * from the `notas-anticipo` module instead, never from here (see
 * `NotasAnticipoService`).
 */
@Controller('recibos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class RecibosController {
  constructor(
    private readonly recibos: RecibosService,
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
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  findAll(@Query() query: ListarRecibosDto): Promise<Paginado<Recibo>> {
    return this.recibos.findAll(query);
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  findOne(@Param('id') id: string): Promise<ReciboDetalle> {
    return this.recibos.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Recibo' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearReciboDto,
  ): Promise<Recibo> {
    // PoliciesGuard already required a Recibo/create permission, which only
    // an account with an active assignment can hold — accountId is
    // guaranteed set here, same reasoning as LotesController.crear().
    return this.recibos.crear(user.accountId!, dto);
  }

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'Recibo' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularReciboDto,
  ): Promise<Recibo> {
    // Same reasoning as crear()/aplicar() above for the non-null assertion:
    // PoliciesGuard already required a Recibo/annul permission, which only an
    // account with an active assignment can hold.
    return this.recibos.anular(id, dto, user.accountId!);
  }

  @Get(':id/pdf')
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  async generarPdf(
    @Param('id') id: string,
    @Query('duplicado') duplicado: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const recibo = await this.recibos.findOneRaw(id);
    const [aplicaciones, copropiedad] = await Promise.all([
      this.recibos.findAplicacionesForSource('RC', recibo._id),
      this.copropiedades.findById(coPropertyId).exec(),
    ]);

    if (!copropiedad) {
      throw new Error(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const datos = await construirDatosImpresionRecibo(
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

    const bytes = await generarPdfRecibo(datos, copropiedad, {
      duplicado: duplicado === 'true',
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${recibo.fullNumber}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }
}
