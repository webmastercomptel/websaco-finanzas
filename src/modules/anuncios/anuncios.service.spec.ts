import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { AnunciosService } from './anuncios.service';

/** A chainable Mongoose query double: every builder step returns itself. */
interface Consulta {
  exec: jest.Mock;
  select: jest.Mock;
  sort: jest.Mock;
}

const consulta = (valor: unknown): Consulta => {
  const q = {} as Consulta;
  q.exec = jest.fn().mockResolvedValue(valor);
  q.select = jest.fn().mockReturnValue(q);
  q.sort = jest.fn().mockReturnValue(q);
  return q;
};

type ModeloAnuncios = jest.Mock & {
  find: jest.Mock;
  findOne: jest.Mock;
  findOneAndUpdate: jest.Mock;
  findOneAndDelete: jest.Mock;
};

const COPROPIEDAD = new Types.ObjectId();
const ANUNCIO = new Types.ObjectId();
const CUENTA = new Types.ObjectId();
const OTRA_CUENTA = new Types.ObjectId();

const anuncioDoc = (extra: Record<string, unknown> = {}) => ({
  _id: ANUNCIO,
  copropiedadId: COPROPIEDAD,
  titulo: 'Corte de agua',
  contenido: 'El sábado no habrá agua de 9 a 13hs.',
  categoria: 'mantenimiento',
  autor: 'Ana',
  imagenUrl: null,
  destacado: false,
  vistas: 0,
  meGustaIds: [] as Types.ObjectId[],
  estado: 'enviado',
  publicadoEn: new Date('2026-01-01T00:00:00.000Z'),
  notificadosIds: [] as Types.ObjectId[],
  correosEnviadosIds: [] as Types.ObjectId[],
  destinatariosTotal: 0,
  correoConfigurado: null,
  ...extra,
});

const usuario = (accountId?: Types.ObjectId): IRequestUser => ({
  uid: 'uid',
  email: 'x@y.co',
  nombre: 'Ana Gómez',
  accountId: accountId?.toString(),
});

function montar() {
  const anuncios = jest
    .fn()
    .mockImplementation((doc: Record<string, unknown>) => {
      const instancia: Record<string, unknown> = {
        ...anuncioDoc(),
        ...doc,
        _id: ANUNCIO,
        meGustaIds: [],
        notificadosIds: [],
        correosEnviadosIds: [],
        vistas: 0,
      };
      instancia.save = jest.fn().mockResolvedValue(instancia);
      return instancia;
    }) as ModeloAnuncios;
  anuncios.find = jest.fn().mockReturnValue(consulta([]));
  anuncios.findOne = jest.fn().mockReturnValue(consulta(anuncioDoc()));
  anuncios.findOneAndUpdate = jest.fn().mockReturnValue(consulta(anuncioDoc()));
  anuncios.findOneAndDelete = jest.fn().mockReturnValue(consulta(anuncioDoc()));
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const servicio = new AnunciosService(anuncios as never, tenant as never);
  return { servicio, anuncios, tenant };
}

describe('AnunciosService — crear', () => {
  it('crea un borrador en la copropiedad activa con el autor tomado de la cuenta, no del cliente', async () => {
    const { servicio, anuncios } = montar();

    const creado = await servicio.crear(
      { titulo: 'Corte de agua', contenido: 'x', categoria: 'seguridad' },
      usuario(CUENTA),
    );

    expect(anuncios).toHaveBeenCalledWith(
      expect.objectContaining({
        copropiedadId: COPROPIEDAD,
        autor: 'Ana Gómez',
        estado: 'borrador',
        imagenUrl: null,
        destacado: false,
      }),
    );
    expect(creado.estado).toBe('borrador');
  });

  it('un usuario sin nombre firma con cadena vacía en vez de inventar un autor', async () => {
    const { servicio, anuncios } = montar();

    await servicio.crear(
      { titulo: 't', contenido: 'c', categoria: 'comunidad' },
      { uid: 'u', email: 'a@b.co' },
    );

    expect(anuncios).toHaveBeenCalledWith(
      expect.objectContaining({ autor: '' }),
    );
  });
});

