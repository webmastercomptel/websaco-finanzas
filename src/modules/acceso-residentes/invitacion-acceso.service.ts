// src/modules/acceso-residentes/invitacion-acceso.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CorreoService } from '../../common/correo/correo.service';
import { EnlaceAccesoService } from '../../common/cuentas/enlace-acceso.service';
import type { ResultadoInvitacion } from '../../contracts';
import {
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { construirCorreoInvitacion } from './invitacion-correo';

/** Who is being invited and where the button should land them. */
export interface SolicitudInvitacion {
  accountId: string;
  email: string;
  nombre: string;
  copropiedadId: Types.ObjectId;
  tipo: 'residente' | 'personal';
  /** True when the account pre-dated this invitation. */
  cuentaExistente: boolean;
  /** Same-site relative path the sign-in link opens (`/portal`, `/`). */
  destino: string;
}

/**
 * Sends the one email of the access flows: "you now have access". Shared by the
 * team and the resident modules so both promise exactly the same thing.
 *
 * Never throws, and never builds a link nobody will receive: when mail is not
 * configured it answers `false/false` before touching `EnlaceAccesoService`
 * (each issued link is a live bearer credential, so none is minted for nothing).
 * The caller reports the two flags to the screen; the account exists either way
 * and the invitation can be re-sent.
 */
@Injectable()
export class InvitacionAccesoService {
  private readonly logger = new Logger(InvitacionAccesoService.name);

  constructor(
    private readonly correo: CorreoService,
    private readonly enlaces: EnlaceAccesoService,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
  ) {}

  /** Whether this environment can send mail at all (for bulk summaries). */
  correoConfigurado(): boolean {
    return this.correo.estaConfigurado();
  }

  async enviar(solicitud: SolicitudInvitacion): Promise<ResultadoInvitacion> {
    if (!this.correo.estaConfigurado()) {
      return { invitacionEnviada: false, enlaceIncluido: false };
    }
    try {
      const copropiedad = await this.copropiedades
        .findById(solicitud.copropiedadId)
        .select('nombre')
        .lean()
        .exec();
      const enlace = await this.enlaces.construir(
        solicitud.accountId,
        solicitud.copropiedadId.toString(),
        solicitud.destino,
      );
      const { asunto, html } = construirCorreoInvitacion({
        nombre: solicitud.nombre,
        nombreCopropiedad: copropiedad?.nombre ?? 'tu copropiedad',
        tipo: solicitud.tipo,
        cuentaExistente: solicitud.cuentaExistente,
        enlace,
      });
      const enviado = await this.correo.enviar({
        para: solicitud.email,
        asunto,
        html,
      });
      return {
        invitacionEnviada: enviado,
        enlaceIncluido: enviado && enlace !== null,
      };
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo preparar la invitación a ${solicitud.email}: ${(error as Error).message}`,
      );
      return { invitacionEnviada: false, enlaceIncluido: false };
    }
  }
}
