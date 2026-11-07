// src/modules/facturacion-bloque/facturacion-bloque-ingesta.service.ts
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { LockService } from '../../common/redis/lock.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { ReporteIngestaBloque } from '../../contracts';
import {
  BloqueFacturacion,
  type BloqueFacturacionDocument,
} from '../../database/schemas/administracion/bloque-facturacion.schema';
import {
  DocumentoBloque,
  type DocumentoBloqueDocument,
} from '../../database/schemas/administracion/documento-bloque.schema';
import {
  Inmueble,
  type InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  construirMapaPaginas,
  normalizarCodigoUnidad,
  REGEX_ETIQUETA_POR_DEFECTO,
} from './detector-unidades';
import {
  FacturacionBloqueAlmacenService,
  prefijoDeUnidades,
  rutaDeUnidad,
} from './facturacion-bloque-almacen.service';
import { comoUint8Array, LectorPdfBloque } from './lector-pdf-bloque';

/** Largest PDF accepted, checked on the declared size AND on the real object. */
export const TAMANO_MAXIMO_BLOQUE_BYTES = 200 * 1024 * 1024;

/**
 * How long an ingest lease (and the Redis lock) lives. It must outlast the
 * slowest legitimate ingest; a request that died leaves the lease to expire and
 * the block becomes claimable again. Renewed every `LATIDO_CADA_UNIDADES` units.
 */
export const VIGENCIA_PROCESAMIENTO_MS = 30 * 60 * 1000;

/** The lease is renewed after this many per-unit files, so a long ingest keeps it. */
const LATIDO_CADA_UNIDADES = 25;

/** Redis key of the per-coproperty ingest lock. */
export const claveLockIngesta = (copropiedadId: string): string =>
  `facturacion-bloque:ingesta:${copropiedadId}`;

/** Most refused codes quoted in an error message. */
const MAX_CODIGOS_EN_MENSAJE = 3;

interface UnidadRegistrada {
  id: Types.ObjectId;
  /** `Inmueble.codigo` as stored. */
  codigo: string;
}

/**
 * Internal signal: the claim was already handed back to `pendiente` because of
 * a transient Storage failure, so `ejecutar` must neither mark `error` nor
 * hide the original failure.
 */
class DevueltoAPendiente extends Error {
  constructor(readonly causa: unknown) {
    super('devuelto a pendiente');
  }
}

const MENSAJE_OCUPADO =
  'Ya hay un bloque procesándose. Esperá a que termine e intentá de nuevo en unos minutos.';

/**
 * Turns an uploaded block into one stored PDF per unit.
 *
 * This is the memory-critical path (the host has 1 GiB and the input can be
 * 200 MB), so it is built around three limits:
 *
 * - AT MOST ONE ingest per process: a plain flag checked and set before any
 *   `await`, so two requests cannot both pass. The second is turned away with a
 *   429 instead of queued: queueing would pin the request (and its socket) for
 *   minutes, and the admin can simply press the button again.
 * - AT MOST ONE per coproperty across instances: a Redis lock (`LockService`).
 *   Redis being down fails closed (429): refusing is better than two 200 MB
 *   ingests on one small host.
 * - The two heavy phases never overlap. Phase 1 downloads the PDF and reads the
 *   text with pdfjs, page by page; only short strings survive it, so the buffer
 *   and the pdfjs document are garbage by the time phase 2 downloads the PDF
 *   AGAIN and lets pdf-lib parse it once and cut each unit out, writing every
 *   output as soon as it exists. The second download costs time and egress and
 *   buys a lower peak (and avoids relying on a pdfjs buffer that may have been
 *   detached).
 *
 * Peak memory is therefore roughly `max(buffer + pdfjs working set,
 * buffer + pdf-lib object graph of the original + one output PDF)`. The pdf-lib
 * graph is the dominant term and scales with the number of objects, not only
 * with the file size, so a 200 MB file is the worst case the limit allows, not a
 * size that is known to fit in 1 GiB.
 *
 * State is claimed with one atomic update (`pendiente`/`error`, or an expired
 * `procesando`, to `procesando` with a token). Every later write carries that
 * token, so a request that lost its lease cannot overwrite the new owner's work.
 */
