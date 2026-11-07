import {
  DURACION_MAXIMA_MS,
  estaEnCurso,
  formatearRangoUtc,
  franjasDe,
  horaUtc,
  horarioDeOperacion,
  MS_POR_MINUTO,
} from './reservas-horario';

describe('franjasDe', () => {
  const t = (iso: string) => new Date(iso);
  const minuto = (iso: string) => t(iso).getTime() / MS_POR_MINUTO;

  it('cubre cada minuto de [inicio, fin): el de fin no se ocupa', () => {
    const franjas = franjasDe(
      t('2026-09-01T10:00:00.000Z'),
      t('2026-09-01T10:03:00.000Z'),
    );

    expect(franjas).toEqual([
      minuto('2026-09-01T10:00:00.000Z'),
      minuto('2026-09-01T10:01:00.000Z'),
      minuto('2026-09-01T10:02:00.000Z'),
    ]);
  });

  it('dos reservas contiguas (una termina cuando empieza la otra) no comparten franja', () => {
    const a = franjasDe(
      t('2026-09-01T10:00:00.000Z'),
      t('2026-09-01T11:00:00.000Z'),
    );
    const b = franjasDe(
      t('2026-09-01T11:00:00.000Z'),
      t('2026-09-01T12:00:00.000Z'),
    );

    expect(a.some((f) => b.includes(f))).toBe(false);
  });

  it('dos reservas que se solapan un minuto comparten franja: eso es lo que dispara el índice único', () => {
    const a = franjasDe(
      t('2026-09-01T10:00:00.000Z'),
      t('2026-09-01T11:01:00.000Z'),
    );
    const b = franjasDe(
      t('2026-09-01T11:00:00.000Z'),
      t('2026-09-01T12:00:00.000Z'),
    );

    expect(a.filter((f) => b.includes(f))).toHaveLength(1);
  });

  it('redondea hacia fuera: un borde con segundos solo puede generar conflicto, nunca solape', () => {
    const franjas = franjasDe(
      t('2026-09-01T10:00:30.000Z'),
      t('2026-09-01T10:01:30.000Z'),
    );

    expect(franjas).toHaveLength(2);
  });

  it('el máximo permitido (24 horas) son 1440 franjas', () => {
    const inicio = t('2026-09-01T00:00:00.000Z');
    const fin = new Date(inicio.getTime() + DURACION_MAXIMA_MS);

    expect(franjasDe(inicio, fin)).toHaveLength(1440);
  });
});

describe('etiquetas horarias (UTC)', () => {
  it('horaUtc rellena con ceros', () => {
    expect(horaUtc(new Date('2026-09-01T07:05:00.000Z'))).toBe('07:05');
  });

  it('formatearRangoUtc reproduce el formato del original "HH:MM - HH:MM"', () => {
    expect(
      formatearRangoUtc(
        new Date('2026-09-01T14:00:00.000Z'),
        new Date('2026-09-01T16:30:00.000Z'),
      ),
    ).toBe('14:00 - 16:30');
  });
});

describe('estaEnCurso', () => {
  const inicio = new Date('2026-09-01T10:00:00.000Z');
  const fin = new Date('2026-09-01T12:00:00.000Z');

  it('incluye el inicio y excluye el fin', () => {
    expect(estaEnCurso(inicio, inicio, fin)).toBe(true);
    expect(estaEnCurso(new Date('2026-09-01T11:59:59.000Z'), inicio, fin)).toBe(
      true,
    );
    expect(estaEnCurso(fin, inicio, fin)).toBe(false);
    expect(estaEnCurso(new Date('2026-09-01T09:59:59.000Z'), inicio, fin)).toBe(
      false,
    );
  });
});

describe('horarioDeOperacion', () => {
  it('lee el primer rango HH:MM - HH:MM del texto libre', () => {
    expect(horarioDeOperacion('Lunes a viernes 08:00 - 20:00')).toEqual({
      inicio: '08:00',
      fin: '20:00',
    });
    expect(horarioDeOperacion('6:30-21:15')).toEqual({
      inicio: '6:30',
      fin: '21:15',
    });
  });

  it('sin rango usa 06:00 a 22:00', () => {
    expect(horarioDeOperacion('')).toEqual({ inicio: '06:00', fin: '22:00' });
    expect(horarioDeOperacion('Todo el día')).toEqual({
      inicio: '06:00',
      fin: '22:00',
    });
  });
});
