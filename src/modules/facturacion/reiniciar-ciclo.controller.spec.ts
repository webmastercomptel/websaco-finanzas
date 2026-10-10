import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { ReiniciarCicloController } from './reiniciar-ciclo.controller';
import type { ReiniciarCicloService } from './reiniciar-ciclo.service';
import type { ResultadoReinicioCiclo } from '../../contracts';

describe('ReiniciarCicloController', () => {
  it('solo lo alcanza un administrador de plataforma: guardas exactas y en orden (autenticación primero)', () => {
    const guardas = Reflect.getMetadata(
      '__guards__',
      ReiniciarCicloController,
    ) as unknown[];

    expect(guardas).toEqual([FirebaseAuthGuard, PlatformAdminGuard]);
  });

  it('pasa el accountId de quien llama al servicio y devuelve su resultado', async () => {
    const resultado = { lotesEliminados: 1 } as ResultadoReinicioCiclo;
    const reiniciar = jest.fn(() => Promise.resolve(resultado));
    const controller = new ReiniciarCicloController({
      reiniciar,
    } as unknown as ReiniciarCicloService);
    const usuario: IRequestUser = {
      uid: 'uid-1',
      email: 'admin@example.com',
      accountId: 'cuenta-123',
      isPlatformAdmin: true,
    };

    await expect(controller.reiniciar(usuario)).resolves.toBe(resultado);

    expect(reiniciar).toHaveBeenCalledWith('cuenta-123');
  });
});
