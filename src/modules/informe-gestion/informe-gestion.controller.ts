// src/modules/informe-gestion/informe-gestion.controller.ts
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { CheckAnyAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { ConsultarInformeGestionDto } from './dto/consultar-informe-gestion.dto';
import { InformeGestionService } from './informe-gestion.service';

/** «Soporte a infogestión»: a PDF of the period's management activity. */
@Controller('informe-gestion')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class InformeGestionController {
  constructor(private readonly informe: InformeGestionService) {}

  /**
   * Gate: reading at least one of the three subjects; the service then
   * includes only the sections the caller may read.
   */
  @Get('pdf')
  @CheckAnyAbility(
    { action: 'read', subject: 'Actividad' },
    { action: 'read', subject: 'Mantenimiento' },
    { action: 'read', subject: 'Pqr' },
  )
  async generarPdf(
    @CurrentUser() user: IRequestUser,
    @Query() query: ConsultarInformeGestionDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const bytes = await this.informe.generarPdf(user, query);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="soporte-infogestion-${query.desde}-a-${query.hasta}.pdf"`,
    });
    res.send(bytes);
  }
}
