import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  MarcarEnvioFacturasDto,
  MAX_FACTURAS_POR_MARCADO,
} from './marcar-envio-facturas.dto';

const ID = 'a'.repeat(24);
const validar = (plano: Record<string, unknown>) =>
  validate(plainToInstance(MarcarEnvioFacturasDto, plano));

describe('MarcarEnvioFacturasDto', () => {
  it('acepta un lote o una lista de facturas', async () => {
    expect(await validar({ loteId: ID })).toHaveLength(0);
    expect(await validar({ facturaIds: [ID, 'b'.repeat(24)] })).toHaveLength(0);
  });

  it.each(['no-es-un-id', `0x${'a'.repeat(22)}`, 'a'.repeat(23)])(
    'rechaza el id mal formado %s',
    async (id) => {
      expect(await validar({ loteId: id })).not.toHaveLength(0);
      expect(await validar({ facturaIds: [id] })).not.toHaveLength(0);
    },
  );

  it('rechaza una lista vacía, repetida o demasiado larga', async () => {
    expect(await validar({ facturaIds: [] })).not.toHaveLength(0);
    expect(await validar({ facturaIds: [ID, ID] })).not.toHaveLength(0);
    const larga = Array.from({ length: MAX_FACTURAS_POR_MARCADO + 1 }, (_, i) =>
      i.toString(16).padStart(24, '0'),
    );
    expect(await validar({ facturaIds: larga })).not.toHaveLength(0);
  });
});
