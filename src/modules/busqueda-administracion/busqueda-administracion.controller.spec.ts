import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { BusquedaAdministracionController } from './busqueda-administracion.controller';
import type { BusquedaAdministracionService } from './busqueda-administracion.service';

describe('BusquedaAdministracionController', () => {
  const handler = Object.getOwnPropertyDescriptor(
    BusquedaAdministracionController.prototype,
    'buscar',
  )?.value as object;

  it('cuelga de busqueda-administracion, distinto del GET /busqueda financiero', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, BusquedaAdministracionController),
    ).toBe('busqueda-administracion');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(0); // GET
  });

  it('exige leer al menos una de las entidades buscables, o subir documentos (facturas por bloque)', () => {
    const reglas = Reflect.getMetadata(
      CHECK_ANY_ABILITY_KEY,
      handler,
    ) as RequiredRule[];

    expect(reglas.map((r) => `${r.action}:${r.subject}`).sort()).toEqual(
      [
        'read:Tarea',
        'read:Anuncio',
        'read:Pqr',
        'read:Mantenimiento',
        'read:Actividad',
        'read:Documento',
        'read:Zona',
        'read:Reserva',
        'create:Documento',
      ].sort(),
    );
  });

  it('no mezcla subjects financieros en la puerta', () => {
    const reglas = Reflect.getMetadata(
      CHECK_ANY_ABILITY_KEY,
      handler,
    ) as RequiredRule[];
    const financieros = ['Factura', 'Recibo', 'NotaCredito', 'Inmueble'];

    expect(reglas.some((r) => financieros.includes(r.subject))).toBe(false);
    expect(Reflect.getMetadata(CHECK_ABILITY_KEY, handler)).toBeUndefined();
  });

  it('usa FirebaseAuthGuard antes que PoliciesGuard', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, BusquedaAdministracionController),
    ).toEqual([FirebaseAuthGuard, PoliciesGuard]);
  });

  it('declara el módulo administracion: sin licencia, 403 aunque tenga el permiso', () => {
    expect(
      Reflect.getMetadata(MODULO_KEY, BusquedaAdministracionController),
    ).toBe('administracion');
  });

  it('delega en el servicio con el usuario y la consulta', async () => {
    const respuesta = { tareas: [] };
    const buscar = jest.fn().mockResolvedValue(respuesta);
    const controller = new BusquedaAdministracionController({
      buscar,
    } as unknown as BusquedaAdministracionService);
    const user = { uid: 'u', email: 'a@b.co' } as IRequestUser;
    const query = { q: 'acta', limite: 3 };

    await expect(controller.buscar(user, query)).resolves.toBe(respuesta);
    expect(buscar).toHaveBeenCalledWith(user, query);
  });
});
