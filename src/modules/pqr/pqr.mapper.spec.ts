import { Types } from 'mongoose';
import type { PqrDocument } from '../../database/schemas/administracion/pqr.schema';
import {
  desdeCrearDto,
  desdePortalDto,
  normalizarPrioridad,
  toPqr,
  toPqrPortal,
} from './pqr.mapper';

const COPROPIEDAD = new Types.ObjectId();
const AUTOR = new Types.ObjectId();

const pqrDoc = (extra: Record<string, unknown> = {}): PqrDocument =>
  ({
    _id: new Types.ObjectId(),
    copropiedadId: COPROPIEDAD,
    autorId: AUTOR,
    codigo: 'PQR-001',
    titulo: 'Filtración',
    descripcion: 'Resumen',
    descripcionCompleta: 'Detalle',
    categoria: 'Mantenimiento',
    tipo: 'reclamos',
    estado: 'pendiente',
    prioridad: 'normal',
    unidad: 'A-101',
    residente: { nombre: 'Juan Pérez', rol: 'Propietario' },
    archivosAdjuntos: [],
    seguimientos: [],
    tecnicoId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  }) as unknown as PqrDocument;

describe('toPqr', () => {
  it('traduce el documento al contrato sin renombrar valores', () => {
    const contrato = toPqr(pqrDoc());

    expect(contrato).toMatchObject({
      codigo: 'PQR-001',
      titulo: 'Filtración',
      descripcion: 'Resumen',
      descripcionCompleta: 'Detalle',
      categoria: 'Mantenimiento',
      tipo: 'reclamos',
      estado: 'radicada',
      prioridad: 'normal',
      unidad: 'A-101',
      fechaCreacion: '2026-01-01T00:00:00.000Z',
      residente: { nombre: 'Juan Pérez', iniciales: 'JP', rol: 'Propietario' },
      tecnicoAsignado: null,
    });
  });

  it('nunca expone autorId ni la ruta interna de almacenamiento', () => {
    const contrato = toPqr(
      pqrDoc({
        archivosAdjuntos: [
          {
            _id: new Types.ObjectId(),
            tipo: 'pdf',
            nombre: 'a.pdf',
            url: null,
            rutaAlmacenamiento: 'pqrs/x/y/secreto.pdf',
            estado: 'pendiente',
          },
        ],
      }),
    );

    const serializado = JSON.stringify(contrato);
    expect(serializado).not.toContain(AUTOR.toString());
    expect(serializado).not.toContain('secreto.pdf');
    expect(contrato.archivosAdjuntos[0]).toEqual({
      id: expect.any(String) as string,
      tipo: 'pdf',
      nombre: 'a.pdf',
      url: null,
      estado: 'pendiente',
    });
  });

  it('mapea los seguimientos con id, autor, mensaje y fecha ISO', () => {
    const id = new Types.ObjectId();
    const contrato = toPqr(
      pqrDoc({
        seguimientos: [
          {
            _id: id,
            autor: 'Ana',
            mensaje: 'Enviamos un técnico',
            fecha: new Date('2026-01-02T10:00:00Z'),
          },
        ],
      }),
    );

    expect(contrato.seguimientos).toEqual([
      {
        id: id.toString(),
        autor: 'Ana',
        mensaje: 'Enviamos un técnico',
        fecha: '2026-01-02T10:00:00.000Z',
      },
    ]);
  });

  it('el técnico poblado sale como su nombre; un ObjectId sin poblar, como null', () => {
    expect(
      toPqr(
        pqrDoc({ tecnicoId: { _id: new Types.ObjectId(), nombre: 'Luis' } }),
      ).tecnicoAsignado,
    ).toBe('Luis');
    expect(
      toPqr(pqrDoc({ tecnicoId: new Types.ObjectId() })).tecnicoAsignado,
    ).toBeNull();
  });
});

describe('toPqr (etapas)', () => {
  it('un estado legado sale siempre como su etapa', () => {
    expect(toPqr(pqrDoc({ estado: 'resuelto' })).estado).toBe('cerrada');
    expect(toPqr(pqrDoc({ estado: 'urgente' })).estado).toBe('en_gestion');
  });

  it('un estado legado urgente se lee con prioridad alta', () => {
    expect(
      toPqr(pqrDoc({ estado: 'urgente', prioridad: 'normal' })).prioridad,
    ).toBe('alta');
  });

  it('la fecha límite sugerida cuenta 15 días hábiles desde la radicación', () => {
    const contrato = toPqr(
      pqrDoc({ createdAt: new Date('2026-11-17T15:00:00Z') }),
    );
    expect(contrato.fechaLimiteSugerida).toBe('2026-12-09');
    expect(contrato.fechaLimite).toBeNull();
    expect(contrato.vencida).toBe(false);
  });

  it('vencida solo pasado el día límite y si sigue abierta', () => {
    const doc = pqrDoc({
      estado: 'en_gestion',
      fechaLimite: new Date('2026-12-09T00:00:00Z'),
    });
    expect(toPqr(doc, new Date('2026-12-09T00:00:00Z')).vencida).toBe(false);
    expect(toPqr(doc, new Date('2026-12-10T00:00:00Z')).vencida).toBe(true);
    expect(toPqr(doc, new Date('2026-12-10T00:00:00Z')).fechaLimite).toBe(
      '2026-12-09',
    );
  });

  it('mapea la bitácora', () => {
    const contrato = toPqr(
      pqrDoc({
        bitacora: [
          {
            fecha: new Date('2026-01-02T10:00:00Z'),
            tipo: 'radicada',
            actor: 'Ana',
            accountId: AUTOR,
            detalle: 'Radicada por Ana',
          },
        ],
      }),
    );
    expect(contrato.bitacora).toEqual([
      {
        fecha: '2026-01-02T10:00:00.000Z',
        tipo: 'radicada',
        actor: 'Ana',
        detalle: 'Radicada por Ana',
      },
    ]);
  });
});

