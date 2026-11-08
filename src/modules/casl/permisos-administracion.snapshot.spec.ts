// Drift guard for the Administración permission catalog.
//
// The frontend keeps a hand-written mirror of `PERMISOS_ADMINISTRACION` (ids,
// names, descriptions and group headings). This spec pins the catalog to a
// committed JSON snapshot; the frontend copy is checked against the very same
// file, so the two repos cannot drift apart without a test failing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISOS_ADMINISTRACION } from './permisos-catalogo';

const RUTA_SNAPSHOT = join(__dirname, 'permisos-administracion.snapshot.json');

/** Set to regenerate the snapshot from the catalog: `ACTUALIZAR_SNAPSHOT_PERMISOS=1 npm test -- permisos-administracion.snapshot`. */
const REGENERAR = process.env.ACTUALIZAR_SNAPSHOT_PERMISOS === '1';

const serializar = (): string =>
  `${JSON.stringify(PERMISOS_ADMINISTRACION, null, 2)}\n`;

describe('permisos-administracion.snapshot.json', () => {
  if (REGENERAR) {
    it('regenera el snapshot (modo ACTUALIZAR_SNAPSHOT_PERMISOS=1)', () => {
      writeFileSync(RUTA_SNAPSHOT, serializar(), 'utf8');
      expect(existsSync(RUTA_SNAPSHOT)).toBe(true);
    });
    return;
  }

  it('coincide con PERMISOS_ADMINISTRACION (ids, nombres, descripciones y grupos, en orden)', () => {
    const ayuda =
      'El catálogo de permisos de Administración cambió y el snapshot committed ya no coincide.\n' +
      '1. Regenéralo: ACTUALIZAR_SNAPSHOT_PERMISOS=1 npm test -- permisos-administracion.snapshot\n' +
      '2. Copia src/modules/casl/permisos-administracion.snapshot.json al frontend y actualiza\n' +
      '   frontend/src/lib/permisos-administracion.ts (CATALOGO_PERMISOS_ADMINISTRACION) para que su\n' +
      '   prueba de contrato vuelva a pasar.';

    if (!existsSync(RUTA_SNAPSHOT)) {
      throw new Error(`Falta el snapshot. ${ayuda}`);
    }
    const guardado: unknown = JSON.parse(readFileSync(RUTA_SNAPSHOT, 'utf8'));

    try {
      expect(guardado).toEqual(JSON.parse(serializar()));
    } catch (error) {
      throw new Error(
        `${ayuda}\n\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  it('tiene claves únicas y cada entrada trae id, nombre, descripción y grupo', () => {
    const entradas = JSON.parse(serializar()) as Record<string, unknown>[];
    expect(new Set(entradas.map((e) => e.id)).size).toBe(entradas.length);
    for (const entrada of entradas) {
      expect(Object.keys(entrada).sort()).toEqual([
        'descripcion',
        'id',
        'modulo',
        'nombre',
      ]);
    }
  });
});
