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
import { NotasDebitoService } from './notas-debito.service';
import { CrearNotaDebitoDto } from './dto/crear-nota-debito.dto';
import { AnularNotaDebitoDto } from './dto/anular-nota-debito.dto';
import { ListarNotaDebitoDto } from './dto/listar-nota-debito.dto';
import type { NotaDebito, NotaDebitoDetalle, Paginado } from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

/**
 * `subject: 'OtraNota'` throughout — already registered in
 * casl-ability.constants.ts and permission-map.ts (module key:
 * 'otras-notas'). Actions: create, read, annul. No update: a Nota
 * Débito is immutable except for voiding.
 */
@Controller('notas-debito')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class NotasDebitoController {
  constructor(private readonly notasDebito: NotasDebitoService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'OtraNota' })
  findAll(@Query() query: ListarNotaDebitoDto): Promise<Paginado<NotaDebito>> {
    return this.notasDebito.findAll(query);
  }

  /**
   * Also the frontend's source for rendering a Nota Débito's PDF
   * client-side — `NotaDebito.documentDefinition` (frozen once, at
   * `crear()` time — see `NotasDebitoService.congelarPresentacionNotaDebito`;
   * no `?duplicado=true` variant baked in, reprinting a duplicate copy is a
   * client-side concern now) is just another field on the same mapped
   * contract, so there's no separate `:id/pdf` route anymore.
   */
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
}
