import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { BusquedaController } from './busqueda.controller';
import {
  CHECK_ANY_ABILITY_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import type { BusquedaService } from './busqueda.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

describe('BusquedaController', () => {
  const handler = Object.getOwnPropertyDescriptor(
    BusquedaController.prototype,
    'buscar',
  )?.value as object;

  it('exige leer al menos una de las siete entidades buscables', () => {
    const reglas = Reflect.getMetadata(
      CHECK_ANY_ABILITY_KEY,
      handler,
    ) as RequiredRule[];

    expect(reglas).toHaveLength(7);
    expect(reglas.every((r) => r.action === 'read')).toBe(true);
    expect(reglas.map((r) => r.subject).sort()).toEqual(
      [
        'Factura',
        'Inmueble',
        'NotaAnticipo',
        'NotaContable',
        'NotaCredito',
        'OtraNota',
        'Recibo',
      ].sort(),
    );
  });

  it('usa FirebaseAuthGuard antes que PoliciesGuard', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      BusquedaController,
    ) as unknown[];

    expect(guards).toEqual([FirebaseAuthGuard, PoliciesGuard]);
  });

  it('delega en el servicio con el usuario y la consulta', async () => {
    const respuesta = { facturas: [] };
    const buscar = jest.fn().mockResolvedValue(respuesta);
    const controller = new BusquedaController({
      buscar,
    } as unknown as BusquedaService);
    const user = { uid: 'u', email: 'a@b.co' } as IRequestUser;
    const query = { q: '1041', limite: 3 };

    await expect(controller.buscar(user, query)).resolves.toBe(respuesta);
    expect(buscar).toHaveBeenCalledWith(user, query);
  });
});
