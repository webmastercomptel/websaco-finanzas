import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { PortalGuard } from '../portal/portal.guard';
import { DocumentosPortalController } from './documentos-portal.controller';
import { DocumentosController } from './documentos.controller';

type Ctor = { prototype: object };

const handlers = (controlador: Ctor): Array<[string, object]> =>
  Object.getOwnPropertyNames(controlador.prototype)
    .filter((n) => n !== 'constructor')
    .map((n): [string, object] => [
      n,
      (controlador.prototype as Record<string, object>)[n],
    ])
    .filter(([, fn]) => Reflect.getMetadata(METHOD_METADATA, fn) !== undefined);

const reglasDe = (handler: keyof DocumentosController): RequiredRule[] =>
  Reflect.getMetadata(
    CHECK_ABILITY_KEY,
    // Only the function object is read for its metadata; it is never called.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    DocumentosController.prototype[handler],
  ) as RequiredRule[];

const nombresDeGuards = (controlador: Ctor): string[] =>
  (
    Reflect.getMetadata(GUARDS_METADATA, controlador) as Array<{
      name: string;
    }>
  ).map((g) => g.name);

describe('DocumentosController — política de acceso (personal)', () => {
  it('cuelga de documentos', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DocumentosController)).toBe(
      'documentos',
    );
  });

  // Sin llave `eliminar` en el catálogo: borrar y administrar es `gestionar` (manage).
  it.each([
    ['listarCarpetas', 'read'],
    ['carpetaPorSlug', 'read'],
    ['rutaDeCarpeta', 'read'],
    ['crearCarpeta', 'manage'],
    ['actualizarCarpeta', 'manage'],
    ['eliminarCarpeta', 'manage'],
    ['estadisticas', 'read'],
    ['listar', 'read'],
    ['iniciarSubida', 'create'],
    ['confirmarSubida', 'create'],
    ['descargar', 'read'],
    ['actualizar', 'create'],
    ['eliminar', 'manage'],
  ] as const)('%s exige la acción %s sobre Documento', (handler, action) => {
    expect(reglasDe(handler)).toEqual([{ action, subject: 'Documento' }]);
  });

  it('toda ruta del controlador declara una habilidad', () => {
    for (const [nombre, fn] of handlers(DocumentosController)) {
      const reglas = Reflect.getMetadata(CHECK_ABILITY_KEY, fn) as
        RequiredRule[] | undefined;
      expect({ nombre, tiene: (reglas ?? []).length > 0 }).toEqual({
        nombre,
        tiene: true,
      });
    }
  });

  it('ninguna ruta de administración o borrado se conforma con read o create', () => {
    for (const handler of [
      'crearCarpeta',
      'actualizarCarpeta',
      'eliminarCarpeta',
      'eliminar',
    ] as const) {
      expect(reglasDe(handler).map((r) => r.action)).toEqual(['manage']);
    }
  });

  it('declara el módulo administracion y los guards en orden (autenticación antes que políticas)', () => {
    expect(Reflect.getMetadata(MODULO_KEY, DocumentosController)).toBe(
      'administracion',
    );
    expect(nombresDeGuards(DocumentosController)).toEqual([
      'FirebaseAuthGuard',
      'PoliciesGuard',
    ]);
  });
});

describe('DocumentosController — delegación', () => {
  const user: IRequestUser = { uid: 'u', email: 'a@b.co', accountId: 'c1' };

  function montar() {
    const documentos = {
      estadisticas: jest.fn().mockResolvedValue({}),
      listar: jest.fn().mockResolvedValue([]),
      iniciar: jest.fn().mockResolvedValue({}),
      confirmar: jest.fn().mockResolvedValue({}),
      descargar: jest.fn().mockResolvedValue({}),
      actualizar: jest.fn().mockResolvedValue({}),
      eliminar: jest.fn().mockResolvedValue({}),
    };
    const carpetas = {
      listar: jest.fn().mockResolvedValue([]),
      porSlug: jest.fn().mockResolvedValue({}),
      ruta: jest.fn().mockResolvedValue([]),
      crear: jest.fn().mockResolvedValue({}),
      actualizar: jest.fn().mockResolvedValue({}),
      eliminar: jest.fn().mockResolvedValue({}),
    };
    return {
      documentos,
      carpetas,
      controlador: new DocumentosController(
        documentos as never,
        carpetas as never,
      ),
    };
  }

  it('pasa el usuario autenticado al listar carpetas y archivos', async () => {
    const { controlador, carpetas, documentos } = montar();
    await controlador.listarCarpetas({}, user);
    await controlador.listar({ q: 'acta' }, user);
    expect(carpetas.listar).toHaveBeenCalledWith({}, user);
    expect(documentos.listar).toHaveBeenCalledWith({ q: 'acta' }, user);
  });

  it('delega la subida en dos pasos con el usuario', async () => {
    const { controlador, documentos } = montar();
    const dto = {
      nombre: 'a.pdf',
      mimeType: 'application/pdf',
      carpeta: 'actas',
      tamanoBytes: 10,
    };
    await controlador.iniciarSubida(dto, user);
    await controlador.confirmarSubida('d1', user);
    expect(documentos.iniciar).toHaveBeenCalledWith(dto, user);
    expect(documentos.confirmar).toHaveBeenCalledWith('d1', user);
  });

  it('delega la administración de carpetas y el borrado de archivos', async () => {
    const { controlador, carpetas, documentos } = montar();
    await controlador.crearCarpeta({ nombre: 'X' }, user);
    await controlador.actualizarCarpeta('c1', { nombre: 'Y' }, user);
    await controlador.eliminarCarpeta('c1', user);
    await controlador.eliminar('d1', user);
    expect(carpetas.crear).toHaveBeenCalledWith({ nombre: 'X' }, user);
    expect(carpetas.actualizar).toHaveBeenCalledWith(
      'c1',
      { nombre: 'Y' },
      user,
    );
    expect(carpetas.eliminar).toHaveBeenCalledWith('c1', user);
    expect(documentos.eliminar).toHaveBeenCalledWith('d1', user);
  });
});

