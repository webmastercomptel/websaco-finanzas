import { GUARDS_METADATA } from '@nestjs/common/constants';
import { InterfazComptableController } from './interfaz-comptable.controller';
import { CHECK_ABILITY_KEY } from '../casl/check-ability.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';

const servicio = () => ({
  estado: jest.fn().mockResolvedValue({}),
  pendientes: jest.fn().mockResolvedValue({}),
  simular: jest.fn().mockResolvedValue({}),
  enviar: jest.fn().mockResolvedValue({}),
  listar: jest.fn().mockResolvedValue([]),
  reintentar: jest.fn().mockResolvedValue({}),
  retirar: jest.fn().mockResolvedValue({}),
});

const usuario = {
  uid: 'u1',
  email: 'ana@example.com',
  accountId: '66f000000000000000000099',
  nombre: '  ',
};

describe('InterfazComptableController', () => {
  it('pasa el actor autenticado (con el email cuando no hay nombre), nunca uno del body', async () => {
    const s = servicio();
    const controller = new InterfazComptableController(s as never);

    await controller.enviar(usuario);
    await controller.retirar('L1', { ...usuario, nombre: 'Ana Pérez' });

    expect(s.enviar).toHaveBeenCalledWith({
      accountId: usuario.accountId,
      nombre: 'ana@example.com',
    });
    expect(s.retirar).toHaveBeenCalledWith('L1', {
      accountId: usuario.accountId,
      nombre: 'Ana Pérez',
    });
  });

  it('autentica y autoriza: Firebase y luego CASL, en ese orden', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, InterfazComptableController),
    ).toEqual([FirebaseAuthGuard, PoliciesGuard]);
  });

  it.each([
    ['estado', 'read'],
    ['pendientes', 'read'],
    ['listar', 'read'],
    ['simular', 'create'],
    ['enviar', 'create'],
    ['reintentar', 'create'],
    ['retirar', 'annul'],
  ] as const)('%s exige %s sobre InterfazComptable', (metodo, action) => {
    expect(
      Reflect.getMetadata(
        CHECK_ABILITY_KEY,
        // Metadata lookup only — the method is never called unbound.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        InterfazComptableController.prototype[metodo],
      ),
    ).toEqual([{ action, subject: 'InterfazComptable' }]);
  });
});
