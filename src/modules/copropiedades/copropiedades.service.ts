// src/modules/copropiedades/copropiedades.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  ContadorCopropiedad,
  ContadorCopropiedadDocument,
} from '../../database/schemas/copropiedades/contador-copropiedad.schema';
import {
  Asignacion,
  AsignacionDocument,
} from '../../database/schemas/cuentas/asignacion.schema';
import {
  Account,
  AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import {
  ConsecutivoDocumento,
  ConsecutivoDocumentoDocument,
  type CategoriaDocumento,
} from '../../database/schemas/numeracion/consecutivo-documento.schema';
import {
  CuentaContable,
  CuentaContableDocument,
} from '../../database/schemas/contabilidad/cuenta-contable.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import type {
  Copropiedad as CopropiedadContract,
  CopropiedadResumen as CopropiedadResumenContract,
  Paginado,
} from '../../contracts';
import { toCopropiedad } from './copropiedades.mapper';
import type { ListarCopropiedadesDto } from './dto/listar-copropiedades.dto';
import type {
  ActualizarCopropiedadDto,
  CrearCopropiedadDto,
} from './dto/guardar-copropiedad.dto';
import type { CopiarConfiguracionDto } from './dto/copiar-configuracion.dto';
import { escapeRegex } from '../../common/utils/query.utils';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { ConceptosService } from '../conceptos/conceptos.service';

/**
 * Manages the platform's catalogue of coproperties.
 *
 * Deliberately NOT scoped by TenantContextService. A coproperty IS the tenant
 * — this service manages the definition of every tenant there is, so there is
 * no single active one to filter by. Access is restricted at the controller
 * by PlatformAdminGuard instead.
 */
@Injectable()
export class CopropiedadesService {
  constructor(
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(ContadorCopropiedad.name)
    private readonly contador: Model<ContadorCopropiedadDocument>,
    @InjectModel(Asignacion.name)
    private readonly asignaciones: Model<AsignacionDocument>,
    @InjectModel(Account.name)
    private readonly accounts: Model<AccountDocument>,
    private readonly auditoria: AuditoriaService,
    private readonly conceptos: ConceptosService,
    @InjectModel(ConsecutivoDocumento.name)
    private readonly consecutivos: Model<ConsecutivoDocumentoDocument>,
    @InjectModel(CuentaContable.name)
    private readonly cuentasContables: Model<CuentaContableDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptosCobro: Model<ConceptoCobroDocument>,
  ) {}

