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
    getMetadata: jest
      .fn()
      .mockResolvedValue([{ size: 1024, contentType: 'image/png' }]),
    delete: jest.fn().mockResolvedValue([{}]),
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

  it.each(['image/svg+xml', 'image/gif', 'image/tiff'])(
    'rechaza con 400 un tipo de imagen fuera de png/jpeg/webp (%s)',
    async (mimeType) => {
      const { servicio, archivo } = montar();

      await expect(
        servicio.iniciar(ZONA_ID, { ...dto, mimeType }),
      ).rejects.toThrow(BadRequestException);
      expect(archivo.getSignedUrl).not.toHaveBeenCalled();
    },
  );

  it('rechaza con 400 un archivo que no es imagen', async () => {
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

  it('NUNCA hace público el objeto: guarda la ruta y devuelve una URL de lectura firmada', async () => {
    const { servicio, zonas, archivo } = montar();
    archivo.getSignedUrl.mockResolvedValue([
      'https://storage.example.com/firmada-lectura',
    ]);
    zonas.findOneAndUpdate.mockReturnValue(
      consulta(zonaDoc({ imagenRuta: rutaPropia, imagenUrl: null })),
    );

    const resultado = await servicio.confirmar(ZONA_ID, rutaPropia);

    expect(archivo.makePublic).not.toHaveBeenCalled();
    expect(zonas.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ZONA_ID, copropiedadId: COPROPIEDAD },
      { $set: { imagenRuta: rutaPropia, imagenUrl: null } },
      { new: true },
    );
    expect(archivo.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v4', action: 'read' }),
    );
    expect(resultado.imagen).toBe(
      'https://storage.example.com/firmada-lectura',
    );
  });

  it('mide el objeto REAL: si supera 10 MB lo borra y responde 400 sin tocar la zona', async () => {
    const { servicio, zonas, archivo } = montar();
    archivo.getMetadata.mockResolvedValue([
      { size: String(11 * 1024 * 1024), contentType: 'image/png' },
    ]);

    await expect(servicio.confirmar(ZONA_ID, rutaPropia)).rejects.toThrow(
      BadRequestException,
    );
    expect(archivo.delete).toHaveBeenCalled();
    expect(zonas.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('si el objeto real no es png/jpeg/webp lo borra y responde 400', async () => {
    const { servicio, zonas, archivo } = montar();
    archivo.getMetadata.mockResolvedValue([
      { size: 100, contentType: 'image/svg+xml' },
    ]);

    await expect(servicio.confirmar(ZONA_ID, rutaPropia)).rejects.toThrow(
      BadRequestException,
    );
    expect(archivo.delete).toHaveBeenCalled();
    expect(zonas.findOneAndUpdate).not.toHaveBeenCalled();
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

describe('ZonasImagenService — la URL de subida no sirve después de confirmar', () => {
  it('firma la escritura con x-goog-if-generation-match: 0 y devuelve los encabezados que el navegador debe mandar', async () => {
    const { servicio, archivo } = montar();

    const resultado = await servicio.iniciar(ZONA_ID, dto);

    expect(archivo.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'write',
        contentType: 'image/png',
        extensionHeaders: { 'x-goog-if-generation-match': '0' },
      }),
    );
    expect(resultado.encabezadosSubida).toEqual({
      'Content-Type': 'image/png',
      'x-goog-if-generation-match': '0',
    });
  });
});

describe('ZonasImagenService.confirmar — la imagen reemplazada no queda huérfana', () => {
  const rutaNueva = `zonas/${COPROPIEDAD.toString()}/${ZONA_ID}/nueva-foto.png`;
  const rutaVieja = `zonas/${COPROPIEDAD.toString()}/${ZONA_ID}/vieja-foto.png`;

  it('al confirmar una imagen nueva borra el objeto de la anterior', async () => {
    const { servicio, zonas, bucket, archivo } = montar();
    zonas.findOne.mockReturnValue(
      consulta({ _id: ZONA, imagenRuta: rutaVieja }),
    );
    zonas.findOneAndUpdate.mockReturnValue(
      consulta(zonaDoc({ imagenRuta: rutaNueva })),
    );

    await servicio.confirmar(ZONA_ID, rutaNueva);

    expect(bucket.file).toHaveBeenCalledWith(rutaVieja);
    expect(archivo.delete).toHaveBeenCalledTimes(1);
  });

  it('no borra nada fuera del prefijo de esa zona ni la misma ruta confirmada otra vez', async () => {
    for (const anterior of [
      `zonas/${COPROPIEDAD.toString()}/${new Types.ObjectId().toString()}/x.png`,
      'otra-cosa/x.png',
      rutaNueva,
    ]) {
      const { servicio, zonas, archivo } = montar();
      zonas.findOne.mockReturnValue(
        consulta({ _id: ZONA, imagenRuta: anterior }),
      );
      zonas.findOneAndUpdate.mockReturnValue(
        consulta(zonaDoc({ imagenRuta: rutaNueva })),
      );

      await servicio.confirmar(ZONA_ID, rutaNueva);

      expect(archivo.delete).not.toHaveBeenCalled();
    }
  });
});
