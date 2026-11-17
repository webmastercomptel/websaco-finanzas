import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConsultarInformeGestionDto } from './consultar-informe-gestion.dto';

const invalidas = async (plano: Record<string, unknown>) =>
  (await validate(plainToInstance(ConsultarInformeGestionDto, plano))).map(
    (e) => e.property,
  );

describe('ConsultarInformeGestionDto', () => {
  it('acepta un período válido', async () => {
    expect(
      await invalidas({ desde: '2026-11-01', hasta: '2026-11-30' }),
    ).toEqual([]);
  });
  it('rechaza un mes inexistente', async () => {
    expect(
      await invalidas({ desde: '2026-13-01', hasta: '2026-11-30' }),
    ).toEqual(['desde']);
  });
  it('rechaza un día inexistente', async () => {
    expect(
      await invalidas({ desde: '2026-02-30', hasta: '2026-11-30' }),
    ).toEqual(['desde']);
  });
  it('rechaza un formato distinto', async () => {
    expect(
      await invalidas({ desde: '01/11/2026', hasta: '2026-11-30' }),
    ).toEqual(['desde']);
  });
  it('rechaza hasta ausente', async () => {
    expect(await invalidas({ desde: '2026-11-01' })).toEqual(['hasta']);
  });
});
