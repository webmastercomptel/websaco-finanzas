import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  ActualizarInmuebleDto,
  CrearInmuebleDto,
} from './guardar-inmueble.dto';

/** The exact pipe `app-setup.ts` installs globally. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

describe('CrearInmuebleDto / ActualizarInmuebleDto — resideEnElInmueble retirado', () => {
  it('un cliente viejo que aún envía resideEnElInmueble al crear no recibe 400 y el valor se descarta', async () => {
    const dto = (await pipe.transform(
      { codigo: '301', resideEnElInmueble: true },
      { type: 'body', metatype: CrearInmuebleDto },
    )) as CrearInmuebleDto;

    expect(dto.codigo).toBe('301');
    expect(dto.resideEnElInmueble).toBeUndefined();
  });

  it('lo mismo al editar: se acepta y no llega al servicio', async () => {
    const dto = (await pipe.transform(
      { zona: 'Norte', resideEnElInmueble: false },
      { type: 'body', metatype: ActualizarInmuebleDto },
    )) as ActualizarInmuebleDto;

    expect(dto.zona).toBe('Norte');
    expect(dto.resideEnElInmueble).toBeUndefined();
  });

  it('una propiedad desconocida cualquiera sigue siendo rechazada', async () => {
    await expect(
      pipe.transform(
        { codigo: '301', columnaInventada: 1 },
        { type: 'body', metatype: CrearInmuebleDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
