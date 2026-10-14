// src/modules/busqueda/busqueda.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import {
  NotaCredito,
  NotaCreditoDocument,
} from '../../database/schemas/notas-credito/nota-credito.schema';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../../database/schemas/notas-debito/nota-debito.schema';
import {
  NotaContable,
  NotaContableDocument,
} from '../../database/schemas/notas-contables/nota-contable.schema';
import {
  NotaAnticipo,
  NotaAnticipoDocument,
} from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { escapeRegex } from '../../common/utils/query.utils';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type {
  RespuestaBusqueda,
  ResultadoBusquedaDocumento,
} from '../../contracts';
import { LIMITE_BUSQUEDA_POR_DEFECTO } from './dto/buscar.dto';
import type { BuscarDto } from './dto/buscar.dto';
import {
  toInmuebleVisible,
  toResultadoFactura,
  toResultadoInmueble,
  toResultadoNotaAnticipo,
  toResultadoNotaContable,
  toResultadoNotaCredito,
  toResultadoNotaDebito,
  toResultadoRecibo,
} from './busqueda.mapper';
import type {
  FilaFacturaBusqueda,
  FilaInmuebleBusqueda,
  FilaNotaAnticipoBusqueda,
  FilaNotaContableBusqueda,
  FilaNotaCreditoBusqueda,
  FilaNotaDebitoBusqueda,
  FilaReciboBusqueda,
} from './busqueda.mapper';

/**
 * Cap on the matching-unit set reused as a document criterion. A two-letter
 * term can match most of a building; an unbounded `$in` over every unit would
 * make the document queries as heavy as the scan the limit is meant to avoid.
 * Units past the cap are still reachable by typing more of the code or name.
 */
const MAX_INMUEBLES_COINCIDENTES = 200;

/** Fields every document projection needs, on top of its type-specific ones. */
const BASE = { inmuebleId: 1, numeroCompleto: 1, estado: 1 } as const;

const PROYECCION_FACTURA = {
  ...BASE,
  codigoInmueble: 1,
  'titular.nombre': 1,
  fechaEmision: 1,
  total: 1,
};
const PROYECCION_RECIBO = { ...BASE, fechaRecibo: 1, montoRecibido: 1 };
const PROYECCION_NOTA_CREDITO = {
  ...BASE,
  fecha: 1,
  createdAt: 1,
  montoTotal: 1,
};
const PROYECCION_NOTA_DEBITO = { ...BASE, fechaEmision: 1, total: 1 };
const PROYECCION_NOTA_CONTABLE = { ...BASE, fecha: 1, createdAt: 1, monto: 1 };
const PROYECCION_NOTA_ANTICIPO = { ...BASE, fechaEmision: 1, montoAplicado: 1 };

/** Newest first, as each Nota's own list does; `_id` breaks ties. */
const ORDEN_NOTAS = { createdAt: -1, _id: -1 } as const;

/**
 * Global search (Ctrl/Cmd+K) over the ACTIVE coproperty: documents by number
 * OR by the unit / holder they belong to, and units by code or holder.
 *
 * Every group is gated by its own CASL subject here, not only by the route:
 * the route is one door onto several subjects, and a caller who may read
 * Facturas but not Recibos must not learn Recibos exist. A forbidden group is
 * OMITTED (key absent) rather than answered `[]`, so the client can tell "no
 * permission" from "no matches".
 *
 * Display data comes from ONE batch unit lookup shared by all hits. Facturas
 * show their FROZEN unit code and holder (what the invoice itself prints);
 * every other type shows the unit's LIVE holder, which is acceptable for a
 * search hint — those documents freeze no holder to prefer.
 */
