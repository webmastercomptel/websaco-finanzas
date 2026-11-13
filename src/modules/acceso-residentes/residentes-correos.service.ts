// src/modules/acceso-residentes/residentes-correos.service.ts
import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { ResidenciaService } from '../../common/acceso/residencia.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { claveCorreo, normalizarEmail } from '../../common/utils/email.utils';
import type {
  Paginado,
  ResidenteCorreo,
  ResultadoAccionResidenteCorreo,
  ResultadoReenvioEnlace,
  UnidadDeResidente,
} from '../../contracts';
import {
  Inmueble,
  type InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Account,
  type AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import {
  RevocacionPortal,
  type RevocacionPortalDocument,
} from '../../database/schemas/cuentas/revocacion-portal.schema';
import {
  Tercero,
  type TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { AuditoriaService } from '../auditoria/auditoria.service';
import {
  IngresoPortalService,
  type MotivoInelegible,
} from '../ingreso-portal/ingreso-portal.service';
import type { AccionResidenteCorreoDto } from './dto/accion-residente-correo.dto';
import type { ListarResidentesCorreosDto } from './dto/listar-residentes-correos.dto';
import {
  construirFilasResidentes,
  direccionesDeTercero,
  filtrarFilasResidentes,
  paginarFilas,
  type CuentaParaFila,
  type TerceroParaFila,
} from './residentes-correos.mapper';

/** Mongo duplicate-key error code. */
const CLAVE_DUPLICADA = 11000;

/**
 * Why a resend is refused, in the words staff read (a 409). Staff are
 * authenticated, so unlike the public route the reason is named.
 */
const FRASE_INELEGIBLE: Record<MotivoInelegible, string> = {
  revocado: 'Esa persona no puede entrar: su acceso está revocado.',
  'cuenta-inactiva': 'Esa persona no puede entrar: su cuenta está inactiva.',
  'sin-registro':
    'Esa persona no puede entrar: su correo no está en una ficha con una unidad activa.',
  'correo-generico':
    'Esa persona no puede entrar: su correo está en demasiadas fichas. Corrígelo en Terceros.',
};

/**
 * Residentes, per ADDRESS: who can enter the portal of the active coproperty,
 * and the staff operations on it (resend the sign-in link, revoke, re-allow).
 * Granting is not here: anyone with an address on a record enters by
 * themselves (`modules/ingreso-portal/`).
 *
 * Every read names the ACTIVE coproperty (`resolveCoPropertyId()`, never the
 * payload). The address is shown to staff only, and no log line of this
 * service carries one.
 */
@Injectable()
export class ResidentesCorreosService {
  private readonly logger = new Logger(ResidentesCorreosService.name);

  constructor(
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(Account.name)
    private readonly cuentas: Model<AccountDocument>,
    private readonly tenant: TenantContextService,
    private readonly residencia: ResidenciaService,
    @InjectModel(RevocacionPortal.name)
    private readonly revocaciones: Model<RevocacionPortalDocument>,
    private readonly auditoria: AuditoriaService,
    @InjectConnection() private readonly connection: Connection,
    private readonly ingreso: IngresoPortalService,
  ) {}

  /**
   * Units of the active coproperty that have a holder, keyed by the holder's
   * party id. One query however many units: the coproperty is bounded
   * (hundreds of units) and the list needs the whole map.
   */
  private async unidadesPorTercero(
    copropiedadId: Types.ObjectId,
  ): Promise<Map<string, UnidadDeResidente[]>> {
    const unidades = await this.inmuebles
      .find({
        copropiedadId,
        estado: 'active',
        $or: [{ titularId: { $ne: null } }, { arrendatarioId: { $ne: null } }],
      })
      .select('codigo titularId arrendatarioId')
      .sort({ codigo: 1 })
      .lean()
      .exec();

    const mapa = new Map<string, UnidadDeResidente[]>();
    const agregar = (
      terceroId: Types.ObjectId | null | undefined,
      u: { _id: Types.ObjectId; codigo: string },
      rol: UnidadDeResidente['rol'],
    ): void => {
      if (!terceroId) return;
      const clave = terceroId.toString();
      const lista = mapa.get(clave) ?? [];
      lista.push({ inmuebleId: u._id.toString(), codigo: u.codigo, rol });
      mapa.set(clave, lista);
    };
    for (const u of unidades) {
      agregar(u.titularId, u, 'propietario');
      agregar(u.arrendatarioId, u, 'arrendatario');
    }
    return mapa;
  }

  /**
   * One row per (party, address) of the current owners and tenants of the
   * active coproperty. The rows are built in memory from ONE query each for
   * units, parties, accounts and revocations (plus one for the generic-inbox
   * rule), so the cost does not grow with the number of parties. A party that
   * holds no unit, or has no usable address, has no row.
   */
  async listar(
    filtros: ListarResidentesCorreosDto,
  ): Promise<Paginado<ResidenteCorreo>> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const pagina = filtros.pagina ?? 1;
    const porPagina = filtros.porPagina ?? 50;

    const unidades = await this.unidadesPorTercero(copropiedadId);
    if (unidades.size === 0) return paginarFilas([], pagina, porPagina);

    const filas = await this.terceros
      .find({
        _id: { $in: [...unidades.keys()].map((id) => new Types.ObjectId(id)) },
        copropiedadId,
        estado: 'active',
      })
      .select('nombre emails accountId')
      .sort({ nombre: 1, _id: 1 })
      .lean()
      .exec();
    const terceros: TerceroParaFila[] = filas.map((t) => ({
      id: t._id.toString(),
      nombre: t.nombre,
      emails: t.emails ?? [],
      accountId: t.accountId ? t.accountId.toString() : null,
    }));

    const correos = new Set<string>();
    for (const t of terceros) {
      for (const d of direccionesDeTercero(t.emails)) {
        correos.add(normalizarEmail(d.correo));
      }
    }
    const cuentaIds = terceros
      .map((t) => t.accountId)
      .filter((id): id is string => id !== null);

    const ramas: Record<string, unknown>[] = [];
    if (correos.size > 0) ramas.push({ email: { $in: [...correos] } });
    if (cuentaIds.length > 0) {
      ramas.push({
        _id: { $in: cuentaIds.map((id) => new Types.ObjectId(id)) },
      });
    }
    const cuentasDocs =
      ramas.length === 0
        ? []
        : await this.cuentas
            .find({ $or: ramas })
            .select('email correoProbadoClave ultimoIngresoPortalEn')
            .lean()
            .exec();
    const cuentas: CuentaParaFila[] = cuentasDocs.map((c) => ({
      id: c._id.toString(),
      email: c.email,
      correoProbadoClave: c.correoProbadoClave ?? null,
      ultimoIngresoPortalEn: c.ultimoIngresoPortalEn ?? null,
    }));

    // An orphaned legacy account (its address left the record) is judged too.
    const claves = new Set<string>([...correos].map((c) => claveCorreo(c)));
    for (const c of cuentas) claves.add(claveCorreo(c.email));

    const [revocadas, genericos] = await Promise.all([
      this.residencia.clavesRevocadas([...claves], copropiedadId.toString()),
      this.residencia.motivosCorreoGenerico([...correos]),
    ]);

    const todas = construirFilasResidentes({
      terceros,
      unidades,
      cuentasPorId: new Map(cuentas.map((c) => [c.id, c])),
      cuentasPorCorreo: new Map(
        cuentas.map((c) => [normalizarEmail(c.email), c]),
      ),
      revocadas,
      genericos,
    });
    return paginarFilas(
      filtrarFilasResidentes(todas, {
        buscar: filtros.buscar,
        estado: filtros.estado,
      }),
      pagina,
      porPagina,
    );
  }

  /**
   * The party of the ACTIVE coproperty a row names, and the address behind its
   * `clave`, re-resolved from the record, never taken from the caller. A
   * foreign party, an unknown id and a `clave` that is not on that record are
   * all the same 404, so an action can never be aimed at an address or a
   * tenant of the caller's choosing.
   *
   * `admiteHeredado`: revoke and re-allow also accept the address of the
   * account linked to the party by the legacy `accountId` even when the record
   * no longer carries it (that access exists and must be revocable). A resend
   * does not: it only ever mails an address that is on the record.
   */
  private async resolverDireccion(
    dto: AccionResidenteCorreoDto,
    copropiedadId: Types.ObjectId,
    admiteHeredado: boolean,
  ): Promise<{ nombre: string; correo: string }> {
    const noEncontrado = (): NotFoundException =>
      new NotFoundException('Residente no encontrado');
    if (!Types.ObjectId.isValid(dto.terceroId)) throw noEncontrado();

    const tercero = await this.terceros
      .findOne({
        _id: new Types.ObjectId(dto.terceroId),
        copropiedadId,
        estado: 'active',
      })
      .select('nombre emails accountId')
      .lean()
      .exec();
    if (!tercero) throw noEncontrado();

    const enFicha = direccionesDeTercero(tercero.emails).find(
      (d) => d.clave === dto.clave,
    );
    if (enFicha) return { nombre: tercero.nombre, correo: enFicha.correo };

    if (admiteHeredado && tercero.accountId) {
      const vinculada = await this.cuentas
        .findOne({ _id: tercero.accountId })
        .select('email')
        .lean()
        .exec();
      if (vinculada && claveCorreo(vinculada.email) === dto.clave) {
        return { nombre: tercero.nombre, correo: vinculada.email };
      }
    }
    throw noEncontrado();
  }

  /** Audit label: names the party and the coproperty, never an address or a unit. */
  private etiqueta(nombre: string, copropiedadId: Types.ObjectId): string {
    return `Acceso de residente: ${nombre} (copropiedad ${copropiedadId.toString()})`;
  }

  /** `withTransaction` may re-run the callback on a transient error: every write in it is safe to repeat. */
  private async transaccion<T>(
    fn: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let resultado!: T;
      await session.withTransaction(async () => {
        resultado = await fn(session);
      });
      return resultado;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Revokes the portal of ONE address in the ACTIVE coproperty: one active
   * `revocaciones_portal` row keyed by `clave` plus the audit entry
   * (`retirar`), in one transaction, so a failed audit write leaves no
   * revocation. It takes effect on the next request of whoever holds the
   * address (nothing is cached) and cuts the legacy link through the same
   * rule.
   *
   * It touches no Firebase identity, no `Asignacion`, no `Tercero.accountId`,
   * no other coproperty and no invoice recipient. The partial unique index on
   * the active row decides a repeat: the second insert is E11000, which means
   * "already revoked" (200, no audit, the first who/when stays).
   */
  async revocar(
    dto: AccionResidenteCorreoDto,
    user: IRequestUser,
  ): Promise<ResultadoAccionResidenteCorreo> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const { nombre } = await this.resolverDireccion(dto, copropiedadId, true);
    const resultado = { terceroId: dto.terceroId, clave: dto.clave };

    try {
      await this.transaccion(async (session) => {
        const [fila] = await this.revocaciones.create(
          [
            {
              copropiedadId,
              clave: dto.clave,
              activa: true,
              revocadaPor: new Types.ObjectId(user.accountId),
              revocadaEn: new Date(),
            },
          ],
          { session },
        );
        await this.auditoria.registrar(
          {
            actorAccountId: user.accountId!,
            actorNombre: user.nombre ?? user.email,
            accion: 'retirar',
            entidadTipo: 'acceso-residente',
            entidadId: fila._id.toString(),
            entidadEtiqueta: this.etiqueta(nombre, copropiedadId),
          },
          session,
        );
      });
    } catch (error: unknown) {
      if ((error as { code?: number })?.code === CLAVE_DUPLICADA) {
        return resultado;
      }
      throw error;
    }
    return resultado;
  }

  /**
   * Lifts the active revocation of the address in the ACTIVE coproperty: ONE
   * conditional update (`activa: true` -> false, with who and when), so the
   * history stays and a repeat finds nothing to lift (200, no write, no
   * audit). The audit entry (`restablecer`) is written in the same
   * transaction. Access returns on the next request if the address still
   * qualifies and has a proof; nothing is redeemed again and no link is
   * touched.
   */
  async permitir(
    dto: AccionResidenteCorreoDto,
    user: IRequestUser,
  ): Promise<ResultadoAccionResidenteCorreo> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const { nombre } = await this.resolverDireccion(dto, copropiedadId, true);

    await this.transaccion(async (session) => {
      const levantada = await this.revocaciones
        .findOneAndUpdate(
          { copropiedadId, clave: dto.clave, activa: true },
          {
            $set: {
              activa: false,
              levantadaPor: new Types.ObjectId(user.accountId),
              levantadaEn: new Date(),
            },
          },
          { session, new: true },
        )
        .lean()
        .exec();
      if (!levantada) return;
      await this.auditoria.registrar(
        {
          actorAccountId: user.accountId!,
          actorNombre: user.nombre ?? user.email,
          accion: 'restablecer',
          entidadTipo: 'acceso-residente',
          entidadId: levantada._id.toString(),
          entidadEtiqueta: this.etiqueta(nombre, copropiedadId),
        },
        session,
      );
    });
    return { terceroId: dto.terceroId, clave: dto.clave };
  }

  /**
   * Staff resend of the sign-in link to ONE address of a listed party. The
   * address is re-resolved from the party's record in the ACTIVE coproperty
   * (404 when the pair is no longer there), so the e-mail can only go to an
   * address that record carries. It reuses the self-service issuance path
   * (`IngresoPortalService`: insert the new link, send, kill the older ones
   * only after the provider accepted, void the new one otherwise) with the
   * staff origin, and its OWN per-address counter, so a stranger flooding the
   * public route can never stop staff from sending.
   *
   * The caller is authenticated, so the outcome is explicit: sent; 409 with the
   * reason (revoked here, revoked everywhere, inactive account, no unit,
   * shared inbox); `motivo: 'limite'`; `motivo: 'sin-correo-configurado'`; 502
   * when the provider refused. Eligibility is asked before the counter, so a
   * refusal spends nothing. The audit entry (`enviar`) is written only for a
   * send that went out; a failure to write it cannot unsend the e-mail, so it
   * is logged by party id and the send is still reported.
   */
  async reenviar(
    dto: AccionResidenteCorreoDto,
    user: IRequestUser,
  ): Promise<ResultadoReenvioEnlace> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const { nombre, correo } = await this.resolverDireccion(
      dto,
      copropiedadId,
      false,
    );

    // Revoked in the coproperty staff are looking at: the reason they expect,
    // even if the address is still eligible somewhere else.
    const revocadas = await this.residencia.revocacionesActivas(dto.clave, [
      copropiedadId.toString(),
    ]);
    if (revocadas.size > 0) {
      throw new ConflictException(FRASE_INELEGIBLE.revocado);
    }

    const elegibilidad = await this.ingreso.evaluarElegibilidad(correo);
    if (!elegibilidad.elegible) {
      throw new ConflictException(
        FRASE_INELEGIBLE[elegibilidad.motivo ?? 'sin-registro'],
      );
    }

    if (!(await this.ingreso.tomarCupoReenvio(correo))) {
      return { enviado: false, motivo: 'limite' };
    }

    const resultado = await this.ingreso.emitirYEnviar(
      correo,
      'personal',
      new Types.ObjectId(user.accountId),
    );
    if (resultado === 'sin-correo-configurado') {
      return { enviado: false, motivo: 'sin-correo-configurado' };
    }
    if (resultado === 'fallo') {
      throw new BadGatewayException(
        'No pudimos enviar el correo. Inténtalo de nuevo en unos minutos.',
      );
    }

    try {
      await this.transaccion((session) =>
        this.auditoria.registrar(
          {
            actorAccountId: user.accountId!,
            actorNombre: user.nombre ?? user.email,
            accion: 'enviar',
            entidadTipo: 'acceso-residente',
            entidadId: dto.terceroId,
            entidadEtiqueta: `Enlace de ingreso reenviado: ${nombre} (copropiedad ${copropiedadId.toString()})`,
          },
          session,
        ),
      );
    } catch (error: unknown) {
      this.logger.error(
        `Residentes: se reenvió el enlace del tercero ${dto.terceroId} pero no se pudo auditar (tipo=${(error as Error)?.name ?? 'desconocido'}).`,
      );
    }
    return { enviado: true };
  }
}
