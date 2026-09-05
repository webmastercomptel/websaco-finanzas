// src/modules/inmuebles/inmuebles-eliminacion.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  ValorRecurrente,
  ValorRecurrenteDocument,
} from '../../database/schemas/conceptos/valor-recurrente.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';

/**
 * The one place an `Inmueble` can actually be gone for good — everywhere
 * else in this domain, retiring something is `estado: 'inactivo'`, never a
 * delete (see `InmueblesController`'s own note on why). A unit that was
 * loaded, then never billed, is different: nothing downstream references
 * it, so removing it orphans nothing. `ConceptosService.delete` guards the
 * exact same way for the exact same reason — see its own note.
 *
 * Kept as its own service, not a method on `InmueblesService`, so that
 * service's constructor never has to carry a `Factura` model it otherwise
 * has no use for.
 */
@Injectable()
export class InmueblesEliminacionService {
  constructor(
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(ValorRecurrente.name)
    private readonly valoresRecurrentes: Model<ValorRecurrenteDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async eliminar(id: string): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const existe = await this.inmuebles
      .exists({ _id: id, coPropertyId })
      .exec();
    if (!existe) {
      throw new NotFoundException(`No se encontró el inmueble ${id}`);
    }

    // Any Factura at all — even anulada — is real financial history. This
    // never trusts a client-supplied "no lo he facturado", the same way no
    // other guard in this app does.
    const facturado = await this.facturas
      .exists({ coPropertyId, inmuebleId: id })
      .exec();
    if (facturado) {
      throw new ConflictException(
        'Este inmueble ya tiene facturas emitidas y no puede eliminarse',
      );
    }

    // Not a financial effect — a ValorRecurrente row is a standing monthly
    // template, never posted anywhere on its own — so it is removed
    // outright along with the unit, not retired.
    await this.valoresRecurrentes
      .deleteMany({ coPropertyId, inmuebleId: id })
      .exec();
    await this.inmuebles.deleteOne({ _id: id, coPropertyId }).exec();
  }

  /**
   * Wipes every deletable unit of the active coproperty in one shot —
   * called by `InmueblesService.importar` before loading a file, since a
   * bulk import replaces the roster wholesale rather than merging into it.
   * Never called on its own from the UI; there is no "empty this building"
   * button.
   *
   * A unit with a Factura is left untouched, exactly like `eliminar` guards
   * a single one — there is no partial wipe of one unit's own data, only
   * "deleted whole" or "left whole", and its code is reported back so the
   * import result can tell the person it survived on purpose.
   */
  async eliminarTodosEliminables(): Promise<{
    eliminados: number;
    bloqueados: string[];
  }> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const todos = await this.inmuebles
      .find({ coPropertyId })
      .select('_id code')
      .exec();
    if (todos.length === 0) return { eliminados: 0, bloqueados: [] };

    const idsConFactura = new Set(
      (
        await this.facturas.distinct('inmuebleId', {
          coPropertyId,
          inmuebleId: { $in: todos.map((d) => d._id) },
        })
      ).map((id) => id.toString()),
    );

    const eliminables = todos.filter(
      (d) => !idsConFactura.has(d._id.toString()),
    );
    const bloqueados = todos
      .filter((d) => idsConFactura.has(d._id.toString()))
      .map((d) => d.code);
    const idsEliminables = eliminables.map((d) => d._id);

    await this.valoresRecurrentes
      .deleteMany({ coPropertyId, inmuebleId: { $in: idsEliminables } })
      .exec();
    await this.inmuebles
      .deleteMany({ _id: { $in: idsEliminables }, coPropertyId })
      .exec();

    return { eliminados: idsEliminables.length, bloqueados };
  }
}
