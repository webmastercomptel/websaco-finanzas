import { Types } from 'mongoose';
import type { UnidadDeResidente } from '../../contracts';
import { claveCorreo } from '../../common/utils/email.utils';
import {
  construirFilasResidentes,
  direccionesDeTercero,
  filtrarFilasResidentes,
  paginarFilas,
  type CuentaParaFila,
  type EntradaFilas,
  type TerceroParaFila,
} from './residentes-correos.mapper';

const unidad = (codigo: string): UnidadDeResidente => ({
  inmuebleId: new Types.ObjectId().toString(),
  codigo,
  rol: 'propietario',
});

const tercero = (over: Partial<TerceroParaFila> = {}): TerceroParaFila => ({
  id: new Types.ObjectId().toString(),
  nombre: 'Ana Pérez',
  emails: ['ana@correo.co'],
  accountId: null,
  ...over,
});

const cuenta = (over: Partial<CuentaParaFila> = {}): CuentaParaFila => ({
  id: new Types.ObjectId().toString(),
  email: 'ana@correo.co',
  correoProbadoClave: null,
  ultimoIngresoPortalEn: null,
  ...over,
});

/** Builds the mapper input: every party gets one unit unless told otherwise. */
const entrada = (
  terceros: TerceroParaFila[],
  extra: {
    cuentas?: CuentaParaFila[];
    revocadas?: string[];
    genericos?: [string, 'correo-compartido'][];
    sinUnidad?: string[];
  } = {},
): EntradaFilas => {
  const cuentas = extra.cuentas ?? [];
  return {
    terceros,
    unidades: new Map(
      terceros
        .filter((t) => !(extra.sinUnidad ?? []).includes(t.id))
        .map((t) => [t.id, [unidad('101')]]),
    ),
    cuentasPorId: new Map(cuentas.map((c) => [c.id, c])),
    cuentasPorCorreo: new Map(cuentas.map((c) => [c.email, c])),
    revocadas: new Set(extra.revocadas ?? []),
    genericos: new Map(extra.genericos ?? []),
  };
};

const CLAVE_ANA = claveCorreo('ana@correo.co');

describe('direccionesDeTercero', () => {
  it('lista solo los correos válidos, sin repetir por mayúsculas', () => {
    const r = direccionesDeTercero([
      'Ana@Correo.co',
      'ana@correo.co',
      'sin-arroba',
      '',
      'otra@correo.co',
    ]);
    expect(r.map((d) => d.correo)).toEqual(['Ana@Correo.co', 'otra@correo.co']);
    expect(r[0].clave).toBe(CLAVE_ANA);
  });

  it('marca el valor con espacios y calcula la clave del valor recortado', () => {
    const [d] = direccionesDeTercero(['  ana@correo.co ']);
    expect(d).toMatchObject({
      correo: 'ana@correo.co',
      clave: CLAVE_ANA,
      conEspacios: true,
    });
  });
});

