import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  AsientoContable,
  AsientoContableDocument,
} from '../../database/schemas/facturacion/asiento-contable.schema';
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
import {
  resolveAnchorId,
  resolverMovimientoContable,
} from './movimiento-contable.util';
import type { RespuestaMovimientoContable } from '../../contracts';

/** One anchor document's identity — enough to resolve `numeroDocumento` and
 *  which inmueble it belongs to, across all five document types. */
type AnchorInfo = { fullNumber: string; inmuebleId: Types.ObjectId };

type InmuebleMeta = {
  inmuebleCodigo: string | null;
  propietario: string | null;
  nit: string | null;
};

const META_VACIA: InmuebleMeta = {
  inmuebleCodigo: null,
  propietario: null,
  nit: null,
};

@Injectable()
export class MovimientoContableService {
  constructor(
    @InjectModel(AsientoContable.name)
    private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(Recibo.name) private readonly recibos: Model<ReciboDocument>,
    @InjectModel(NotaCredito.name)
    private readonly notasCredito: Model<NotaCreditoDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(NotaContable.name)
    private readonly notasContables: Model<NotaContableDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(CuentaContable.name)
    private readonly cuentasContables: Model<CuentaContableDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Coproperty-wide accounting journal for a date range — every
   * AsientoContable in the window, regardless of which inmueble or document
   * type anchors it. Unlike the per-inmueble browse this replaced,
   * AsientoContable already carries `date` and `coPropertyId` directly, so no
   * document-id prefetch per type is needed to scope the query.
   */
  async findAll(params: {
    desde: string;
    hasta: string;
  }): Promise<RespuestaMovimientoContable> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const desde = new Date(params.desde);
    const hasta = new Date(params.hasta);

    const asientos = await this.asientos
      .find({ coPropertyId, date: { $gte: desde, $lte: hasta } })
      .sort({ date: 1 })
      .exec();

    if (asientos.length === 0) return { movimientos: [] };

    const anchorMap = await this.buildAnchorMap(asientos, coPropertyId);

    const inmuebleIds = [
      ...new Set([...anchorMap.values()].map((a) => a.inmuebleId.toString())),
    ].map((id) => new Types.ObjectId(id));
    const metaMap = await this.resolveMetaBatch(inmuebleIds, coPropertyId);

    const cuentaCodigos = [
      ...new Set(asientos.flatMap((a) => a.entries.map((e) => e.account))),
    ];
    const nombrePorCuenta = await this.resolveNombresCuenta(
      cuentaCodigos,
      coPropertyId,
    );

    const movimientos = asientos.map((a) => {
      const anchorId = resolveAnchorId(a).toString();
      const anchorInfo = anchorMap.get(anchorId);
      const numeroDocumento = anchorInfo?.fullNumber ?? '—';
      const meta = anchorInfo
        ? (metaMap.get(anchorInfo.inmuebleId.toString()) ?? META_VACIA)
        : META_VACIA;
      return resolverMovimientoContable(
        a,
        { ...meta, numeroDocumento },
        nombrePorCuenta,
      );
    });

    return { movimientos };
  }

  /** Batch-resolve inmueble code + propietario/nit for every inmueble
   *  referenced by this batch of asientos — one query per collection
   *  regardless of how many distinct inmuebles are involved. */
  private async resolveMetaBatch(
    inmuebleIds: Types.ObjectId[],
    coPropertyId: Types.ObjectId,
  ): Promise<Map<string, InmuebleMeta>> {
    const result = new Map<string, InmuebleMeta>();
    if (inmuebleIds.length === 0) return result;

    const inmuebles = await this.inmuebles
      .find({ coPropertyId, _id: { $in: inmuebleIds } })
      .exec();

    const holderIds = inmuebles
      .map((i) => i.holderId)
      .filter((id): id is Types.ObjectId => id !== null);
    const nombreMap = new Map<string, { name: string; nit: string | null }>();
    if (holderIds.length > 0) {
      const uniqueHolderIds = [
        ...new Set(holderIds.map((id) => id.toString())),
      ].map((id) => new Types.ObjectId(id));
      const terceros = await this.terceros
        .find({ coPropertyId, _id: { $in: uniqueHolderIds } })
        .exec();
      for (const t of terceros) {
        const nit = t.identificationNumber
          ? `${t.identificationNumber}${t.identificationVerificationDigit ? `-${t.identificationVerificationDigit}` : ''}`
          : null;
        nombreMap.set(t._id.toString(), { name: t.name, nit });
      }
    }

    for (const i of inmuebles) {
      const holder = i.holderId
        ? (nombreMap.get(i.holderId.toString()) ?? null)
        : null;
      result.set(i._id.toString(), {
        inmuebleCodigo: i.code,
        propietario: holder?.name ?? null,
        nit: holder?.nit ?? null,
      });
    }
    return result;
  }

  /** Batch-resolve account code -> name from the coproperty's chart of
   *  accounts. A code with no chart entry is simply absent from the map —
   *  the caller falls back to the code itself. */
  private async resolveNombresCuenta(
    codigos: string[],
    coPropertyId: Types.ObjectId,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (codigos.length === 0) return map;

    const cuentas = await this.cuentasContables
      .find({ coPropertyId, code: { $in: codigos } })
      .exec();
    for (const c of cuentas) {
      map.set(c.code, c.name);
    }
    return map;
  }

  /** Build a Map<anchorId, {fullNumber, inmuebleId}> for all anchor types
   *  referenced by this batch of asientos. */
  private async buildAnchorMap(
    asientos: AsientoContableDocument[],
    coPropertyId: Types.ObjectId,
  ): Promise<Map<string, AnchorInfo>> {
    const map = new Map<string, AnchorInfo>();

    const idsByType = new Map<string, Types.ObjectId[]>();
    for (const a of asientos) {
      const anchorId = resolveAnchorId(a);
      const key = a.facturaId
        ? 'FC'
        : a.reciboId
          ? 'RC'
          : a.notaCreditoId
            ? 'NC'
            : a.notaDebitoId
              ? 'ND'
              : 'NT';
      const list = idsByType.get(key) ?? [];
      list.push(anchorId);
      idsByType.set(key, list);
    }

    const fetchers: Array<
      [
        string,
        Model<{
          _id: Types.ObjectId;
          fullNumber: string;
          inmuebleId: Types.ObjectId;
        }>,
      ]
    > = [
      ['FC', this.facturas as never],
      ['RC', this.recibos as never],
      ['NC', this.notasCredito as never],
      ['ND', this.notasDebito as never],
      ['NT', this.notasContables as never],
    ];

    for (const [tipo, model] of fetchers) {
      const ids = idsByType.get(tipo);
      if (!ids || ids.length === 0) continue;
      const docs = await model
        .find(
          { _id: { $in: ids }, coPropertyId },
          { fullNumber: 1, inmuebleId: 1 },
        )
        .exec();
      for (const doc of docs) {
        map.set(doc._id.toString(), {
          fullNumber: doc.fullNumber,
          inmuebleId: doc.inmuebleId,
        });
      }
    }

    return map;
  }
}
