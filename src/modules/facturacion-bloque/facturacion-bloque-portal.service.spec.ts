import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { UnidadPortal } from '../portal/portal-acceso.service';
import { FacturacionBloquePortalService } from './facturacion-bloque-portal.service';

/** A chainable Mongoose query double: every builder step returns itself. */
interface Consulta {
  exec: jest.Mock;
  select: jest.Mock;
}

const consulta = (valor: unknown): Consulta => {
  const q = {} as Consulta;
  q.exec = jest.fn().mockResolvedValue(valor);
  q.select = jest.fn().mockReturnValue(q);
  return q;
};

const llamada = (mock: jest.Mock, n = 0): unknown[] =>
  (mock.mock.calls as unknown[][])[n];

const COPROPIEDAD = new Types.ObjectId();
const CUENTA = new Types.ObjectId();
const user: IRequestUser = {
  uid: 'u',
  email: 'r@b.co',
  accountId: CUENTA.toString(),
  nombre: 'Rosa',
  copropiedadId: COPROPIEDAD.toString(),
  esResidente: true,
};

const unidad = (
  codigo: string,
  rol: 'propietario' | 'arrendatario',
): UnidadPortal => ({
  inmuebleId: new Types.ObjectId().toString(),
  codigo,
  rol,
});

const documentoDe = (
  u: UnidadPortal,
  tipo: string,
  bloqueId: Types.ObjectId,
  extra: Record<string, unknown> = {},
) => ({
  _id: new Types.ObjectId(),
  copropiedadId: COPROPIEDAD,
  bloqueId,
  inmuebleId: new Types.ObjectId(u.inmuebleId),
  codigoInmueble: u.codigo,
  tipo,
  periodo: '2026-07',
  paginas: [1, 2],
  rutaAlmacenamiento: `facturacion-bloque/${COPROPIEDAD.toString()}/${bloqueId.toString()}/unidades/${u.inmuebleId}.pdf`,
  tamanoBytes: 1234,
  ...extra,
});

const bloqueEnviado = (
  id: Types.ObjectId,
  fecha = new Date('2026-07-05T10:00:00.000Z'),
) => ({
  _id: id,
  enviadoEn: fecha,
  createdAt: new Date('2026-07-01T10:00:00.000Z'),
});

