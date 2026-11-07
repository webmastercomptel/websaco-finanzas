import { Types } from 'mongoose';
import {
  tipoDeArchivo,
  toAcl,
  toArchivo,
  toCarpeta,
  toCarpetaPortal,
} from './documentos.mapper';
import { construirCorreoDocumentoNuevo } from './documento-correo';

const ROL = new Types.ObjectId();

const carpetaDoc = (extra: Record<string, unknown> = {}) =>
  ({
    _id: new Types.ObjectId(),
    carpetaPadreId: null,
    slug: 'actas',
    nombre: 'Actas',
    descripcion: 'Actas de asamblea',
    icono: 'folder',
    color: '#111',
    acls: [
      { tipo: 'rol', rolId: ROL, puedeLeer: true, puedeEscribir: true },
      {
        tipo: 'residentes',
        rol: 'propietario',
        puedeLeer: true,
        puedeEscribir: false,
      },
    ],
    ...extra,
  }) as never;

const stats = {
  archivos: 2,
  tamanoBytes: 30,
  actualizado: '2026-01-01T00:00:00.000Z',
};

describe('tipoDeArchivo', () => {
  it.each([
    ['application/pdf', 'x', 'pdf'],
    ['application/msword', 'x', 'docx'],
    ['application/vnd.ms-excel', 'x', 'xlsx'],
    ['image/png', 'x', 'png'],
    ['image/jpeg', 'x', 'jpg'],
    ['application/octet-stream', 'Balance.XLSX', 'xlsx'],
    ['application/octet-stream', 'foto.jpeg', 'jpg'],
    ['application/octet-stream', 'sin-extension', 'otro'],
    ['application/zip', 'x.pdf', 'otro'],
  ])('%s + %s -> %s', (mime, nombre, esperado) => {
    expect(tipoDeArchivo(mime, nombre)).toBe(esperado);
  });
});

describe('toAcl', () => {
  it('una regla de rol sale con el id como string', () => {
    expect(
      toAcl({ tipo: 'rol', rolId: ROL, puedeLeer: true, puedeEscribir: true }),
    ).toEqual({
      tipo: 'rol',
      rolId: ROL.toString(),
      puedeLeer: true,
      puedeEscribir: true,
    });
  });

  it('una regla de residentes nunca sale con escritura, aunque el dato guardado la tenga', () => {
    expect(
      toAcl({
        tipo: 'residentes',
        rol: 'arrendatario',
        puedeLeer: true,
        puedeEscribir: true,
      }),
    ).toEqual({
      tipo: 'residentes',
      rol: 'arrendatario',
      puedeLeer: true,
      puedeEscribir: false,
    });
  });
});

describe('toCarpeta / toCarpetaPortal', () => {
  const permisos = {
    puedeLeer: true,
    puedeEscribir: false,
    puedeAdministrar: false,
  };

  it('la vista del personal incluye reglas, permisos y herencia', () => {
    const res = toCarpeta(carpetaDoc(), stats, permisos);
    expect(res.acls).toHaveLength(2);
    expect(res.permisos).toEqual(permisos);
    expect(res).toMatchObject({
      heredaDe: null,
      permisosHeredados: [],
      archivos: 2,
    });
  });

  it('la vista del residente NO incluye reglas, ids de rol, permisos ni herencia', () => {
    const res = toCarpetaPortal(carpetaDoc(), stats);
    expect(res).not.toHaveProperty('acls');
    expect(res).not.toHaveProperty('permisos');
    expect(res).not.toHaveProperty('heredaDe');
    expect(res).not.toHaveProperty('permisosHeredados');
    expect(JSON.stringify(res)).not.toContain(ROL.toString());
    expect(res).toMatchObject({ slug: 'actas', archivos: 2, tamanoBytes: 30 });
  });
});

describe('toArchivo', () => {
  const doc = (extra: Record<string, unknown> = {}) =>
    ({
      _id: new Types.ObjectId(),
      codigo: 'DOC-009',
      nombre: 'Acta.pdf',
      tipo: 'pdf',
      categoria: 'Legal',
      tamanoBytes: 10,
      autorNombre: 'Ana',
      destacado: true,
      etiquetas: ['a'],
      rutaAlmacenamiento: 'documentos-administracion/c/x',
      estado: 'listo',
      updatedAt: new Date('2026-04-01T00:00:00Z'),
      ...extra,
    }) as never;

  it('mapea al contrato en español', () => {
    expect(toArchivo(doc(), 'actas', 'Actas')).toMatchObject({
      codigo: 'DOC-009',
      nombre: 'Acta.pdf',
      carpeta: 'actas',
      ubicacion: 'Actas',
      tamanoBytes: 10,
      autor: 'Ana',
      destacado: true,
      etiquetas: ['a'],
      tieneArchivo: true,
      modificado: '2026-04-01T00:00:00.000Z',
    });
  });

  it('un archivo pendiente no tiene archivo todavía', () => {
    expect(toArchivo(doc({ estado: 'pendiente' }), 's', '').tieneArchivo).toBe(
      false,
    );
  });

  it('no expone la ruta de almacenamiento', () => {
    expect(JSON.stringify(toArchivo(doc(), 's', ''))).not.toContain(
      'documentos-administracion',
    );
  });
});

describe('construirCorreoDocumentoNuevo', () => {
  const datos = {
    nombreDestinatario: 'Luis',
    nombreCopropiedad: 'Torres',
    nombreDocumento: 'Reglamento.pdf',
    carpetaRuta: 'Legal / 2026',
    autor: 'Ana',
    enlace: 'https://app/enlace',
  };

  it('arma asunto, carpeta, autor y botón', () => {
    const { asunto, html } = construirCorreoDocumentoNuevo(datos);
    expect(asunto).toBe('Nuevo documento en Torres: Reglamento.pdf');
    expect(html).toContain('Legal / 2026');
    expect(html).toContain('(por Ana)');
    expect(html).toContain('https://app/enlace');
    expect(html).toContain('Ver el documento');
  });

  it('sin enlace no hay botón', () => {
    const { html } = construirCorreoDocumentoNuevo({ ...datos, enlace: null });
    expect(html).not.toContain('Ver el documento');
  });

  it('escapa todo texto escrito por usuarios', () => {
    const { html } = construirCorreoDocumentoNuevo({
      ...datos,
      nombreDocumento: '<img src=x onerror=alert(1)>',
      carpetaRuta: '<b>x</b>',
      autor: '<script>',
      nombreDestinatario: '<i>Luis</i>',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<i>Luis</i>');
  });
});
