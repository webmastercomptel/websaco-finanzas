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
import { AplicarReciboDto } from './dto/aplicar-recibo.dto';
import { AnularReciboDto } from './dto/anular-recibo.dto';
import { ListarRecibosDto } from './dto/listar-recibos.dto';
import type {
  Paginado,
  Recibo,
  ReciboDetalle,
  ResultadoAplicacion,
} from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { generarPdfRecibo } from '../../common/pdf/recibo-pdf';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';

/**
 * `subject: 'Recibo'` throughout, `create`/`read`/`update`/`annul` per
 * action — same one-subject-for-the-whole-lifecycle choice LotesController
 * already made for `'Factura'` (design §5). GET routes are added in Task
 * 10, `/aplicar` in Task 8, `/anular` in Task 9.
 */
@Controller('recibos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class RecibosController {
  constructor(
    private readonly recibos: RecibosService,
    private readonly tenant: TenantContextService,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
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

  @Post(':id/aplicar')
  @CheckAbility({ action: 'update', subject: 'Recibo' })
  aplicar(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AplicarReciboDto,
  ): Promise<ResultadoAplicacion> {
    return this.recibos.aplicar(id, dto, user.accountId!);
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

    const bytes = await generarPdfRecibo(recibo, aplicaciones, copropiedad, {
      duplicado: duplicado === 'true',
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${recibo.fullNumber}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }
}