describe('AnunciosService — listas', () => {
  it('el listado de staff filtra por la copropiedad activa, categoría y estado, y trae la entrega', async () => {
    const { servicio, anuncios } = montar();
    const q = consulta([
      anuncioDoc({
        destinatariosTotal: 3,
        notificadosIds: [CUENTA],
        correosEnviadosIds: [],
        correoConfigurado: false,
      }),
    ]);
    anuncios.find.mockReturnValue(q);

    const lista = await servicio.listar({
      categoria: 'seguridad',
      estado: 'fallido',
    });

    expect(anuncios.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      categoria: 'seguridad',
      estado: 'fallido',
    });
    expect(lista[0].entrega).toEqual({
      destinatarios: 3,
      notificados: 1,
      correosEnviados: 0,
      correoConfigurado: false,
    });
    expect(lista[0].likedByMe).toBeUndefined();
  });

  it("'todos' no filtra", async () => {
    const { servicio, anuncios } = montar();

    await servicio.listar({ categoria: 'todos', estado: 'todos' });

    expect(anuncios.find).toHaveBeenCalledWith({ copropiedadId: COPROPIEDAD });
  });

  it('el residente solo ve anuncios publicados (nunca borradores), de su copropiedad', async () => {
    const { servicio, anuncios } = montar();
    const q = consulta([]);
    anuncios.find.mockReturnValue(q);

    await servicio.listarParaResidente(
      { categoria: 'comunidad' },
      usuario(CUENTA),
    );

    expect(anuncios.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      estado: { $in: ['enviando', 'enviado', 'fallido'] },
      categoria: 'comunidad',
    });
    expect(q.sort).toHaveBeenCalledWith({ publicadoEn: -1 });
  });

  it('el residente no recibe el progreso de entrega ni el token: se excluyen de la lectura y del contrato', async () => {
    const { servicio, anuncios } = montar();
    const q = consulta([anuncioDoc({ meGustaIds: [CUENTA, OTRA_CUENTA] })]);
    anuncios.find.mockReturnValue(q);

    const [uno] = await servicio.listarParaResidente({}, usuario(CUENTA));

    expect(q.select).toHaveBeenCalledWith(
      expect.stringContaining('-notificadosIds'),
    );
    expect(uno.entrega).toBeUndefined();
    expect(uno.likes).toBe(2);
    expect(uno.likedByMe).toBe(true);
  });

  it('un llamador sin cuenta nunca figura con like (falla cerrado)', async () => {
    const { servicio, anuncios } = montar();
    anuncios.find.mockReturnValue(
      consulta([anuncioDoc({ meGustaIds: [CUENTA] })]),
    );

    const [uno] = await servicio.listarParaResidente({}, usuario());

    expect(uno.likedByMe).toBe(false);
  });
});

