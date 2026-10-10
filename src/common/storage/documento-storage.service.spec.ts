import type { Bucket } from '@google-cloud/storage';
import { DocumentoStorageService } from './documento-storage.service';

const PREFIJO = 'documentos-generados/64b7f0c2a1d3e4f5a6b7c8d9/';

/** A bucket object whose delete resolves, or rejects when `falla` is set. */
const archivoMock = (falla = false) => ({
  delete: jest.fn(() =>
    falla ? Promise.reject(new Error('403')) : Promise.resolve([{}]),
  ),
});

/** Hand-rolled bucket exposing only `getFiles`, plus the bare mock so the
 *  tests can assert on it without reading a method off the typed `Bucket`. */
const makeBucket = (archivos: ReturnType<typeof archivoMock>[]) => {
  const getFiles = jest.fn(() => Promise.resolve([archivos]));
  return { bucket: { getFiles } as unknown as Bucket, getFiles };
};

describe('DocumentoStorageService.eliminarPrefijo', () => {
  it('lista por prefijo, borra cada objeto y cuenta los que se borraron', async () => {
    const archivos = [archivoMock(), archivoMock(), archivoMock()];
    const { bucket, getFiles } = makeBucket(archivos);
    const service = new DocumentoStorageService(bucket);

    const resultado = await service.eliminarPrefijo(PREFIJO);

    expect(getFiles).toHaveBeenCalledWith({ prefix: PREFIJO });
    for (const archivo of archivos) {
      expect(archivo.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
    }
    expect(resultado).toEqual({ eliminados: 3, fallidos: 0 });
  });

  it('con un prefijo sin objetos devuelve 0 y 0', async () => {
    const { bucket } = makeBucket([]);
    const service = new DocumentoStorageService(bucket);

    await expect(service.eliminarPrefijo(PREFIJO)).resolves.toEqual({
      eliminados: 0,
      fallidos: 0,
    });
  });

  it('cuenta los éxitos reales: un borrado que falla no oculta los que sí se hicieron', async () => {
    const archivos = [
      archivoMock(),
      archivoMock(true),
      archivoMock(),
      archivoMock(true),
      archivoMock(),
    ];
    const { bucket } = makeBucket(archivos);
    const service = new DocumentoStorageService(bucket);

    await expect(service.eliminarPrefijo(PREFIJO)).resolves.toEqual({
      eliminados: 3,
      fallidos: 2,
    });
    // Un fallo no corta el resto: todos se intentaron.
    for (const archivo of archivos) {
      expect(archivo.delete).toHaveBeenCalledTimes(1);
    }
  });

  it('borra con concurrencia acotada, no todo a la vez', async () => {
    let enVuelo = 0;
    let maximo = 0;
    const archivos = Array.from({ length: 35 }, () => ({
      delete: jest.fn(async () => {
        enVuelo++;
        maximo = Math.max(maximo, enVuelo);
        await new Promise((resolver) => setTimeout(resolver, 1));
        enVuelo--;
        return [{}];
      }),
    }));
    const { bucket } = makeBucket(archivos);
    const service = new DocumentoStorageService(bucket);

    const resultado = await service.eliminarPrefijo(PREFIJO);

    expect(resultado.eliminados).toBe(35);
    expect(maximo).toBeLessThanOrEqual(10);
  });

  it.each([
    ['vacío', ''],
    ['solo "/"', '/'],
    ['la carpeta sin id', 'documentos-generados/'],
    ['un id corto', 'documentos-generados/64b7f0/'],
    ['un id sin barra final', 'documentos-generados/64b7f0c2a1d3e4f5a6b7c8d9'],
    ['un id con mayúsculas', 'documentos-generados/64B7F0C2A1D3E4F5A6B7C8D9/'],
    ['una subcarpeta', `${PREFIJO}FV/`],
    ['otra carpeta', 'otra-carpeta/64b7f0c2a1d3e4f5a6b7c8d9/'],
  ])('rechaza un prefijo %s sin tocar el bucket', async (_nombre, prefijo) => {
    const { bucket, getFiles } = makeBucket([archivoMock()]);
    const service = new DocumentoStorageService(bucket);

    await expect(service.eliminarPrefijo(prefijo)).rejects.toThrow();
    expect(getFiles).not.toHaveBeenCalled();
  });

  it('propaga el error si el bucket falla al listar', async () => {
    const bucket = {
      getFiles: jest.fn(() => Promise.reject(new Error('sin permiso'))),
    } as unknown as Bucket;
    const service = new DocumentoStorageService(bucket);

    await expect(service.eliminarPrefijo(PREFIJO)).rejects.toThrow(
      'sin permiso',
    );
  });
});
