import { generarPdfInformeGestion } from './informe-gestion-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

const copropiedad = {
  nombre: 'Conjunto Demo',
  nit: '900123456',
  digitoVerificacion: '7',
} as unknown as CopropiedadDocument;

const periodo = { desde: '2026-01-01', hasta: '2026-03-31' };

describe('generarPdfInformeGestion', () => {
  it('renderiza las tres secciones con filas', async () => {
    const buf = await generarPdfInformeGestion(copropiedad, periodo, {
      actividades: [
        {
          fecha: new Date('2026-02-10T00:00:00Z'),
          titulo: 'Bingo',
          categoria: 'integracion',
          estado: 'finalizado',
          inscritos: 12,
        },
      ],
      mantenimientos: [
        {
          fecha: new Date('2026-01-15T00:00:00Z'),
          titulo: 'Revisión ascensor',
          tipo: 'preventivo',
          equipo: null,
          responsable: null,
          estado: 'completado',
          costoEstimado: null,
          equipoId: null,
        },
      ],
      pqr: [
        {
          fecha: new Date('2026-03-01T04:30:00Z'),
          codigo: 'PQR-1',
          unidad: 'Apto 101',
          tipo: 'quejas',
          prioridad: 'alta',
          estado: 'pendiente',
        },
      ],
    });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('renderiza solo pqr con lista vacía', async () => {
    const buf = await generarPdfInformeGestion(copropiedad, periodo, {
      pqr: [],
    });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('pagina 300 mantenimientos', async () => {
    const filas = Array.from({ length: 300 }, (_, i) => ({
      fecha: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
      titulo: `Mantenimiento ${i}`,
      tipo: 'correctivo',
      equipo: 'Bomba',
      responsable: 'Proveedor',
      estado: 'programado',
      costoEstimado: 1500000,
      equipoId: 'e1',
    }));
    const buf = await generarPdfInformeGestion(copropiedad, periodo, {
      mantenimientos: filas,
    });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
