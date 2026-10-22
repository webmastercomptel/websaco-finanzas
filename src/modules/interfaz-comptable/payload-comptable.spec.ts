import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Types } from 'mongoose';
import {
  aCentavos,
  centavosATexto,
  codigosTercero,
  construirPayloadComptable,
  inmueblesSinTitular,
  totalesDe,
  type ResolucionPayload,
  type TitularComptable,
  type TitularesPorInmueble,
} from './payload-comptable';

const FIXTURE = join(
  __dirname,
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'comptable',
  'payload-v1.json',
);

const anclas = {
  facturaId: null,
  reciboId: null,
  notaCreditoId: null,
  notaDebitoId: null,
  notaContableId: null,
  notaAnticipoId: null,
};

type MovimientoFixture = Record<string, unknown>;

const asiento = (
  ancla: Record<string, Types.ObjectId>,
  fecha: string,
  movimientos: MovimientoFixture[],
) =>
  ({
    ...anclas,
    ...ancla,
    _id: new Types.ObjectId(),
    fecha: new Date(fecha),
    movimientos,
  }) as never;

const ANA: TitularComptable = {
  tipoPersona: 'natural',
  nombre: 'Ana Pérez',
  primerNombre: 'Ana',
  segundoNombre: null,
  primerApellido: 'Pérez',
  segundoApellido: null,
  razonSocial: null,
  tipoIdentificacion: '13',
  digitoVerificacion: null,
  emails: ['ana@example.com', 'otra@example.com'],
  telefono: null,
  direccion: null,
  ciudad: null,
  ciudadCodigo: null,
};

const ORIGEN = {
  copropiedadId: new Types.ObjectId('66f000000000000000000001'),
  loteOrigenId: new Types.ObjectId('671000000000000000000001'),
  numeroLote: 12,
  periodoDesde: new Date('2026-10-01T00:00:00.000Z'),
  periodoHasta: new Date('2026-10-31T00:00:00.000Z'),
  generadoPor: { accountId: '66f000000000000000000099', nombre: 'Ana Pérez' },
};

/** Stands in for the Tabla de Documentos: each key's código is the key. */
const codigoIgualALaClave = (clave: string): string => clave;

const resolucionVacia = (): ResolucionPayload => ({
  codigoDe: codigoIgualALaClave,
  anchorMap: new Map(),
  conceptoMap: new Map(),
  saldosInicialesPorNumero: new Map(),
});