@Injectable()
export class BusquedaService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(NotaCredito.name)
    private readonly notasCredito: Model<NotaCreditoDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(NotaContable.name)
    private readonly notasContables: Model<NotaContableDocument>,
    @InjectModel(NotaAnticipo.name)
    private readonly notasAnticipo: Model<NotaAnticipoDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    private readonly tenant: TenantContextService,
    private readonly abilities: CaslAbilityFactory,
  ) {}

  async buscar(user: IRequestUser, dto: BuscarDto): Promise<RespuestaBusqueda> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const ability = this.abilities.createForUser(user);
    const limite = dto.limite ?? LIMITE_BUSQUEDA_POR_DEFECTO;

    const puede = {
      facturas: ability.can('read', 'Factura'),
      recibos: ability.can('read', 'Recibo'),
      notaCredito: ability.can('read', 'NotaCredito'),
      // Notas de débito are the `OtraNota` subject — see their controller.
      notaDebito: ability.can('read', 'OtraNota'),
      notaContable: ability.can('read', 'NotaContable'),
      notaAnticipo: ability.can('read', 'NotaAnticipo'),
      inmuebles: ability.can('read', 'Inmueble'),
    };
    const puedeNotas =
      puede.notaCredito ||
      puede.notaDebito ||
      puede.notaContable ||
      puede.notaAnticipo;

    // Nothing readable: no query at all (the route's own gate normally stops
    // this first; this keeps the service safe if it is ever reused).
    if (!puede.facturas && !puede.recibos && !puedeNotas && !puede.inmuebles) {
      return {};
    }

    // Escaped: a search box is user input, and an unescaped "(" throws or a
    // crafted pattern pins the database.
    const regex = { $regex: escapeRegex(dto.q), $options: 'i' };
    const coincidentes = await this.inmueblesCoincidentes(copropiedadId, regex);
    const idsCoincidentes = coincidentes.map((i) => i._id);

    // The tenant always leads the filter (tenancy law); the unit branch is
    // what lets "who / where" searches find a document whose number says
    // nothing (old documents, a different numbering scheme).
    const filtro = {
      copropiedadId,
      $or: [
        { numeroCompleto: regex },
        ...(idsCoincidentes.length
          ? [{ inmuebleId: { $in: idsCoincidentes } }]
          : []),
      ],
    };

    const [
      facturas,
      recibos,
      notasCredito,
      notasDebito,
      notasContables,
      notasAnticipo,
    ] = await Promise.all([
      puede.facturas
        ? this.facturas
            .find(filtro, PROYECCION_FACTURA)
            .sort({ fechaEmision: -1, _id: -1 })
            .limit(limite)
            .lean<FilaFacturaBusqueda[]>()
            .exec()
        : [],
      puede.recibos
        ? this.recibos
            .find(filtro, PROYECCION_RECIBO)
            .sort({ numero: -1, _id: -1 })
            .limit(limite)
            .lean<FilaReciboBusqueda[]>()
            .exec()
        : [],
      puede.notaCredito
        ? this.notasCredito
            .find(filtro, PROYECCION_NOTA_CREDITO)
            .sort(ORDEN_NOTAS)
            .limit(limite)
            .lean<FilaNotaCreditoBusqueda[]>()
            .exec()
        : [],
      puede.notaDebito
        ? this.notasDebito
            .find(filtro, PROYECCION_NOTA_DEBITO)
            .sort(ORDEN_NOTAS)
            .limit(limite)
            .lean<FilaNotaDebitoBusqueda[]>()
            .exec()
        : [],
      puede.notaContable
        ? this.notasContables
            .find(filtro, PROYECCION_NOTA_CONTABLE)
            .sort(ORDEN_NOTAS)
            .limit(limite)
            .lean<FilaNotaContableBusqueda[]>()
            .exec()
        : [],
      puede.notaAnticipo
        ? this.notasAnticipo
            .find(filtro, PROYECCION_NOTA_ANTICIPO)
            .sort(ORDEN_NOTAS)
            .limit(limite)
            .lean<FilaNotaAnticipoBusqueda[]>()
            .exec()
        : [],
    ]);

    // One lookup for every unit that has to be displayed: the ones the
    // non-Factura hits point at, plus the top matches of the Inmuebles group.
    // (Facturas carry their own frozen code and holder.)
    const idsInmueblesGrupo = puede.inmuebles
      ? idsCoincidentes.slice(0, limite)
      : [];
    const idsAMostrar = new Set<string>([
      ...[
        ...recibos,
        ...notasCredito,
        ...notasDebito,
        ...notasContables,
        ...notasAnticipo,
      ].map((d) => d.inmuebleId.toString()),
      ...idsInmueblesGrupo.map((id) => id.toString()),
    ]);
    const filasInmuebles = await this.cargarInmuebles(
      copropiedadId,
      [...idsAMostrar].map((id) => new Types.ObjectId(id)),
    );
    const visibles = new Map(
      filasInmuebles.map((f) => [f._id.toString(), toInmuebleVisible(f)]),
    );
    const filaPorId = new Map(filasInmuebles.map((f) => [f._id.toString(), f]));

    const respuesta: RespuestaBusqueda = {};
    if (puede.facturas) respuesta.facturas = facturas.map(toResultadoFactura);
    if (puede.recibos) {
      respuesta.recibos = recibos.map((r) => toResultadoRecibo(r, visibles));
    }
    if (puedeNotas) {
      // Top `limite` PER TYPE was already taken in each query; merging them
      // and cutting again keeps the newest overall without starving a type.
      const notas: ResultadoBusquedaDocumento[] = [
        ...notasCredito.map((n) => toResultadoNotaCredito(n, visibles)),
        ...notasDebito.map((n) => toResultadoNotaDebito(n, visibles)),
        ...notasContables.map((n) => toResultadoNotaContable(n, visibles)),
        ...notasAnticipo.map((n) => toResultadoNotaAnticipo(n, visibles)),
      ];
      respuesta.notas = notas
        .sort(
          (a, b) => b.fecha.localeCompare(a.fecha) || b.id.localeCompare(a.id),
        )
        .slice(0, limite);
    }
    if (puede.inmuebles) {
      respuesta.inmuebles = idsInmueblesGrupo
        .map((id) => filaPorId.get(id.toString()))
        .filter((f): f is FilaInmuebleBusqueda => f !== undefined)
        .map(toResultadoInmueble);
    }
    return respuesta;
  }

  /**
   * Units of the active coproperty whose code or holder name matches — the same
   * rule as `InmueblesService.findAll`'s `buscar` (the holder's name lives on a
   * separate Tercero, so matching it means resolving the terceros first).
   * Sorted by code and capped; ids only, the display fields are loaded later
   * for just the units that end up on screen.
   */
  private async inmueblesCoincidentes(
    copropiedadId: Types.ObjectId,
    regex: { $regex: string; $options: string },
  ): Promise<{ _id: Types.ObjectId }[]> {
    const terceroIds = await this.terceros
      .find({ copropiedadId, nombre: regex })
      .distinct('_id')
      .exec();
    return this.inmuebles
      .find(
        {
          copropiedadId,
          $or: [
            { codigo: regex },
            ...(terceroIds.length ? [{ titularId: { $in: terceroIds } }] : []),
          ],
        },
        { _id: 1 },
      )
      .sort({ codigo: 1 })
      .limit(MAX_INMUEBLES_COINCIDENTES)
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
  }

  /** Display fields of the given units, tenant-scoped (never `findById`). */
  private async cargarInmuebles(
    copropiedadId: Types.ObjectId,
    ids: Types.ObjectId[],
  ): Promise<FilaInmuebleBusqueda[]> {
    if (ids.length === 0) return [];
    return this.inmuebles
      .find(
        { copropiedadId, _id: { $in: ids } },
        { codigo: 1, titularId: 1, estado: 1 },
      )
      .populate('titularId', 'nombre')
      .lean<FilaInmuebleBusqueda[]>()
      .exec();
  }
}
