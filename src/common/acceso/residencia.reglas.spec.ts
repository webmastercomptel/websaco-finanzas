import { claveCorreo } from '../utils/email.utils';
import {
  MAX_TERCEROS_POR_CORREO,
  REVOCACION_DETIENE_CORREOS_FACTURA,
  coincideCorreo,
  motivoCorreoGenerico,
  correoProbado,
  copropiedadAdmiteIngresoResidentes,
  revocacionAplica,
  unidadesDeTerceros,
} from './residencia.reglas';

describe('coincideCorreo', () => {
  it.each([
    ['ana@example.com', 'ana@example.com', true],
    ['Ana@Example.COM', 'ana@example.com', true],
    ['ana@example.com', '  ANA@example.com ', true],
    // A legacy value stored WITH padding does not match until its party is saved again.
    [' ana@example.com ', 'ana@example.com', false],
    ['ana@example.com ', 'ana@example.com', false],
    ['otra@example.com', 'ana@example.com', false],
    // What a strength-2 collation may equate but is not the same address.
    ['straße@example.com', 'strasse@example.com', false],
    ['', 'ana@example.com', false],
  ])('stored %j vs %j -> %s', (almacenado, correo, esperado) => {
    expect(coincideCorreo(almacenado, correo)).toBe(esperado);
  });
});

describe('unidadesDeTerceros', () => {
  const C1 = 'c1';
  const C2 = 'c2';
  const terceros = [
    { id: 'p1', copropiedadId: C1 },
    { id: 'p2', copropiedadId: C1 },
    { id: 'p3', copropiedadId: C2 },
  ];
  const unidad = (
    id: string,
    copropiedadId: string,
    titularId: string | null,
    arrendatarioId: string | null,
  ) => ({ id, copropiedadId, titularId, arrendatarioId });

  it('returns titular and arrendatario units with their role', () => {
    const resultado = unidadesDeTerceros(terceros.slice(0, 1), [
      unidad('101', C1, 'p1', null),
      unidad('202', C1, 'x', 'p1'),
    ]);
    expect(resultado).toEqual([
      { inmuebleId: '101', copropiedadId: C1, rol: 'propietario' },
      { inmuebleId: '202', copropiedadId: C1, rol: 'arrendatario' },
    ]);
  });

  it('lists a unit once and the owner wins', () => {
    const resultado = unidadesDeTerceros(terceros.slice(0, 2), [
      unidad('101', C1, 'p1', 'p2'),
      unidad('102', C1, 'p2', 'p1'),
    ]);
    expect(resultado).toEqual([
      { inmuebleId: '101', copropiedadId: C1, rol: 'propietario' },
      { inmuebleId: '102', copropiedadId: C1, rol: 'propietario' },
    ]);
  });

  it('a unit whose arrendatario is the party and whose titular is another party of the set is still owner', () => {
    const resultado = unidadesDeTerceros(terceros.slice(0, 2), [
      unidad('103', C1, 'p2', 'p1'),
    ]);
    expect(resultado[0].rol).toBe('propietario');
  });

  it('SEC: a party id of another coproperty counts for nothing', () => {
    const resultado = unidadesDeTerceros(terceros, [
      // p3 belongs to C2 but the unit says C1.
      unidad('101', C1, 'p3', null),
      unidad('301', C2, 'p3', null),
    ]);
    expect(resultado).toEqual([
      { inmuebleId: '301', copropiedadId: C2, rol: 'propietario' },
    ]);
  });

  it('ignores units that name none of the parties', () => {
    expect(
      unidadesDeTerceros(terceros.slice(0, 1), [unidad('9', C1, 'p2', null)]),
    ).toEqual([]);
  });

  it('keeps the order of the units given', () => {
    const resultado = unidadesDeTerceros(terceros.slice(0, 1), [
      unidad('b', C1, 'p1', null),
      unidad('a', C1, 'p1', null),
    ]);
    expect(resultado.map((r) => r.inmuebleId)).toEqual(['b', 'a']);
  });
});

describe('revocacionAplica', () => {
  it('applies to its own coproperty while active', () => {
    expect(revocacionAplica({ copropiedadId: 'c1', activa: true }, 'c1')).toBe(
      true,
    );
  });

  it('does not apply to another coproperty', () => {
    expect(revocacionAplica({ copropiedadId: 'c1', activa: true }, 'c2')).toBe(
      false,
    );
  });

  it('does not apply once lifted', () => {
    expect(revocacionAplica({ copropiedadId: 'c1', activa: false }, 'c1')).toBe(
      false,
    );
  });
});

describe('copropiedadAdmiteIngresoResidentes', () => {
  it('admits a coproperty with Finanzas', () => {
    expect(copropiedadAdmiteIngresoResidentes(['finanzas'])).toBe(true);
  });

  it('admits a coproperty with Administracion', () => {
    expect(copropiedadAdmiteIngresoResidentes(['administracion'])).toBe(true);
  });

  it('admits a coproperty with both', () => {
    expect(
      copropiedadAdmiteIngresoResidentes(['finanzas', 'administracion']),
    ).toBe(true);
  });

  it('refuses a coproperty that contracted no module', () => {
    expect(copropiedadAdmiteIngresoResidentes([])).toBe(false);
  });
});

describe('correoProbado', () => {
  const email = 'ana@example.com';

  it('is true only when the proof is for the current address of an active account', () => {
    expect(
      correoProbado({ email, correoProbadoClave: claveCorreo(email) }),
    ).toBe(true);
    expect(
      correoProbado({
        email,
        estado: 'active',
        correoProbadoClave: claveCorreo(email),
      }),
    ).toBe(true);
  });

  it('SEC: no proof, a proof for another address or an inactive account proves nothing', () => {
    expect(correoProbado({ email, correoProbadoClave: null })).toBe(false);
    expect(correoProbado({ email })).toBe(false);
    expect(
      correoProbado({
        email,
        correoProbadoClave: claveCorreo('otra@example.com'),
      }),
    ).toBe(false);
    expect(
      correoProbado({
        email,
        estado: 'inactive',
        correoProbadoClave: claveCorreo(email),
      }),
    ).toBe(false);
  });
});

describe('flip points', () => {
  it('revoking the portal does not stop invoice e-mails (owner assumption 3)', () => {
    expect(REVOCACION_DETIENE_CORREOS_FACTURA).toBe(false);
  });
});

describe('motivoCorreoGenerico (buzones genéricos)', () => {
  it('fija el tope en 3 terceros distintos', () => {
    expect(MAX_TERCEROS_POR_CORREO).toBe(3);
  });

  it.each([
    [1, null],
    [3, null],
    [4, 'correo-compartido'],
    [10, 'correo-compartido'],
  ] as const)('%i terceros -> %s', (tercerosDistintos, esperado) => {
    expect(motivoCorreoGenerico({ tercerosDistintos })).toBe(esperado);
  });

  it('ser personal no vuelve genérica una dirección: el acceso de personal y el de residente se suman', () => {
    // The rule takes no staff fact at all: the only reason left is sharing.
    const hechos = { tercerosDistintos: 1, esCorreoDePersonal: true };
    expect(motivoCorreoGenerico(hechos)).toBeNull();
  });
});
