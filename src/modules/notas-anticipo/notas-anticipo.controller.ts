import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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
  constructor(private readonly notasAnticipo: NotasAnticipoService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'NotaAnticipo' })
  findAll(
    @Query() query: ListarNotaAnticipoDto,
  ): Promise<Paginado<NotaAnticipo>> {
    return this.notasAnticipo.findAll(query);
  }

  /**
   * Also the frontend's source for rendering a Nota de Anticipo's PDF
   * client-side — `NotaAnticipo.documentDefinition` (frozen once, at
   * `crear()` time — see
   * `NotasAnticipoService.congelarPresentacionNotaAnticipo`; no
   * `?duplicado=true` variant baked in) is just another field on the same
   * mapped contract, so there's no separate `:id/pdf` route anymore.
   */
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
}
