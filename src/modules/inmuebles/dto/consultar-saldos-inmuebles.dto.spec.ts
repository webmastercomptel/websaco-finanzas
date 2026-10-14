import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConsultarSaldosInmueblesDto } from './consultar-saldos-inmuebles.dto';

const ID_A = '64b7f0c2a1b2c3d4e5f60718';
const ID_B = '64b7f0c2a1b2c3d4e5f60719';

describe('ConsultarSaldosInmueblesDto', () => {
  it('parte la cadena separada por comas, recorta espacios y descarta vacíos', async () => {
    const dto = plainToInstance(ConsultarSaldosInmueblesDto, {
      ids: ` ${ID_A}, ${ID_B} ,,`,
    });

    expect(dto.ids).toEqual([ID_A, ID_B]);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza ids vacíos, no-ObjectId y más de 50', async () => {
    const vacio = plainToInstance(ConsultarSaldosInmueblesDto, { ids: ' , ' });
    const invalido = plainToInstance(ConsultarSaldosInmueblesDto, {
      ids: `${ID_A},no-es-id`,
    });
    const demasiados = plainToInstance(ConsultarSaldosInmueblesDto, {
      ids: Array.from({ length: 51 }, () => ID_A).join(','),
    });

    expect(await validate(vacio)).not.toHaveLength(0);
    expect(await validate(invalido)).not.toHaveLength(0);
    expect(await validate(demasiados)).not.toHaveLength(0);
  });
});