describe('construirPayloadComptable', () => {
  it('documento lleva el tipo de la Tabla de Documentos y prefijo el del documento, nunca la llave interna', () => {
    const facturaId = new Types.ObjectId();
    const resolucion = resolucionVacia();
    resolucion.codigoDe = (clave, prefijo) =>
      clave === 'FV' && prefijo === 'FEVP' ? 'FAC' : '?';
    resolucion.anchorMap.set(facturaId.toString(), {
      prefix: 'FEVP',
      number: 4152,
    });

    const payload = construirPayloadComptable(
      [asiento({ facturaId }, '2026-10-05', [])],
      resolucion,
      new Map(),
      ORIGEN,
    );

    expect(payload.asientos[0]).toMatchObject({
      documento: 'FAC',
      prefijo: 'FEVP',
      numero: 4152,
    });
  });

  it('reproduce exactamente el payload-v1.json compartido con Comptable', () => {
    const facturaId = new Types.ObjectId();
    const reciboId = new Types.ObjectId();
    const asientos = [
      asiento({ facturaId }, '2026-10-01T00:00:00.000Z', [
        {
          cuenta: '13050501',
          tipo: 'debito',
          monto: 350000,
          descripcion: 'Cartera',
          tercero: '101-A',
          centroCosto: '01',
          flujoCaja: null,
          baseGravable: null,
          tipoDocumento: 'FV',
          numeroDocumento: 4152,
        },
        {
          cuenta: '41709501',
          tipo: 'credito',
          monto: 350000,
          descripcion: 'Administración',
          tercero: null,
          centroCosto: '01',
          flujoCaja: null,
          baseGravable: null,
          tipoDocumento: null,
          numeroDocumento: null,
        },
      ]),
      asiento({ reciboId }, '2026-10-05T00:00:00.000Z', [
        {
          cuenta: '11100501',
          tipo: 'debito',
          monto: 350000,
          descripcion: 'Caja',
          tercero: null,
          centroCosto: null,
          flujoCaja: 'FC01',
          baseGravable: null,
          tipoDocumento: null,
          numeroDocumento: null,
        },
        {
          cuenta: '13050501',
          tipo: 'credito',
          monto: 350000,
          descripcion: 'Cartera',
          tercero: '101-A',
          centroCosto: '01',
          flujoCaja: null,
          baseGravable: null,
          tipoDocumento: 'FV',
          numeroDocumento: 4152,
        },
      ]),
    ];
    const resolucion: ResolucionPayload = {
      codigoDe: codigoIgualALaClave,
      anchorMap: new Map([
        [facturaId.toString(), { prefix: 'FEVP', number: 4152 }],
        [reciboId.toString(), { prefix: '', number: 88 }],
      ]),
      conceptoMap: new Map([
        [facturaId.toString(), 'Cargo del Periodo 01/10/2026 - 31/10/2026'],
        [reciboId.toString(), 'Pago administración octubre'],
      ]),
      saldosInicialesPorNumero: new Map(),
    };
    const titulares: TitularesPorInmueble = new Map([['101-A', ANA]]);

    const payload = construirPayloadComptable(
      asientos,
      resolucion,
      titulares,
      ORIGEN,
    );

    const esperado = JSON.stringify(
      JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown,
    );
    expect(JSON.stringify(payload)).toBe(esperado);
  });

  it.each([
    ['facturaId', 'FV'],
    ['reciboId', 'RC'],
    ['notaCreditoId', 'NC'],
    ['notaDebitoId', 'ND'],
    ['notaContableId', 'NT'],
    ['notaAnticipoId', 'NA'],
  ])(
    '%s viaja como documento %s con el prefijo y número del ancla',
    (campo, tipo) => {
      const id = new Types.ObjectId();
      const resolucion = resolucionVacia();
      resolucion.anchorMap.set(id.toString(), { prefix: tipo, number: 7 });

      const [primero] = construirPayloadComptable(
        [
          asiento({ [campo]: id }, '2026-10-02T00:00:00.000Z', [
            { cuenta: '1', tipo: 'debito', monto: 1, descripcion: 'd' },
            { cuenta: '2', tipo: 'credito', monto: 1, descripcion: 'c' },
          ]),
        ],
        resolucion,
        new Map(),
        ORIGEN,
      ).asientos;

      expect(primero).toMatchObject({
        documento: tipo,
        prefijo: tipo,
        numero: 7,
        fecha: '2026-10-02',
      });
    },
  );

  it('el tercero lleva el código DANE de la ciudad del titular, para que Comptable complete el departamento', () => {
    const [primero] = construirPayloadComptable(
      [
        asiento(
          { reciboId: new Types.ObjectId() },
          '2026-10-02T00:00:00.000Z',
          [
            { cuenta: '1', tipo: 'debito', monto: 5, descripcion: 'x' },
            {
              cuenta: '2',
              tipo: 'credito',
              monto: 5,
              descripcion: 'y',
              tercero: '101-A',
            },
          ],
        ),
      ],
      resolucionVacia(),
      new Map([
        ['101-A', { ...ANA, ciudad: 'Medellín', ciudadCodigo: '05001' }],
      ]),
      ORIGEN,
    ).asientos;

    expect(primero.movimientos[1].tercero).toMatchObject({
      ciudad: 'Medellín',
      ciudadCodigo: '05001',
    });
  });

  it('un documento sin prefijo viaja con prefijo "" y sin concepto usa el texto del primer movimiento', () => {
    const id = new Types.ObjectId();
    const resolucion = resolucionVacia();
    resolucion.anchorMap.set(id.toString(), { prefix: '', number: 3 });

    const [primero] = construirPayloadComptable(
      [
        asiento({ notaCreditoId: id }, '2026-10-02T00:00:00.000Z', [
          { cuenta: '1', tipo: 'debito', monto: 5, descripcion: 'Devolución' },
          { cuenta: '2', tipo: 'credito', monto: 5, descripcion: 'Cartera' },
        ]),
      ],
      resolucion,
      new Map(),
      ORIGEN,
    ).asientos;

    expect(primero.prefijo).toBe('');
    expect(primero.descripcion).toBe('Devolución');
    expect(primero.movimientos.map((m) => m.detalle)).toEqual([
      'Devolución',
      'Devolución',
    ]);
  });

  it('montos con centavos: dos decimales exactos, sin errores de coma flotante', () => {
    const [primero] = construirPayloadComptable(
      [
        asiento(
          { reciboId: new Types.ObjectId() },
          '2026-10-02T00:00:00.000Z',
          [
            {
              cuenta: '1',
              tipo: 'debito',
              monto: 0.1 + 0.2,
              descripcion: 'd',
              baseGravable: 1234.5,
            },
            { cuenta: '2', tipo: 'credito', monto: 0.3, descripcion: 'c' },
          ],
        ),
      ],
      resolucionVacia(),
      new Map(),
      ORIGEN,
    ).asientos;

    expect(primero.movimientos[0]).toMatchObject({
      debito: '0.30',
      credito: '0',
      baseGravable: '1234.50',
    });
    expect(primero.movimientos[1]).toMatchObject({
      debito: '0',
      credito: '0.30',
      baseGravable: null,
    });
  });

  it('cada asiento cuadra: la suma de débitos es igual a la de créditos', () => {
    const facturaId = new Types.ObjectId();
    const payload = construirPayloadComptable(
      [
        asiento({ facturaId }, '2026-10-01T00:00:00.000Z', [
          { cuenta: '1305', tipo: 'debito', monto: 119000, descripcion: 'a' },
          { cuenta: '4170', tipo: 'credito', monto: 100000, descripcion: 'b' },
          {
            cuenta: '2408',
            tipo: 'credito',
            monto: 19000,
            descripcion: 'IVA',
            baseGravable: 100000,
          },
        ]),
      ],
      resolucionVacia(),
      new Map(),
      ORIGEN,
    );

    for (const a of payload.asientos) {
      const suma = (lado: 'debito' | 'credito') =>
        a.movimientos.reduce(
          (total, m) => total + aCentavos(Number(m[lado])),
          0,
        );
      expect(suma('debito')).toBe(suma('credito'));
    }
  });

  it('documento cruce de un Saldo Inicial: tipo SI con el número ORIGINAL, como en el CSV', () => {
    const resolucion = resolucionVacia();
    resolucion.saldosInicialesPorNumero.set(2, { tipo: 'FV', numero: '2941' });

    const [primero] = construirPayloadComptable(
      [
        asiento(
          { reciboId: new Types.ObjectId() },
          '2026-10-02T00:00:00.000Z',
          [
            { cuenta: '1110', tipo: 'debito', monto: 10, descripcion: 'd' },
            {
              cuenta: '1305',
              tipo: 'credito',
              monto: 10,
              descripcion: 'c',
              tipoDocumento: 'SI',
              numeroDocumento: 2,
            },
          ],
        ),
      ],
      resolucion,
      new Map(),
      ORIGEN,
    ).asientos;

    expect(primero.movimientos[1]).toMatchObject({
      tipoDocCruce: 'SI',
      numeroDocCruce: '2941',
    });
    expect(primero.movimientos[0]).toMatchObject({
      tipoDocCruce: null,
      numeroDocCruce: null,
    });
  });

  it('centro de costo → centroUtilidad; centroDestino siempre null', () => {
    const [primero] = construirPayloadComptable(
      [
        asiento(
          { reciboId: new Types.ObjectId() },
          '2026-10-02T00:00:00.000Z',
          [
            {
              cuenta: '1',
              tipo: 'debito',
              monto: 1,
              descripcion: 'd',
              centroCosto: '07',
            },
          ],
        ),
      ],
      resolucionVacia(),
      new Map(),
      ORIGEN,
    ).asientos;

    expect(primero.movimientos[0]).toMatchObject({
      centroUtilidad: '07',
      centroDestino: null,
    });
  });

  describe('tercero', () => {
    const conTercero = (titulares: TitularesPorInmueble) =>
      construirPayloadComptable(
        [
          asiento(
            { reciboId: new Types.ObjectId() },
            '2026-10-02T00:00:00.000Z',
            [
              {
                cuenta: '1305',
                tipo: 'credito',
                monto: 1,
                descripcion: 'c',
                tercero: '201',
              },
            ],
          ),
        ],
        resolucionVacia(),
        titulares,
        ORIGEN,
      ).asientos[0].movimientos[0].tercero;

    it('una persona jurídica sin razón social usa su nombre', () => {
      expect(
        conTercero(
          new Map([
            [
              '201',
              {
                ...ANA,
                tipoPersona: 'juridica',
                nombre: 'Inversiones Andinas SAS',
                primerNombre: null,
                primerApellido: null,
                razonSocial: null,
                tipoIdentificacion: '31',
                digitoVerificacion: '7',
              },
            ],
          ]),
        ),
      ).toMatchObject({
        identificacion: '201',
        tipoPersona: 'juridica',
        razonSocial: 'Inversiones Andinas SAS',
        nombre1: null,
        digitoVerificacion: '7',
      });
    });

    it('una persona natural sin nombres separados usa su nombre completo como nombre1', () => {
      expect(
        conTercero(
          new Map([
            [
              '201',
              {
                ...ANA,
                primerNombre: null,
                primerApellido: null,
                nombre: 'Luis Gómez',
              },
            ],
          ]),
        ),
      ).toMatchObject({ nombre1: 'Luis Gómez', apellido1: null });
    });

    it('sin titular solo viaja la identificación (el envío se bloquea antes)', () => {
      expect(conTercero(new Map([['201', null]]))).toEqual({
        identificacion: '201',
        tipoPersona: null,
        nombre1: null,
        nombre2: null,
        apellido1: null,
        apellido2: null,
        razonSocial: null,
        tipoIdentificacion: null,
        digitoVerificacion: null,
        email: null,
        telefono: null,
        direccion: null,
        ciudad: null,
        ciudadCodigo: null,
      });
    });
  });

  it('en la vista previa el lote todavía no tiene id', () => {
    expect(
      construirPayloadComptable([], resolucionVacia(), new Map(), {
        ...ORIGEN,
        loteOrigenId: null,
      }).origen.loteOrigenId,
    ).toBeNull();
  });
});

