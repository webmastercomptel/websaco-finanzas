import { Logger } from '@nestjs/common';
import {
  DocumentosAlmacenService,
  esRutaDeDocumentos,
  PREFIJO_DOCUMENTOS,
  rutaParaArchivo,
  VIGENCIA_URL_MS,
} from './documentos-almacen.service';
import { GRACIA_SUBIDAS_PENDIENTES_MS } from './documentos-huerfanos.service';

function montar() {
  const getSignedUrl = jest.fn().mockResolvedValue(['https://firmada.example']);
  const getMetadata = jest.fn().mockResolvedValue([{ size: '2048' }]);
  const borrar = jest.fn().mockResolvedValue(undefined);
  const file = jest.fn(() => ({ getSignedUrl, getMetadata, delete: borrar }));
  const getFiles = jest.fn();
  const bucket = { file, getFiles };
  return {
    servicio: new DocumentosAlmacenService(bucket as never),
    file,
    getSignedUrl,
    getMetadata,
    borrar,
    getFiles,
  };
}

const VALIDA = `${PREFIJO_DOCUMENTOS}cop-1/uuid-acta.pdf`;

describe('rutaParaArchivo', () => {
  it('cuelga del prefijo propio y de la copropiedad, y sanea el nombre', () => {
    const ruta = rutaParaArchivo('cop-1', 'Acta de Asamblea (final).pdf');
    expect(ruta.startsWith('documentos-administracion/cop-1/')).toBe(true);
    expect(ruta).toMatch(/Acta_de_Asamblea_final_\.pdf$/);
    expect(esRutaDeDocumentos(ruta)).toBe(true);
  });

  it('dos subidas del mismo nombre no comparten ruta', () => {
    expect(rutaParaArchivo('c', 'a.pdf')).not.toBe(
      rutaParaArchivo('c', 'a.pdf'),
    );
  });
});

describe('esRutaDeDocumentos', () => {
  it.each([
    ['facturas/2026/f-1.pdf', false],
    ['documentos/cop/x.pdf', false],
    ['pqrs/cop/1/a.pdf', false],
    ['zonas/cop/1/a.png', false],
    ['documentos-administracionX/a', false],
    [PREFIJO_DOCUMENTOS, false],
    ['', false],
    [VALIDA, true],
  ])('%s -> %s', (ruta, esperado) => {
    expect(esRutaDeDocumentos(ruta)).toBe(esperado);
  });
});

describe('DocumentosAlmacenService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('firma la subida fijando el tipo de contenido y la vigencia', async () => {
    const { servicio, getSignedUrl } = montar();
    await expect(
      servicio.firmarSubida(VALIDA, 'application/pdf'),
    ).resolves.toBe('https://firmada.example');
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 'v4',
        action: 'write',
        contentType: 'application/pdf',
      }),
    );
  });

  it('firma la lectura con vigencia corta', async () => {
    const { servicio, getSignedUrl } = montar();
    const antes = Date.now();
    await servicio.firmarLectura(VALIDA);
    const { expires } = (getSignedUrl.mock.calls as unknown[][])[0][0] as {
      expires: number;
    };
    expect(expires - antes).toBeLessThanOrEqual(VIGENCIA_URL_MS + 1000);
  });

  it('se niega a firmar, medir o leer fuera del prefijo', async () => {
    const { servicio, file } = montar();
    await expect(servicio.firmarLectura('facturas/x.pdf')).rejects.toThrow();
    await expect(
      servicio.firmarSubida('pqrs/x.pdf', 'application/pdf'),
    ).rejects.toThrow();
    await expect(servicio.tamanoReal('zonas/x.png')).rejects.toThrow();
    expect(file).not.toHaveBeenCalled();
  });

  it('devuelve el tamaño real del objeto subido', async () => {
    const { servicio } = montar();
    await expect(servicio.tamanoReal(VALIDA)).resolves.toBe(2048);
  });

  it('borra un objeto del prefijo', async () => {
    const { servicio, borrar, file } = montar();
    await expect(servicio.eliminar(VALIDA)).resolves.toBe(true);
    expect(file).toHaveBeenCalledWith(VALIDA);
    expect(borrar).toHaveBeenCalledTimes(1);
  });

  it('nunca borra fuera del prefijo: devuelve false sin tocar el bucket', async () => {
    const { servicio, file, borrar } = montar();
    for (const ruta of [
      'facturas/2026/f.pdf',
      'pqrs/a',
      '',
      PREFIJO_DOCUMENTOS,
    ]) {
      await expect(servicio.eliminar(ruta)).resolves.toBe(false);
    }
    expect(file).not.toHaveBeenCalled();
    expect(borrar).not.toHaveBeenCalled();
  });

  it('un fallo al borrar no lanza: devuelve false', async () => {
    const { servicio, borrar } = montar();
    borrar.mockRejectedValue(new Error('no existe'));
    await expect(servicio.eliminar(VALIDA)).resolves.toBe(false);
  });

  it('jamás lista el bucket', async () => {
    const { servicio, getFiles } = montar();
    await servicio.firmarLectura(VALIDA);
    await servicio.eliminar(VALIDA);
    expect(getFiles).not.toHaveBeenCalled();
  });
});

describe('gracia de las subidas pendientes', () => {
  it('es mayor que la vigencia de la URL firmada: nadie sigue subiendo cuando el cron borra', () => {
    expect(GRACIA_SUBIDAS_PENDIENTES_MS).toBeGreaterThan(VIGENCIA_URL_MS);
    expect(GRACIA_SUBIDAS_PENDIENTES_MS).toBe(60 * 60 * 1000);
  });
});
