import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { CarpetasService } from './carpetas.service';
import type { ActorDocumentos } from './documentos-acceso';
import { PREFIJO_DOCUMENTOS } from './documentos-almacen.service';
import {
  CUOTA_ALMACENAMIENTO_BYTES,
  DocumentosService,
  TAMANO_MAXIMO_DOCUMENTO_BYTES,
} from './documentos.service';

const COPROPIEDAD = new Types.ObjectId();
const CUENTA = new Types.ObjectId();
const ROL_ESCRIBE = new Types.ObjectId();
const ROL_LEE = new Types.ObjectId();

const user: IRequestUser = {
  uid: 'u',
  email: 'a@b.co',
  accountId: CUENTA.toString(),
  nombre: 'Ana Admin',
};

const consulta = (valor: unknown) => {
  const q: Record<string, jest.Mock> = {};
  q.exec = jest.fn().mockResolvedValue(valor);
  q.select = jest.fn().mockReturnValue(q);
  q.lean = jest.fn().mockReturnValue(q);
  q.sort = jest.fn().mockReturnValue(q);
  return q;
};

const carpeta = (slug: string, acls: unknown[], nombre = slug) => ({
  _id: new Types.ObjectId(),
  copropiedadId: COPROPIEDAD,
  carpetaPadreId: null,
  slug,
  nombre,
  acls,
});

const regla = (rolId: Types.ObjectId, leer: boolean, escribir: boolean) => ({
  tipo: 'rol',
  rolId,
  puedeLeer: leer,
  puedeEscribir: escribir,
});

// "actas" is writable by ROL_ESCRIBE and read-only for ROL_LEE; "privada" has no rules.
const ACTAS = carpeta('actas', [
  regla(ROL_ESCRIBE, true, true),
  regla(ROL_LEE, true, false),
]);
const PRIVADA = carpeta('privada', []);

const actor = (roles: Types.ObjectId[], gestiona = false): ActorDocumentos => ({
  roleIds: new Set(roles.map((r) => r.toString())),
  gestiona,
});

const archivoDoc = (extra: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  copropiedadId: COPROPIEDAD,
  carpetaId: ACTAS._id,
  codigo: 'DOC-001',
  nombre: 'Acta.pdf',
  mimeType: 'application/pdf',
  tipo: 'pdf',
  categoria: '',
  rutaAlmacenamiento: `${PREFIJO_DOCUMENTOS}${COPROPIEDAD.toString()}/uuid-Acta.pdf`,
  estado: 'listo',
  tamanoBytes: 1000,
  autorNombre: 'Ana Admin',
  destacado: false,
  etiquetas: [],
  subidoPorId: CUENTA,
  updatedAt: new Date('2026-03-01T00:00:00Z'),
  ...extra,
});