function montar(
  opciones: {
    unidades?: UnidadPortal[];
    documentos?: ReturnType<typeof documentoDe>[];
    bloquesVisibles?: Array<ReturnType<typeof bloqueEnviado>>;
    bloqueVisible?: boolean;
    sinCuenta?: boolean;
  } = {},
) {
  const unidades = opciones.unidades ?? [];
  const documentos = {
    find: jest.fn().mockReturnValue(consulta(opciones.documentos ?? [])),
    findOne: jest.fn(),
  };
  const bloques = {
    find: jest.fn().mockReturnValue(consulta(opciones.bloquesVisibles ?? [])),
    exists: jest
      .fn()
      .mockReturnValue(
        consulta(opciones.bloqueVisible === false ? null : { _id: 'x' }),
      ),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const portalAcceso = {
    unidadesDe: jest.fn().mockResolvedValue(unidades),
    rolEn: jest
      .fn()
      .mockImplementation((_cuenta: string, _cop: string, inmueble: string) =>
        Promise.resolve(
          unidades.find((u) => u.inmuebleId === inmueble)?.rol ?? null,
        ),
      ),
  };
  const almacen = {
    firmarLectura: jest.fn().mockResolvedValue('https://storage.test/firmada'),
  };
  const servicio = new FacturacionBloquePortalService(
    documentos as never,
    bloques as never,
    tenant as never,
    portalAcceso as never,
    almacen as never,
  );
  return { servicio, documentos, bloques, tenant, portalAcceso, almacen };
}

describe('FacturacionBloquePortalService — listar', () => {
  it('el propietario ve la factura Y el estado de cuenta de su unidad', async () => {
    const u = unidad('301', 'propietario');
    const bloque = new Types.ObjectId();
    const { servicio } = montar({
      unidades: [u],
      documentos: [
        documentoDe(u, 'factura', bloque),
        documentoDe(u, 'estado_cuenta', bloque),
      ],
      bloquesVisibles: [bloqueEnviado(bloque)],
    });

    const lista = await servicio.listar({}, user);

    expect(lista.map((d) => d.tipo).sort()).toEqual([
      'estado_cuenta',
      'factura',
    ]);
    expect(lista[0]).toMatchObject({
      inmuebleId: u.inmuebleId,
      codigoInmueble: '301',
      rol: 'propietario',
      cantidadPaginas: 2,
      tamanoBytes: 1234,
      fecha: '2026-07-05T10:00:00.000Z',
    });
  });

  it('el arrendatario ve la factura pero NUNCA el estado de cuenta', async () => {
    const u = unidad('301', 'arrendatario');
    const bloque = new Types.ObjectId();
    const { servicio } = montar({
      unidades: [u],
      documentos: [
        documentoDe(u, 'factura', bloque),
        documentoDe(u, 'estado_cuenta', bloque),
      ],
      bloquesVisibles: [bloqueEnviado(bloque)],
    });

    const lista = await servicio.listar({}, user);

    expect(lista.map((d) => d.tipo)).toEqual(['factura']);
  });

  it('el rol es POR unidad: dueño de una y arrendatario de otra ve el estado de cuenta solo de la suya', async () => {
    const propia = unidad('301', 'propietario');
    const alquilada = unidad('302', 'arrendatario');
    const bloque = new Types.ObjectId();
    const { servicio } = montar({
      unidades: [propia, alquilada],
      documentos: [
        documentoDe(propia, 'estado_cuenta', bloque),
        documentoDe(alquilada, 'estado_cuenta', bloque),
        documentoDe(alquilada, 'factura', bloque),
      ],
      bloquesVisibles: [bloqueEnviado(bloque)],
    });

    const lista = await servicio.listar({}, user);

    expect(lista.map((d) => `${d.codigoInmueble}:${d.tipo}`).sort()).toEqual([
      '301:estado_cuenta',
      '302:factura',
    ]);
  });

  it('un recibo no lo ve nadie, ni siquiera el propietario (aunque llegara hasta el servicio)', async () => {
    const u = unidad('301', 'propietario');
    const bloque = new Types.ObjectId();
    const { servicio, documentos } = montar({
      unidades: [u],
      documentos: [documentoDe(u, 'recibo', bloque)],
      bloquesVisibles: [bloqueEnviado(bloque)],
    });

    const lista = await servicio.listar({}, user);

    expect(lista).toEqual([]);
    // Y la consulta ni siquiera pide recibos.
    const filtro = llamada(documentos.find)[0] as {
      tipo: { $in: string[] };
    };
    expect(filtro.tipo.$in).toEqual(['factura', 'estado_cuenta']);
  });

  it('solo consulta las unidades del llamante, en la copropiedad activa', async () => {
    const u = unidad('301', 'propietario');
    const { servicio, documentos, portalAcceso } = montar({ unidades: [u] });

    await servicio.listar({}, user);

    expect(portalAcceso.unidadesDe).toHaveBeenCalledWith(
      CUENTA.toString(),
      COPROPIEDAD.toString(),
    );
    const filtro = llamada(documentos.find)[0] as Record<string, unknown>;
    expect(filtro.copropiedadId).toBe(COPROPIEDAD);
    expect(filtro.inmuebleId).toEqual({
      $in: [new Types.ObjectId(u.inmuebleId)],
    });
  });

  it('el documento de una unidad que no es del llamante no aparece aunque la consulta lo devolviera', async () => {
    const mia = unidad('301', 'propietario');
    const ajena = unidad('999', 'propietario');
    const bloque = new Types.ObjectId();
    const { servicio } = montar({
      unidades: [mia],
      documentos: [
        documentoDe(mia, 'factura', bloque),
        documentoDe(ajena, 'factura', bloque),
      ],
      bloquesVisibles: [bloqueEnviado(bloque)],
    });

    const lista = await servicio.listar({}, user);

    expect(lista.map((d) => d.codigoInmueble)).toEqual(['301']);
  });

  it('sin unidades en la copropiedad no consulta documentos y devuelve []', async () => {
    const { servicio, documentos } = montar({ unidades: [] });

    await expect(servicio.listar({}, user)).resolves.toEqual([]);
    expect(documentos.find).not.toHaveBeenCalled();
  });

  it('un bloque todavía no enviado (generado) no aparece: solo se ven los pendiente_envio y enviado', async () => {
    const u = unidad('301', 'propietario');
    const bloque = new Types.ObjectId();
    const { servicio, bloques } = montar({
      unidades: [u],
      documentos: [documentoDe(u, 'factura', bloque)],
      bloquesVisibles: [],
    });

    const lista = await servicio.listar({}, user);

    expect(lista).toEqual([]);
    const filtro = llamada(bloques.find)[0] as {
      estado: { $in: string[] };
      copropiedadId: Types.ObjectId;
    };
    expect(filtro.estado.$in).toEqual(['pendiente_envio', 'enviado']);
    expect(filtro.copropiedadId).toBe(COPROPIEDAD);
  });

  it('filtra por tipo cuando se pide', async () => {
    const u = unidad('301', 'propietario');
    const { servicio, documentos } = montar({ unidades: [u] });

    await servicio.listar({ tipo: 'estado_cuenta' }, user);

    expect((llamada(documentos.find)[0] as { tipo: unknown }).tipo).toEqual({
      $in: ['estado_cuenta'],
    });
  });

  it('ordena del más recientemente enviado al más antiguo', async () => {
    const u = unidad('301', 'propietario');
    const viejo = new Types.ObjectId();
    const nuevo = new Types.ObjectId();
    const { servicio } = montar({
      unidades: [u],
      documentos: [
        documentoDe(u, 'factura', viejo, { periodo: '2026-06' }),
        documentoDe(u, 'factura', nuevo, { periodo: '2026-07' }),
      ],
      bloquesVisibles: [
        bloqueEnviado(viejo, new Date('2026-06-05T10:00:00.000Z')),
        bloqueEnviado(nuevo, new Date('2026-07-05T10:00:00.000Z')),
      ],
    });

    const lista = await servicio.listar({}, user);

    expect(lista.map((d) => d.periodo)).toEqual(['2026-07', '2026-06']);
  });

  it('nunca expone la ruta de almacenamiento ni ids internos del bloque', async () => {
    const u = unidad('301', 'propietario');
    const bloque = new Types.ObjectId();
    const { servicio } = montar({
      unidades: [u],
      documentos: [documentoDe(u, 'factura', bloque)],
      bloquesVisibles: [bloqueEnviado(bloque)],
    });

    const [item] = await servicio.listar({}, user);

    expect(JSON.stringify(item)).not.toContain('facturacion-bloque/');
    expect(Object.keys(item).sort()).toEqual([
      'cantidadPaginas',
      'codigoInmueble',
      'fecha',
      'id',
      'inmuebleId',
      'periodo',
      'rol',
      'tamanoBytes',
      'tipo',
    ]);
  });

  it('una cuenta sin id (no provisionada) es 403', async () => {
    const { servicio } = montar();

    await expect(
      servicio.listar({}, { ...user, accountId: undefined }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('FacturacionBloquePortalService — descargar', () => {
  const preparar = (
    rol: 'propietario' | 'arrendatario',
    tipo: string,
    extra: { bloqueVisible?: boolean } = {},
  ) => {
    const u = unidad('301', rol);
    const bloque = new Types.ObjectId();
    const doc = documentoDe(u, tipo, bloque);
    const m = montar({ unidades: [u], bloqueVisible: extra.bloqueVisible });
    m.documentos.findOne.mockReturnValue(consulta(doc));
    return { ...m, doc, u };
  };

  it('el propietario recibe una URL firmada de SU documento, con el nombre del archivo', async () => {
    const { servicio, doc, almacen, documentos } = preparar(
      'propietario',
      'estado_cuenta',
    );

    const respuesta = await servicio.descargar(doc._id.toString(), user);

    expect(respuesta).toEqual({
      url: 'https://storage.test/firmada',
      nombre: 'estado_cuenta-2026-07-301.pdf',
    });
    expect(almacen.firmarLectura).toHaveBeenCalledWith(
      doc.rutaAlmacenamiento,
      'estado_cuenta-2026-07-301.pdf',
    );
    expect(llamada(documentos.findOne)[0]).toEqual({
      _id: doc._id.toString(),
      copropiedadId: COPROPIEDAD,
    });
  });

  it('el arrendatario descarga la factura', async () => {
    const { servicio, doc } = preparar('arrendatario', 'factura');

    await expect(
      servicio.descargar(doc._id.toString(), user),
    ).resolves.toMatchObject({ nombre: 'factura-2026-07-301.pdf' });
  });

  it('el arrendatario pidiendo un estado de cuenta de su unidad recibe 404 y no se firma nada', async () => {
    const { servicio, doc, almacen } = preparar(
      'arrendatario',
      'estado_cuenta',
    );

    await expect(
      servicio.descargar(doc._id.toString(), user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(almacen.firmarLectura).not.toHaveBeenCalled();
  });

  it.each(['propietario', 'arrendatario'] as const)(
    'un recibo es 404 también para el %s',
    async (rol) => {
      const { servicio, doc, almacen } = preparar(rol, 'recibo');

      await expect(
        servicio.descargar(doc._id.toString(), user),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(almacen.firmarLectura).not.toHaveBeenCalled();
    },
  );

  it('un documento de una unidad que el llamante no tiene es 404 (igual que uno inexistente: no se filtra su existencia)', async () => {
    const ajena = unidad('999', 'propietario');
    const bloque = new Types.ObjectId();
    const doc = documentoDe(ajena, 'factura', bloque);
    const { servicio, documentos, almacen } = montar({ unidades: [] });
    documentos.findOne.mockReturnValue(consulta(doc));

    await expect(servicio.descargar(doc._id.toString(), user)).rejects.toThrow(
      `Documento ${doc._id.toString()} no encontrado`,
    );
    expect(almacen.firmarLectura).not.toHaveBeenCalled();
  });

  it('un documento de otra copropiedad no se encuentra (la búsqueda lleva copropiedadId)', async () => {
    const { servicio, documentos } = montar();
    documentos.findOne.mockReturnValue(consulta(null));
    const id = new Types.ObjectId().toString();

    await expect(servicio.descargar(id, user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(
      (llamada(documentos.findOne)[0] as { copropiedadId: unknown })
        .copropiedadId,
    ).toBe(COPROPIEDAD);
  });

  it('un id mal formado es 404 y no toca la base', async () => {
    const { servicio, documentos } = montar();

    await expect(
      servicio.descargar('no-es-un-id', user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(documentos.findOne).not.toHaveBeenCalled();
  });

  it('un documento de un bloque que todavía no se envió es 404 aunque la unidad sea del llamante', async () => {
    const { servicio, doc, almacen } = preparar('propietario', 'factura', {
      bloqueVisible: false,
    });

    await expect(
      servicio.descargar(doc._id.toString(), user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(almacen.firmarLectura).not.toHaveBeenCalled();
  });

  it('el rol se resuelve contra la unidad del DOCUMENTO, no contra lo que diga el cliente', async () => {
    const { servicio, doc, portalAcceso, u } = preparar(
      'propietario',
      'factura',
    );

    await servicio.descargar(doc._id.toString(), user);

    expect(portalAcceso.rolEn).toHaveBeenCalledWith(
      CUENTA.toString(),
      COPROPIEDAD.toString(),
      u.inmuebleId,
    );
  });

  it('el nombre de descarga se sanea (el código viene de un PDF)', async () => {
    const u = unidad('Torre A/../301', 'propietario');
    const bloque = new Types.ObjectId();
    const doc = documentoDe(u, 'factura', bloque);
    const { servicio, documentos, almacen } = montar({ unidades: [u] });
    documentos.findOne.mockReturnValue(consulta(doc));

    const { nombre } = await servicio.descargar(doc._id.toString(), user);

    expect(nombre).toBe('factura-2026-07-Torre_A_.._301.pdf');
    expect(nombre).not.toContain('/');
    expect(almacen.firmarLectura).toHaveBeenCalled();
  });
});
