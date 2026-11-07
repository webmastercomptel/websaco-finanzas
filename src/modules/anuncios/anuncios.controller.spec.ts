import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  CHECK_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { rulesFromPermissionKeys } from '../casl/permission-map';
import { AnunciosController } from './anuncios.controller';

/** The ability a handler declares, read from the same metadata the guard reads. */
const reglasDe = (handler: keyof AnunciosController): RequiredRule[] =>
  Reflect.getMetadata(
    CHECK_ABILITY_KEY,
    // Only the function object is read for its metadata; it is never called.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    AnunciosController.prototype[handler],
  ) as RequiredRule[];

describe('AnunciosController — política de acceso', () => {
  it('cuelga de anuncios', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AnunciosController)).toBe(
      'anuncios',
    );
  });

  it.each([
    ['listar', 'read'],
    ['crear', 'create'],
    ['actualizar', 'update'],
    ['eliminar', 'remove'],
    ['publicar', 'update'],
  ] as const)('%s exige la acción %s sobre Anuncio', (handler, action) => {
    expect(reglasDe(handler)).toEqual([{ action, subject: 'Anuncio' }]);
  });

  it('expone exactamente las rutas esperadas, ninguna de ellas de residente', () => {
    const rutas = Object.getOwnPropertyNames(AnunciosController.prototype)
      .filter((n) => n !== 'constructor')
      .map(
        (n) =>
          [
            n,
            (AnunciosController.prototype as unknown as Record<string, object>)[
              n
            ],
          ] as const,
      )
      .filter(
        ([, fn]) => Reflect.getMetadata(METHOD_METADATA, fn) !== undefined,
      )
      .map(([n, fn]) => [n, String(Reflect.getMetadata(PATH_METADATA, fn))])
      .sort();

    expect(rutas).toEqual([
      ['actualizar', ':id'],
      ['crear', '/'],
      ['eliminar', ':id'],
      ['listar', '/'],
      ['publicar', ':id/publicar'],
    ]);
  });

  it('declara el módulo administracion y los guards en orden (autenticación antes que políticas)', () => {
    expect(Reflect.getMetadata(MODULO_KEY, AnunciosController)).toBe(
      'administracion',
    );
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, AnunciosController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });

  it('las claves anuncios.* del catálogo producen exactamente las acciones que las rutas piden', () => {
    const reglas = (clave: string) =>
      rulesFromPermissionKeys([clave]).filter((r) => !r.inverted);
    expect(reglas('anuncios.ver')).toEqual([
      { action: 'read', subject: 'Anuncio' },
    ]);
    expect(reglas('anuncios.crear')).toEqual([
      { action: 'create', subject: 'Anuncio' },
    ]);
    expect(reglas('anuncios.editar')).toEqual([
      { action: 'update', subject: 'Anuncio' },
    ]);
    expect(reglas('anuncios.eliminar')).toEqual([
      { action: 'remove', subject: 'Anuncio' },
    ]);
  });
});

describe('AnunciosController — delegación', () => {
  const user: IRequestUser = {
    uid: 'u',
    email: 'a@b.co',
    accountId: 'cuenta-1',
    nombre: 'Ana',
  };

  function montar() {
    const anuncios = {
      listar: jest.fn().mockResolvedValue([]),
      crear: jest.fn().mockResolvedValue({ id: 'a1' }),
      actualizar: jest.fn().mockResolvedValue({ id: 'a1' }),
      eliminar: jest.fn().mockResolvedValue({ id: 'a1' }),
    };
    const entrega = { publicar: jest.fn().mockResolvedValue({ id: 'a1' }) };
    return {
      anuncios,
      entrega,
      controlador: new AnunciosController(anuncios as never, entrega as never),
    };
  }

  it('pasa filtros al listar y el usuario autenticado al crear (el autor sale de su cuenta)', async () => {
    const { anuncios, controlador } = montar();

    await controlador.listar({ estado: 'borrador' });
    await controlador.crear(
      { titulo: 't', contenido: 'c', categoria: 'comunidad' },
      user,
    );

    expect(anuncios.listar).toHaveBeenCalledWith({ estado: 'borrador' });
    expect(anuncios.crear).toHaveBeenCalledWith(
      { titulo: 't', contenido: 'c', categoria: 'comunidad' },
      user,
    );
  });

  it('delega actualizar y eliminar con el id', async () => {
    const { anuncios, controlador } = montar();

    await controlador.actualizar('a1', { titulo: 'y' });
    await controlador.eliminar('a1');

    expect(anuncios.actualizar).toHaveBeenCalledWith('a1', { titulo: 'y' });
    expect(anuncios.eliminar).toHaveBeenCalledWith('a1');
  });

  it('publicar delega solo el id al servicio de entrega: el cliente no decide canales ni audiencia', async () => {
    const { entrega, controlador } = montar();

    await controlador.publicar('a1', { canales: ['email'] });

    expect(entrega.publicar).toHaveBeenCalledWith('a1');
  });
});
