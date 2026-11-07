import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import {
  CHECK_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { ReservasController } from './reservas.controller';

/** The ability a handler declares, read from the same metadata the guard reads. */
const reglasDe = (handler: keyof ReservasController): RequiredRule[] =>
  Reflect.getMetadata(
    CHECK_ABILITY_KEY,
    // Only the function object is read for its metadata; it is never called.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    ReservasController.prototype[handler],
  ) as RequiredRule[];

const LECTURAS = [
  'solicitudes',
  'estadisticas',
  'disponibilidad',
  'listar',
] as const;
const ESCRITURAS = ['crear', 'actualizarEstado'] as const;

describe('ReservasController — política de acceso', () => {
  it('cuelga de reservas (la ruta del sistema original)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ReservasController)).toBe(
      'reservas',
    );
  });

  // Decisión de seguridad: ver (read) no basta para tocar nada, y no existe
  // reservas.gestionar en el catálogo, así que las escrituras exigen approve.
  it.each([
    ['solicitudes', 'read'],
    ['estadisticas', 'read'],
    ['disponibilidad', 'read'],
    ['listar', 'read'],
    ['crear', 'approve'],
    ['actualizarEstado', 'approve'],
  ] as const)('%s exige la acción %s sobre Reserva', (handler, action) => {
    expect(reglasDe(handler)).toEqual([{ action, subject: 'Reserva' }]);
  });

  it('ninguna ruta pide manage Reserva: ninguna clave del catálogo la podría conceder', () => {
    for (const handler of [...LECTURAS, ...ESCRITURAS]) {
      expect(reglasDe(handler)).not.toContainEqual({
        action: 'manage',
        subject: 'Reserva',
      });
    }
  });

  it('declara el módulo administracion y los guards en orden (autenticación antes que políticas)', () => {
    expect(Reflect.getMetadata(MODULO_KEY, ReservasController)).toBe(
      'administracion',
    );
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, ReservasController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });

  it('expone las rutas del original y ninguna de residente', () => {
    const rutas = Object.getOwnPropertyNames(ReservasController.prototype)
      .filter((n) => n !== 'constructor')
      .map((n): [string, object] => [
        n,
        (ReservasController.prototype as unknown as Record<string, object>)[n],
      ])
      .filter(
        ([, fn]) => Reflect.getMetadata(METHOD_METADATA, fn) !== undefined,
      )
      .map(([n]) => n)
      .sort();
    expect(rutas).toEqual([
      'actualizarEstado',
      'crear',
      'disponibilidad',
      'estadisticas',
      'listar',
      'solicitudes',
    ]);
  });
});

describe('ReservasController — el PoliciesGuard real sobre las rutas reales', () => {
  const guard = new PoliciesGuard(new Reflector(), new CaslAbilityFactory());

  const contexto = (
    handler: keyof ReservasController,
    permissions: string[],
    extra: Partial<IRequestUser> = {},
  ): ExecutionContext => {
    const user: IRequestUser = {
      uid: 'u',
      email: 'a@b.co',
      permissions,
      modulos: ['administracion'],
      ...extra,
    };
    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      // Only the function object is read for its metadata; it is never called.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getHandler: () => ReservasController.prototype[handler],
      getClass: () => ReservasController,
    } as unknown as ExecutionContext;
  };

  it.each(LECTURAS)('reservas.ver permite %s', (handler) => {
    expect(guard.canActivate(contexto(handler, ['reservas.ver']))).toBe(true);
  });

  it.each(ESCRITURAS)('reservas.ver NO permite %s', (handler) => {
    expect(() =>
      guard.canActivate(contexto(handler, ['reservas.ver'])),
    ).toThrow(ForbiddenException);
  });

  it.each([...LECTURAS, ...ESCRITURAS])(
    'reservas.aprobar permite %s',
    (handler) => {
      // `approve` alone is enough for the writes; the reads need `ver`, and the
      // two keys are normally granted together.
      expect(
        guard.canActivate(
          contexto(handler, ['reservas.ver', 'reservas.aprobar']),
        ),
      ).toBe(true);
    },
  );

  it.each(ESCRITURAS)('reservas.aprobar solo ya permite %s', (handler) => {
    expect(guard.canActivate(contexto(handler, ['reservas.aprobar']))).toBe(
      true,
    );
  });

  it.each([...LECTURAS, ...ESCRITURAS])(
    'zonas.gestionar NO abre %s: gestionar zonas no es aprobar reservas',
    (handler) => {
      expect(() =>
        guard.canActivate(contexto(handler, ['zonas.gestionar', 'zonas.ver'])),
      ).toThrow(ForbiddenException);
    },
  );

  it.each([...LECTURAS, ...ESCRITURAS])(
    'un residente sin permisos no entra a %s',
    (handler) => {
      expect(() =>
        guard.canActivate(contexto(handler, [], { esResidente: true })),
      ).toThrow(ForbiddenException);
    },
  );

  it('niega si la copropiedad no contrató el módulo administracion', () => {
    expect(() =>
      guard.canActivate(
        contexto('actualizarEstado', ['reservas.aprobar'], {
          modulos: ['finanzas'],
        }),
      ),
    ).toThrow(ForbiddenException);
  });
});

describe('ReservasController — delegación', () => {
  const user: IRequestUser = { uid: 'u', email: 'a@b.co', accountId: 'c1' };

  it('crear y actualizarEstado entregan el cuerpo y el usuario al servicio', async () => {
    const servicio = {
      crearComoPersonal: jest.fn().mockResolvedValue({}),
      cambiarEstado: jest.fn().mockResolvedValue({}),
      disponibilidad: jest.fn().mockResolvedValue({}),
    };
    const controlador = new ReservasController(servicio as never);
    const dto = {
      espacioId: 'e',
      inicio: '2026-09-01T10:00:00Z',
      fin: '2026-09-01T11:00:00Z',
    };

    await controlador.crear(dto, user);
    await controlador.actualizarEstado('r1', { estado: 'aprobada' }, user);
    await controlador.disponibilidad('e1', { fecha: '2026-09-01' });

    expect(servicio.crearComoPersonal).toHaveBeenCalledWith(dto, user);
    expect(servicio.cambiarEstado).toHaveBeenCalledWith(
      'r1',
      { estado: 'aprobada' },
      user,
    );
    expect(servicio.disponibilidad).toHaveBeenCalledWith('e1', '2026-09-01');
  });
});