@Injectable()
export class FacturacionBloqueIngestaService {
  private readonly logger = new Logger(FacturacionBloqueIngestaService.name);

  /** True while this process is ingesting. See the class docblock. */
  private procesando = false;

  constructor(
    @InjectModel(BloqueFacturacion.name)
    private readonly bloques: Model<BloqueFacturacionDocument>,
    @InjectModel(DocumentoBloque.name)
    private readonly documentos: Model<DocumentoBloqueDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    private readonly tenant: TenantContextService,
    private readonly almacen: FacturacionBloqueAlmacenService,
    private readonly lector: LectorPdfBloque,
    private readonly lock: LockService,
  ) {}

  /**
   * Step 2 of the upload: verifies the object, detects the unit of every page,
   * cuts and stores one PDF per unit and leaves the block `generado`. Nothing is
   * sent. Answers the match report the admin reviews before sending.
   */
  async procesar(id: string): Promise<ReporteIngestaBloque> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Bloque ${id} no encontrado`);
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();

    // Check and set with no `await` in between: this is the semaphore.
    if (this.procesando) {
      throw new HttpException(MENSAJE_OCUPADO, HttpStatus.TOO_MANY_REQUESTS);
    }
    this.procesando = true;
    try {
      const salida: { reporte?: ReporteIngestaBloque } = {};
      const corrio = await this.lock.runExclusive(
        claveLockIngesta(copropiedadId.toString()),
        VIGENCIA_PROCESAMIENTO_MS,
        async () => {
          salida.reporte = await this.ejecutar(id, copropiedadId);
        },
      );
      if (!corrio || !salida.reporte) {
        throw new HttpException(MENSAJE_OCUPADO, HttpStatus.TOO_MANY_REQUESTS);
      }
      return salida.reporte;
    } finally {
      this.procesando = false;
    }
  }

  private async ejecutar(
    id: string,
    copropiedadId: Types.ObjectId,
  ): Promise<ReporteIngestaBloque> {
    const token = randomUUID();
    const bloque = await this.reclamar(id, copropiedadId, token);
    try {
      return await this.ingerir(bloque, copropiedadId, token);
    } catch (error: unknown) {
      // A transient Storage failure already gave the claim back: surface the
      // original error and leave the block `pendiente` (not `error`).
      if (error instanceof DevueltoAPendiente) throw error.causa;
      // The controlled failures already settled the state. Anything else (a
      // storage or database failure) must not leave the block `procesando`
      // until the lease expires.
      if (!(error instanceof HttpException)) {
        this.logger.error(
          `Falló el procesamiento del bloque ${id}: ${(error as Error).message}`,
        );
        await this.marcarError(
          bloque._id,
          copropiedadId,
          token,
          'No se pudieron generar los documentos por unidad. Reintentá el procesamiento.',
        );
      }
      throw error;
    }
  }

  /**
   * Takes the ingest lease with ONE atomic update. Claimable: `pendiente`,
   * `error` (retry) or a `procesando` whose lease expired. 404 when the block is
   * not in this coproperty, 409 for any other state (already generated or sent,
   * or being processed right now).
   */
  private async reclamar(
    id: string,
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<BloqueFacturacionDocument> {
    const ahora = new Date();
    const limite = new Date(ahora.getTime() - VIGENCIA_PROCESAMIENTO_MS);
    const reclamado = await this.bloques
      .findOneAndUpdate(
        {
          _id: id,
          copropiedadId,
          $or: [
            { estado: { $in: ['pendiente', 'error'] } },
            {
              estado: 'procesando',
              $or: [
                { procesamientoIniciadoEn: null },
                { procesamientoIniciadoEn: { $lt: limite } },
              ],
            },
          ],
        },
        {
          $set: {
            estado: 'procesando',
            tokenProcesamiento: token,
            procesamientoIniciadoEn: ahora,
            motivoError: null,
          },
        },
        { new: true },
      )
      .exec();
    if (reclamado) return reclamado;

    // The claim matched nothing: tell "not here" from "not claimable". This read
    // only picks the error, it never decides the transition.
    const existente = await this.bloques
      .findOne({ _id: id, copropiedadId })
      .select('estado')
      .exec();
    if (!existente) throw new NotFoundException(`Bloque ${id} no encontrado`);
    throw new ConflictException(
      existente.estado === 'procesando'
        ? 'Este bloque se está procesando. Si se interrumpió, volvé a intentarlo en unos minutos.'
        : 'Este bloque ya fue procesado. Para corregirlo, eliminalo y subí el archivo de nuevo.',
    );
  }

  private async ingerir(
    bloque: BloqueFacturacionDocument,
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<ReporteIngestaBloque> {
    const bloqueId = bloque._id;

    const tamano = await this.verificarObjeto(bloque, copropiedadId, token);

    const textos = await this.leerTextos(bloque, copropiedadId, token);
    const registradas = await this.cargarUnidades(copropiedadId);
    const detectado = construirMapaPaginas(
      textos,
      REGEX_ETIQUETA_POR_DEFECTO,
      new Set(registradas.keys()),
    );
    const totalPaginas = textos.length;
    // Release the page texts before the heavy phase 2.
    textos.length = 0;

    if (detectado.rechazadasPorGuarda.length > 0) {
      // Codes and page numbers only: the printed text may carry personal data.
      this.logger.warn(
        {
          bloqueId: bloqueId.toString(),
          copropiedadId: copropiedadId.toString(),
          paginas: detectado.rechazadasPorGuarda.map((r) => r.pagina),
          unidades: [
            ...new Set(detectado.rechazadasPorGuarda.map((r) => r.unidad)),
          ],
        },
        'Páginas rechazadas por la guarda de privacidad (el código impreso continúa tras una unidad registrada)',
      );
    }

    // Split what was detected into "has a unit here" and "no such unit": the
    // second group is REPORTED and never gets a document or a recipient.
    const grupos: Array<{ clave: string; paginas: number[] }> = [];
    const codigoPorClave = new Map<string, string>();
    const unidadesNoRegistradas: Array<{ codigo: string; paginas: number[] }> =
      [];
    for (const [codigo, paginas] of detectado.unidades) {
      const unidad = registradas.get(codigo);
      if (unidad) {
        grupos.push({ clave: unidad.id.toString(), paginas });
        codigoPorClave.set(unidad.id.toString(), unidad.codigo);
      } else {
        unidadesNoRegistradas.push({ codigo, paginas });
      }
    }
    unidadesNoRegistradas.sort((a, b) => a.codigo.localeCompare(b.codigo));

    if (grupos.length === 0) {
      const motivo = this.motivoSinUnidades(
        detectado.unidades.size,
        detectado.rechazadasPorGuarda.map((r) => r.unidad),
        unidadesNoRegistradas.length,
      );
      await this.marcarError(bloqueId, copropiedadId, token, motivo, tamano);
      throw new BadRequestException(motivo);
    }

    await this.limpiarSalidaPrevia(copropiedadId, bloqueId);
    await this.dividirYGuardar(
      bloque,
      copropiedadId,
      token,
      grupos,
      codigoPorClave,
    );

    const final = await this.bloques
      .updateOne(
        {
          _id: bloqueId,
          copropiedadId,
          estado: 'procesando',
          tokenProcesamiento: token,
        },
        {
          $set: {
            estado: 'generado',
            tamanoBytes: tamano,
            totalPaginas,
            totalUnidades: grupos.length,
            paginasSinMatch: detectado.paginasSinMatch,
            unidadesNoRegistradas,
            motivoError: null,
            tokenProcesamiento: null,
            procesamientoIniciadoEn: null,
          },
        },
      )
      .exec();
    if (final.matchedCount !== 1) {
      throw new ConflictException(
        'El procesamiento de este bloque fue tomado por otra solicitud.',
      );
    }

    return {
      id: bloqueId.toString(),
      estado: 'generado',
      totalPaginas,
      totalUnidades: grupos.length,
      unidades: [...codigoPorClave.values()].sort(),
      paginasSinMatch: detectado.paginasSinMatch,
      unidadesNoRegistradas,
    };
  }

  /**
   * The real size of the object, trusted over the declared one. Missing object:
   * the claim goes back to `pendiente` so the admin can finish the upload and
   * confirm again. Over the limit: object and record are removed (the same call
   * that would let a 5 GB PUT sit in the bucket forever).
   */
  private async verificarObjeto(
    bloque: BloqueFacturacionDocument,
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<number> {
    let tamano: number;
    try {
      tamano = await this.almacen.tamanoReal(bloque.rutaOriginal);
    } catch {
      await this.devolverAPendiente(bloque._id, copropiedadId, token);
      throw new BadRequestException('El archivo no se subió correctamente');
    }
    if (tamano > TAMANO_MAXIMO_BLOQUE_BYTES) {
      // Record first, then the object: an object left behind is only an orphan,
      // a record without its object would be a broken download.
      const borrado = await this.bloques
        .deleteOne({
          _id: bloque._id,
          copropiedadId,
          tokenProcesamiento: token,
        })
        .exec();
      if (borrado.deletedCount === 1) {
        await this.almacen.eliminar(bloque.rutaOriginal);
      }
      throw new BadRequestException('El archivo supera el límite de 200 MB');
    }
    return tamano;
  }

  /**
   * Phase 1: downloads the PDF and reads the text of every page. Only the page
   * strings leave this method; the buffer and the pdfjs document do not. A
   * Storage failure is NOT blamed on the file (the claim goes back to
   * `pendiente` and the error surfaces as a 500, so retrying makes sense); an
   * unreadable PDF is a terminal `error` and a 400.
   */
  private async leerTextos(
    bloque: BloqueFacturacionDocument,
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<string[]> {
    let bytes: Buffer;
    try {
      bytes = await this.almacen.descargar(bloque.rutaOriginal);
    } catch (error: unknown) {
      await this.devolverAPendiente(bloque._id, copropiedadId, token);
      throw new DevueltoAPendiente(error);
    }
    try {
      return await this.lector.textoPorPagina(comoUint8Array(bytes));
    } catch {
      const motivo = 'No se pudo leer el PDF (archivo inválido)';
      await this.marcarError(bloque._id, copropiedadId, token, motivo);
      throw new BadRequestException(motivo);
    }
  }

  /**
   * Phase 2: downloads the PDF again, parses it once and writes each unit's PDF
   * the moment it is cut, one at a time. The lease is renewed along the way and
   * the loop aborts when it was lost.
   */
  private async dividirYGuardar(
    bloque: BloqueFacturacionDocument,
    copropiedadId: Types.ObjectId,
    token: string,
    grupos: Array<{ clave: string; paginas: number[] }>,
    codigoPorClave: Map<string, string>,
  ): Promise<void> {
    const paginasPorClave = new Map(grupos.map((g) => [g.clave, g.paginas]));
    const bytes = await this.almacen.descargar(bloque.rutaOriginal);
    let producidos = 0;

    await this.lector.dividir(
      comoUint8Array(bytes),
      grupos,
      async (clave, pdf) => {
        const ruta = rutaDeUnidad(
          copropiedadId.toString(),
          bloque._id.toString(),
          clave,
        );
        await this.almacen.subir(ruta, pdf);
        await this.documentos.create({
          copropiedadId,
          bloqueId: bloque._id,
          inmuebleId: new Types.ObjectId(clave),
          codigoInmueble: codigoPorClave.get(clave) ?? clave,
          tipo: bloque.tipo,
          periodo: bloque.periodo,
          paginas: paginasPorClave.get(clave) ?? [],
          rutaAlmacenamiento: ruta,
          tamanoBytes: pdf.byteLength,
        });
        producidos++;
        if (producidos % LATIDO_CADA_UNIDADES === 0) {
          const vigente = await this.latido(bloque._id, copropiedadId, token);
          if (!vigente) {
            throw new ConflictException(
              'El procesamiento de este bloque fue tomado por otra solicitud.',
            );
          }
        }
      },
    );
  }

  /**
   * Removes what an earlier, interrupted run left behind: its rows and its
   * files. The paths are deterministic, so files would be overwritten anyway;
   * this also clears units that no longer match. Nothing is visible meanwhile
   * because residents only see sent blocks.
   */
  private async limpiarSalidaPrevia(
    copropiedadId: Types.ObjectId,
    bloqueId: Types.ObjectId,
  ): Promise<void> {
    await this.documentos.deleteMany({ copropiedadId, bloqueId }).exec();
    try {
      await this.almacen.eliminarPrefijo(
        prefijoDeUnidades(copropiedadId.toString(), bloqueId.toString()),
      );
    } catch (error: unknown) {
      this.logger.warn(
        `No se pudo limpiar la salida previa del bloque ${bloqueId.toString()}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * ACTIVE units of the coproperty keyed by normalized code. A code shared by
   * two units after normalization (`a-1` and `A-1`) is dropped from the set: the
   * page could belong to either, and guessing would hand one resident the
   * other's invoice. Such pages surface in `unidadesNoRegistradas` instead.
   */
  private async cargarUnidades(
    copropiedadId: Types.ObjectId,
  ): Promise<Map<string, UnidadRegistrada>> {
    const filas = await this.inmuebles
      .find({ copropiedadId, estado: 'active' })
      .select('codigo')
      .lean()
      .exec();
    const registradas = new Map<string, UnidadRegistrada>();
    const ambiguas = new Set<string>();
    for (const fila of filas) {
      const clave = normalizarCodigoUnidad(fila.codigo);
      if (!clave) continue;
      if (registradas.has(clave)) ambiguas.add(clave);
      else registradas.set(clave, { id: fila._id, codigo: fila.codigo });
    }
    for (const clave of ambiguas) registradas.delete(clave);
    if (ambiguas.size > 0) {
      this.logger.warn(
        `Copropiedad ${copropiedadId.toString()}: ${ambiguas.size} código(s) de inmueble se repiten al normalizar y no se usarán para asignar páginas.`,
      );
    }
    return registradas;
  }