describe('AnunciosService — actualizar y eliminar', () => {
  it('actualiza filtrando por id Y copropiedad, solo con los campos enviados, sin tocar el autor', async () => {
    const { servicio, anuncios } = montar();

    await servicio.actualizar(ANUNCIO.toString(), {
      titulo: 'Nuevo',
      imagen: null,
    });

    expect(anuncios.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ANUNCIO.toString(), copropiedadId: COPROPIEDAD },
      { $set: { titulo: 'Nuevo', imagenUrl: null } },
      { new: true },
    );
  });

  it('actualizar un anuncio de otra copropiedad (o inexistente) es 404', async () => {
    const { servicio, anuncios } = montar();
    anuncios.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.actualizar(ANUNCIO.toString(), { titulo: 'x' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('un id mal formado es 404 sin tocar la base', async () => {
    const { servicio, anuncios } = montar();

    await expect(servicio.actualizar('no-existe', {})).rejects.toThrow(
      NotFoundException,
    );
    await expect(servicio.eliminar('no-existe')).rejects.toThrow(
      NotFoundException,
    );
    expect(anuncios.findOneAndUpdate).not.toHaveBeenCalled();
    expect(anuncios.findOneAndDelete).not.toHaveBeenCalled();
  });

  it('elimina filtrando por id Y copropiedad y responde 404 si no hay nada', async () => {
    const { servicio, anuncios } = montar();

    await expect(servicio.eliminar(ANUNCIO.toString())).resolves.toEqual({
      id: ANUNCIO.toString(),
    });
    expect(anuncios.findOneAndDelete).toHaveBeenCalledWith({
      _id: ANUNCIO.toString(),
      copropiedadId: COPROPIEDAD,
    });

    anuncios.findOneAndDelete.mockReturnValue(consulta(null));
    await expect(servicio.eliminar(ANUNCIO.toString())).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('AnunciosService — vista', () => {
  it('cuenta la vista de forma atómica sobre un anuncio publicado de la copropiedad', async () => {
    const { servicio, anuncios } = montar();
    anuncios.findOneAndUpdate.mockReturnValue(
      consulta(anuncioDoc({ vistas: 5 })),
    );

    const resultado = await servicio.registrarVista(
      ANUNCIO.toString(),
      usuario(CUENTA),
    );

    expect(anuncios.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: ANUNCIO.toString(),
        copropiedadId: COPROPIEDAD,
        estado: { $in: ['enviando', 'enviado', 'fallido'] },
      },
      { $inc: { vistas: 1 } },
      { new: true },
    );
    expect(resultado.vistas).toBe(5);
  });

  it('ver un borrador es 404, igual que un anuncio inexistente', async () => {
    const { servicio, anuncios } = montar();
    anuncios.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.registrarVista(ANUNCIO.toString(), usuario(CUENTA)),
    ).rejects.toThrow(NotFoundException);
  });

  it('sin cuenta aprovisionada es 400 y no escribe', async () => {
    const { servicio, anuncios } = montar();

    await expect(
      servicio.registrarVista(ANUNCIO.toString(), usuario()),
    ).rejects.toThrow(BadRequestException);
    expect(anuncios.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('AnunciosService — me gusta (atómico, sin contador aparte)', () => {
  const publicado = {
    _id: ANUNCIO.toString(),
    copropiedadId: COPROPIEDAD,
    estado: { $in: ['enviando', 'enviado', 'fallido'] },
  };

  it('da like con $addToSet solo si la cuenta aún no está, y el conteo sale del arreglo', async () => {
    const { servicio, anuncios } = montar();
    anuncios.findOneAndUpdate
      .mockReturnValueOnce(consulta(null)) // no estaba: el $pull no matchea
      .mockReturnValueOnce(consulta(anuncioDoc({ meGustaIds: [CUENTA] })));

    const resultado = await servicio.alternarMeGusta(
      ANUNCIO.toString(),
      usuario(CUENTA),
    );

    expect(anuncios.findOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      { ...publicado, meGustaIds: CUENTA },
      { $pull: { meGustaIds: CUENTA } },
      { new: true },
    );
    expect(anuncios.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      { ...publicado, meGustaIds: { $ne: CUENTA } },
      { $addToSet: { meGustaIds: CUENTA } },
      { new: true },
    );
    expect(resultado.likes).toBe(1);
    expect(resultado.likedByMe).toBe(true);
  });

  it('quita el like con $pull cuando ya estaba, sin segunda escritura', async () => {
    const { servicio, anuncios } = montar();
    anuncios.findOneAndUpdate.mockReturnValueOnce(
      consulta(anuncioDoc({ meGustaIds: [OTRA_CUENTA] })),
    );

    const resultado = await servicio.alternarMeGusta(
      ANUNCIO.toString(),
      usuario(CUENTA),
    );

    expect(anuncios.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(resultado.likes).toBe(1);
    expect(resultado.likedByMe).toBe(false);
  });

  it('un doble clic que ya aterrizó se reporta como like, sin duplicar ni fallar', async () => {
    const { servicio, anuncios } = montar();
    anuncios.findOneAndUpdate
      .mockReturnValueOnce(consulta(null))
      .mockReturnValueOnce(consulta(null));
    anuncios.findOne.mockReturnValue(
      consulta(anuncioDoc({ meGustaIds: [CUENTA] })),
    );

    const resultado = await servicio.alternarMeGusta(
      ANUNCIO.toString(),
      usuario(CUENTA),
    );

    expect(resultado.likedByMe).toBe(true);
    expect(resultado.likes).toBe(1);
  });

  it('dar like a un borrador o a un anuncio ajeno es 404 y no deja nada escrito', async () => {
    const { servicio, anuncios } = montar();
    anuncios.findOneAndUpdate.mockReturnValue(consulta(null));
    anuncios.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.alternarMeGusta(ANUNCIO.toString(), usuario(CUENTA)),
    ).rejects.toThrow(NotFoundException);
    expect(anuncios.findOne).toHaveBeenCalledWith(publicado);
  });

  it('un id mal formado es 404 sin tocar la base', async () => {
    const { servicio, anuncios } = montar();

    await expect(
      servicio.alternarMeGusta('no-existe', usuario(CUENTA)),
    ).rejects.toThrow(NotFoundException);
    expect(anuncios.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
