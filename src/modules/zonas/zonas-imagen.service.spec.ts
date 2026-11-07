import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ZonasImagenService } from './zonas-imagen.service';

/** A chainable Mongoose query double: every builder step returns itself. */
interface Consulta {
  exec: jest.Mock;
  select: jest.Mock;
}

const consulta = (valor: unknown): Consulta => {
  const q = {} as Consulta;
  q.exec = jest.fn().mockResolvedValue(valor);
  q.select = jest.fn().mockReturnValue(q);
  return q;
};

const COPROPIEDAD = new Types.ObjectId();
const ZONA = new Types.ObjectId();
const ZONA_ID = ZONA.toString();

const zonaDoc = (extra: Record<string, unknown> = {}) => ({
  _id: ZONA,
  copropiedadId: COPROPIEDAD,
  codigo: 'ZC-001',
  nombre: 'Salón social',
  tipo: 'social',
  descripcion: '',
  capacidad: 20,
  horario: '',
  requiereReserva: false,
  costo: null,
  imagenUrl: null,
  reglas: [] as string[],
  estado: 'disponible',
  ...extra,
});

function montar() {
  const zonas = {
    findOne: jest.fn().mockReturnValue(consulta({ _id: ZONA })),
    findOneAndUpdate: jest.fn(),
  };
  const archivo = {
    getSignedUrl: jest
      .fn()
      .mockResolvedValue(['https://storage.example.com/signed-write-url']),
    getMetadata: jest.fn().mockResolvedValue([{ size: 1024 }]),
    makePublic: jest.fn().mockResolvedValue(undefined),
    publicUrl: jest.fn().mockReturnValue('https://storage.example.com/publica'),
  };
  const bucket = { file: jest.fn().mockReturnValue(archivo) };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const servicio = new ZonasImagenService(
    zonas as never,
    bucket as never,
    tenant as never,
  );
  return { servicio, zonas, bucket, archivo };
}

const dto = {
  nombre: 'foto.png',
  mimeType: 'image/png',
  tamanoBytes: 2048,
};

describe('ZonasImagenService.iniciar', () => {
  it('firma una URL de escritura y devuelve un storagePath con el prefijo de la copropiedad y la zona', async () => {
    const { servicio, bucket, archivo } = montar();

    const resultado = await servicio.iniciar(ZONA_ID, dto);

    expect(resultado.uploadUrl).toBe(
      'https://storage.example.com/signed-write-url',
    );
    expect(resultado.storagePath).toContain(
      `zonas/${COPROPIEDAD.toString()}/${ZONA_ID}/`,
    );
    expect(bucket.file).toHaveBeenCalledWith(resultado.storagePath);
    expect(archivo.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'write', contentType: 'image/png' }),
    );
  });

  it('busca la zona por id Y copropiedad', async () => {
    const { servicio, zonas } = montar();

    await servicio.iniciar(ZONA_ID, dto);

    expect(zonas.findOne).toHaveBeenCalledWith({
      _id: ZONA_ID,
      copropiedadId: COPROPIEDAD,
    });
  });

  it('lanza 404 si la zona no existe en la copropiedad activa, sin firmar nada', async () => {
    const { servicio, zonas, archivo } = montar();
    zonas.findOne.mockReturnValue(consulta(null));

    await expect(servicio.iniciar(ZONA_ID, dto)).rejects.toThrow(
      NotFoundException,
    );
    expect(archivo.getSignedUrl).not.toHaveBeenCalled();
  });

  it('un id mal formado es un 404 y no toca la base', async () => {
    const { servicio, zonas } = montar();

    await expect(servicio.iniciar('xx', dto)).rejects.toThrow(
      NotFoundException,
    );
    expect(zonas.findOne).not.toHaveBeenCalled();
  });

  it('rechaza con 400 si la imagen declarada supera el límite de 10 MB', async () => {
    const { servicio, archivo } = montar();

    await expect(
      servicio.iniciar(ZONA_ID, { ...dto, tamanoBytes: 11 * 1024 * 1024 }),
    ).rejects.toThrow(BadRequestException);
    expect(archivo.getSignedUrl).not.toHaveBeenCalled();
  });

  it('rechaza con 400 un archivo que no es imagen: se publica tal cual', async () => {
    const { servicio, archivo } = montar();

    await expect(
      servicio.iniciar(ZONA_ID, { ...dto, mimeType: 'text/html' }),
    ).rejects.toThrow(BadRequestException);
    expect(archivo.getSignedUrl).not.toHaveBeenCalled();
  });

  it('sanea el nombre del archivo dentro de la ruta', async () => {
    const { servicio } = montar();

    const { storagePath } = await servicio.iniciar(ZONA_ID, {
      ...dto,
      nombre: '../../mi foto?.png',
    });

    // Slashes become underscores, so a hostile name can never add path segments
    // (the object stays exactly under zonas/<copropiedad>/<zona>/).
    expect(storagePath.split('/')).toHaveLength(4);
    expect(storagePath).not.toContain(' ');
    expect(
      storagePath.startsWith(`zonas/${COPROPIEDAD.toString()}/${ZONA_ID}/`),
    ).toBe(true);
  });
});

describe('ZonasImagenService.confirmar', () => {
  const rutaPropia = `zonas/${COPROPIEDAD.toString()}/${ZONA_ID}/abc-foto.png`;

  it('hace público el objeto y sobreescribe imagenUrl con su URL pública', async () => {
    const { servicio, zonas, archivo } = montar();
    zonas.findOneAndUpdate.mockReturnValue(
      consulta(zonaDoc({ imagenUrl: 'https://storage.example.com/publica' })),
    );

    const resultado = await servicio.confirmar(ZONA_ID, rutaPropia);

    expect(archivo.makePublic).toHaveBeenCalled();
    expect(zonas.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ZONA_ID, copropiedadId: COPROPIEDAD },
      { $set: { imagenUrl: 'https://storage.example.com/publica' } },
      { new: true },
    );
    expect(resultado.imagen).toBe('https://storage.example.com/publica');
  });

  it('lanza 404 si la zona no existe en la copropiedad activa', async () => {
    const { servicio, zonas } = montar();
    zonas.findOne.mockReturnValue(consulta(null));

    await expect(servicio.confirmar(ZONA_ID, rutaPropia)).rejects.toThrow(
      NotFoundException,
    );
    expect(zonas.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rechaza con 400 un storagePath de otra copropiedad o de otra zona, sin hacerlo público', async () => {
    const { servicio, zonas, archivo } = montar();

    await expect(
      servicio.confirmar(
        ZONA_ID,
        `zonas/${new Types.ObjectId().toString()}/${ZONA_ID}/abc-foto.png`,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      servicio.confirmar(
        ZONA_ID,
        `zonas/${COPROPIEDAD.toString()}/${new Types.ObjectId().toString()}/abc-foto.png`,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(archivo.makePublic).not.toHaveBeenCalled();
    expect(zonas.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rechaza con 400 si el objeto no existe en el almacenamiento (getMetadata falla)', async () => {
    const { servicio, zonas, archivo } = montar();
    archivo.getMetadata.mockRejectedValue(new Error('not found'));

    await expect(servicio.confirmar(ZONA_ID, rutaPropia)).rejects.toThrow(
      BadRequestException,
    );
    expect(archivo.makePublic).not.toHaveBeenCalled();
    expect(zonas.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('si la zona desaparece entre la verificación y la escritura, es un 404', async () => {
    const { servicio, zonas } = montar();
    zonas.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(servicio.confirmar(ZONA_ID, rutaPropia)).rejects.toThrow(
      NotFoundException,
    );
  });
});