  async findAll(
    query: ListarCopropiedadesDto,
  ): Promise<Paginado<CopropiedadContract>> {
    const filtro: Record<string, unknown> = {};

    if (query.estado !== 'todos') {
      filtro.status = query.estado === 'inactivo' ? 'inactive' : 'active';
    }
    if (query.buscar) {
      const patron = { $regex: escapeRegex(query.buscar), $options: 'i' };
      filtro.$or = [{ code: patron }, { name: patron }];
    }
    if (query.entidadAdministradoraId) {
      filtro.managingEntityId = new Types.ObjectId(
        query.entidadAdministradoraId,
      );
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.copropiedades
        .find(filtro)
        .populate('managingEntityId', 'name')
        .sort({ code: -1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.copropiedades.countDocuments(filtro).exec(),
    ]);

    const usuariosPorCopropiedad = await this.usuariosAdministradores(
      documentos.filter((d) => !d.managingEntityId).map((d) => d._id),
    );

    return {
      items: documentos.map((d) =>
        toCopropiedad(d, usuariosPorCopropiedad.get(d._id.toString()) ?? null),
      ),
      total,
      pagina,
      porPagina,
    };
  }

  /**
   * Read-only preview of the code the next `create()` would assign — for
   * the "Código" field on the create form, auto-populated instead of typed
   * by hand. A pure read: it never touches the counter, so opening the form
   * and never submitting never burns a number.
   */
  async previsualizarSiguienteCodigo(): Promise<string> {
    return String((await this.pisoActual()) + 1).padStart(4, '0');
  }

  /**
   * The highest numeric `code` already in use — either already recorded on
   * the counter, or typed by hand before this became automatic (or any
   * future direct insert).
   */
  private async pisoActual(): Promise<number> {
    const [maximo] = await this.copropiedades
      .find({ code: /^\d+$/ })
      .sort({ code: -1 })
      .collation({ locale: 'en_US', numericOrdering: true })
      .limit(1)
      .exec();
    const pisoCopropiedades = maximo ? parseInt(maximo.code, 10) : 0;

    const contadorActual = await this.contador.findOne({}).exec();
    const pisoContador = contadorActual?.valor ?? 0;

    return Math.max(pisoCopropiedades, pisoContador);
  }

  /**
   * Atomically increments the single counter document and formats the
   * result as a zero-padded 4-digit code ("0001", "0002", ...). Floors the
   * counter at `pisoActual()` first — cheap to repeat on every call: once
   * the counter has caught up, the floor is a no-op.
   */
  private async siguienteCodigo(): Promise<string> {
    const piso = await this.pisoActual();

    await this.contador
      .updateOne(
        { valor: { $lt: piso } },
        { $set: { valor: piso } },
        { upsert: true },
      )
      .exec();

    const contador = await this.contador
      .findOneAndUpdate(
        {},
        { $inc: { valor: 1 } },
        { upsert: true, returnDocument: 'after' },
      )
      .exec();
    return String(contador.valor).padStart(4, '0');
  }

  async findOne(id: string): Promise<CopropiedadContract> {
    const documento = await this.copropiedades
      .findById(id)
      .populate('managingEntityId', 'name')
      .exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró la copropiedad ${id}`);
    }
    const usuariosPorCopropiedad = documento.managingEntityId
      ? new Map<string, string>()
      : await this.usuariosAdministradores([documento._id]);
    return toCopropiedad(
      documento,
      usuariosPorCopropiedad.get(documento._id.toString()) ?? null,
    );
  }

  /**
   * Other active coproperties under the SAME entidad administradora as
   * `coPropertyId`, for the "copiar configuración" picker — used both by the
   * platform-admin screen (any `:id`) and by `MiCopropiedadController` (the
   * caller's own active coproperty). Empty when `coPropertyId` has no
   * managing entity on file: there is no "sibling" concept without one.
   */
  async listarHermanas(
    coPropertyId: Types.ObjectId,
  ): Promise<CopropiedadResumenContract[]> {
    const propia = await this.copropiedades.findById(coPropertyId).exec();
    if (!propia?.managingEntityId) return [];

    const hermanas = await this.copropiedades
      .find({
        managingEntityId: propia.managingEntityId,
        status: 'active',
        _id: { $ne: coPropertyId },
      })
      .sort({ code: 1 })
      .exec();

    return hermanas.map((h) => ({
      id: h._id.toString(),
      codigo: h.code,
      nombre: h.name,
    }));
  }

  /**
   * The account(s) with an active Asignación scoped directly to each given
   * coproperty — one batch query for the page, not one per row. Callers
   * only pass ids of buildings with no `managingEntityId`: an entidad grant
   * covers a building through the company, never through a per-building
   * Asignación row, so a managed building's "who has access" question is
   * already answered by `entidadAdministradora`.
   */
  private async usuariosAdministradores(
    coPropertyIds: Types.ObjectId[],
  ): Promise<Map<string, string>> {
    if (coPropertyIds.length === 0) return new Map();

    const asignaciones = await this.asignaciones
      .find({
        scope: 'copropiedad',
        coPropertyId: { $in: coPropertyIds },
        status: 'active',
      })
      .exec();
    if (asignaciones.length === 0) return new Map();

    const accountIds = [
      ...new Set(asignaciones.map((a) => a.accountId.toString())),
    ];
    const cuentas = await this.accounts
      .find({ _id: { $in: accountIds } })
      .exec();
    const nombrePorCuenta = new Map(
      cuentas.map((c) => [c._id.toString(), c.fullName]),
    );

    const nombresPorCopropiedad = new Map<string, string[]>();
    for (const asignacion of asignaciones) {
      const cop = asignacion.coPropertyId!.toString();
      const nombre = nombrePorCuenta.get(asignacion.accountId.toString());
      if (!nombre) continue;
      const lista = nombresPorCopropiedad.get(cop) ?? [];
      lista.push(nombre);
      nombresPorCopropiedad.set(cop, lista);
    }

    return new Map(
      [...nombresPorCopropiedad.entries()].map(([cop, nombres]) => [
        cop,
        nombres.join(', '),
      ]),
    );
  }

  async create(
    dto: CrearCopropiedadDto,
    actor: { accountId: string; nombre: string },
  ): Promise<CopropiedadContract> {
    const code = await this.siguienteCodigo();
    const creada = await this.copropiedades.create({
      ...this.aDocumento(dto),
      code,
    });

    await this.auditoria.registrar({
      actorAccountId: actor.accountId,
      actorNombre: actor.nombre,
      accion: 'crear',
      entidadTipo: 'copropiedad',
      entidadId: creada._id.toString(),
      entidadEtiqueta: creada.name,
    });

    // Created in this order so their auto-assigned sortOrder lands 1, 2, 3 —
    // ConceptosService.create() numbers each one past whatever came before.
    const copropiedadId = creada._id.toString();
    const cargosSistema = [
      { nombre: 'Administración', tipo: 'administracion' as const },
      { nombre: 'Intereses por Mora', tipo: 'intereses' as const },
      { nombre: 'Multas', tipo: 'otro' as const },
    ];
    for (const cargo of cargosSistema) {
      await this.conceptos.create(copropiedadId, {
        nombre: cargo.nombre,
        tipo: cargo.tipo,
        sistema: true,
      });
    }

    await this.crearDocumentosSistema(creada._id);

    // Re-read populated: the created document holds a raw id for the managing
    // entity, and the contract promises its name.
    return this.findOne(creada._id.toString());
  }

  /**
   * Seeds the six ConsecutivoDocumento rows every coproperty needs before it
   * can issue anything — same reasoning as the three system cargos right
   * above: without them, the first invoice/receipt/nota an operator tries to
   * issue fails on "tipo de documento no configurado" instead of just
   * working. `nextNumber: 0` on every row — see the schema's own note: it is
   * the LAST number issued, so 0 means "none yet" and the first document
   * gets 1, never 0.
   *
   * NA (Nota de Anticipo) is filed under category NT, same as NT itself —
   * see the schema comment on `ConsecutivoDocumento.category` and
   * `DocumentosService.getHighestIssuedNumber`'s note on why NA's real
   * documents still live in their own collection despite the shared category.
   */
  private async crearDocumentosSistema(
    coPropertyId: Types.ObjectId,
  ): Promise<void> {
    const documentos: {
      category: CategoriaDocumento;
      code: string;
      displayName: string;
      accountingVoucherCode: string | null;
    }[] = [
      {
        category: 'FV',
        code: 'FV',
        displayName: 'Cobro Expensas Comunes',
        accountingVoucherCode: '01',
      },
      {
        category: 'IN',
        code: 'RC',
        displayName: 'Recibo de Caja',
        accountingVoucherCode: null,
      },
      {
        category: 'NC',
        code: 'NC',
        displayName: 'Nota Credito',
        accountingVoucherCode: null,
      },
      {
        category: 'ND',
        code: 'ND',
        displayName: 'Nota Debito',
        accountingVoucherCode: null,
      },
      {
        category: 'NT',
        code: 'NA',
        displayName: 'Nota de Anticipo',
        accountingVoucherCode: null,
      },
      {
        category: 'NT',
        code: 'NT',
        displayName: 'Nota Contable',
        accountingVoucherCode: null,
      },
    ];

    await this.consecutivos.insertMany(
      documentos.map((doc) => ({
        coPropertyId,
        category: doc.category,
        code: doc.code,
        prefix: doc.code,
        displayName: doc.displayName,
        accountingVoucherCode: doc.accountingVoucherCode,
        nextNumber: 0,
      })),
    );
  }

  /**
   * Edits a coproperty. There is deliberately no delete: `estado: 'inactivo'`
   * stops it being billed and keeps every invoice and receipt ever issued
   * against it readable, for the same reason nothing removes a financial
   * document.
   */
  async update(
    id: string,
    dto: ActualizarCopropiedadDto,
    actor: { accountId: string; nombre: string },
  ): Promise<CopropiedadContract> {
    const actualizada = await this.copropiedades
      .findByIdAndUpdate(
        id,
        { $set: this.aDocumento(dto) },
        { returnDocument: 'after' },
      )
      .exec();

    if (!actualizada) {
      throw new NotFoundException(`No se encontró la copropiedad ${id}`);
    }

    await this.auditoria.registrar({
      actorAccountId: actor.accountId,
      actorNombre: actor.nombre,
      accion: 'actualizar',
      entidadTipo: 'copropiedad',
      entidadId: actualizada._id.toString(),
      entidadEtiqueta: actualizada.name,
    });

    return this.findOne(actualizada._id.toString());
  }

  /**
   * Fills a coproperty's maestro de cuentas, cargos and parámetros de
   * facturación from a sibling coproperty of the SAME entidad
   * administradora — a shortcut for a managing company opening a new
   * building that should start from the chart of accounts and charges it
   * already uses everywhere else, instead of retyping them by hand.
   *
   * Deliberately ADDITIVE, never destructive: an account is copied only when
   * `destino` has no account with that `code` yet, a cargo only when it has
   * no cargo with that `name` yet (the three system cargos every coproperty
   * is born with are never touched, `origen`'s own copies of them are always
   * skipped), and a parámetro field is overwritten only while it still sits
   * at its schema default (null/0/false) — never over a value someone
   * already configured. Safe to run more than once, and safe on a
   * coproperty that already has some of its own configuration.
   */
  async copiarConfiguracion(
    destinoId: string,
    dto: CopiarConfiguracionDto,
    actor: { accountId: string; nombre: string },
  ): Promise<CopropiedadContract> {
    if (destinoId === dto.origenId) {
      throw new ConflictException(
        'La copropiedad de origen no puede ser la misma que la de destino',
      );
    }

    const [destino, origen] = await Promise.all([
      this.copropiedades.findById(destinoId).exec(),
      this.copropiedades.findById(dto.origenId).exec(),
    ]);
    if (!destino) {
      throw new NotFoundException(`No se encontró la copropiedad ${destinoId}`);
    }
    if (!origen) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${dto.origenId}`,
      );
    }
    if (
      !destino.managingEntityId ||
      !origen.managingEntityId ||
      !destino.managingEntityId.equals(origen.managingEntityId)
    ) {
      throw new ConflictException(
        'Ambas copropiedades deben pertenecer a la misma entidad administradora',
      );
    }

