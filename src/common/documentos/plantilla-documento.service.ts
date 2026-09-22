import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  PlantillaDocumento,
  PlantillaDocumentoDocument,
} from '../../database/schemas/documentos/plantilla-documento.schema';
import type { TipoDocumentoPresentacion } from '../../database/schemas/documentos/presentacion-documento.schema';

/**
 * Reads/writes `plantilla_documento` — the platform-wide pdfmake template
 * for each of the six document kinds. Registered on the (global)
 * `CommonModule`, not scoped to `plantillas-documento` — every one of the
 * six document modules (facturación, recibos, notas crédito/débito/
 * contables/anticipo) needs to read a template at the moment it offers
 * `solicitar-generacion`, the same reason `PresentacionDocumentoService`
 * lives here instead of inside a single feature module.
 *
 * Deliberately thin: no versioning, no per-coproperty variant — see the
 * schema's own docblock for why editing in place is safe here.
 */
@Injectable()
export class PlantillaDocumentoService {
  constructor(
    @InjectModel(PlantillaDocumento.name)
    private readonly model: Model<PlantillaDocumentoDocument>,
  ) {}

  /** Every template currently on file — the six-row (at most) listing for
   *  the administration screen. */
  async findAll(): Promise<PlantillaDocumentoDocument[]> {
    return this.model.find().sort({ tipoDocumento: 1 }).exec();
  }

  /** One type's template, or throws — a document module reading this to
   *  serve `solicitar-generacion` has nothing useful to fall back to when
   *  it is missing; see the plan's own "coordination point" note that all
   *  six templates must be authored before generation works at all. */
  async findOne(
    tipoDocumento: TipoDocumentoPresentacion,
  ): Promise<PlantillaDocumentoDocument> {
    const plantilla = await this.model.findOne({ tipoDocumento }).exec();
    if (!plantilla) {
      throw new NotFoundException(
        `No hay plantilla configurada para el tipo de documento ${tipoDocumento}`,
      );
    }
    return plantilla;
  }

  /** Idempotent upsert — the only write path. A `PUT`, not a `POST`, because
   *  the six-row set is fixed by the enum: there is never a "new" template
   *  to create, only an existing slot to overwrite. */
  async upsert(
    tipoDocumento: TipoDocumentoPresentacion,
    docDefinition: Record<string, unknown>,
  ): Promise<PlantillaDocumentoDocument> {
    return this.model
      .findOneAndUpdate(
        { tipoDocumento },
        { $set: { docDefinition } },
        { upsert: true, new: true },
      )
      .exec();
  }
}
