import {
  PLAN_MIGRACION_PQR,
  actualizacionPara,
  informe,
  leerModo,
} from './migrar-estados-pqr.nucleo';

type Etapa = { $set: Record<string, unknown> };
const campos = (legado: Parameters<typeof actualizacionPara>[0]) =>
  (actualizacionPara(legado)[0] as unknown as Etapa).$set;

describe('migrar-estados-pqr.nucleo', () => {
  describe('leerModo', () => {
    it('--aplicar activa la escritura', () => {
      expect(leerModo(['--aplicar'])).toEqual({ aplicar: true });
    });

    it('sin banderas es solo lectura y --env= se ignora', () => {
      expect(leerModo(['--env=dev'])).toEqual({ aplicar: false });
    });

    it('una bandera desconocida lanza', () => {
      expect(() => leerModo(['--foo'])).toThrow('Opción desconocida: --foo');
    });
  });

  describe('actualizacionPara', () => {
    it('urgente pasa a en_gestion con prioridad alta', () => {
      const set = campos('urgente');
      expect(set.estado).toBe('en_gestion');
      expect(set.prioridad).toBe('alta');
    });

    it('resuelto cierra y conserva cerradaEn si ya existía', () => {
      const set = campos('resuelto');
      expect(set.estado).toBe('cerrada');
      expect(set.cerradaEn).toEqual({ $ifNull: ['$cerradaEn', '$updatedAt'] });
    });

    it('pendiente no toca cerradaEn ni prioridad', () => {
      const set = campos('pendiente');
      expect(set.estado).toBe('radicada');
      expect(set).not.toHaveProperty('cerradaEn');
      expect(set).not.toHaveProperty('prioridad');
    });

    it('agrega a la bitácora una entrada migrada con la etiqueta anterior', () => {
      const set = campos('en_revision') as unknown as {
        bitacora: { $concatArrays: [unknown, Array<Record<string, unknown>>] };
      };
      const entrada = set.bitacora.$concatArrays[1][0];
      expect(entrada).toMatchObject({
        tipo: 'migrada',
        actor: 'Sistema',
        accountId: null,
        detalle: 'Estado anterior: «En revisión»',
      });
    });

    it('el plan cubre las cinco etiquetas', () => {
      expect(
        Object.values(PLAN_MIGRACION_PQR).map((p) => p.etiquetaAnterior),
      ).toEqual(['Pendiente', 'En revisión', 'Urgente', 'Resuelto', 'Cerrado']);
    });
  });

  describe('informe', () => {
    it('en lectura indica lo pendiente', () => {
      expect(informe({ urgente: 2 }, false)).toContain(
        'Pendientes de convertir: 2',
      );
    });

    it('sin pendientes lo dice', () => {
      expect(informe({}, false)).toContain('No hay PQRS');
    });

    it('al aplicar informa lo convertido', () => {
      expect(informe({ resuelto: 3 }, true)).toContain('Convertidas: 3');
    });
  });
});
