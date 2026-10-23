import {
  datosRespuestaComptable,
  leerRespuestaComptable,
  MAX_MENSAJE_LOG,
  mensajeParaLog,
  parsearCuerpo,
} from './comptable.respuesta';

describe('leerRespuestaComptable', () => {
  it('lee los campos en el nivel superior', () => {
    expect(
      leerRespuestaComptable({
        statusCode: 409,
        codigo: 'LOTE_YA_RECIBIDO',
        loteId: 'abc',
        message: 'Ya se recibió',
      }),
    ).toEqual({
      codigo: 'LOTE_YA_RECIBIDO',
      loteId: 'abc',
      errores: [],
      mensaje: 'Ya se recibió',
    });
  });

  it('lee los campos dentro de data', () => {
    expect(
      leerRespuestaComptable({
        statusCode: 409,
        data: {
          codigo: 'LOTE_INTERVENIDO',
          message: 'Modificado en Comptable',
        },
      }),
    ).toMatchObject({
      codigo: 'LOTE_INTERVENIDO',
      mensaje: 'Modificado en Comptable',
    });
  });

  it('lee los campos cuando message es un objeto (HttpException con objeto)', () => {
    expect(
      leerRespuestaComptable({
        statusCode: 400,
        message: {
          message: 'El lote tiene errores',
          errores: [{ asiento: 'FV 4152', motivo: 'Cuenta inexistente' }],
        },
      }),
    ).toEqual({
      codigo: null,
      loteId: null,
      errores: [{ asiento: 'FV 4152', motivo: 'Cuenta inexistente' }],
      mensaje: 'El lote tiene errores',
    });
  });

  it.each([
    [
      '400 de documentos',
      {
        statusCode: 400,
        message:
          'El lote fue rechazado: hay errores en sus documentos. No se guardó ningún asiento.',
        errores: [{ asiento: 'NA 1088', motivo: 'El documento NA no existe' }],
      },
      {
        codigo: null,
        loteId: null,
        errores: [{ asiento: 'NA 1088', motivo: 'El documento NA no existe' }],
        mensaje:
          'El lote fue rechazado: hay errores en sus documentos. No se guardó ningún asiento.',
      },
    ],
    [
      '400 del DTO',
      {
        statusCode: 400,
        message: ['Solo se acepta la versión 1 del contrato', 'otro'],
        error: 'Bad Request',
      },
      {
        codigo: null,
        loteId: null,
        errores: [],
        mensaje: 'Solo se acepta la versión 1 del contrato; otro',
      },
    ],
    [
      '409 LOTE_YA_RETIRADO',
      {
        statusCode: 409,
        codigo: 'LOTE_YA_RETIRADO',
        message: 'Este lote ya fue retirado de Comptable',
      },
      {
        codigo: 'LOTE_YA_RETIRADO',
        loteId: null,
        errores: [],
        mensaje: 'Este lote ya fue retirado de Comptable',
      },
    ],
    [
      '404',
      { statusCode: 404, message: 'No existe', error: 'Not Found' },
      { codigo: null, loteId: null, errores: [], mensaje: 'No existe' },
    ],
    [
      '401',
      { statusCode: 401, message: 'Unauthorized' },
      { codigo: null, loteId: null, errores: [], mensaje: 'Unauthorized' },
    ],
  ])('lee la forma real de Comptable: %s', (_caso, cuerpo, esperado) => {
    expect(leerRespuestaComptable(cuerpo)).toEqual(esperado);
  });

  it('une los mensajes de validación que vienen como lista', () => {
    expect(
      leerRespuestaComptable({ statusCode: 400, message: ['uno', 'dos'] })
        .mensaje,
    ).toBe('uno; dos');
  });

  it('descarta errores mal formados sin lanzar', () => {
    expect(
      leerRespuestaComptable({
        errores: ['texto', null, { asiento: 'RC 88', motivo: 'Mes cerrado' }],
      }).errores,
    ).toEqual([{ asiento: 'RC 88', motivo: 'Mes cerrado' }]);
  });

  it.each([null, undefined, 'texto', 42, []])(
    'un cuerpo que no es objeto (%p) deja todo en null',
    (cuerpo) => {
      expect(leerRespuestaComptable(cuerpo)).toEqual({
        codigo: null,
        loteId: null,
        errores: [],
        mensaje: null,
      });
    },
  );
});

describe('datosRespuestaComptable', () => {
  it('desenvuelve el sobre { statusCode, data }', () => {
    expect(
      datosRespuestaComptable({ statusCode: 200, data: { id: 'x' } }),
    ).toEqual({
      id: 'x',
    });
  });

  it('sin sobre devuelve el cuerpo tal cual', () => {
    expect(datosRespuestaComptable({ id: 'x' })).toEqual({ id: 'x' });
  });
});

describe('parsearCuerpo', () => {
  it('devuelve null para vacío o texto que no es JSON', () => {
    expect(parsearCuerpo('')).toBeNull();
    expect(parsearCuerpo('<html>502</html>')).toBeNull();
  });

  it('parsea JSON válido', () => {
    expect(parsearCuerpo('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('mensajeParaLog', () => {
  const SECRETO = 'secreto-compartido-0123456789abcdef0123';

  it('devuelve null cuando no hay mensaje o solo queda espacio en blanco', () => {
    expect(mensajeParaLog(null)).toBeNull();
    expect(mensajeParaLog('')).toBeNull();
    expect(mensajeParaLog(' \n\t ')).toBeNull();
  });

  it('deja intacto un mensaje corto y limpio', () => {
    expect(mensajeParaLog('Falta la cuenta técnica')).toBe(
      'Falta la cuenta técnica',
    );
  });

  it('colapsa saltos de línea, tabuladores y caracteres de control en un espacio', () => {
    expect(mensajeParaLog('a\nb\r\nc\td\u0000e\u001bf')).toBe('a b c d e f');
  });

  it('trunca a MAX_MENSAJE_LOG caracteres y marca el corte', () => {
    const largo = 'x'.repeat(MAX_MENSAJE_LOG + 50);

    const resultado = mensajeParaLog(largo);

    expect(MAX_MENSAJE_LOG).toBe(300);
    expect(resultado).toBe(`${'x'.repeat(MAX_MENSAJE_LOG)}…`);
  });

  it('no trunca un mensaje que mide exactamente el máximo', () => {
    const justo = 'y'.repeat(MAX_MENSAJE_LOG);

    expect(mensajeParaLog(justo)).toBe(justo);
  });

  it('no parte un carácter fuera del plano básico (emoji) al truncar', () => {
    const resultado = mensajeParaLog('😀'.repeat(MAX_MENSAJE_LOG + 5));

    expect(resultado).toBe(`${'😀'.repeat(MAX_MENSAJE_LOG)}…`);
  });

  it('enmascara el secreto repetido en el mensaje', () => {
    const resultado = mensajeParaLog(`uno ${SECRETO} dos ${SECRETO}`, SECRETO);

    expect(resultado).toBe('uno [redactado] dos [redactado]');
  });

  it('enmascara antes de truncar: un secreto que el corte habría partido no queda a medias', () => {
    const mensaje = `${'z'.repeat(MAX_MENSAJE_LOG - 10)}${SECRETO}`;

    const resultado = mensajeParaLog(mensaje, SECRETO);

    expect(resultado).not.toContain(SECRETO);
    expect(resultado).not.toContain(SECRETO.slice(0, 10));
  });

  it('sin secreto configurado no enmascara nada', () => {
    expect(mensajeParaLog(`hola ${SECRETO}`)).toBe(`hola ${SECRETO}`);
  });
});
