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
import { NotasCreditoService } from './notas-credito.service';
import { CrearNotaCreditoDto } from './dto/crear-nota-credito.dto';
import { AplicarNotaCreditoDto } from './dto/aplicar-nota-credito.dto';
import { AnularNotaCreditoDto } from './dto/anular-nota-credito.dto';
import { ListarNotasCreditoDto } from './dto/listar-notas-credito.dto';
import type {
  NotaCredito,
  NotaCreditoDetalle,
  Paginado,
  ResultadoAplicacion,
} from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { generarPdfNotaCredito } from '../../common/pdf/nota-credito-pdf';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { RecibosService } from '../recibos/recibos.service';

/**
 * `subject: 'NotaCredito'` throughout, `create`/`read`/`update`/`annul` per
 * action (design §5) — CASL's `NotaCredito` subject and `notas-credito`
 * module key are already registered (verified in Task 3); no CASL code
 * changes are needed for this module. GET routes land in Task 9, `/aplicar`
 * in Task 7, `/anular` in Task 8.
 */
@Controller('notas-credito')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class NotasCreditoController {
  constructor(
    private readonly notasCredito: NotasCreditoService,
    private readonly recibos: RecibosService,
    private readonly tenant: TenantContextService,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'NotaCredito' })
  findAll(
    @Query() query: ListarNotasCreditoDto,
  ): Promise<Paginado<NotaCredito>> {
    return this.notasCredito.findAll(query);
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'NotaCredito' })
  findOne(@Param('id') id: string): Promise<NotaCreditoDetalle> {
    return this.notasCredito.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'NotaCredito' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearNotaCreditoDto,
  ): Promise<NotaCredito> {
    // PoliciesGuard already required a NotaCredito/create permission, which
    // only an account with an active assignment can hold — accountId is
    // guaranteed set here, same reasoning as RecibosController.crear().
    return this.notasCredito.crear(user.accountId!, dto);
  }

  @Post(':id/aplicar')
  @CheckAbility({ action: 'update', subject: 'NotaCredito' })
  aplicar(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AplicarNotaCreditoDto,
  ): Promise<ResultadoAplicacion> {
    return this.notasCredito.aplicar(id, dto, user.accountId!);
  }

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'NotaCredito' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularNotaCreditoDto,
  ): Promise<NotaCredito> {
    return this.notasCredito.anular(id, dto, user.accountId!);
  }

  @Get(':id/pdf')
  @CheckAbility({ action: 'read', subject: 'NotaCredito' })
  async generarPdf(
    @Param('id') id: string,
    @Query('duplicado') duplicado: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const nota = await this.notasCredito.findOneRaw(id);
    const [aplicaciones, copropiedad] = await Promise.all([
      this.recibos.findAplicacionesForSource('NC', nota._id),
      this.copropiedades.findById(coPropertyId).exec(),
    ]);

    if (!copropiedad) {
      throw new Error(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const bytes = await generarPdfNotaCredito(nota, aplicaciones, copropiedad, {
      duplicado: duplicado === 'true',
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${nota.fullNumber}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }
}