    const destinoOid = destino._id;

    // 1) Maestro de cuentas — copy any origen account whose code isn't
    // already in destino.
    const [cuentasOrigen, cuentasDestinoExistentes] = await Promise.all([
      this.cuentasContables.find({ coPropertyId: origen._id }).exec(),
      this.cuentasContables
        .find({ coPropertyId: destinoOid })
        .distinct('code')
        .exec(),
    ]);
    const codigosDestino = new Set(cuentasDestinoExistentes);
    const cuentasACopiar = cuentasOrigen.filter(
      (c) => !codigosDestino.has(c.code),
    );
    if (cuentasACopiar.length > 0) {
      await this.cuentasContables.insertMany(
        cuentasACopiar.map((c) => ({
          coPropertyId: destinoOid,
          code: c.code,
          name: c.name,
          requiresTercero: c.requiresTercero,
          isBank: c.isBank,
          cashFlow: c.cashFlow,
          profitCenter: c.profitCenter,
          destinationCenter: c.destinationCenter,
          requiresCrossDocument: c.requiresCrossDocument,
          appliesTax: c.appliesTax,
          taxRate: c.taxRate,
          active: c.active,
        })),
      );
    }

    // Every account destino now has, by code — pre-existing plus what was
    // just copied — to remap a cargo's cuenta references below.
    const cuentasDestino = await this.cuentasContables
      .find({ coPropertyId: destinoOid })
      .exec();
    const idDestinoPorCodigo = new Map(
      cuentasDestino.map((c) => [c.code, c._id.toString()]),
    );
    const codigoPorIdOrigen = new Map(
      cuentasOrigen.map((c) => [c._id.toString(), c.code]),
    );
    const remapCuenta = (id: Types.ObjectId | null): string | undefined => {
      if (!id) return undefined;
      const codigo = codigoPorIdOrigen.get(id.toString());
      if (!codigo) return undefined;
      return idDestinoPorCodigo.get(codigo);
    };

