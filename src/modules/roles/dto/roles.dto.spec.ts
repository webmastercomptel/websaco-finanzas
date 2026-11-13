import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  MAX_CLAVES_ASIGNABLES,
  PERMISOS_ADMINISTRACION,
  PERMISOS_FINANZAS,
} from '../../casl/permisos-catalogo';
import { ActualizarRolDto, CrearRolDto } from './guardar-rol.dto';

/** Same options as the global ValidationPipe in main.ts. */
const errores = async <T extends object>(
  clase: new () => T,
  plano: Record<string, unknown>,
) =>
  (
    await validate(plainToInstance(clase, plano), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

describe.each([
  ['CrearRolDto', CrearRolDto, { nombre: 'Tesorería' }],
  ['ActualizarRolDto', ActualizarRolDto, {}],
] as const)(
  '%s — límite de claves derivado del catálogo',
  (_nombre, clase, base) => {
    const claveN = (n: number) =>
      Array.from({ length: n }, (_, i) => `modulo${i}.ver`);

    it('acepta una petición con TODAS las claves ofrecidas más 17 `x.gestionar` que viajan de vuelta (S-D8.1)', async () => {
      const permisos = [
        ...PERMISOS_FINANZAS,
        ...PERMISOS_ADMINISTRACION.map((p) => p.id),
        ...Array.from({ length: 17 }, (_, i) => `legado${i}.gestionar`),
      ];
      expect(permisos.length).toBeLessThanOrEqual(MAX_CLAVES_ASIGNABLES);

      expect(await errores(clase, { ...base, permisos })).toEqual([]);
    });

    it('el tope es MAX_CLAVES_ASIGNABLES (116 hoy): ese número cabe, uno más no (S-D8.2)', async () => {
      expect(MAX_CLAVES_ASIGNABLES).toBe(116);
      expect(
        await errores(clase, {
          ...base,
          permisos: claveN(MAX_CLAVES_ASIGNABLES),
        }),
      ).toEqual([]);
      expect(
        await errores(clase, {
          ...base,
          permisos: claveN(MAX_CLAVES_ASIGNABLES + 1),
        }),
      ).toContain('permisos');
    });

    it('cada clave mide como mucho 80 caracteres, igual que en Equipo', async () => {
      expect(
        await errores(clase, { ...base, permisos: ['a'.repeat(80)] }),
      ).toEqual([]);
      expect(
        await errores(clase, { ...base, permisos: ['a'.repeat(81)] }),
      ).toContain('permisos');
    });

    it('rechaza claves que no son texto', async () => {
      expect(await errores(clase, { ...base, permisos: [1] })).toContain(
        'permisos',
      );
    });
  },
);
