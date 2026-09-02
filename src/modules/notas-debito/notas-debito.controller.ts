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
import { NotasDebitoService } from './notas-debito.service';
import { CrearNotaDebitoDto } from './dto/crear-nota-debito.dto';
import { AnularNotaDebitoDto } from './dto/anular-nota-debito.dto';
import { ListarNotaDebitoDto } from './dto/listar-nota-debito.dto';
import type { NotaDebito, NotaDebitoDetalle, Paginado } from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { generarPdfNotaDebito } from '../../common/pdf/nota-debito-pdf';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';

/**
 * `subject: 'OtraNota'` throughout — already registered in
 * casl-ability.constants.ts and permission-map.ts (module key:
 * 'otras-notas'). Actions: create, read, annul. No update: a Nota
 * Débito is immutable except for voiding.
 */
@Controller('notas-debito')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class NotasDebitoController {
  constructor(
    private readonly notasDebito: NotasDebitoService,
    private readonly tenant: TenantContextService,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'OtraNota' })
  findAll(@Query() query: ListarNotaDebitoDto): Promise<Paginado<NotaDebito>> {
    return this.notasDebito.findAll(query);
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'OtraNota' })
  findOne(@Param('id') id: string): Promise<NotaDebitoDetalle> {
    return this.notasDebito.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'OtraNota' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearNotaDebitoDto,
  ): Promise<NotaDebito> {
    return this.notasDebito.crear(user.accountId!, dto);
  }

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'OtraNota' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularNotaDebitoDto,
  ): Promise<NotaDebito> {
    return this.notasDebito.anular(id, dto, user.accountId!);
  }

  @Get(':id/pdf')
  @CheckAbility({ action: 'read', subject: 'OtraNota' })
  async generarPdf(
    @Param('id') id: string,
    @Query('duplicado') duplicado: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const nota = await this.notasDebito.findOneRaw(id);
    const copropiedad = await this.copropiedades
      .findById(coPropertyId)
      .exec();

    if (!copropiedad) {
      throw new Error(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const bytes = await generarPdfNotaDebito(nota, copropiedad, {
      duplicado: duplicado === 'true',
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${nota.fullNumber}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }
}
