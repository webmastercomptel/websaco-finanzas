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
    const copropiedadId = this.tenant.resolveCoPropertyId();

    const existe = await this.inmuebles
      .exists({ _id: id, copropiedadId })
      .exec();
    if (!existe) {
      throw new NotFoundException(`No se encontró el inmueble ${id}`);
    }

    // Any Factura at all — even anulada — is real financial history. This
    // never trusts a client-supplied "no lo he facturado", the same way no
    // other guard in this app does.
    const facturado = await this.facturas
      .exists({ copropiedadId, inmuebleId: id })
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
      .deleteMany({ copropiedadId, inmuebleId: id })
      .exec();
    await this.inmuebles.deleteOne({ _id: id, copropiedadId }).exec();
  }
}
