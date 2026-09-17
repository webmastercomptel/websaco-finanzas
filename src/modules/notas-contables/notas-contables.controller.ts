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
import { NotasContablesService } from './notas-contables.service';
import { CrearNotaContableDto } from './dto/crear-nota-contable.dto';
import { AnularNotaContableDto } from './dto/anular-nota-contable.dto';
import { ListarNotaContableDto } from './dto/listar-nota-contable.dto';
import type { NotaContable, Paginado } from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { generarPdfRecibo } from '../../common/pdf/recibo-pdf';
import { construirDatosImpresionNotaContable } from './nota-contable-pdf-datos.util';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
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

@Controller('notas-contables')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class NotasContablesController {
  constructor(
    private readonly notasContables: NotasContablesService,
    private readonly tenant: TenantContextService,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(CuentaContable.name)
    private readonly cuentasContables: Model<CuentaContableDocument>,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'NotaContable' })
  findAll(
    @Query() query: ListarNotaContableDto,
  ): Promise<Paginado<NotaContable>> {
    return this.notasContables.findAll(query);
  }

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

  @Get(':id/pdf')
  @CheckAbility({ action: 'read', subject: 'NotaContable' })
  async generarPdf(
    @Param('id') id: string,
    @Query('duplicado') duplicado: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const nota = await this.notasContables.findOneRaw(id);
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();

    if (!copropiedad) {
      throw new Error(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const datos = await construirDatosImpresionNotaContable(
      nota,
      copropiedad,
      coPropertyId,
      {
        conceptos: this.conceptos,
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
