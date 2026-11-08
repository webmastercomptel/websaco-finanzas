import { Types } from 'mongoose';
import {
  esRutaDeBloques,
  FacturacionBloqueAlmacenService,
  prefijoDeBloque,
  prefijoDeUnidades,
  PREFIJO_BLOQUES,
  rutaDeUnidad,
  rutaOriginal,
} from './facturacion-bloque-almacen.service';

const COP = new Types.ObjectId().toString();
const BLOQUE = new Types.ObjectId().toString();
const INMUEBLE = new Types.ObjectId().toString();

function montar() {
  const archivos = new Map<string, Record<string, jest.Mock>>();
  const archivo = (ruta: string) => {
    let f = archivos.get(ruta);
    if (!f) {
      f = {
        getSignedUrl: jest.fn().mockResolvedValue(['https://firmada']),
        getMetadata: jest.fn().mockResolvedValue([{ size: '42' }]),
        download: jest.fn().mockResolvedValue([Buffer.from('pdf')]),
        save: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
      };
      archivos.set(ruta, f);
    }
    return f;
  };
  const bucket = {
    file: jest.fn().mockImplementation(archivo),
    getFiles: jest.fn().mockResolvedValue([[]]),
  };
  return {
    servicio: new FacturacionBloqueAlmacenService(bucket as never),
    bucket,
    archivo,
  };
}

describe('rutas de almacenamiento', () => {
  it('el original y las unidades viven bajo la carpeta del bloque, dentro del prefijo propio', () => {
    expect(rutaOriginal(COP, BLOQUE)).toBe(
      `facturacion-bloque/${COP}/${BLOQUE}/original.pdf`,
    );
    expect(rutaDeUnidad(COP, BLOQUE, INMUEBLE)).toBe(
      `facturacion-bloque/${COP}/${BLOQUE}/unidades/${INMUEBLE}.pdf`,
    );
    expect(prefijoDeUnidades(COP, BLOQUE)).toBe(
      `${prefijoDeBloque(COP, BLOQUE)}unidades/`,
    );
  });

  it('esRutaDeBloques rechaza lo que está fuera del prefijo y el prefijo pelado', () => {
    expect(esRutaDeBloques(rutaOriginal(COP, BLOQUE))).toBe(true);
    expect(esRutaDeBloques(PREFIJO_BLOQUES)).toBe(false);
    expect(esRutaDeBloques('documentos-administracion/x/y.pdf')).toBe(false);
    expect(esRutaDeBloques(`documentos-generados/${COP}/f.pdf`)).toBe(false);
    expect(esRutaDeBloques('')).toBe(false);
  });
});

