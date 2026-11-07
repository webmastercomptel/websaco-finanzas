import { Types } from 'mongoose';
import type { PqrDocument } from '../../database/schemas/administracion/pqr.schema';
import {
  desdeCrearDto,
  desdePortalDto,
  normalizarPrioridad,
  toPqr,
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
      estado: 'pendiente',
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

  it('sin autor, con estado pendiente y prioridad normal por defecto', () => {
    expect(desdeCrearDto(base, COPROPIEDAD)).toMatchObject({
      copropiedadId: COPROPIEDAD,
      autorId: null,
      estado: 'pendiente',
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
          estado: 'en_revision',
          prioridad: 'urgente',
          unidad: ' B-2 ',
          residenteNombre: ' Marta ',
          residenteRol: 'Arrendatario',
        },
        COPROPIEDAD,
      ),
    ).toMatchObject({
      estado: 'en_revision',
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

  it('toma autor, unidad, nombre y rol del reportante verificado y arranca pendiente', () => {
    expect(
      desdePortalDto(
        { titulo: 'T', descripcion: 'D', tipo: 'peticiones' },
        COPROPIEDAD,
        reportante,
      ),
    ).toMatchObject({
      copropiedadId: COPROPIEDAD,
      autorId: AUTOR,
      estado: 'pendiente',
      prioridad: 'normal',
      unidad: 'A-101',
      residente: { nombre: 'Juan Pérez', rol: 'Propietario' },
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
