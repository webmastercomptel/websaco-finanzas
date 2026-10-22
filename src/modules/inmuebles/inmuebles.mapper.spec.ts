import { parseEmails } from '../../common/utils/email.utils';
import { toFilaExportacion } from './inmuebles.mapper';

/** The 25 import columns, in the order the import template reads them. */
const COLUMNAS = [
  'codigoCopropiedad',
  'codigo',
  'referencia',
  'bloque',
  'zona',
  'uso',
  'area',
  'coeficiente',
  'tipoTitular',
  'resideEnElInmueble',
  'estadoCartera',
  'contacto',
  'observaciones',
  'nom1Titular',
  'nom2Titular',
  'ape1Titular',
  'ape2Titular',
  'razonSocialTitular',
  'tipoIdentificacionTitular',
  'numeroIdentificacionTitular',
  'digitoVerificacionTitular',
  'emailTitular',
  'telefonoTitular',
  'direccionTitular',
  'ciudadTitular',
];

const unidadCompleta = {
  codigo: 'Torre A-301',
  referencia: 'REF-1',
  bloque: 'A',
  zona: 'Norte',
  uso: 'Vivienda',
  area: 55.5,
  coeficiente: 0.25,
  tipoTitular: 'arrendatario' as const,
  resideEnElInmueble: true,
  estadoCartera: 'juridico' as const,
  contacto: 'Portería',
  observaciones: 'Esquinero',
};

describe('toFilaExportacion', () => {
  it('trae exactamente las 25 columnas del import, en su orden', () => {
    const fila = toFilaExportacion('0001', unidadCompleta, null);

    expect(Object.keys(fila)).toEqual(COLUMNAS);
    expect(COLUMNAS).toHaveLength(25);
  });

  it('repite el código de la copropiedad en cada fila y copia los valores de la unidad tal cual', () => {
    const fila = toFilaExportacion('0001', unidadCompleta, null);

    expect(fila).toMatchObject({
      codigoCopropiedad: '0001',
      ...unidadCompleta,
    });
  });

  it('un valor ausente sale como "" (los strings) y área/coeficiente quedan "" sin inventar un 0', () => {
    const fila = toFilaExportacion('0001', { codigo: '301' });

    expect(fila).toMatchObject({
      referencia: '',
      bloque: '',
      zona: '',
      uso: '',
      area: '',
      coeficiente: '',
      contacto: '',
      observaciones: '',
    });
  });

  it('un área o coeficiente de 0 sigue siendo el número 0, no ""', () => {
    const fila = toFilaExportacion('0001', {
      codigo: '301',
      area: 0,
      coeficiente: 0,
    });

    expect(fila.area).toBe(0);
    expect(fila.coeficiente).toBe(0);
  });

  it('un titular persona natural llena sus columnas, con el código DIAN y el código DANE (no nombres)', () => {
    const fila = toFilaExportacion('0001', unidadCompleta, {
      primerNombre: 'Ana',
      segundoNombre: 'María',
      primerApellido: 'Pérez',
      segundoApellido: 'Gómez',
      razonSocial: null,
      tipoIdentificacion: '13',
      numeroIdentificacion: '123456',
      digitoVerificacion: null,
      emails: ['ana@ejemplo.com'],
      telefono: '3000000000',
      direccion: 'Calle 10 # 20-30',
      ciudadCodigo: '05001',
    });

    expect(fila).toMatchObject({
      nom1Titular: 'Ana',
      nom2Titular: 'María',
      ape1Titular: 'Pérez',
      ape2Titular: 'Gómez',
      razonSocialTitular: '',
      tipoIdentificacionTitular: '13',
      numeroIdentificacionTitular: '123456',
      digitoVerificacionTitular: '',
      emailTitular: 'ana@ejemplo.com',
      telefonoTitular: '3000000000',
      direccionTitular: 'Calle 10 # 20-30',
      ciudadTitular: '05001',
    });
  });

  it('un titular persona jurídica llena razón social y dígito de verificación, y deja los nombres en ""', () => {
    const fila = toFilaExportacion('0001', unidadCompleta, {
      primerNombre: null,
      segundoNombre: null,
      primerApellido: null,
      segundoApellido: null,
      razonSocial: 'Ferretería SAS',
      tipoIdentificacion: '31',
      numeroIdentificacion: '900123456',
      digitoVerificacion: '7',
      emails: [],
      telefono: null,
      direccion: null,
      ciudadCodigo: null,
    });

    expect(fila).toMatchObject({
      nom1Titular: '',
      ape1Titular: '',
      razonSocialTitular: 'Ferretería SAS',
      tipoIdentificacionTitular: '31',
      digitoVerificacionTitular: '7',
      emailTitular: '',
      telefonoTitular: '',
      direccionTitular: '',
      ciudadTitular: '',
    });
  });

  it('sin titular todas las columnas del titular salen ""', () => {
    const fila = toFilaExportacion('0001', unidadCompleta, undefined);

    const titulares = COLUMNAS.filter(
      (c) => c.endsWith('Titular') && c !== 'tipoTitular',
    );
    expect(titulares).toHaveLength(12);
    for (const columna of titulares) {
      expect(fila[columna as keyof typeof fila]).toBe('');
    }
  });

  it('varios emails ida y vuelta: lo exportado se vuelve a leer igual con parseEmails del import', () => {
    const emails = ['ana@ejemplo.com', 'gestor@ejemplo.com', 'otro@ejemplo.co'];

    const fila = toFilaExportacion('0001', unidadCompleta, { emails });

    expect(parseEmails(fila.emailTitular)).toEqual(emails);
  });
});