describe('FacturacionBloqueAlmacenService — confinado a facturacion-bloque/', () => {
  const fuera = 'documentos-administracion/otra-cosa.pdf';

  it.each([
    [
      'firmarSubida',
      (s: FacturacionBloqueAlmacenService) => s.firmarSubida(fuera),
    ],
    [
      'firmarLectura',
      (s: FacturacionBloqueAlmacenService) => s.firmarLectura(fuera, 'a.pdf'),
    ],
    ['tamanoReal', (s: FacturacionBloqueAlmacenService) => s.tamanoReal(fuera)],
    ['descargar', (s: FacturacionBloqueAlmacenService) => s.descargar(fuera)],
    [
      'subir',
      (s: FacturacionBloqueAlmacenService) => s.subir(fuera, new Uint8Array(1)),
    ],
  ])(
    '%s rechaza una ruta fuera del prefijo y no toca el bucket',
    async (_n, accion) => {
      const { servicio, bucket } = montar();

      await expect(accion(servicio)).rejects.toThrow(
        'fuera de facturacion-bloque/',
      );
      expect(bucket.file).not.toHaveBeenCalled();
    },
  );

  it('eliminar fuera del prefijo devuelve false (y no borra), nunca lanza', async () => {
    const { servicio, bucket } = montar();

    await expect(servicio.eliminar(fuera)).resolves.toBe(false);
    expect(bucket.file).not.toHaveBeenCalled();
  });

  it('eliminar dentro del prefijo borra el objeto; si falla, devuelve false sin lanzar', async () => {
    const { servicio, archivo } = montar();
    const ruta = rutaOriginal(COP, BLOQUE);

    await expect(servicio.eliminar(ruta)).resolves.toBe(true);
    archivo(ruta).delete.mockRejectedValueOnce(new Error('403'));
    await expect(servicio.eliminar(ruta)).resolves.toBe(false);
  });

  it('la URL de subida queda atada a application/pdf en la propia firma', async () => {
    const { servicio, archivo } = montar();
    const ruta = rutaOriginal(COP, BLOQUE);

    await servicio.firmarSubida(ruta);

    expect(archivo(ruta).getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'write',
        version: 'v4',
        contentType: 'application/pdf',
      }),
    );
  });

  it('la URL de subida es solo de crear: firma x-goog-if-generation-match: 0', async () => {
    const { servicio, archivo } = montar();
    const ruta = rutaOriginal(COP, BLOQUE);

    await servicio.firmarSubida(ruta);

    expect(archivo(ruta).getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionHeaders: { 'x-goog-if-generation-match': '0' },
      }),
    );
  });

  it('la URL de lectura es corta, de lectura, y el nombre de descarga va firmado y saneado', async () => {
    const { servicio, archivo } = montar();
    const ruta = rutaDeUnidad(COP, BLOQUE, INMUEBLE);
    const antes = Date.now();

    await servicio.firmarLectura(ruta, 'factura 2026/07 "301".pdf');

    const opciones = (
      archivo(ruta).getSignedUrl.mock.calls as unknown[][]
    )[0][0] as {
      action: string;
      expires: number;
      responseDisposition: string;
    };
    expect(opciones.action).toBe('read');
    expect(opciones.expires - antes).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    expect(opciones.responseDisposition).toBe(
      'attachment; filename="factura_2026_07_301_.pdf"',
    );
  });

  it('subir escribe en una sola petición (no resumable) como PDF y sin copiar los bytes', async () => {
    const { servicio, archivo } = montar();
    const ruta = rutaDeUnidad(COP, BLOQUE, INMUEBLE);
    const bytes = new Uint8Array([37, 80, 68, 70]);

    await servicio.subir(ruta, bytes);

    const [contenido, opciones] = archivo(ruta).save.mock.calls[0] as [
      Buffer,
      unknown,
    ];
    expect(contenido.buffer).toBe(bytes.buffer);
    expect(opciones).toEqual({
      contentType: 'application/pdf',
      resumable: false,
    });
  });

  it('tamanoReal devuelve el tamaño del objeto como número', async () => {
    const { servicio } = montar();

    await expect(servicio.tamanoReal(rutaOriginal(COP, BLOQUE))).resolves.toBe(
      42,
    );
  });
});

describe('FacturacionBloqueAlmacenService.eliminarPrefijo', () => {
  it.each([
    [''],
    ['/'],
    [PREFIJO_BLOQUES],
    [`${PREFIJO_BLOQUES}${COP}/`],
    [`${PREFIJO_BLOQUES}${COP}/${BLOQUE.slice(0, 10)}/`],
    [`${PREFIJO_BLOQUES}${COP}/${BLOQUE}`],
    [`${PREFIJO_BLOQUES}${COP}/${BLOQUE}/otra/`],
    [`documentos-generados/${COP}/`],
    [`${PREFIJO_BLOQUES}${COP}/../${BLOQUE}/`],
  ])(
    'rechaza el prefijo %j: nunca puede borrar más que UN bloque',
    async (prefijo) => {
      const { servicio, bucket } = montar();

      await expect(servicio.eliminarPrefijo(prefijo)).rejects.toThrow(
        'para no borrar más de lo previsto',
      );
      expect(bucket.getFiles).not.toHaveBeenCalled();
    },
  );

  it('borra la carpeta de un bloque y la de sus unidades, y cuenta eliminados y fallidos', async () => {
    const { servicio, bucket } = montar();
    const ok = { delete: jest.fn().mockResolvedValue(undefined) };
    const mal = { delete: jest.fn().mockRejectedValue(new Error('x')) };
    bucket.getFiles.mockResolvedValue([[ok, mal, ok]]);

    const r1 = await servicio.eliminarPrefijo(prefijoDeBloque(COP, BLOQUE));
    const r2 = await servicio.eliminarPrefijo(prefijoDeUnidades(COP, BLOQUE));

    expect(r1).toEqual({ eliminados: 2, fallidos: 1 });
    expect(r2).toEqual({ eliminados: 2, fallidos: 1 });
    expect(bucket.getFiles).toHaveBeenCalledWith({
      prefix: prefijoDeBloque(COP, BLOQUE),
    });
  });

  it('un fallo al LISTAR se propaga (no se tocó nada)', async () => {
    const { servicio, bucket } = montar();
    bucket.getFiles.mockRejectedValue(new Error('403'));

    await expect(
      servicio.eliminarPrefijo(prefijoDeBloque(COP, BLOQUE)),
    ).rejects.toThrow('403');
  });
});