describe('toPqrPortal', () => {
  it('no trae como claves lo interno de la gestión', () => {
    const claves = Object.keys(toPqrPortal(pqrDoc()));
    for (const interna of [
      'responsable',
      'fechaLimite',
      'fechaLimiteSugerida',
      'vencida',
      'bitacora',
    ]) {
      expect(claves).not.toContain(interna);
    }
    expect(claves).toContain('estado');
  });
});

describe('normalizarPrioridad', () => {
  it('urgente (un estado, no una prioridad) se normaliza a alta', () => {
    expect(normalizarPrioridad('urgente')).toBe('alta');
  });

  it('deja pasar las prioridades reales y undefined', () => {
    expect(normalizarPrioridad('baja')).toBe('baja');
    expect(normalizarPrioridad(undefined)).toBeUndefined();
  });
});

describe('desdeCrearDto (personal)', () => {
  const base = { titulo: 'T', descripcion: 'D', tipo: 'quejas' as const };

  const creador = { nombre: 'Ana Gómez' };

  it('sin autor, radicada y prioridad normal por defecto, con su entrada en la bitácora', () => {
    const campos = desdeCrearDto(base, COPROPIEDAD, creador);
    expect(campos.bitacora).toHaveLength(1);
    expect(campos.bitacora[0]).toMatchObject({
      tipo: 'radicada',
      actor: 'Ana Gómez',
      detalle: 'Registrada por Ana Gómez a nombre de un residente',
    });
    expect(campos).toMatchObject({
      copropiedadId: COPROPIEDAD,
      autorId: null,
      estado: 'radicada',
      prioridad: 'normal',
      descripcionCompleta: 'D',
      categoria: '',
      unidad: '',
      residente: { nombre: '', rol: '' },
    });
  });

  it('respeta lo que el personal escribe sobre el reportante y normaliza urgente', () => {
    expect(
      desdeCrearDto(
        {
          ...base,
          estado: 'en_revision', // se ignora
          prioridad: 'urgente',
          unidad: ' B-2 ',
          residenteNombre: ' Marta ',
          residenteRol: 'Arrendatario',
        },
        COPROPIEDAD,
        creador,
      ),
    ).toMatchObject({
      estado: 'radicada',
      prioridad: 'alta',
      unidad: 'B-2',
      residente: { nombre: 'Marta', rol: 'Arrendatario' },
    });
  });
});

describe('desdePortalDto (residente)', () => {
  const reportante = {
    autorId: AUTOR,
    unidad: 'A-101',
    nombre: 'Juan Pérez',
    rol: 'Propietario',
  };

  it('toma autor, unidad, nombre y rol del reportante verificado y arranca radicada', () => {
    expect(
      desdePortalDto(
        { titulo: 'T', descripcion: 'D', tipo: 'peticiones' },
        COPROPIEDAD,
        reportante,
      ),
    ).toMatchObject({
      copropiedadId: COPROPIEDAD,
      autorId: AUTOR,
      estado: 'radicada',
      prioridad: 'normal',
      unidad: 'A-101',
      residente: { nombre: 'Juan Pérez', rol: 'Propietario' },
    });
  });

  it('deja la entrada de radicación en la bitácora', () => {
    const { bitacora } = desdePortalDto(
      { titulo: 'T', descripcion: 'D', tipo: 'peticiones' },
      COPROPIEDAD,
      reportante,
    );
    expect(bitacora).toHaveLength(1);
    expect(bitacora[0]).toMatchObject({
      tipo: 'radicada',
      actor: 'Juan Pérez',
      detalle: 'Radicada por Juan Pérez',
    });
  });

  it('ignora cualquier otra unidad que traiga el cuerpo', () => {
    const campos = desdePortalDto(
      { titulo: 'T', descripcion: 'D', tipo: 'peticiones', unidad: 'Z-999' },
      COPROPIEDAD,
      reportante,
    );

    expect(campos.unidad).toBe('A-101');
  });
});