describe('DocumentosPortalController — metadatos de acceso (residentes)', () => {
  it('cuelga de portal/documentos', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DocumentosPortalController)).toBe(
      'portal/documentos',
    );
  });

  it('usa PortalGuard después de FirebaseAuthGuard (PortalGuard lee request.user) y nunca PoliciesGuard', () => {
    expect(nombresDeGuards(DocumentosPortalController)).toEqual([
      'FirebaseAuthGuard',
      'PortalGuard',
    ]);
  });

  it('declara el módulo administracion', () => {
    expect(Reflect.getMetadata(MODULO_KEY, DocumentosPortalController)).toBe(
      'administracion',
    );
  });

  it('no declara habilidades CASL: los residentes no tienen permisos', () => {
    for (const [, fn] of handlers(DocumentosPortalController)) {
      expect(Reflect.getMetadata(CHECK_ABILITY_KEY, fn)).toBeUndefined();
      expect(Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, fn)).toBeUndefined();
    }
  });

  it('solo expone rutas de lectura: nunca POST, PATCH, PUT ni DELETE', () => {
    // RequestMethod: GET = 0
    const metodos = handlers(DocumentosPortalController).map(
      ([, fn]) => Reflect.getMetadata(METHOD_METADATA, fn) as number,
    );
    expect(metodos.length).toBeGreaterThan(0);
    expect(metodos.every((m) => m === 0)).toBe(true);
  });

  it('expone exactamente carpetas, ruta, por-slug, listado y descarga', () => {
    const rutas = handlers(DocumentosPortalController)
      .map(([, fn]) =>
        // Nest stores the bare `@Get()` path as "/".
        (Reflect.getMetadata(PATH_METADATA, fn) as string).replace(/^\/$/, ''),
      )
      .sort();
    expect(rutas).toEqual(
      [
        '',
        ':id/descarga',
        'carpetas',
        'carpetas/:id/ruta',
        'carpetas/por-slug/:slug',
      ].sort(),
    );
  });

  describe('PortalGuard', () => {
    const contexto = (user: IRequestUser | undefined) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
        getHandler: () =>
          (
            DocumentosPortalController.prototype as unknown as Record<
              string,
              object
            >
          ).listar,
        getClass: () => DocumentosPortalController,
      }) as unknown as ExecutionContext;

    it('rechaza a quien no es residente de la copropiedad activa', () => {
      const guard = new PortalGuard(new Reflector());
      expect(() =>
        guard.canActivate(
          contexto({ uid: 'u', email: 'e@x.co', accountId: 'a' }),
        ),
      ).toThrow(ForbiddenException);
    });

    it('deja pasar a un residente con el módulo contratado', () => {
      const guard = new PortalGuard(new Reflector());
      expect(
        guard.canActivate(
          contexto({
            uid: 'u',
            email: 'e@x.co',
            accountId: 'a',
            esResidente: true,
            copropiedadId: 'c',
            modulos: ['administracion'],
          }),
        ),
      ).toBe(true);
    });

    it('rechaza a un residente si la copropiedad no contrató el módulo', () => {
      const guard = new PortalGuard(new Reflector());
      expect(() =>
        guard.canActivate(
          contexto({
            uid: 'u',
            email: 'e@x.co',
            accountId: 'a',
            esResidente: true,
            copropiedadId: 'c',
            modulos: ['finanzas'],
          }),
        ),
      ).toThrow(ForbiddenException);
    });
  });
});

describe('DocumentosPortalController — delegación', () => {
  const user: IRequestUser = { uid: 'u', email: 'r@x.co', accountId: 'c1' };

  it('pasa el usuario autenticado a cada lectura', async () => {
    const servicio = {
      listarCarpetas: jest.fn().mockResolvedValue([]),
      carpetaPorSlug: jest.fn().mockResolvedValue({}),
      ruta: jest.fn().mockResolvedValue([]),
      listarDocumentos: jest.fn().mockResolvedValue([]),
      descargar: jest.fn().mockResolvedValue({}),
    };
    const controlador = new DocumentosPortalController(servicio as never);

    await controlador.listarCarpetas({}, user);
    await controlador.carpetaPorSlug('s', user);
    await controlador.rutaDeCarpeta('c', user);
    await controlador.listar({ q: 'x' }, user);
    await controlador.descargar('d', user);

    expect(servicio.listarCarpetas).toHaveBeenCalledWith({}, user);
    expect(servicio.carpetaPorSlug).toHaveBeenCalledWith('s', user);
    expect(servicio.ruta).toHaveBeenCalledWith('c', user);
    expect(servicio.listarDocumentos).toHaveBeenCalledWith({ q: 'x' }, user);
    expect(servicio.descargar).toHaveBeenCalledWith('d', user);
  });
});
