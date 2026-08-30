import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CrearReciboDto } from './crear-recibo.dto';
import { AplicarReciboDto } from './aplicar-recibo.dto';
import { AnularReciboDto } from './anular-recibo.dto';
import { ListarRecibosDto } from './listar-recibos.dto';

const validoCrear = () => ({
  inmuebleId: '507f1f77bcf86cd799439011',
  terceroId: '507f1f77bcf86cd799439012',
  montoRecibido: 500000,
  fechaRecibo: '2026-08-27',
  medioPago: 'transferencia',
  cuentaDestino: '111005',
});

describe('CrearReciboDto', () => {
  it('acepta el mínimo bien formado (sin aplicaciones — puro anticipo)', async () => {
    const dto = plainToInstance(CrearReciboDto, validoCrear());
    expect(await validate(dto)).toHaveLength(0);
  });

  it('acepta con aplicaciones manuales anidadas', async () => {
    const dto = plainToInstance(CrearReciboDto, {
      ...validoCrear(),
      aplicaciones: [
        { tipoDocumento: 'FV', documentoId: '507f1f77bcf86cd799439013', montoAplicado: 200000 },
      ],
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza un medioPago fuera del catálogo', async () => {
    const dto = plainToInstance(CrearReciboDto, { ...validoCrear(), medioPago: 'bitcoin' });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza un montoAplicado negativo dentro de aplicaciones', async () => {
    const dto = plainToInstance(CrearReciboDto, {
      ...validoCrear(),
      aplicaciones: [
        { tipoDocumento: 'FV', documentoId: '507f1f77bcf86cd799439013', montoAplicado: -1 },
      ],
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza un documentoId que no es un ObjectId', async () => {
    const dto = plainToInstance(CrearReciboDto, {
      ...validoCrear(),
      aplicaciones: [{ tipoDocumento: 'FV', documentoId: 'no-es-un-id', montoAplicado: 100 }],
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});

describe('AplicarReciboDto', () => {
  it('acepta aplicacionAutomatica sola', async () => {
    const dto = plainToInstance(AplicarReciboDto, { aplicacionAutomatica: true });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('acepta aplicaciones manuales solas', async () => {
    const dto = plainToInstance(AplicarReciboDto, {
      aplicaciones: [
        { tipoDocumento: 'FV', documentoId: '507f1f77bcf86cd799439013', montoAplicado: 100000 },
      ],
    });
    expect(await validate(dto)).toHaveLength(0);
  });
});

describe('AnularReciboDto', () => {
  it('acepta un motivo del catálogo con detalle de al menos 20 caracteres', async () => {
    const dto = plainToInstance(AnularReciboDto, {
      motivo: 'duplicado',
      detalle: 'Se cargó el mismo comprobante dos veces por error',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rechaza un motivo fuera del catálogo', async () => {
    const dto = plainToInstance(AnularReciboDto, {
      motivo: 'porque_si',
      detalle: 'Un detalle de más de veinte caracteres',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rechaza un detalle demasiado corto — el mismo umbral que el botón deshabilitado del mockup', async () => {
    const dto = plainToInstance(AnularReciboDto, { motivo: 'otro', detalle: 'muy corto' });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});

describe('ListarRecibosDto', () => {
  it('acepta vacío', async () => {
    const dto = plainToInstance(ListarRecibosDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });

  it('transforma conAnticipoDisponible=true (string de query) a boolean', () => {
    const dto = plainToInstance(ListarRecibosDto, { conAnticipoDisponible: 'true' });
    expect(dto.conAnticipoDisponible).toBe(true);
  });

  it('transforma conAnticipoDisponible=false (string de query) a boolean, no truthy por default de JS', () => {
    const dto = plainToInstance(ListarRecibosDto, { conAnticipoDisponible: 'false' });
    expect(dto.conAnticipoDisponible).toBe(false);
  });
});
