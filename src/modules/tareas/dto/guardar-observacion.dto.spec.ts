import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CrearObservacionDto } from './guardar-observacion.dto';

describe('CrearObservacionDto', () => {
  it('acepta un texto', async () => {
    const errores = await validate(
      plainToInstance(CrearObservacionDto, { texto: 'Faltan insumos' }),
    );
    expect(errores).toEqual([]);
  });

  it('rechaza un texto vacío o ausente', async () => {
    expect(
      await validate(plainToInstance(CrearObservacionDto, { texto: '' })),
    ).not.toEqual([]);
    expect(
      await validate(plainToInstance(CrearObservacionDto, {})),
    ).not.toEqual([]);
  });
});