    // 2) Cargos — copy any non-system origen concepto whose name isn't
    // already in destino. Reuses ConceptosService.create so the copy gets
    // exactly the same validation (name/kind uniqueness, sortOrder) a
    // manually-typed cargo would — a conflict on one row (e.g. a stray
    // non-system 'administracion'/'intereses' kind) skips only that row.
    const [conceptosOrigen, nombresDestinoExistentes] = await Promise.all([
      this.conceptosCobro
        .find({ coPropertyId: origen._id, isSystem: { $ne: true } })
        .sort({ sortOrder: 1 })
        .exec(),
      this.conceptosCobro
        .find({ coPropertyId: destinoOid })
        .distinct('name')
        .exec(),
    ]);
    const nombresDestino = new Set(nombresDestinoExistentes);
    let cargosCopiados = 0;
    for (const concepto of conceptosOrigen) {
      if (nombresDestino.has(concepto.name)) continue;
      try {
        await this.conceptos.create(destinoId, {
          nombre: concepto.name,
          tipo: concepto.kind,
          tasaImpuesto: concepto.taxRate,
          cuentaDebitoId: remapCuenta(concepto.cuentaDebitoId),
          cuentaCreditoId: remapCuenta(concepto.cuentaCreditoId),
          cuentaImpuestoId: remapCuenta(concepto.cuentaImpuestoId),
          liquidaMora: concepto.liquidaMora,
          cargaXls: concepto.availableAsNovedad,
        });
        cargosCopiados += 1;
      } catch {
        // Skipped, not aborted — same "one bad row doesn't stop the rest"
        // convention as every other bulk operation in this codebase.
      }
    }

