import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AsientoContable, AsientoContableDocument } from '../../database/schemas/facturacion/asiento-contable.schema';
import { Factura, FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import { Recibo, ReciboDocument } from '../../database/schemas/recibos/recibo.schema';
import { NotaCredito, NotaCreditoDocument } from '../../database/schemas/notas-credito/nota-credito.schema';
import { NotaDebito, NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import { NotaContable, NotaContableDocument } from '../../database/schemas/notas-contables/nota-contable.schema';
import { Inmueble, InmuebleDocument } from '../../database/schemas/copropiedades/inmueble.schema';
import { Tercero, TerceroDocument } from '../../database/schemas/terceros/tercero.schema';
import { resolverMovimientoContable } from './movimiento-contable.util';
import type { RespuestaMovimientoContable, MovimientoContable } from '../../contracts';

/** Map from tipoDocumento to the corresponding anchor field name on AsientoContable. */
const ANCHOR_FIELD: Record<string, keyof Pick<AsientoContableDocument, 'facturaId' | 'reciboId' | 'notaCreditoId' | 'notaDebitoId' | 'notaContableId'>> = {
  FC: 'facturaId',
  RC: 'reciboId',
  NC: 'notaCreditoId',
  ND: 'notaDebitoId',
  NT: 'notaContableId',
};

@Injectable()
export class MovimientoContableService {
  constructor(
    @InjectModel(AsientoContable.name) private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(Factura.name) private readonly facturas: Model<FacturaDocument>,
    @InjectModel(Recibo.name) private readonly recibos: Model<ReciboDocument>,
    @InjectModel(NotaCredito.name) private readonly notasCredito: Model<NotaCreditoDocument>,
    @InjectModel(NotaDebito.name) private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(NotaContable.name) private readonly notasContables: Model<NotaContableDocument>,
    @InjectModel(Inmueble.name) private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name) private readonly terceros: Model<TerceroDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Endpoint 1: look up every AsientoContable anchored to a specific document
   * (by tipoDocumento + numeroCompleto).
   */
  async buscar(params: {
    tipoDocumento: 'FC' | 'RC' | 'NC' | 'ND' | 'NT';
    numeroCompleto: string;
  }): Promise<RespuestaMovimientoContable> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const anchorField = ANCHOR_FIELD[params.tipoDocumento];

    // 1. Resolve the source document
    const anchorModel = this.getAnchorModel(params.tipoDocumento);
    const anchor = await anchorModel.findOne({ coPropertyId, fullNumber: params.numeroCompleto }).exec();
    if (!anchor) return { movimientos: [] };

    // 2. Query AsientoContable by the matching anchor field
    const filter: Record<string, unknown> = { coPropertyId, [anchorField]: anchor._id };
    const asientos = await this.asientos.find(filter).sort({ date: 1 }).exec();
    if (asientos.length === 0) return { movimientos: [] };

    // 3. Resolve inmueble + propietario once (shared by all entries)
    const meta = await this.resolveMeta(anchor.inmuebleId, coPropertyId);

    // 4. Map each asiento
    const movimientos = asientos.map((a) =>
      resolverMovimientoContable(a, { ...meta, numeroDocumento: anchor.fullNumber }),
    );

    return { movimientos };
  }

  /**
   * Endpoint 2: list every AsientoContable for one inmueble within a date range.
   */
  async findAll(params: {
    inmuebleId: string;
    desde: string;
    hasta: string;
  }): Promise<RespuestaMovimientoContable> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const inmuebleObjectId = new Types.ObjectId(params.inmuebleId);
    const desde = new Date(params.desde);
    const hasta = new Date(params.hasta);

    // 1. Fetch all document IDs for this inmueble (unfiltered by date — only IDs needed)
    const [facturas, recibos, notasCredito, notasDebito, notasContables] = await Promise.all([
      this.facturas.find({ coPropertyId, inmuebleId: inmuebleObjectId }, { _id: 1 }).exec(),
      this.recibos.find({ coPropertyId, inmuebleId: inmuebleObjectId }, { _id: 1 }).exec(),
      this.notasCredito.find({ coPropertyId, inmuebleId: inmuebleObjectId }, { _id: 1 }).exec(),
      this.notasDebito.find({ coPropertyId, inmuebleId: inmuebleObjectId }, { _id: 1 }).exec(),
      this.notasContables.find({ coPropertyId, inmuebleId: inmuebleObjectId }, { _id: 1 }).exec(),
    ]);

    const facturaIds = facturas.map((f) => f._id);
    const reciboIds = recibos.map((r) => r._id);
    const ncIds = notasCredito.map((nc) => nc._id);
    const ndIds = notasDebito.map((nd) => nd._id);
    const ntIds = notasContables.map((nt) => nt._id);

    // 2. Build $or filter — only include non-empty arrays
    const orConditions: Record<string, unknown>[] = [];
    if (facturaIds.length) orConditions.push({ facturaId: { $in: facturaIds } });
    if (reciboIds.length) orConditions.push({ reciboId: { $in: reciboIds } });
    if (ncIds.length) orConditions.push({ notaCreditoId: { $in: ncIds } });
    if (ndIds.length) orConditions.push({ notaDebitoId: { $in: ndIds } });
    if (ntIds.length) orConditions.push({ notaContableId: { $in: ntIds } });

    if (orConditions.length === 0) return { movimientos: [] };

    const asientos = await this.asientos
      .find({
        coPropertyId,
        date: { $gte: desde, $lte: hasta },
        $or: orConditions,
      })
      .sort({ date: 1 })
      .exec();

    if (asientos.length === 0) return { movimientos: [] };

    // 3. Resolve inmueble + propietario once
    const meta = await this.resolveMeta(inmuebleObjectId, coPropertyId);

    // 4. Build a lookup map for anchor documents (all share the same inmueble)
    const anchorMap = await this.buildAnchorMap(asientos, coPropertyId);

    // 5. Map each asiento
    const movimientos = asientos.map((a) => {
      const anchorId = this.getAnchorId(a).toString();
      const numeroDocumento = anchorMap.get(anchorId)?.fullNumber ?? '—';
      return resolverMovimientoContable(a, { ...meta, numeroDocumento });
    });

    return { movimientos };
  }

  /** Get the Mongoose model for a given document type. */
  private getAnchorModel(tipo: string): Model<FacturaDocument | ReciboDocument | NotaCreditoDocument | NotaDebitoDocument | NotaContableDocument> {
    switch (tipo) {
      case 'FC': return this.facturas;
      case 'RC': return this.recibos;
      case 'NC': return this.notasCredito;
      case 'ND': return this.notasDebito;
      case 'NT': return this.notasContables;
      default: throw new Error(`Unknown tipoDocumento: ${tipo}`);
    }
  }

  /** Resolve the inmueble code and propietario/nit from the anchor's inmuebleId. */
  private async resolveMeta(
    inmuebleId: Types.ObjectId,
    coPropertyId: Types.ObjectId,
  ): Promise<{ inmuebleCodigo: string | null; propietario: string | null; nit: string | null }> {
    const inmueble = await this.inmuebles.findOne({ _id: inmuebleId, coPropertyId }).exec();
    if (!inmueble) return { inmuebleCodigo: null, propietario: null, nit: null };

    if (!inmueble.holderId) {
      return { inmuebleCodigo: inmueble.code, propietario: null, nit: null };
    }

    const tercero = await this.terceros.findOne({ _id: inmueble.holderId, coPropertyId }).exec();
    if (!tercero) {
      return { inmuebleCodigo: inmueble.code, propietario: null, nit: null };
    }

    const nit = tercero.identificationNumber
      ? `${tercero.identificationNumber}${tercero.identificationVerificationDigit ? `-${tercero.identificationVerificationDigit}` : ''}`
      : null;

    return {
      inmuebleCodigo: inmueble.code,
      propietario: tercero.name,
      nit,
    };
  }

  /** Extract the anchor document's _id from an AsientoContable. */
  private getAnchorId(asiento: AsientoContableDocument): Types.ObjectId {
    if (asiento.facturaId) return asiento.facturaId;
    if (asiento.reciboId) return asiento.reciboId;
    if (asiento.notaCreditoId) return asiento.notaCreditoId;
    if (asiento.notaDebitoId) return asiento.notaDebitoId;
    if (asiento.notaContableId) return asiento.notaContableId;
    throw new Error('AsientoContable has no anchor');
  }

  /** Build a Map<anchorId, { fullNumber }> for all anchor types referenced by the asientos. */
  private async buildAnchorMap(
    asientos: AsientoContableDocument[],
    coPropertyId: Types.ObjectId,
  ): Promise<Map<string, { fullNumber: string }>> {
    const map = new Map<string, { fullNumber: string }>();

    // Collect IDs per type
    const idsByType = new Map<string, Types.ObjectId[]>();
    for (const a of asientos) {
      if (a.facturaId) {
        const key = 'FC';
        const list = idsByType.get(key) ?? [];
        list.push(a.facturaId);
        idsByType.set(key, list);
      } else if (a.reciboId) {
        const key = 'RC';
        const list = idsByType.get(key) ?? [];
        list.push(a.reciboId);
        idsByType.set(key, list);
      } else if (a.notaCreditoId) {
        const key = 'NC';
        const list = idsByType.get(key) ?? [];
        list.push(a.notaCreditoId);
        idsByType.set(key, list);
      } else if (a.notaDebitoId) {
        const key = 'ND';
        const list = idsByType.get(key) ?? [];
        list.push(a.notaDebitoId);
        idsByType.set(key, list);
      } else if (a.notaContableId) {
        const key = 'NT';
        const list = idsByType.get(key) ?? [];
        list.push(a.notaContableId);
        idsByType.set(key, list);
      }
    }

    // Fetch each type's documents
    const fetchers: Array<[string, Model<unknown>]> = [
      ['FC', this.facturas],
      ['RC', this.recibos],
      ['NC', this.notasCredito],
      ['ND', this.notasDebito],
      ['NT', this.notasContables],
    ];

    for (const [tipo, model] of fetchers) {
      const ids = idsByType.get(tipo);
      if (!ids || ids.length === 0) continue;
      const docs = await (model as Model<{ _id: Types.ObjectId; fullNumber: string }>)
        .find({ _id: { $in: ids }, coPropertyId }, { fullNumber: 1 })
        .exec();
      for (const doc of docs) {
        map.set(doc._id.toString(), { fullNumber: doc.fullNumber });
      }
    }

    return map;
  }
}
