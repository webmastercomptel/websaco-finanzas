import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TAMANO_MAXIMO_BLOQUE_BYTES } from './facturacion-bloque-ingesta.service';
import { FacturacionBloqueService } from './facturacion-bloque.service';

/** A chainable Mongoose query double: every builder step returns itself. */
interface Consulta {
  exec: jest.Mock;
  sort: jest.Mock;
  limit: jest.Mock;
}

const consulta = (valor: unknown): Consulta => {
  const q = {} as Consulta;
  q.exec = jest.fn().mockResolvedValue(valor);
  q.sort = jest.fn().mockReturnValue(q);
  q.limit = jest.fn().mockReturnValue(q);
  return q;
};

const llamada = (mock: jest.Mock, n = 0): unknown[] =>
  (mock.mock.calls as unknown[][])[n];

const COPROPIEDAD = new Types.ObjectId();
const BLOQUE = new Types.ObjectId();
const CUENTA = new Types.ObjectId();
const user: IRequestUser = {
  uid: 'u',
  email: 'a@b.co',
  accountId: CUENTA.toString(),
  nombre: 'Ana Administradora',
};

const bloqueDoc = (extra: Record<string, unknown> = {}) => ({
  _id: BLOQUE,
  copropiedadId: COPROPIEDAD,
  tipo: 'factura',
  periodo: '2026-07',
  nombre: 'julio.pdf',
  rutaOriginal: `facturacion-bloque/${COPROPIEDAD.toString()}/${BLOQUE.toString()}/original.pdf`,
  estado: 'generado',
  tamanoBytes: 1000,
  totalPaginas: 4,
  totalUnidades: 2,
  paginasSinMatch: [],
  unidadesNoRegistradas: [],
  subidoPorNombre: 'Ana Administradora',
  enviadoEn: null,
  enviadoPorNombre: '',
  destinatariosTotal: 0,
  correoConfigurado: null,
  createdAt: new Date('2026-07-01T09:00:00.000Z'),
  updatedAt: new Date('2026-07-01T09:00:00.000Z'),
  ...extra,
});

