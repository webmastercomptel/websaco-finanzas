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
import { NotasContablesService } from './notas-contables.service';
import { CrearNotaContableDto } from './dto/crear-nota-contable.dto';
import { AnularNotaContableDto } from './dto/anular-nota-contable.dto';
import { ListarNotaContableDto } from './dto/listar-nota-contable.dto';
import type { NotaContable, Paginado } from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

@Controller('notas-contables')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class NotasContablesController {
  constructor(private readonly notasContables: NotasContablesService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'NotaContable' })
  findAll(
    @Query() query: ListarNotaContableDto,
  ): Promise<Paginado<NotaContable>> {
    return this.notasContables.findAll(query);
  }

  /**
   * Also the frontend's source for rendering a Nota Contable's PDF
   * client-side — `NotaContable.documentDefinition` (frozen once, at
   * `crear()` time — see
   * `NotasContablesService.congelarPresentacionNotaContable`; no
   * `?duplicado=true` variant baked in) is just another field on the same
   * mapped contract, so there's no separate `:id/pdf` route anymore.
   */
  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'NotaContable' })
  findOne(@Param('id') id: string): Promise<NotaContable> {
    return this.notasContables.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'NotaContable' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearNotaContableDto,
  ): Promise<NotaContable> {
    return this.notasContables.crear(user.accountId!, dto);
  }

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'NotaContable' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularNotaContableDto,
  ): Promise<NotaContable> {
    return this.notasContables.anular(id, dto, user.accountId!);
  }
}