beforeEach(() => {
  // The "object left behind" warning is expected in some cases; keep output clean.
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

function montar(a: ActorDocumentos) {
  const guardados: Array<Record<string, unknown>> = [];
  const archivos = Object.assign(
    jest.fn().mockImplementation((datos: Record<string, unknown>) => ({
      save: jest.fn().mockImplementation(() => {
        const creado = {
          _id: new Types.ObjectId(),
          updatedAt: new Date(),
          ...datos,
        };
        guardados.push(creado);
        return Promise.resolve(creado);
      }),
    })),
    {
      find: jest.fn().mockReturnValue(consulta([])),
      findOne: jest.fn().mockReturnValue(consulta(null)),
      findOneAndUpdate: jest.fn().mockReturnValue(consulta(null)),
      findOneAndDelete: jest.fn().mockReturnValue(consulta(null)),
      deleteOne: jest.fn().mockReturnValue(consulta({ deletedCount: 1 })),
      aggregate: jest.fn().mockReturnValue(consulta([])),
      countDocuments: jest.fn(),
    },
  );
  const carpetasModelo = {
    find: jest.fn().mockReturnValue(consulta([ACTAS, PRIVADA])),
  };
  const consecutivos = {
    findOneAndUpdate: jest.fn().mockReturnValue(consulta({ valor: 7 })),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const actores = { deSolicitud: jest.fn().mockResolvedValue(a) };
  const almacen = {
    firmarSubida: jest.fn().mockResolvedValue('https://storage/subida'),
    firmarLectura: jest.fn().mockResolvedValue('https://storage/lectura'),
    objetoReal: jest
      .fn()
      .mockResolvedValue({ tamanoBytes: 4096, mimeType: 'application/pdf' }),
    eliminar: jest.fn().mockResolvedValue(true),
  };
  const notificaciones = {
    notificarNuevo: jest.fn().mockResolvedValue(undefined),
  };
  const carpetas = new CarpetasService(
    carpetasModelo as never,
    archivos as never,
    {} as never,
    tenant as never,
    actores as never,
  );
  const servicio = new DocumentosService(
    archivos as never,
    consecutivos as never,
    tenant as never,
    carpetas,
    actores as never,
    almacen as never,
    notificaciones as never,
  );
  return {
    servicio,
    archivos,
    consecutivos,
    almacen,
    notificaciones,
    guardados,
  };
}

const subida = (extra: Record<string, unknown> = {}) => ({
  nombre: 'Acta 12.pdf',
  mimeType: 'application/pdf',
  carpeta: 'actas',
  tamanoBytes: 5000,
  ...extra,
});

describe('DocumentosService.iniciar — subida en dos pasos', () => {
  it('registra el archivo pendiente bajo el prefijo propio y firma la URL con el tipo de contenido', async () => {
    const { servicio, guardados, almacen } = montar(actor([ROL_ESCRIBE]));

    const res = await servicio.iniciar(subida(), user);

    const guardado = guardados[0];
    expect(guardado).toMatchObject({
      copropiedadId: COPROPIEDAD,
      carpetaId: ACTAS._id,
      codigo: 'DOC-007',
      estado: 'pendiente',
      tipo: 'pdf',
      tamanoBytes: 5000,
      autorNombre: 'Ana Admin',
    });
    expect(guardado.rutaAlmacenamiento).toEqual(
      expect.stringMatching(
        new RegExp(`^${PREFIJO_DOCUMENTOS}${COPROPIEDAD.toString()}/`),
      ),
    );
    expect(almacen.firmarSubida).toHaveBeenCalledWith(
      guardado.rutaAlmacenamiento,
      'application/pdf',
    );
    expect(res.uploadUrl).toBe('https://storage/subida');
    expect(res.encabezadosSubida).toEqual({
      'Content-Type': 'application/pdf',
      'x-goog-if-generation-match': '0',
    });
    expect(res.documento).toMatchObject({
      carpeta: 'actas',
      tieneArchivo: false,
      codigo: 'DOC-007',
    });
  });

  it('quien solo lee la carpeta no puede subir: 403, sin código consumido ni URL firmada', async () => {
    const { servicio, guardados, almacen, consecutivos } = montar(
      actor([ROL_LEE]),
    );
    await expect(servicio.iniciar(subida(), user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(consecutivos.findOneAndUpdate).not.toHaveBeenCalled();
    expect(almacen.firmarSubida).not.toHaveBeenCalled();
    expect(guardados).toHaveLength(0);
  });

  it('en una carpeta sin reglas solo sube quien gestiona', async () => {
    const sinPermiso = montar(actor([ROL_ESCRIBE]));
    await expect(
      sinPermiso.servicio.iniciar(subida({ carpeta: 'privada' }), user),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const gestor = montar(actor([], true));
    await expect(
      gestor.servicio.iniciar(subida({ carpeta: 'privada' }), user),
    ).resolves.toBeDefined();
  });

  it('una carpeta inexistente en la copropiedad es 404', async () => {
    const { servicio } = montar(actor([], true));
    await expect(
      servicio.iniciar(subida({ carpeta: 'no-existe' }), user),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rechaza con 400 un archivo mayor al límite de 200 MB, antes de registrar nada', async () => {
    const { servicio, guardados, almacen } = montar(actor([ROL_ESCRIBE]));
    await expect(
      servicio.iniciar(
        subida({ tamanoBytes: TAMANO_MAXIMO_DOCUMENTO_BYTES + 1 }),
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(guardados).toHaveLength(0);
    expect(almacen.firmarSubida).not.toHaveBeenCalled();
  });

  it('acepta exactamente 200 MB', async () => {
    const { servicio } = montar(actor([ROL_ESCRIBE]));
    await expect(
      servicio.iniciar(
        subida({ tamanoBytes: TAMANO_MAXIMO_DOCUMENTO_BYTES }),
        user,
      ),
    ).resolves.toBeDefined();
  });

  it('no revela el límite de tamaño a quien no puede escribir en la carpeta', async () => {
    const { servicio } = montar(actor([ROL_LEE]));
    await expect(
      servicio.iniciar(
        subida({ tamanoBytes: TAMANO_MAXIMO_DOCUMENTO_BYTES + 1 }),
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    ['application/pdf', 'a.pdf', 'pdf'],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'a.docx',
      'docx',
    ],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'a.xlsx',
      'xlsx',
    ],
    ['image/png', 'a.png', 'png'],
    ['image/jpeg', 'a.jpg', 'jpg'],
    ['application/octet-stream', 'balance.xlsx', 'xlsx'],
    ['application/zip', 'respaldo.zip', 'otro'],
    ['text/plain', 'notas.txt', 'otro'],
  ])('deriva el tipo de %s (%s) como %s', async (mimeType, nombre, tipo) => {
    const { servicio, guardados } = montar(actor([ROL_ESCRIBE]));
    await servicio.iniciar(subida({ mimeType, nombre }), user);
    expect(guardados[0].tipo).toBe(tipo);
  });

  it('sanea el nombre en la ruta de almacenamiento', async () => {
    const { servicio, guardados } = montar(actor([ROL_ESCRIBE]));
    await servicio.iniciar(
      subida({ nombre: '../../etc/pass wd (1).pdf' }),
      user,
    );
    const ruta = guardados[0].rutaAlmacenamiento as string;
    expect(ruta.startsWith(PREFIJO_DOCUMENTOS)).toBe(true);
    expect(ruta).not.toContain('..');
    expect(ruta).not.toContain(' ');
  });
});

describe('DocumentosService.confirmar', () => {
  const pendiente = () => archivoDoc({ estado: 'pendiente' });

  it('id mal formado es 404 sin consultar', async () => {
    const { servicio, archivos } = montar(actor([ROL_ESCRIBE]));
    await expect(servicio.confirmar('xyz', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(archivos.findOne).not.toHaveBeenCalled();
  });

  it('busca por id Y copropiedad: un documento de otra copropiedad es 404', async () => {
    const { servicio, archivos } = montar(actor([ROL_ESCRIBE]));
    const id = new Types.ObjectId().toString();
    await expect(servicio.confirmar(id, user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(archivos.findOne).toHaveBeenCalledWith({
      _id: id,
      copropiedadId: COPROPIEDAD,
    });
  });

  it('sin permiso de escritura en la carpeta: 403 y ni siquiera mira el objeto', async () => {
    const { servicio, archivos, almacen } = montar(actor([ROL_LEE]));
    archivos.findOne.mockReturnValue(consulta(pendiente()));
    await expect(
      servicio.confirmar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(almacen.objetoReal).not.toHaveBeenCalled();
  });

  it('un documento ya confirmado es 409', async () => {
    const { servicio, archivos } = montar(actor([ROL_ESCRIBE]));
    archivos.findOne.mockReturnValue(consulta(archivoDoc({ estado: 'listo' })));
    await expect(
      servicio.confirmar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('si el objeto no llegó a Storage es 400 y no cambia el estado', async () => {
    const { servicio, archivos, almacen } = montar(actor([ROL_ESCRIBE]));
    archivos.findOne.mockReturnValue(consulta(pendiente()));
    almacen.objetoReal.mockRejectedValue(new Error('404'));
    await expect(
      servicio.confirmar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(archivos.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un objeto real mayor al límite se borra con su registro y es 400', async () => {
    const { servicio, archivos, almacen, notificaciones } = montar(
      actor([ROL_ESCRIBE]),
    );
    const doc = pendiente();
    archivos.findOne.mockReturnValue(consulta(doc));
    almacen.objetoReal.mockResolvedValue({
      tamanoBytes: TAMANO_MAXIMO_DOCUMENTO_BYTES + 1,
      mimeType: 'application/pdf',
    });

    await expect(
      servicio.confirmar(doc._id.toString(), user),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(archivos.deleteOne).toHaveBeenCalledWith({
      _id: doc._id.toString(),
      copropiedadId: COPROPIEDAD,
      estado: 'pendiente',
    });
    expect(almacen.eliminar).toHaveBeenCalledWith(doc.rutaAlmacenamiento);
    expect(notificaciones.notificarNuevo).not.toHaveBeenCalled();
  });

  it('un objeto real de otro tipo que el declarado se borra con su registro y es 400', async () => {
    const { servicio, archivos, almacen, notificaciones } = montar(
      actor([ROL_ESCRIBE]),
    );
    const doc = pendiente();
    archivos.findOne.mockReturnValue(consulta(doc));
    almacen.objetoReal.mockResolvedValue({
      tamanoBytes: 100,
      mimeType: 'text/html',
    });

    await expect(
      servicio.confirmar(doc._id.toString(), user),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(archivos.deleteOne).toHaveBeenCalledWith({
      _id: doc._id.toString(),
      copropiedadId: COPROPIEDAD,
      estado: 'pendiente',
    });
    expect(almacen.eliminar).toHaveBeenCalledWith(doc.rutaAlmacenamiento);
    expect(archivos.findOneAndUpdate).not.toHaveBeenCalled();
    expect(notificaciones.notificarNuevo).not.toHaveBeenCalled();
  });

  it('compara el tipo sin importar mayúsculas ni parámetros (charset)', async () => {
    const { servicio, archivos, almacen } = montar(actor([ROL_ESCRIBE]));
    const doc = pendiente();
    archivos.findOne.mockReturnValue(consulta(doc));
    archivos.findOneAndUpdate.mockReturnValue(
      consulta({ ...doc, estado: 'listo' }),
    );
    almacen.objetoReal.mockResolvedValue({
      tamanoBytes: 10,
      mimeType: 'Application/PDF; charset=binary',
    });
    await expect(
      servicio.confirmar(doc._id.toString(), user),
    ).resolves.toBeDefined();
  });

  it('confirma de forma atómica (solo si sigue pendiente), guarda el tamaño real y notifica', async () => {
    const { servicio, archivos, almacen, notificaciones } = montar(
      actor([ROL_ESCRIBE]),
    );
    const doc = pendiente();
    archivos.findOne.mockReturnValue(consulta(doc));
    archivos.findOneAndUpdate.mockReturnValue(
      consulta({ ...doc, estado: 'listo', tamanoBytes: 4096 }),
    );
    almacen.objetoReal.mockResolvedValue({
      tamanoBytes: 4096,
      mimeType: 'application/pdf',
    });

    const res = await servicio.confirmar(doc._id.toString(), user);

    expect(archivos.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: doc._id.toString(),
        copropiedadId: COPROPIEDAD,
        estado: 'pendiente',
      },
      { $set: { estado: 'listo', tamanoBytes: 4096 } },
      { new: true },
    );
    expect(res).toMatchObject({ tieneArchivo: true, tamanoBytes: 4096 });
    expect(notificaciones.notificarNuevo).toHaveBeenCalledTimes(1);
  });

  it('si otra confirmación ganó la carrera es 409 y no notifica dos veces', async () => {
    const { servicio, archivos, notificaciones } = montar(actor([ROL_ESCRIBE]));
    const doc = pendiente();
    archivos.findOne.mockReturnValue(consulta(doc));
    archivos.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.confirmar(doc._id.toString(), user),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(notificaciones.notificarNuevo).not.toHaveBeenCalled();
  });
});

describe('DocumentosService.descargar', () => {
  it('firma la lectura solo para un archivo confirmado de una carpeta que el usuario puede leer', async () => {
    const { servicio, archivos, almacen } = montar(actor([ROL_LEE]));
    const doc = archivoDoc();
    archivos.findOne.mockReturnValue(consulta(doc));

    const res = await servicio.descargar(doc._id.toString(), user);

    expect(almacen.firmarLectura).toHaveBeenCalledWith(
      doc.rutaAlmacenamiento,
      'Acta.pdf',
      'application/pdf',
    );
    expect(res).toEqual({ url: 'https://storage/lectura', nombre: 'Acta.pdf' });
  });

  it('sin acceso de lectura a la carpeta: 403 y no se firma nada', async () => {
    const { servicio, archivos, almacen } = montar(
      actor([new Types.ObjectId()]),
    );
    archivos.findOne.mockReturnValue(consulta(archivoDoc()));
    await expect(
      servicio.descargar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(almacen.firmarLectura).not.toHaveBeenCalled();
  });

  it('un archivo aún pendiente es 409 y no se firma nada', async () => {
    const { servicio, archivos, almacen } = montar(actor([ROL_LEE]));
    archivos.findOne.mockReturnValue(
      consulta(archivoDoc({ estado: 'pendiente' })),
    );
    await expect(
      servicio.descargar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(almacen.firmarLectura).not.toHaveBeenCalled();
  });

  it('un documento de otra copropiedad o inexistente es 404', async () => {
    const { servicio, archivos } = montar(actor([], true));
    const id = new Types.ObjectId().toString();
    await expect(servicio.descargar(id, user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(archivos.findOne).toHaveBeenCalledWith({
      _id: id,
      copropiedadId: COPROPIEDAD,
    });
  });

  it('quien gestiona descarga de una carpeta sin reglas', async () => {
    const { servicio, archivos, almacen } = montar(actor([], true));
    archivos.findOne.mockReturnValue(
      consulta(archivoDoc({ carpetaId: PRIVADA._id })),
    );
    await servicio.descargar(new Types.ObjectId().toString(), user);
    expect(almacen.firmarLectura).toHaveBeenCalled();
  });
});

describe('DocumentosService.listar', () => {
  it('sin carpeta, consulta solo las carpetas legibles y solo archivos listos de la copropiedad', async () => {
    const { servicio, archivos } = montar(actor([ROL_LEE]));
    await servicio.listar({}, user);
    expect(archivos.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      estado: 'listo',
      carpetaId: { $in: [ACTAS._id] },
    });
  });

  it('quien gestiona consulta todas las carpetas', async () => {
    const { servicio, archivos } = montar(actor([], true));
    await servicio.listar({ carpeta: 'todos' }, user);
    const filtro = (archivos.find.mock.calls as unknown[][])[0][0] as {
      carpetaId: { $in: Types.ObjectId[] };
    };
    expect(filtro.carpetaId.$in).toHaveLength(2);
  });

  it('una carpeta pedida que no puede leer es 403 y no consulta archivos', async () => {
    const { servicio, archivos } = montar(actor([ROL_LEE]));
    await expect(
      servicio.listar({ carpeta: 'privada' }, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(archivos.find).not.toHaveBeenCalled();
  });

  it('escapa la búsqueda: un patrón con regex no se interpreta', async () => {
    const { servicio, archivos } = montar(actor([ROL_LEE]));
    await servicio.listar({ q: '(a+)+$' }, user);
    const filtro = (archivos.find.mock.calls as unknown[][])[0][0] as {
      nombre: RegExp;
    };
    expect(filtro.nombre.source).toBe('\\(a\\+\\)\\+\\$');
    expect(filtro.nombre.flags).toBe('i');
  });

  it('devuelve el slug de la carpeta y la ubicación como texto', async () => {
    const { servicio, archivos } = montar(actor([ROL_LEE]));
    archivos.find.mockReturnValue(consulta([archivoDoc()]));
    const [res] = await servicio.listar({}, user);
    expect(res).toMatchObject({ carpeta: 'actas', ubicacion: 'actas' });
  });
});

describe('DocumentosService.actualizar', () => {
  it('sin escritura en la carpeta actual: 403 y no escribe', async () => {
    const { servicio, archivos } = montar(actor([ROL_LEE]));
    archivos.findOne.mockReturnValue(consulta(archivoDoc()));
    await expect(
      servicio.actualizar(
        new Types.ObjectId().toString(),
        { destacado: true },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(archivos.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('mover exige escritura también en la carpeta destino', async () => {
    const { servicio, archivos } = montar(actor([ROL_ESCRIBE]));
    archivos.findOne.mockReturnValue(consulta(archivoDoc()));
    await expect(
      servicio.actualizar(
        new Types.ObjectId().toString(),
        { carpeta: 'privada' },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(archivos.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('actualiza con $set filtrando por id Y copropiedad', async () => {
    const { servicio, archivos } = montar(actor([ROL_ESCRIBE]));
    const doc = archivoDoc();
    archivos.findOne.mockReturnValue(consulta(doc));
    archivos.findOneAndUpdate.mockReturnValue(
      consulta({ ...doc, destacado: true, etiquetas: ['acta'] }),
    );

    const res = await servicio.actualizar(
      doc._id.toString(),
      { destacado: true, etiquetas: ['acta'] },
      user,
    );

    expect(archivos.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: doc._id.toString(), copropiedadId: COPROPIEDAD },
      { $set: { destacado: true, etiquetas: ['acta'] } },
      { new: true },
    );
    expect(res.destacado).toBe(true);
  });
});

describe('DocumentosService.eliminar', () => {
  it('solo quien gestiona puede eliminar', async () => {
    const { servicio, archivos } = montar(actor([ROL_ESCRIBE]));
    await expect(
      servicio.eliminar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(archivos.findOneAndDelete).not.toHaveBeenCalled();
  });

  it('borra el registro (por id Y copropiedad) y después el objeto', async () => {
    const { servicio, archivos, almacen } = montar(actor([], true));
    const doc = archivoDoc();
    archivos.findOneAndDelete.mockReturnValue(consulta(doc));

    await expect(servicio.eliminar(doc._id.toString(), user)).resolves.toEqual({
      id: doc._id.toString(),
    });

    expect(archivos.findOneAndDelete).toHaveBeenCalledWith({
      _id: doc._id.toString(),
      copropiedadId: COPROPIEDAD,
    });
    expect(almacen.eliminar).toHaveBeenCalledWith(doc.rutaAlmacenamiento);
  });

  it('si el objeto no se pudo borrar, el borrado del documento igual se completa', async () => {
    const { servicio, archivos, almacen } = montar(actor([], true));
    archivos.findOneAndDelete.mockReturnValue(consulta(archivoDoc()));
    almacen.eliminar.mockResolvedValue(false);
    await expect(
      servicio.eliminar(new Types.ObjectId().toString(), user),
    ).resolves.toBeDefined();
  });

  it('un documento de otra copropiedad es 404 y no toca Storage', async () => {
    const { servicio, almacen } = montar(actor([], true));
    await expect(
      servicio.eliminar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(almacen.eliminar).not.toHaveBeenCalled();
  });

  it('id mal formado es 404', async () => {
    const { servicio } = montar(actor([], true));
    await expect(servicio.eliminar('xyz', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('DocumentosService.estadisticas', () => {
  it('cuenta solo archivos listos de la copropiedad y devuelve la cuota', async () => {
    const { servicio, archivos } = montar(actor([], true));
    archivos.aggregate.mockReturnValue(consulta([{ total: 3, usado: 9000 }]));

    await expect(servicio.estadisticas(user)).resolves.toEqual({
      totalArchivos: 3,
      espacioUsadoBytes: 9000,
      espacioTotalBytes: CUOTA_ALMACENAMIENTO_BYTES,
    });
    const pipeline = (
      archivos.aggregate.mock.calls as unknown[][]
    )[0][0] as Array<{
      $match?: unknown;
    }>;
    expect(pipeline[0].$match).toEqual({
      copropiedadId: COPROPIEDAD,
      estado: 'listo',
      carpetaId: { $in: [ACTAS._id, PRIVADA._id] },
    });
  });

  it('respeta los permisos de carpeta: no cuenta archivos de carpetas que el actor no puede leer', async () => {
    const { servicio, archivos } = montar(actor([ROL_LEE]));

    await servicio.estadisticas(user);

    const pipeline = (
      archivos.aggregate.mock.calls as unknown[][]
    )[0][0] as Array<{ $match?: unknown }>;
    expect(pipeline[0].$match).toEqual({
      copropiedadId: COPROPIEDAD,
      estado: 'listo',
      carpetaId: { $in: [ACTAS._id] },
    });
  });

  it('sin archivos devuelve ceros', async () => {
    const { servicio } = montar(actor([], true));
    await expect(servicio.estadisticas(user)).resolves.toMatchObject({
      totalArchivos: 0,
      espacioUsadoBytes: 0,
    });
  });
});