function montar(bloque: ReturnType<typeof bloqueDoc> | null = bloqueDoc()) {
  const guardar = jest.fn();
  const instancias: Array<Record<string, unknown>> = [];
  // `new this.bloques({...}).save()`: a constructor double that remembers its data.
  const bloques = Object.assign(
    jest.fn().mockImplementation((datos: Record<string, unknown>) => {
      instancias.push(datos);
      guardar.mockResolvedValue(
        bloqueDoc({
          ...datos,
          createdAt: new Date('2026-07-01T09:00:00.000Z'),
        }),
      );
      return { save: guardar };
    }),
    {
      find: jest.fn().mockReturnValue(consulta([bloqueDoc()])),
      findOne: jest.fn().mockReturnValue(consulta(bloque)),
      deleteOne: jest.fn().mockReturnValue(consulta({ deletedCount: 1 })),
    },
  );
  const documentos = {
    find: jest.fn().mockReturnValue(consulta([])),
    deleteMany: jest.fn().mockReturnValue(consulta({ deletedCount: 2 })),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const almacen = {
    firmarSubida: jest.fn().mockResolvedValue('https://storage.test/subida'),
    firmarLectura: jest.fn().mockResolvedValue('https://storage.test/lectura'),
    eliminarPrefijo: jest
      .fn()
      .mockResolvedValue({ eliminados: 3, fallidos: 0 }),
  };
  const servicio = new FacturacionBloqueService(
    bloques as never,
    documentos as never,
    tenant as never,
    almacen as never,
  );
  return { servicio, bloques, documentos, tenant, almacen, instancias };
}

const dto = {
  tipo: 'factura' as const,
  periodo: '2026-07',
  nombre: 'julio.pdf',
  mimeType: 'application/pdf' as const,
  tamanoBytes: 5_000_000,
};

describe('FacturacionBloqueService.crear', () => {
  it('registra el bloque pendiente con una ruta que elige el backend, firma la subida y devuelve el contrato', async () => {
    const { servicio, instancias, almacen } = montar();

    const respuesta = await servicio.crear(dto, user);

    const datos = instancias[0];
    expect(datos).toMatchObject({
      copropiedadId: COPROPIEDAD,
      tipo: 'factura',
      periodo: '2026-07',
      nombre: 'julio.pdf',
      estado: 'pendiente',
      tamanoBytes: 5_000_000,
    });
    const id = (datos._id as Types.ObjectId).toString();
    expect(datos.rutaOriginal).toBe(
      `facturacion-bloque/${COPROPIEDAD.toString()}/${id}/original.pdf`,
    );
    expect(almacen.firmarSubida).toHaveBeenCalledWith(datos.rutaOriginal);
    expect(respuesta.uploadUrl).toBe('https://storage.test/subida');
    expect(respuesta.bloque.estado).toBe('pendiente');
  });

  it('quién sube sale de la cuenta autenticada, no del cuerpo', async () => {
    const { servicio, instancias } = montar();

    await servicio.crear(dto, user);

    expect(instancias[0]).toMatchObject({
      subidoPorId: CUENTA,
      subidoPorNombre: 'Ana Administradora',
    });
  });

  it('declara un archivo de más de 200 MB: 400 y no registra nada', async () => {
    const { servicio, bloques } = montar();

    const intento = servicio.crear(
      { ...dto, tamanoBytes: TAMANO_MAXIMO_BLOQUE_BYTES + 1 },
      user,
    );

    await expect(intento).rejects.toBeInstanceOf(BadRequestException);
    await expect(intento).rejects.toThrow('límite de 200 MB');
    expect(bloques).not.toHaveBeenCalled();
  });

  it('acepta exactamente 200 MB declarados', async () => {
    const { servicio } = montar();

    await expect(
      servicio.crear({ ...dto, tamanoBytes: TAMANO_MAXIMO_BLOQUE_BYTES }, user),
    ).resolves.toBeDefined();
  });
});

describe('FacturacionBloqueService.listar y detalle', () => {
  it('lista solo los bloques de la copropiedad activa, del más nuevo al más viejo, con un tope', async () => {
    const { servicio, bloques } = montar();

    await servicio.listar({});

    expect(llamada(bloques.find)[0]).toEqual({ copropiedadId: COPROPIEDAD });
    const q = bloques.find.mock.results[0].value as Consulta;
    expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(q.limit).toHaveBeenCalledWith(500);
  });

  it('aplica los filtros de tipo y estado', async () => {
    const { servicio, bloques } = montar();

    await servicio.listar({ tipo: 'estado_cuenta', estado: 'generado' });

    expect(llamada(bloques.find)[0]).toEqual({
      copropiedadId: COPROPIEDAD,
      tipo: 'estado_cuenta',
      estado: 'generado',
    });
  });

  it('el detalle busca por id Y copropiedad y trae una fila por unidad con el avance del envío', async () => {
    const { servicio, bloques, documentos } = montar();
    const ana = new Types.ObjectId();
    documentos.find.mockReturnValue(
      consulta([
        {
          _id: new Types.ObjectId(),
          inmuebleId: new Types.ObjectId(),
          codigoInmueble: '301',
          paginas: [1, 2],
          tamanoBytes: 10,
          notificadosIds: [ana],
          correosEnviadosIds: [],
        },
      ]),
    );

    const detalle = await servicio.detalle(BLOQUE.toString());

    expect(llamada(bloques.findOne)[0]).toEqual({
      _id: BLOQUE.toString(),
      copropiedadId: COPROPIEDAD,
    });
    expect(llamada(documentos.find)[0]).toEqual({
      copropiedadId: COPROPIEDAD,
      bloqueId: BLOQUE,
    });
    expect(detalle.unidades).toHaveLength(1);
    expect(detalle.unidades[0]).toMatchObject({
      codigoInmueble: '301',
      paginas: [1, 2],
    });
    expect(detalle.entrega).toMatchObject({
      notificados: 1,
      correosEnviados: 0,
    });
  });

  it('un id mal formado es 404 sin tocar la base; uno de otra copropiedad también', async () => {
    const { servicio, bloques } = montar(null);

    await expect(servicio.detalle('xx')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(bloques.findOne).not.toHaveBeenCalled();
    await expect(servicio.detalle(BLOQUE.toString())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('el contrato no expone la ruta de almacenamiento ni los tokens de lease', async () => {
    const { servicio } = montar(
      bloqueDoc({ tokenEnvio: 'secreto', tokenProcesamiento: 'otro' }),
    );

    const detalle = await servicio.detalle(BLOQUE.toString());

    const json = JSON.stringify(detalle);
    expect(json).not.toContain('facturacion-bloque/');
    expect(json).not.toContain('secreto');
    expect(json).not.toContain('otro');
  });
});

describe('FacturacionBloqueService.descargarOriginal', () => {
  it('devuelve una URL firmada del original con el nombre que subió el admin', async () => {
    const { servicio, almacen } = montar();

    await expect(
      servicio.descargarOriginal(BLOQUE.toString()),
    ).resolves.toEqual({
      url: 'https://storage.test/lectura',
      nombre: 'julio.pdf',
    });
    expect(almacen.firmarLectura).toHaveBeenCalledWith(
      expect.stringContaining('/original.pdf'),
      'julio.pdf',
    );
  });

  it('un bloque que todavía no tiene archivo subido es 409', async () => {
    const { servicio } = montar(bloqueDoc({ estado: 'pendiente' }));

    await expect(
      servicio.descargarOriginal(BLOQUE.toString()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('FacturacionBloqueService.eliminar', () => {
  it('borra el registro con el guard de estado DENTRO del filtro, luego las filas por unidad y la carpeta de Storage', async () => {
    const { servicio, bloques, documentos, almacen } = montar();

    await expect(servicio.eliminar(BLOQUE.toString())).resolves.toEqual({
      id: BLOQUE.toString(),
    });

    const filtro = llamada(bloques.deleteOne)[0] as Record<string, unknown>;
    expect(filtro._id).toBe(BLOQUE);
    expect(filtro.copropiedadId).toBe(COPROPIEDAD);
    const alternativas = JSON.stringify(filtro.$or);
    expect(alternativas).toContain('pendiente');
    expect(alternativas).toContain('generado');
    expect(alternativas).toContain('error');
    // Lo ya enviado, o en envío, no es borrable.
    expect(alternativas).not.toContain('enviado');
    expect(alternativas).not.toContain('pendiente_envio');
    expect(llamada(documentos.deleteMany)[0]).toEqual({
      copropiedadId: COPROPIEDAD,
      bloqueId: BLOQUE,
    });
    expect(almacen.eliminarPrefijo).toHaveBeenCalledWith(
      `facturacion-bloque/${COPROPIEDAD.toString()}/${BLOQUE.toString()}/`,
    );
  });

  it('si el bloque ya salió hacia los residentes (o se está procesando) responde 409 y no borra filas ni archivos', async () => {
    const { servicio, bloques, documentos, almacen } = montar();
    bloques.deleteOne.mockReturnValue(consulta({ deletedCount: 0 }));

    await expect(servicio.eliminar(BLOQUE.toString())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(documentos.deleteMany).not.toHaveBeenCalled();
    expect(almacen.eliminarPrefijo).not.toHaveBeenCalled();
  });

  it('un bloque de otra copropiedad o inexistente es 404', async () => {
    const { servicio, bloques } = montar(null);

    await expect(servicio.eliminar(BLOQUE.toString())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(bloques.deleteOne).not.toHaveBeenCalled();
  });

  it('si falla la limpieza de Storage el borrado igual se da por hecho (queda un huérfano, no un registro roto)', async () => {
    const { servicio, almacen } = montar();
    almacen.eliminarPrefijo.mockRejectedValue(new Error('storage caído'));

    await expect(servicio.eliminar(BLOQUE.toString())).resolves.toEqual({
      id: BLOQUE.toString(),
    });
  });
});