  private motivoSinUnidades(
    detectadas: number,
    rechazadas: string[],
    noRegistradas: number,
  ): string {
    if (detectadas === 0) {
      if (rechazadas.length > 0) {
        const codigos = [...new Set(rechazadas)];
        const listados = codigos.slice(0, MAX_CODIGOS_EN_MENSAJE).join(', ');
        const mas = codigos.length > MAX_CODIGOS_EN_MENSAJE ? ' y otras' : '';
        return `El documento contiene identificadores de unidad, pero no se pudieron asociar sin ambigüedad a una unidad registrada (${rechazadas.length} página(s); unidades: ${listados}${mas}). Revise el formato del código impreso en el PDF`;
      }
      return 'El documento no contiene identificadores de unidad — no corresponde a un documento de facturación';
    }
    return `Se detectaron ${noRegistradas} código(s) de unidad, pero ninguno corresponde a un inmueble activo de la copropiedad. Revise el formato del código impreso en el PDF`;
  }

  /** Renews the ingest lease; false when this request no longer owns the block. */
  private async latido(
    id: Types.ObjectId,
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<boolean> {
    const resultado = await this.bloques
      .updateOne(
        { _id: id, copropiedadId, tokenProcesamiento: token },
        { $set: { procesamientoIniciadoEn: new Date() } },
      )
      .exec();
    return resultado.matchedCount === 1;
  }

  /** Terminal failure of THIS lease holder: conditional on the token, never on the id alone. */
  private async marcarError(
    id: Types.ObjectId,
    copropiedadId: Types.ObjectId,
    token: string,
    motivo: string,
    tamanoBytes?: number,
  ): Promise<void> {
    await this.bloques
      .updateOne(
        { _id: id, copropiedadId, tokenProcesamiento: token },
        {
          $set: {
            estado: 'error',
            motivoError: motivo,
            tokenProcesamiento: null,
            procesamientoIniciadoEn: null,
            ...(tamanoBytes !== undefined && { tamanoBytes }),
          },
        },
      )
      .exec();
  }

  /** Gives the claim back so the same upload can be confirmed again. */
  private async devolverAPendiente(
    id: Types.ObjectId,
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<void> {
    await this.bloques
      .updateOne(
        { _id: id, copropiedadId, tokenProcesamiento: token },
        {
          $set: {
            estado: 'pendiente',
            tokenProcesamiento: null,
            procesamientoIniciadoEn: null,
          },
        },
      )
      .exec();
  }
}