describe('construirFilasResidentes', () => {
  it('una fila por (tercero, correo válido), con sus unidades', () => {
    const t = tercero({ emails: ['a@x.co', 'b@x.co', 'no-es-correo'] });
    const filas = construirFilasResidentes(entrada([t]));
    expect(filas).toHaveLength(2);
    expect(filas.map((f) => f.correo)).toEqual(['a@x.co', 'b@x.co']);
    expect(filas[0]).toMatchObject({
      terceroId: t.id,
      nombre: 'Ana Pérez',
      clave: claveCorreo('a@x.co'),
      estado: 'sin-ingreso',
      ultimoIngresoEn: null,
      requiereCorreccion: false,
      motivoCorreccion: null,
    });
    expect(filas[0].unidades).toHaveLength(1);
  });

  it('S-R1.1: tres correos, uno probado, uno revocado y uno sin entrar', () => {
    const t = tercero({ emails: ['a@x.co', 'b@x.co', 'c@x.co'] });
    const entro = new Date('2026-10-01T15:00:00.000Z');
    const filas = construirFilasResidentes(
      entrada([t], {
        cuentas: [
          cuenta({
            email: 'a@x.co',
            correoProbadoClave: claveCorreo('a@x.co'),
            ultimoIngresoPortalEn: entro,
          }),
        ],
        revocadas: [claveCorreo('b@x.co')],
      }),
    );
    expect(filas.map((f) => f.estado)).toEqual([
      'ingreso',
      'revocado',
      'sin-ingreso',
    ]);
    expect(filas[0].ultimoIngresoEn).toBe(entro.toISOString());
  });

  it('un tercero sin correo no tiene fila; uno sin unidad tampoco', () => {
    const sinCorreo = tercero({ emails: [] });
    const sinUnidades = tercero({ emails: ['x@x.co'] });
    const filas = construirFilasResidentes(
      entrada([sinCorreo, sinUnidades], { sinUnidad: [sinUnidades.id] }),
    );
    expect(filas).toEqual([]);
  });

  it('una prueba para OTRA clave no cuenta como ingreso', () => {
    const t = tercero();
    const filas = construirFilasResidentes(
      entrada([t], {
        cuentas: [
          cuenta({
            correoProbadoClave: claveCorreo('otro@correo.co'),
            ultimoIngresoPortalEn: new Date(),
          }),
        ],
      }),
    );
    expect(filas[0].estado).toBe('sin-ingreso');
    expect(filas[0].ultimoIngresoEn).toBeNull();
  });

  it('heredado: vínculo antiguo cuya cuenta tiene ese correo; con prueba gana ingreso', () => {
    const c = cuenta();
    const t = tercero({ accountId: c.id });
    expect(
      construirFilasResidentes(entrada([t], { cuentas: [c] }))[0].estado,
    ).toBe('heredado');

    const probada = cuenta({
      correoProbadoClave: CLAVE_ANA,
      ultimoIngresoPortalEn: new Date(),
    });
    const t2 = tercero({ accountId: probada.id });
    expect(
      construirFilasResidentes(entrada([t2], { cuentas: [probada] }))[0].estado,
    ).toBe('ingreso');
  });

  it('revocado gana sobre ingreso y heredado', () => {
    const c = cuenta({
      correoProbadoClave: CLAVE_ANA,
      ultimoIngresoPortalEn: new Date(),
    });
    const t = tercero({ accountId: c.id });
    const filas = construirFilasResidentes(
      entrada([t], { cuentas: [c], revocadas: [CLAVE_ANA] }),
    );
    expect(filas[0].estado).toBe('revocado');
  });

  it('S-R1.2: el mismo correo en dos terceros da dos filas, ambas revocadas', () => {
    const a = tercero({ nombre: 'Ana', emails: ['gestor@x.co'] });
    const b = tercero({ nombre: 'Beto', emails: ['gestor@x.co'] });
    const filas = construirFilasResidentes(
      entrada([a, b], { revocadas: [claveCorreo('gestor@x.co')] }),
    );
    expect(filas).toHaveLength(2);
    expect(filas.map((f) => f.estado)).toEqual(['revocado', 'revocado']);
    expect(filas.map((f) => f.terceroId)).toEqual([a.id, b.id]);
  });

  it('S-R1.8: la cuenta vinculada cuyo correo ya no está en la ficha da una fila heredada', () => {
    const c = cuenta({ email: 'viejo@x.co' });
    const t = tercero({ emails: ['nuevo@x.co'], accountId: c.id });
    const filas = construirFilasResidentes(entrada([t], { cuentas: [c] }));
    expect(filas).toHaveLength(2);
    expect(filas[0]).toMatchObject({
      correo: 'nuevo@x.co',
      estado: 'sin-ingreso',
    });
    expect(filas[1]).toMatchObject({
      correo: 'viejo@x.co',
      clave: claveCorreo('viejo@x.co'),
      estado: 'heredado',
    });
  });

  it('la fila heredada huérfana también se puede ver revocada y no existe sin unidades', () => {
    const c = cuenta({ email: 'viejo@x.co' });
    const t = tercero({ emails: [], accountId: c.id });
    const revocada = construirFilasResidentes(
      entrada([t], { cuentas: [c], revocadas: [claveCorreo('viejo@x.co')] }),
    );
    expect(revocada.map((f) => f.estado)).toEqual(['revocado']);
    const sinUnidad = construirFilasResidentes(
      entrada([t], { cuentas: [c], sinUnidad: [t.id] }),
    );
    expect(sinUnidad).toEqual([]);
  });

  it('S-R1.9: un valor guardado con espacios pide corrección y conserva su clave', () => {
    const t = tercero({ emails: ['  ana@correo.co '] });
    const [fila] = construirFilasResidentes(entrada([t]));
    expect(fila.requiereCorreccion).toBe(true);
    expect(fila.motivoCorreccion).toBe('correo-con-espacios');
    expect(fila.correo).toBe('ana@correo.co');
    expect(fila.clave).toBe(CLAVE_ANA);
  });

  it('un correo compartido (regla de buzón genérico) pide corrección con su motivo', () => {
    const t = tercero({ emails: ['Portería@x.co'] });
    const [fila] = construirFilasResidentes(
      entrada([t], {
        genericos: [['portería@x.co', 'correo-compartido']],
      }),
    );
    expect(fila.requiereCorreccion).toBe(true);
    expect(fila.motivoCorreccion).toBe('correo-compartido');
  });

  it('no filtra el id de la cuenta ni el correo de otra fila', () => {
    const c = cuenta();
    const t = tercero({ accountId: c.id });
    const filas = construirFilasResidentes(entrada([t], { cuentas: [c] }));
    expect(JSON.stringify(filas)).not.toContain(c.id);
  });
});

describe('filtrarFilasResidentes y paginarFilas', () => {
  const filas = construirFilasResidentes(
    entrada([
      tercero({ nombre: 'Ana', emails: ['ana@x.co'] }),
      tercero({ nombre: 'Beto', emails: ['beto@y.co'] }),
      tercero({ nombre: 'Carla', emails: ['carla@x.co'] }),
    ]),
  );

  it('busca por nombre, correo o código de unidad, sin distinguir mayúsculas', () => {
    expect(filtrarFilasResidentes(filas, { buscar: 'BETO' })).toHaveLength(1);
    expect(filtrarFilasResidentes(filas, { buscar: '@x.co' })).toHaveLength(2);
    expect(filtrarFilasResidentes(filas, { buscar: '101' })).toHaveLength(3);
    expect(filtrarFilasResidentes(filas, { buscar: 'zzz' })).toHaveLength(0);
  });

  it('filtra por estado; todos o ausente no filtra', () => {
    expect(filtrarFilasResidentes(filas, { estado: 'revocado' })).toHaveLength(
      0,
    );
    expect(
      filtrarFilasResidentes(filas, { estado: 'sin-ingreso' }),
    ).toHaveLength(3);
    expect(filtrarFilasResidentes(filas, { estado: 'todos' })).toHaveLength(3);
    expect(filtrarFilasResidentes(filas, {})).toHaveLength(3);
  });

  it('pagina en memoria y entrega el total', () => {
    const p = paginarFilas(filas, 2, 2);
    expect(p.total).toBe(3);
    expect(p.items.map((f) => f.nombre)).toEqual(['Carla']);
    expect(p).toMatchObject({ pagina: 2, porPagina: 2 });
  });
});