describe('inmueblesSinTitular / codigosTercero', () => {
  const asientos = [
    {
      movimientos: [
        { tercero: '101' },
        { tercero: null },
        { tercero: '102' },
        { tercero: ' ' },
      ],
    },
    { movimientos: [{ tercero: '101' }, { tercero: '103' }] },
  ] as never[];

  it('lista sin repetir los códigos de inmueble usados como tercero', () => {
    expect(codigosTercero(asientos).sort()).toEqual(['101', '102', '103']);
  });

  it('devuelve, ordenados, los inmuebles sin titular o inexistentes', () => {
    const titulares: TitularesPorInmueble = new Map([
      ['101', ANA],
      ['103', null],
    ]);

    expect(inmueblesSinTitular(asientos, titulares)).toEqual(['102', '103']);
  });
});

describe('montos', () => {
  it.each([
    [350000, '350000.00'],
    [0.5, '0.50'],
    [1234.56, '1234.56'],
    [0, '0.00'],
    [-12.3, '-12.30'],
  ])('%p → %s', (monto, texto) => {
    expect(centavosATexto(aCentavos(monto))).toBe(texto);
  });

  it('totalesDe suma en centavos', () => {
    expect(
      totalesDe([
        {
          movimientos: [
            { tipo: 'debito', monto: 0.1 },
            { tipo: 'debito', monto: 0.2 },
            { tipo: 'credito', monto: 0.3 },
          ],
        },
      ] as never[]),
    ).toEqual({
      totalAsientos: 1,
      totalLineas: 3,
      totalDebitosCentavos: 30,
      totalCreditosCentavos: 30,
    });
  });
});
