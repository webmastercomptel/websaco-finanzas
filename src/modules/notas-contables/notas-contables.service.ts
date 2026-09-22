import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  NotaContable,
  NotaContableDocument,
} from '../../database/schemas/notas-contables/nota-contable.schema';
import {
  SaldoCartera,
  SaldoCarteraDocument,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
import {
  CarteraPorDocumento,
  CarteraPorDocumentoDocument,
} from '../../database/schemas/facturacion/cartera-por-documento.schema';
import {
  AsientoContable,
  AsientoContableDocument,
} from '../../database/schemas/facturacion/asiento-contable.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  CuentaContable,
  CuentaContableDocument,
} from '../../database/schemas/contabilidad/cuenta-contable.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { NumeracionService } from '../../common/numeracion/numeracion.service';
import { codigoDeCuentaContable } from '../../common/utils/mapper.utils';
import { exigirPeriodoFacturacionActual } from '../../common/contabilidad/periodo-calendario.util';
import { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';
import { LotesFacturacionService } from '../facturacion/lotes.service';
import { ajustarSaldosCarteraPorDistribucion } from '../recibos/cruce.util';
import {
  construirMovimientosReclasificacion,
  cuentasOrdenDe,
  enriquecerMovimientosConAuxiliares,
  CUENTA_SIN_ASIGNAR,
  type MarcasCuentaContable,
} from '../facturacion/asiento.builder';
import { toNotaContable, fechaNotaContable } from './notas-contables.mapper';
import { construirDatosImpresionNotaContable } from './nota-contable-pdf-datos.util';
import { TituloDocumentoService } from '../../common/documentos/titulo-documento.service';
import type {
  NotaContable as NotaContableContract,
  Paginado,
} from '../../contracts';
import type { CrearNotaContableDto } from './dto/crear-nota-contable.dto';
import type { AnularNotaContableDto } from './dto/anular-nota-contable.dto';
import type { ListarNotaContableDto } from './dto/listar-nota-contable.dto';
import type { DatosReciboImpresion } from '../../common/documentos/datos-impresion.types';

/**
 * Service for Notas Contables: reclassifying an amount between two
 * ConceptoCobro balances within one inmueble's cartera.
 *
 * `terceros` and `presentacionDocumento` were APPENDED, trailing and
 * optional (same reasoning as `cuentasContables`/`inmuebles` right above).
 * Originally added so `crear()` could freeze this Nota Contable's own
 * `documentDefinition` right after creating it — that step is GONE under
 * the pdfmake + frontend-render model (`solicitar-generacion`/
 * `confirmar-generacion` are separate, explicit actions triggered later,
 * from `NotasContablesController`). `terceros` now backs `datosImpresion`
 * and `presentacionDocumento` backs `findOne`'s `objectPath`/`generatedAt`
 * lookup; every existing positional test keeps compiling with both left
 * `undefined`.
 */
@Injectable()
export class NotasContablesService {
  constructor(
    @InjectModel(NotaContable.name)
    private readonly notasContables: Model<NotaContableDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldos: Model<SaldoCarteraDocument>,
    @InjectModel(CarteraPorDocumento.name)
    private readonly carteraPorDocumento: Model<CarteraPorDocumentoDocument>,
    @InjectModel(AsientoContable.name)
    private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly numeracion: NumeracionService,
    @InjectConnection() private readonly connection: Connection,
    private readonly lotes: LotesFacturacionService,
    @InjectModel(CuentaContable.name)
    private readonly cuentasContables?: Model<CuentaContableDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles?: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros?: Model<TerceroDocument>,
    private readonly presentacionDocumento?: PresentacionDocumentoService,
    // APPENDED LAST, optional — same append discipline as every dependency
    // above. Backs `datosImpresion`'s own `resolverGenerico('NT', ...)` call.
    private readonly tituloDocumento?: TituloDocumentoService,
  ) {}

  /** See `RecibosService.conAuxiliares`'s own docblock — identical shape. */
  private async conAuxiliares(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    inmuebleId: Types.ObjectId,
    copropiedad: {
      defaultCostCentre: string | null;
      cashFlowCode: string | null;
    } | null,
    entries: ReturnType<typeof construirMovimientosReclasificacion>,
  ): Promise<ReturnType<typeof construirMovimientosReclasificacion>> {
    if (!this.cuentasContables) return entries;
    const [cuentas, inmueble] = await Promise.all([
      this.cuentasContables.find({ coPropertyId }).session(session).exec(),
      this.inmuebles?.findById(inmuebleId).session(session).exec(),
    ]);
    const marcas = new Map<string, MarcasCuentaContable>(
      cuentas.map((c) => [
        c.code,
        {
          requiereTercero: c.requiresTercero,
          centroUtilidad: c.profitCenter,
          centroDestino: c.destinationCenter,
          flujoCaja: c.cashFlow,
          requiereDocumentoCruce: c.requiresCrossDocument,
        },
      ]),
    );
    return enriquecerMovimientosConAuxiliares(entries, marcas, {
      terceroCode: inmueble?.code ?? null,
      centroCosto: copropiedad?.defaultCostCentre ?? null,
      flujoCajaCodigo: copropiedad?.cashFlowCode ?? null,
    });
  }

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
   * Creates a Nota Contable — reclassifies `monto` from one concepto's
   * balance to another's, on ONE specific Factura/NotaDebito within the
   * inmueble (the document the user picked from "Cartera Pendiente del
   * Inmueble") — never spread across however many documents happen to
   * share the origin concepto at this inmueble.
   *
   * Validates: monto > 0, conceptoOrigenId !== conceptoDestinoId, and the
   * origin concepto's current balance ON THAT DOCUMENT >= monto (design §4,
   * updated to read from `CarteraPorDocumento` instead of the cross-document
   * `SaldoCartera` — a document's own row is also what the check itself
   * confirms exists, so no separate Factura/NotaDebito lookup is needed).
   */
  async crear(
    accountId: string,
    dto: CrearNotaContableDto,
  ): Promise<NotaContableContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const inmuebleId = new Types.ObjectId(dto.inmuebleId);
    const documentoId = new Types.ObjectId(dto.documentoId);
    const conceptoOrigenId = new Types.ObjectId(dto.conceptoOrigenId);
    const conceptoDestinoId = new Types.ObjectId(dto.conceptoDestinoId);

    if (conceptoOrigenId.equals(conceptoDestinoId)) {
      throw new ConflictException(
        'El concepto de origen y destino deben ser distintos',
      );
    }

    // `@IsPositive()` on `CrearNotaContableDto` already rejects this at the
    // HTTP boundary (this repo's global `ValidationPipe`, `app-setup.ts`) —
    // but this docblock has always claimed the SERVICE validates `monto > 0`,
    // and every sibling service (RecibosService.aplicarManual, etc.) owns
    // its own business invariants instead of relying solely on the DTO pipe.
    // Without this, `monto <= 0` sails straight through the balance check
    // below (`0 > balanceDisponible` and `-N > balanceDisponible` are both
    // false for any non-negative balance) and reaches
    // `ajustarSaldosCarteraPorDistribucion` with a sign-flipping amount.
    if (dto.monto <= 0) {
      throw new ConflictException('El monto debe ser mayor que cero');
    }

    // The note's own date must fall in the same month/year as the last
    // consolidated billing run — same rule, same reasoning as
    // `NotasCreditoService.crear()`'s identical check on `dto.fecha`. A
    // coproperty that has never consolidated a lote has no "current period"
    // yet, so nothing to validate against. A refusal costs no session —
    // same placement as `RecibosService.crear()`'s own periodo/lotes checks.
    const ultimoLote = await this.lotes.obtenerUltimoConsolidado(
      coPropertyId.toString(),
    );
    exigirPeriodoFacturacionActual(
      new Date(dto.fecha),
      ultimoLote,
      'La fecha de la nota',
    );
    await this.lotes.exigirSinLoteAbierto(coPropertyId.toString());

    const resultado = await this.transaccion(async (session) => {
      // Read origin concepto's current balance ON THIS DOCUMENT — the ONLY
      // authoritative signal for a reclassification (design §4). Finding no
      // row here means either the document doesn't belong to this
      // inmueble/coproperty or it never had a pending balance for this
      // concepto — both are refused identically, same "no existe, no está
      // vigente, o su saldo es menor" shape every other cruce guard uses.
      const filaOrigen = await this.carteraPorDocumento
        .findOne({
          coPropertyId,
          inmuebleId,
          documentoId,
          conceptoId: conceptoOrigenId,
        })
        .session(session)
        .exec();

      const balanceDisponible = filaOrigen?.saldoPendiente ?? 0;
      if (dto.monto > balanceDisponible) {
        throw new ConflictException(
          `El monto solicitado (${dto.monto}) supera el saldo disponible ` +
            `del concepto de origen en ese documento (${balanceDisponible})`,
        );
      }

      const numero = await this.numeracion.siguienteDocumento(
        coPropertyId.toString(),
        dto.codigo,
        session,
      );

      const [creada] = await this.notasContables.create(
        [
          {
            coPropertyId,
            inmuebleId,
            tipoDocumento: dto.tipoDocumento,
            documentoId,
            conceptoOrigenId,
            conceptoDestinoId,
            monto: dto.monto,
            description: dto.descripcion,
            issueDate: new Date(dto.fecha),
            prefix: numero.prefijo,
            number: numero.numero,
            fullNumber: numero.completo,
            status: 'activo',
            generatedBy: accountId,
          },
        ],
        { session },
      );

      const documento = { tipoDocumento: dto.tipoDocumento, documentoId };

      // Decrease origin concepto's balance.
      await ajustarSaldosCarteraPorDistribucion(
        this.saldos,
        this.carteraPorDocumento,
        session,
        coPropertyId,
        inmuebleId,
        [{ conceptoId: conceptoOrigenId, monto: dto.monto }],
        dto.monto,
        -1,
        documento,
      );

      // Increase destination concepto's balance. NOTE: same limitation as
      // `SaldoCartera`'s own increment above — if this document never had a
      // `CarteraPorDocumento` row for `conceptoDestinoId` (never charged
      // that concepto), there's nothing for `findOneAndUpdate` to match and
      // this silently no-ops, pre-existing behavior, not introduced here.
      await ajustarSaldosCarteraPorDistribucion(
        this.saldos,
        this.carteraPorDocumento,
        session,
        coPropertyId,
        inmuebleId,
        [{ conceptoId: conceptoDestinoId, monto: dto.monto }],
        dto.monto,
        +1,
        documento,
      );

      // Post 2-leg accounting entry, dated with the note's OWN declared
      // date — never `new Date()`.
      await this.postearAsiento(
        session,
        coPropertyId,
        creada,
        conceptoOrigenId,
        conceptoDestinoId,
        fechaNotaContable(creada),
      );

      const final = await this.notasContables
        .findOne({ _id: creada._id, coPropertyId })
        .session(session)
        .exec();
      return toNotaContable(
        final!,
        await this.resolverInmuebleCodigo(inmuebleId),
      );
    });

    // Presentation generation is no longer triggered here — under the
    // pdfmake + frontend-render model, `solicitar-generacion`/
    // `confirmar-generacion` are separate, explicit actions the frontend
    // calls later (`NotasContablesController`), never something `crear()`
    // does internally.
    return resultado;
  }

  /**
   * The pure printable data for this Nota Contable — what
   * `NotasContablesController`'s `solicitar-generacion` route sends the
   * frontend alongside the template, computed fresh every call. Reuses
   * `construirDatosImpresionNotaContable` UNCHANGED.
   */
  async datosImpresion(id: string): Promise<DatosReciboImpresion> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const nota = await this.findOneRaw(id);
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }
    const tituloDocumento = await this.tituloDocumento!.resolverGenerico(
      'NT',
      coPropertyId,
    );
    return construirDatosImpresionNotaContable(
      nota,
      copropiedad,
      coPropertyId,
      {
        conceptos: this.conceptos,
        inmuebles: this.inmuebles!,
        terceros: this.terceros!,
        cuentasContables: this.cuentasContables!,
      },
      tituloDocumento,
    );
  }

  /**
   * Lean listing — always scoped to the active copropiedad, honoring filters.
   * Uses `toNotaContable`, no detail-vs-listing split needed (no
   * `aplicaciones` array).
   */
  async findAll(
    query: ListarNotaContableDto,
  ): Promise<Paginado<NotaContableContract>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { coPropertyId };
    if (query.inmuebleId) filtro.inmuebleId = query.inmuebleId;
    if (query.estado) filtro.status = query.estado;
    if (query.fechaDesde || query.fechaHasta) {
      const rango = {
        ...(query.fechaDesde ? { $gte: new Date(query.fechaDesde) } : {}),
        ...(query.fechaHasta ? { $lte: new Date(query.fechaHasta) } : {}),
      };
      // A note carries a real `issueDate` from that feature onward; one
      // created before it existed has `issueDate: null` and must fall back
      // to `createdAt` — same pattern `NotasCreditoService.findAll` already
      // uses for its own `issueDate`.
      filtro.$or = [
        { issueDate: rango },
        { issueDate: null, createdAt: rango },
      ];
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.notasContables
        .find(filtro)
        .sort({ createdAt: -1, _id: -1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.notasContables.countDocuments(filtro).exec(),
    ]);

    // Batched — one query for the whole page, never one per row.
    const inmuebleIds = [
      ...new Set(documentos.map((d) => d.inmuebleId.toString())),
    ].map((idInmueble) => new Types.ObjectId(idInmueble));
    const inmuebles = inmuebleIds.length
      ? await this.inmuebles
          ?.find({ coPropertyId, _id: { $in: inmuebleIds } })
          .exec()
      : [];
    const codigoPorInmueble = new Map(
      (inmuebles ?? []).map((i) => [i._id.toString(), i.code]),
    );

    return {
      // Never a bare `.map(toNotaContable)` — `Array.map` would leak its
      // own `index` into `toNotaContable`'s second (`inmuebleCodigo`) param,
      // same gotcha `toAplicacionCartera`'s own docblock warns about.
      items: documentos.map((doc) =>
        toNotaContable(
          doc,
          codigoPorInmueble.get(doc.inmuebleId.toString()) ?? '',
        ),
      ),
      total,
      pagina,
      porPagina,
    };
  }

  /**
   * Full detail — same shape as listing (no `aplicaciones` array to embed,
   * unlike every prior module).
   */
  async findOne(id: string): Promise<NotaContableContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const nota = await this.notasContables
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!nota) {
      throw new NotFoundException(`No se encontró la nota contable ${id}`);
    }
    // `objectPath`/`generatedAt` — resolved from `presentacion_documento` the
    // same way `RecibosService.findOne` resolves its own.
    const presentacion = this.presentacionDocumento
      ? await this.presentacionDocumento.buscar('NT', nota._id)
      : null;
    return toNotaContable(
      nota,
      await this.resolverInmuebleCodigo(nota.inmuebleId),
      presentacion,
    );
  }

  /**
   * Returns the raw Mongoose document — used by PDF generation.
   */
  async findOneRaw(id: string): Promise<NotaContableDocument> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const nota = await this.notasContables
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!nota) {
      throw new NotFoundException(`No se encontró la nota contable ${id}`);
    }
    return nota;
  }

  /**
   * Live-resolves an inmueble's printable código from its id — no frozen
   * field for it exists on `NotaContable` itself (unlike `Factura.unitCode`),
   * so every reader looks it up here. Same fallback (`?? ''`) as
   * `CarteraPorConceptosService`'s identical live-resolve.
   */
  async resolverInmuebleCodigo(inmuebleId: Types.ObjectId): Promise<string> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const inmueble = await this.inmuebles
      ?.findOne({ _id: inmuebleId, coPropertyId })
      .exec();
    return inmueble?.code ?? '';
  }

  /**
   * Voids a Nota Contable — reverses the reclassification (destino→origen)
   * and posts the mirrored accounting entry (accounts swapped).
   */
  async anular(
    id: string,
    dto: AnularNotaContableDto,
    accountId: string,
  ): Promise<NotaContableContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    // The reversing asiento is dated by the user, never by the server clock
    // — same rule as creation, same reasoning: the accountant controls
    // every document date in the ledger, this system never assumes "today".
    // A refusal costs no session — same placement as `crear()`'s own check.
    const ultimoLote = await this.lotes.obtenerUltimoConsolidado(
      coPropertyId.toString(),
    );
    exigirPeriodoFacturacionActual(
      new Date(dto.fecha),
      ultimoLote,
      'La fecha de la anulación',
    );

    return this.transaccion(async (session) => {
      const nota = await this.notasContables
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      if (!nota) {
        throw new NotFoundException(`No se encontró la nota contable ${id}`);
      }
      if (nota.status === 'anulado') {
        throw new ConflictException(
          `La nota contable ${nota.fullNumber} ya está anulada`,
        );
      }

      // `documentoId`/`tipoDocumento` are absent on a Nota Contable created
      // before this field existed — omitted entirely rather than passed as
      // `{ documentoId: undefined }`, so `ajustarSaldosCarteraPorDistribucion`
      // takes its own "no document to touch" branch instead of matching
      // nothing with an undefined filter value.
      const documento = nota.documentoId
        ? { tipoDocumento: nota.tipoDocumento, documentoId: nota.documentoId }
        : undefined;

      // Reverse: increase origin, decrease destination (signs swapped).
      await ajustarSaldosCarteraPorDistribucion(
        this.saldos,
        this.carteraPorDocumento,
        session,
        coPropertyId,
        nota.inmuebleId,
        [{ conceptoId: nota.conceptoOrigenId, monto: nota.monto }],
        nota.monto,
        +1,
        documento,
      );
      await ajustarSaldosCarteraPorDistribucion(
        this.saldos,
        this.carteraPorDocumento,
        session,
        coPropertyId,
        nota.inmuebleId,
        [{ conceptoId: nota.conceptoDestinoId, monto: nota.monto }],
        nota.monto,
        -1,
        documento,
      );

      // Post mirrored entry: swap accounts (design §7). Dated with THIS
      // anulación's own declared date, never the note's original date.
      await this.postearAsiento(
        session,
        coPropertyId,
        nota,
        nota.conceptoDestinoId,
        nota.conceptoOrigenId,
        new Date(dto.fecha),
      );

      await this.notasContables
        .findOneAndUpdate(
          { _id: id, coPropertyId },
          {
            $set: {
              status: 'anulado',
              voidedReason: dto.motivo,
              voidedDetail: dto.detalle,
              voidedAt: new Date(),
              voidedBy: accountId,
            },
          },
          { session },
        )
        .exec();

      const final = await this.notasContables
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      return toNotaContable(
        final!,
        await this.resolverInmuebleCodigo(final!.inmuebleId),
      );
    });
  }

  /**
   * Posts the 2-leg accounting entry for a reclassification. Reads each
   * concepto's CREDIT account (the one invoicing posts income to, per
   * `construirMovimientos` in asiento.builder.ts) and falls back to
   * `CUENTA_SIN_ASIGNAR` when unset.
   *
   * Called at creation with (origen, destino) and at void with (destino,
   * origen) — the same function, accounts AND `kind` swapped together
   * (design §7): `cuentaOrigenDoc`/`cuentaDestinoDoc` are looked up from
   * whichever concepto id lands in each param, so `origenEsIntereses`/
   * `destinoEsIntereses` naturally swap alongside the real accounts, and
   * `construirMovimientosReclasificacion`'s own sign logic reverses the
   * memo pair for free — no separate `invertirCuentasOrden` needed here
   * (an earlier version applied that on top and double-flipped it back to
   * the wrong direction on every void).
   */
  private async postearAsiento(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    nota: NotaContableDocument,
    cuentaOrigenConceptoId: Types.ObjectId,
    cuentaDestinoConceptoId: Types.ObjectId,
    fecha: Date,
  ): Promise<void> {
    const [cuentaOrigenDoc, cuentaDestinoDoc, copropiedad] = await Promise.all([
      this.conceptos
        .findOne({ _id: cuentaOrigenConceptoId, coPropertyId })
        .populate('cuentaCreditoId', 'code')
        .session(session)
        .exec(),
      this.conceptos
        .findOne({ _id: cuentaDestinoConceptoId, coPropertyId })
        .populate('cuentaCreditoId', 'code')
        .session(session)
        .exec(),
      this.copropiedades.findById(coPropertyId).session(session).exec(),
    ]);

    const cuentaOrigen =
      codigoDeCuentaContable(cuentaOrigenDoc?.cuentaCreditoId) ??
      CUENTA_SIN_ASIGNAR;
    const cuentaDestino =
      codigoDeCuentaContable(cuentaDestinoDoc?.cuentaCreditoId) ??
      CUENTA_SIN_ASIGNAR;
    const cuentasOrden = cuentasOrdenDe(copropiedad);

    let entries = construirMovimientosReclasificacion(
      cuentaOrigen,
      cuentaDestino,
      nota.monto,
      cuentasOrden,
      cuentaOrigenDoc?.kind === 'intereses',
      cuentaDestinoDoc?.kind === 'intereses',
    );
    entries = await this.conAuxiliares(
      session,
      coPropertyId,
      nota.inmuebleId,
      copropiedad,
      entries,
    );

    await this.asientos.create(
      [
        {
          coPropertyId,
          loteId: null,
          facturaId: null,
          reciboId: null,
          notaCreditoId: null,
          notaDebitoId: null,
          notaContableId: nota._id,
          date: fecha,
          entries,
        },
      ],
      { session },
    );
  }
}