    // 3) Parámetros de facturación — only the fields still at their schema
    // default on destino, never overwriting something already configured.
    const camposParametrosTexto: (keyof Copropiedad)[] = [
      'defaultBankAccountCode',
      'billingNotes',
      'defaultCostCentre',
      'otherIncomeDebitAccount',
      'otherIncomeCreditAccount',
      'discountsDebitAccount',
      'discountsCreditAccount',
      'memorandumDebitAccount',
      'memorandumCreditAccount',
      'cashFlowCode',
    ];
    const camposParametrosNumero: (keyof Copropiedad)[] = [
      'discountPercentage',
      'discountFixedValue',
      'discountGraceDays',
      'lateFeeInterestRate',
    ];
    const camposParametrosBooleano: (keyof Copropiedad)[] = [
      'discountEnabled',
      'discountAppliesWithLateFee',
      'lateFeeEnabled',
      'usesMemorandumAccounts',
    ];

    const setParametros: Record<string, unknown> = {};
    for (const campo of camposParametrosTexto) {
      if (destino[campo] === null && origen[campo] !== null) {
        setParametros[campo] = origen[campo];
      }
    }
    for (const campo of camposParametrosNumero) {
      if (destino[campo] === 0 && origen[campo] !== 0) {
        setParametros[campo] = origen[campo];
      }
    }
    for (const campo of camposParametrosBooleano) {
      if (destino[campo] === false && origen[campo] === true) {
        setParametros[campo] = true;
      }
    }
    if (
      destino.lateFeeValueLimit === null &&
      origen.lateFeeValueLimit !== null
    ) {
      setParametros.lateFeeValueLimit = origen.lateFeeValueLimit;
    }

    if (Object.keys(setParametros).length > 0) {
      await this.copropiedades
        .updateOne({ _id: destinoOid }, { $set: setParametros })
        .exec();
    }

    await this.auditoria.registrar({
      actorAccountId: actor.accountId,
      actorNombre: actor.nombre,
      accion: 'actualizar',
      entidadTipo: 'copropiedad',
      entidadId: destinoId,
      entidadEtiqueta: `${destino.name} — configuración copiada desde ${origen.name} (${cuentasACopiar.length} cuentas, ${cargosCopiados} cargos)`,
    });

    return this.findOne(destinoId);
  }

  /**
   * Translates the Spanish payload into the English document shape. Only keys
   * the caller actually sent are included — spreading the DTO whole would
   * write `undefined` over fields nobody meant to clear.
   *
   * A building has a managing company or it does not, never a partial state
   * of both, so setting one clears the other: naming a managing entity
   * retires the plain-text note, and setting that note detaches the building
   * from whatever company was on file. Neither field is who administers the
   * building day to day — that is always a real person, tracked in
   * Usuarios/Asignacion, present whether or not a company is on file here.
   */
  private aDocumento(
    dto: CrearCopropiedadDto | ActualizarCopropiedadDto,
  ): Record<string, unknown> {
    const doc: Record<string, unknown> = {};
    const set = (clave: string, valor: unknown): void => {
      if (valor !== undefined) doc[clave] = valor;
    };

    set('name', dto.nombre);
    set('taxId', dto.nit);
    set('taxIdVerificationDigit', dto.digitoVerificacion);
    set('address', dto.direccion);
    set('city', dto.ciudad);
    set('phone', dto.telefono);
    set('email', dto.email);
    set('usesBuildingManagement', dto.usaGestionEdificios);
    set('receivablesAccount', dto.cuentaContableCartera);
    set('advancesAccount', dto.cuentaAnticipos);
    set('creditNotesAccount', dto.cuentaDevoluciones);
    if ('estado' in dto && dto.estado !== undefined) {
      doc.status = dto.estado === 'activo' ? 'active' : 'inactive';
    }

    if (dto.entidadAdministradoraId !== undefined) {
      doc.managingEntityId = dto.entidadAdministradoraId;
      doc.administratorName = null;
    } else if (dto.nombreAdministrador !== undefined) {
      doc.administratorName = dto.nombreAdministrador;
      doc.managingEntityId = null;
    }

    return doc;
  }
}
