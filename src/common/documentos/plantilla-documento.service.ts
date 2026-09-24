import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  PlantillaDocumento,
  PlantillaDocumentoDocument,
} from '../../database/schemas/documentos/plantilla-documento.schema';
import {
  TIPOS_DOCUMENTO_PRESENTACION,
  type TipoDocumentoPresentacion,
} from '../../database/schemas/documentos/presentacion-documento.schema';

/**
 * Reads/writes `plantilla_documento` — the platform-wide pdfmake template
 * for each of the six document kinds. Registered on the (global)
 * `CommonModule`, not scoped to `plantillas-documento` — every one of the
 * six document modules (facturación, recibos, notas crédito/débito/
 * contables/anticipo) needs to read a template at the moment it offers
 * `solicitar-generacion`, the same reason `PresentacionDocumentoService`
 * lives here instead of inside a single feature module.
 *
 * Append-only, versioned — see the schema's own docblock for why.
 */
@Injectable()
export class PlantillaDocumentoService {
  constructor(
    @InjectModel(PlantillaDocumento.name)
    private readonly model: Model<PlantillaDocumentoDocument>,
  ) {}

  /** The CURRENT (highest-version) template for every type currently on
   *  file — the six-row (at most) listing for the administration screen.
   *  Six targeted queries rather than an aggregation pipeline: the set is
   *  fixed and tiny, and this stays as simple to read as `findOne` below. */
  async findAll(): Promise<PlantillaDocumentoDocument[]> {
    const resultados = await Promise.all(
      TIPOS_DOCUMENTO_PRESENTACION.map((tipo) =>
        this.model
          .findOne({ tipoDocumento: tipo })
          .sort({ version: -1 })
          .exec(),
      ),
    );
    const encontrados: PlantillaDocumentoDocument[] = [];
    for (const doc of resultados) {
      if (doc) encontrados.push(doc);
    }
    return encontrados;
  }

  /** One type's CURRENT (highest-version) template, or throws — a document
   *  module reading this to serve `solicitar-generacion` has nothing useful
   *  to fall back to when it is missing; see the plan's own "coordination
   *  point" note that all six templates must be authored before generation
   *  works at all. */
  async findOne(
    tipoDocumento: TipoDocumentoPresentacion,
  ): Promise<PlantillaDocumentoDocument> {
    const plantilla = await this.model
      .findOne({ tipoDocumento })
      .sort({ version: -1 })
      .exec();
    if (!plantilla) {
      throw new NotFoundException(
        `No hay plantilla configurada para el tipo de documento ${tipoDocumento}`,
      );
    }
    return plantilla;
  }

  /** One SPECIFIC, historical version of a type's template — what a live
   *  Factura re-render pins to (`PresentacionDocumento.plantillaVersion`),
   *  so it reproduces the exact layout that was live when it was actually
   *  generated, not whatever's current. Throws rather than silently
   *  falling back to `findOne` — a caller asking for a specific version has
   *  a reason to need THAT one, not an approximation. */
  async findVersion(
    tipoDocumento: TipoDocumentoPresentacion,
    version: number,
  ): Promise<PlantillaDocumentoDocument> {
    const plantilla = await this.model
      .findOne({ tipoDocumento, version })
      .exec();
    if (!plantilla) {
      throw new NotFoundException(
        `No existe la versión ${version} de la plantilla ${tipoDocumento}`,
      );
    }
    return plantilla;
  }

  /** The only write path. A `PUT`, not a `POST` — the six-row SET is fixed
   *  by the enum, there is never a "new" template kind to create — but
   *  unlike the old single-row-per-type design, this always INSERTS a new
   *  version rather than overwriting the current one in place. */
  async upsert(
    tipoDocumento: TipoDocumentoPresentacion,
    docDefinition: Record<string, unknown>,
  ): Promise<PlantillaDocumentoDocument> {
    const ultima = await this.model
      .findOne({ tipoDocumento })
      .sort({ version: -1 })
      .exec();
    return this.model.create({
      tipoDocumento,
      version: (ultima?.version ?? 0) + 1,
      docDefinition,
    });
  }
}
