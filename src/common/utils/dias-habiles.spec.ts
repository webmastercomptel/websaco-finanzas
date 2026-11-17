import {
  DIAS_HABILES_RESPUESTA_PQR,
  diaBogota,
  esDiaHabil,
  fechaLimiteSugerida,
  festivosColombia,
  sumarDiasHabiles,
} from './dias-habiles';

describe('dias-habiles', () => {
  describe('festivosColombia', () => {
    it('calcula los festivos de 2026', () => {
      expect(festivosColombia(2026)).toEqual([
        '2026-01-01',
        '2026-01-12',
        '2026-03-23',
        '2026-04-02',
        '2026-04-03',
        '2026-05-01',
        '2026-05-18',
        '2026-06-08',
        '2026-06-15',
        '2026-06-29',
        '2026-07-20',
        '2026-08-07',
        '2026-08-17',
        '2026-10-12',
        '2026-11-02',
        '2026-11-16',
        '2026-12-08',
        '2026-12-25',
      ]);
    });

    it('calcula festivos de 2025 sin duplicar el 30 de junio', () => {
      const f = festivosColombia(2025);
      for (const d of [
        '2025-03-24',
        '2025-04-17',
        '2025-06-02',
        '2025-06-30',
        '2025-11-17',
      ]) {
        expect(f).toContain(d);
      }
      expect(f.filter((d) => d === '2025-06-30')).toHaveLength(1);
      expect(new Set(f).size).toBe(f.length);
    });

    it('calcula festivos de 2027', () => {
      const f = festivosColombia(2027);
      for (const d of [
        '2027-03-25',
        '2027-03-26',
        '2027-05-10',
        '2027-05-31',
        '2027-06-07',
      ]) {
        expect(f).toContain(d);
      }
    });
  });

  describe('fechaLimiteSugerida', () => {
    it('suma 15 días hábiles saltando fines de semana y festivos', () => {
      expect(DIAS_HABILES_RESPUESTA_PQR).toBe(15);
      const esperado = '2026-12-09T00:00:00.000Z';
      expect(
        fechaLimiteSugerida(new Date('2026-11-17T15:00:00Z')).toISOString(),
      ).toBe(esperado);
      expect(
        fechaLimiteSugerida(new Date('2026-11-18T03:30:00Z')).toISOString(),
      ).toBe(esperado);
    });

    it('usa el día de Bogotá para una radicación nocturna de viernes', () => {
      expect(esDiaHabil(new Date('2026-03-23T00:00:00Z'))).toBe(false);
      expect(diaBogota(new Date('2026-03-21T04:30:00Z')).toISOString()).toBe(
        '2026-03-20T00:00:00.000Z',
      );
      expect(
        fechaLimiteSugerida(new Date('2026-03-21T04:30:00Z')).getTime(),
      ).toBe(sumarDiasHabiles(new Date('2026-03-20T00:00:00Z'), 15).getTime());
    });
  });
});
