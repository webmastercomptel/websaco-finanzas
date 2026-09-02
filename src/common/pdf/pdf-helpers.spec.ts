import {
  crearContexto,
  escribirLinea,
  escribirLabelValor,
  escribirTabla,
  escribirMarcaDuplicado,
  escribirEncabezado,
  formatoPeso,
  formatoFecha,
} from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

function makeCopropiedad(
  overrides?: Partial<CopropiedadDocument>,
): CopropiedadDocument {
  return {
    code: 'COP-001',
    name: 'Conjunto Residencial Prueba',
    taxId: '900123456',
    taxIdVerificationDigit: '7',
    address: 'Cra 10 # 5-20',
    city: 'Bogotá',
    phone: '6012345678',
    email: 'admin@prueba.com',
    status: 'active',
    usesBuildingManagement: false,
    managingEntityId: null,
    administratorName: null,
    receivablesAccount: null,
    advancesAccount: null,
    creditNotesAccount: null,
    debitNotesAccount: null,
    ...overrides,
  } as CopropiedadDocument;
}

describe('pdf-helpers', () => {
  describe('crearContexto', () => {
    it('crea un contexto con PDF válido, página y fuentes', async () => {
      const ctx = await crearContexto();

      expect(ctx.doc).toBeDefined();
      expect(ctx.page).toBeDefined();
      expect(ctx.font).toBeDefined();
      expect(ctx.fontBold).toBeDefined();
      expect(ctx.y).toBeGreaterThan(0);
    });

    it('genera un PDF empezando con %PDF-', async () => {
      const ctx = await crearContexto();
      const bytes = await ctx.doc.save();

      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(0);
      const header = Buffer.from(bytes.slice(0, 5)).toString('utf-8');
      expect(header).toBe('%PDF-');
    });
  });

  describe('escribirLinea', () => {
    it('escribe texto sin lanzar errores', async () => {
      const ctx = await crearContexto();
      const yBefore = ctx.y;

      escribirLinea(ctx, 'Hola mundo');

      expect(ctx.y).toBeLessThan(yBefore);
    });

    it('acepta texto vacío', async () => {
      const ctx = await crearContexto();
      expect(() => escribirLinea(ctx, '')).not.toThrow();
    });

    it('acepta texto muy largo', async () => {
      const ctx = await crearContexto();
      const textoLargo = 'A'.repeat(200);
      expect(() => escribirLinea(ctx, textoLargo)).not.toThrow();
    });

    it('usa fontBold cuando bold es true', async () => {
      const ctx = await crearContexto();
      expect(() => escribirLinea(ctx, 'Negrita', { bold: true })).not.toThrow();
    });

    it('acepta un tamaño de fuente personalizado', async () => {
      const ctx = await crearContexto();
      expect(() => escribirLinea(ctx, 'Grande', { size: 16 })).not.toThrow();
    });
  });

  describe('escribirLabelValor', () => {
    it('escribe label y valor en la misma línea cuando caben', async () => {
      const ctx = await crearContexto();
      const yBefore = ctx.y;

      escribirLabelValor(ctx, 'Número:', 'FAC-001');

      expect(ctx.y).toBeLessThan(yBefore);
    });

    it('escribe label y valor en líneas separadas cuando no caben', async () => {
      const ctx = await crearContexto();
      const labelLargo = 'Etiqueta muy larga que ocupa mucho espacio:';
      const valorLargo =
        'Y un valor igualmente largo que no cabe junto al label';

      // Should not throw — wraps to next line
      expect(() =>
        escribirLabelValor(ctx, labelLargo, valorLargo),
      ).not.toThrow();
    });

    it('acepta valor vacío', async () => {
      const ctx = await crearContexto();
      expect(() => escribirLabelValor(ctx, 'Campo:', '')).not.toThrow();
    });
  });

  describe('escribirTabla', () => {
    it('escribe encabezados y filas sin errores', async () => {
      const ctx = await crearContexto();
      const columnas = ['Concepto', 'Base', 'Total'];
      const filas = [
        ['Administración', '$ 100.000', '$ 100.000'],
        ['Agua', '$ 50.000', '$ 50.000'],
      ];

      expect(() => escribirTabla(ctx, columnas, filas)).not.toThrow();
    });

    it('acepta tabla con filas vacías', async () => {
      const ctx = await crearContexto();
      expect(() => escribirTabla(ctx, ['A', 'B'], [])).not.toThrow();
    });

    it('acepta celdas con valores vacíos', async () => {
      const ctx = await crearContexto();
      expect(() =>
        escribirTabla(ctx, ['Concepto', 'Monto'], [['', '$ 0']]),
      ).not.toThrow();
    });
  });

  describe('escribirMarcaDuplicado', () => {
    it('escribe marca con fecha sin errores', async () => {
      const ctx = await crearContexto();
      expect(() =>
        escribirMarcaDuplicado(ctx, '2026-01-15T00:00:00.000Z'),
      ).not.toThrow();
    });

    it('escribe marca sin fecha (fallback)', async () => {
      const ctx = await crearContexto();
      expect(() => escribirMarcaDuplicado(ctx, null)).not.toThrow();
    });

    it('produce un PDF más grande con duplicado que sin él', async () => {
      const ctxSinMarca = await crearContexto();
      escribirLinea(ctxSinMarca, 'test');
      const bytesSinMarca = await ctxSinMarca.doc.save();

      const ctxConMarca = await crearContexto();
      escribirLinea(ctxConMarca, 'test');
      escribirMarcaDuplicado(ctxConMarca, '2026-01-15T00:00:00.000Z');
      const bytesConMarca = await ctxConMarca.doc.save();

      expect(bytesConMarca.length).toBeGreaterThan(bytesSinMarca.length);
    });
  });

  describe('escribirEncabezado', () => {
    it('escribe nombre, dirección, NIT, contacto y título', async () => {
      const ctx = await crearContexto();
      const copropiedad = makeCopropiedad();

      expect(() =>
        escribirEncabezado(ctx, copropiedad, 'FACTURA', 'Original'),
      ).not.toThrow();
    });

    it('acepta copropiedad con campos null', async () => {
      const ctx = await crearContexto();
      const copropiedad = makeCopropiedad({
        taxId: null,
        taxIdVerificationDigit: null,
        address: null,
        city: null,
        phone: null,
        email: null,
      });

      expect(() =>
        escribirEncabezado(ctx, copropiedad, 'RECIBO'),
      ).not.toThrow();
    });

    it('escribe sin subtítulo cuando no se provee', async () => {
      const ctx = await crearContexto();
      expect(() =>
        escribirEncabezado(ctx, makeCopropiedad(), 'NOTA DE CRÉDITO'),
      ).not.toThrow();
    });
  });

  describe('formatoPeso', () => {
    it('formatea número como pesos colombianos', () => {
      expect(formatoPeso(1234567)).toBe('$ 1.234.567');
    });

    it('maneja cero', () => {
      expect(formatoPeso(0)).toBe('$ 0');
    });
  });

  describe('formatoFecha', () => {
    it('formatea Date como dd/mm/yyyy', () => {
      const resultado = formatoFecha(new Date(2026, 0, 15));
      expect(resultado).toContain('15');
      expect(resultado).toContain('2026');
    });

    it('acepta string ISO', () => {
      const resultado = formatoFecha('2026-06-01T00:00:00.000Z');
      expect(resultado).toContain('2026');
    });
  });
});
