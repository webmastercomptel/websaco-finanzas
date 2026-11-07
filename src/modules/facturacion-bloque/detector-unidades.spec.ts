import {
  construirConjuntoConocidas,
  construirMapaPaginas,
  crearRegexEtiqueta,
  ETIQUETA_UNIDAD,
  normalizarCodigoUnidad,
  REGEX_ETIQUETA_POR_DEFECTO,
} from './detector-unidades';

/** The detector returns a Map; assertions read it as a plain object. */
const aObjeto = (mapa: Map<string, number[]>) => Object.fromEntries(mapa);

describe('construirMapaPaginas', () => {
  it('agrupa páginas por la unidad detectada (1-indexed)', () => {
    const pages = [
      `Factura\n${ETIQUETA_UNIDAD}: 201T2\nTotal $100`,
      `Factura\n${ETIQUETA_UNIDAD}: 304T4\nDetalle`,
      `continuación\n${ETIQUETA_UNIDAD}: 304T4\nTotal $250`,
    ];
    const res = construirMapaPaginas(pages);
    expect(aObjeto(res.unidades)).toEqual({ '201T2': [1], '304T4': [2, 3] });
    expect(res.paginasSinMatch).toEqual([]);
  });

  it('registra en unmatchedPages las páginas sin etiqueta', () => {
    const pages = [`${ETIQUETA_UNIDAD}: 101A\nx`, 'portada sin identificador'];
    const res = construirMapaPaginas(pages);
    expect(aObjeto(res.unidades)).toEqual({ '101A': [1] });
    expect(res.paginasSinMatch).toEqual([2]);
  });

  it('normaliza el código a mayúsculas', () => {
    const res = construirMapaPaginas([`${ETIQUETA_UNIDAD.toLowerCase()}: 12b`]);
    expect(aObjeto(res.unidades)).toEqual({ '12B': [1] });
  });

  it('el regex por defecto es case-insensitive y tolera espacios', () => {
    expect(
      `${ETIQUETA_UNIDAD}:   77C`.match(REGEX_ETIQUETA_POR_DEFECTO)?.[1],
    ).toBe('77C');
  });

  it('acepta un regex personalizado con grupo de captura', () => {
    const res = construirMapaPaginas(['Apto 5D fin'], /Apto\s+([A-Za-z0-9]+)/i);
    expect(aObjeto(res.unidades)).toEqual({ '5D': [1] });
  });

  it('distingue códigos con guion (no los corta en el primer segmento)', () => {
    const pages = [
      `${ETIQUETA_UNIDAD}: L-1\nx`,
      `${ETIQUETA_UNIDAD}: L-2\ny`,
      `${ETIQUETA_UNIDAD}: L-3\nz`,
    ];
    const res = construirMapaPaginas(pages);
    expect(aObjeto(res.unidades)).toEqual({
      'L-1': [1],
      'L-2': [2],
      'L-3': [3],
    });
    expect(res.paginasSinMatch).toEqual([]);
  });
});

describe('normalizarCodigoUnidad', () => {
  it('colapsa espacios internos, recorta y pasa a mayúsculas', () => {
    expect(normalizarCodigoUnidad('  torre   a - 301 ')).toBe('TORRE A - 301');
  });

  it('null y undefined se convierten en cadena vacía', () => {
    expect(normalizarCodigoUnidad(null)).toBe('');
    expect(normalizarCodigoUnidad(undefined)).toBe('');
  });

  it('un código simple solo se pasa a mayúsculas', () => {
    expect(normalizarCodigoUnidad('304t4')).toBe('304T4');
  });
});

describe('construirConjuntoConocidas', () => {
  it('normaliza y deduplica las unidades', () => {
    const set = construirConjuntoConocidas([
      ' torre a  - 301 ',
      'TORRE A - 301',
      '304t4',
    ]);
    expect([...set].sort()).toEqual(['304T4', 'TORRE A - 301']);
  });

  it('descarta vacías pero conserva códigos con punto o que empiezan con $ (viven en un Map, no son claves de objeto)', () => {
    const set = construirConjuntoConocidas([
      '',
      '   ',
      null,
      undefined,
      'A.101',
      '$where',
      '301',
    ]);
    expect([...set].sort()).toEqual(['$WHERE', '301', 'A.101']);
  });

  it('un código como constructor es una clave ordinaria y no toca el prototipo', () => {
    const res = construirMapaPaginas(
      [`${ETIQUETA_UNIDAD}: constructor`, `${ETIQUETA_UNIDAD}: toString`],
      REGEX_ETIQUETA_POR_DEFECTO,
      construirConjuntoConocidas(['constructor', 'toString']),
    );
    expect([...res.unidades.keys()].sort()).toEqual([
      'CONSTRUCTOR',
      'TOSTRING',
    ]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe('construirMapaPaginas con unidades conocidas', () => {
  // extractPageTexts une los fragmentos con ' ': el texto real NO tiene saltos
  // de línea, así que estas páginas tampoco los llevan.
  const known = (...units: string[]) => construirConjuntoConocidas(units);

  it('resuelve un código con espacios y guion contra la unidad conocida', () => {
    const res = construirMapaPaginas(
      [`${ETIQUETA_UNIDAD}: Torre A - 301`],
      REGEX_ETIQUETA_POR_DEFECTO,
      known('TORRE A - 301'),
    );
    expect(aObjeto(res.unidades)).toEqual({ 'TORRE A - 301': [1] });
    expect(res.paginasSinMatch).toEqual([]);
  });

  it('tolera minúsculas, espacios dobles y texto sobrante en la misma línea', () => {
    const res = construirMapaPaginas(
      [`${ETIQUETA_UNIDAD.toLowerCase()}: torre  a - 301 Total $100`],
      REGEX_ETIQUETA_POR_DEFECTO,
      known('TORRE A - 301'),
    );
    expect(aObjeto(res.unidades)).toEqual({ 'TORRE A - 301': [1] });
  });

  it('elige el prefijo de tokens más largo (Local 2 vs Local 20), no una subcadena', () => {
    const res = construirMapaPaginas(
      [
        `${ETIQUETA_UNIDAD}: Local 2 Fecha 12/07`,
        `${ETIQUETA_UNIDAD}: Local 20`,
        `${ETIQUETA_UNIDAD}: Local 20 Fecha 12/07`,
      ],
      REGEX_ETIQUETA_POR_DEFECTO,
      known('LOCAL 2', 'LOCAL 20'),
    );
    expect(aObjeto(res.unidades)).toEqual({
      'LOCAL 2': [1],
      'LOCAL 20': [2, 3],
    });
  });

  it('una unidad conocida NO matchea como subcadena de un token más largo', () => {
    const res = construirMapaPaginas(
      [`${ETIQUETA_UNIDAD}: Local 200`],
      REGEX_ETIQUETA_POR_DEFECTO,
      known('LOCAL 2', 'LOCAL 20'),
    );
    // Ninguna conocida es prefijo de tokens → legacy (primer token).
    expect(aObjeto(res.unidades)).toEqual({ LOCAL: [1] });
  });

  it('un código simple conocido se detecta igual que antes', () => {
    const res = construirMapaPaginas(
      [`${ETIQUETA_UNIDAD}: 301`],
      REGEX_ETIQUETA_POR_DEFECTO,
      known('301'),
    );
    expect(aObjeto(res.unidades)).toEqual({ '301': [1] });
  });

  it('texto sobrante tras un código conocido: gana el conocido', () => {
    const res = construirMapaPaginas(
      [`${ETIQUETA_UNIDAD}: 304T4 Total $100`],
      REGEX_ETIQUETA_POR_DEFECTO,
      known('304T4'),
    );
    expect(aObjeto(res.unidades)).toEqual({ '304T4': [1] });
  });

  it('texto sobrante tras un código desconocido: legacy, solo el primer token', () => {
    const res = construirMapaPaginas(
      [`${ETIQUETA_UNIDAD}: 304T4 Total $100`],
      REGEX_ETIQUETA_POR_DEFECTO,
      known('999X9'),
    );
    expect(aObjeto(res.unidades)).toEqual({ '304T4': [1] });
  });

  it('un código con espacios desconocido cae al legacy (primer token)', () => {
    const res = construirMapaPaginas(
      [`${ETIQUETA_UNIDAD}: Torre B - 9`],
      REGEX_ETIQUETA_POR_DEFECTO,
      known('TORRE A - 301'),
    );
    expect(aObjeto(res.unidades)).toEqual({ TORRE: [1] });
  });

  it('con conjunto vacío el resultado es idéntico al legacy', () => {
    const pages = [
      `${ETIQUETA_UNIDAD}: Torre A - 301`,
      `${ETIQUETA_UNIDAD}: 304T4 Total $100`,
      'portada',
    ];
    const conVacio = construirMapaPaginas(
      pages,
      REGEX_ETIQUETA_POR_DEFECTO,
      new Set(),
    );
    expect(conVacio).toEqual(construirMapaPaginas(pages));
    expect(aObjeto(conVacio.unidades)).toEqual({ TORRE: [1], '304T4': [2] });
    expect(conVacio.paginasSinMatch).toEqual([3]);
  });

  it('con varias etiquetas en la misma página gana la primera', () => {
    const res = construirMapaPaginas(
      [`${ETIQUETA_UNIDAD}: Local 2 ${ETIQUETA_UNIDAD}: Local 20 fin`],
      REGEX_ETIQUETA_POR_DEFECTO,
      known('LOCAL 2', 'LOCAL 20'),
    );
    expect(aObjeto(res.unidades)).toEqual({ 'LOCAL 2': [1] });
  });

  it('una etiqueta cuyo valor no empieza con carácter válido queda sin match', () => {
    const res = construirMapaPaginas(
      [`${ETIQUETA_UNIDAD}: #x`],
      REGEX_ETIQUETA_POR_DEFECTO,
      known('X'),
    );
    expect(aObjeto(res.unidades)).toEqual({});
    expect(res.paginasSinMatch).toEqual([1]);
  });

  it('el candidato se acota a la misma línea (no cruza saltos de línea)', () => {
    const res = construirMapaPaginas(
      [`${ETIQUETA_UNIDAD}: Torre A\n- 301`],
      REGEX_ETIQUETA_POR_DEFECTO,
      known('TORRE A - 301'),
    );
    expect(aObjeto(res.unidades)).toEqual({ TORRE: [1] });
  });

  describe('guarda de privacidad: prefijo conocido seguido de puntuación de continuación', () => {
    it('Torre A - 302 impreso con TORRE A conocida NO se asigna a TORRE A (queda en legacy: TORRE)', () => {
      const res = construirMapaPaginas(
        [`${ETIQUETA_UNIDAD}: Torre A - 302 Total`],
        REGEX_ETIQUETA_POR_DEFECTO,
        known('TORRE A', 'TORRE A - 301'),
      );
      expect(aObjeto(res.unidades)).not.toHaveProperty('TORRE A');
      // Legacy: primer token, que no es una unidad conocida → se reporta.
      expect(aObjeto(res.unidades)).toEqual({ TORRE: [1] });
      expect(res.paginasSinMatch).toEqual([]);
    });

    it('Local 2 - Norte con LOCAL 2 conocida NO se asigna a LOCAL 2', () => {
      const res = construirMapaPaginas(
        [`${ETIQUETA_UNIDAD}: Local 2 - Norte`],
        REGEX_ETIQUETA_POR_DEFECTO,
        known('LOCAL 2'),
      );
      expect(aObjeto(res.unidades)).not.toHaveProperty('LOCAL 2');
      expect(aObjeto(res.unidades)).toEqual({ LOCAL: [1] });
    });

    it('Torre A - 301 conocida SÍ matchea cuando se imprime Torre A - 301 Total (gana el prefijo más largo)', () => {
      const res = construirMapaPaginas(
        [`${ETIQUETA_UNIDAD}: Torre A - 301 Total`],
        REGEX_ETIQUETA_POR_DEFECTO,
        known('TORRE A', 'TORRE A - 301'),
      );
      expect(aObjeto(res.unidades)).toEqual({ 'TORRE A - 301': [1] });
    });

    it('la guarda solo aplica al prefijo SELECCIONADO: no se prueba un prefijo más corto', () => {
      const res = construirMapaPaginas(
        [`${ETIQUETA_UNIDAD}: A B - 3`],
        REGEX_ETIQUETA_POR_DEFECTO,
        known('A', 'A B'),
      );
      // 'A B' rechazada por la guarda; 'A' no se prueba y, como el primer token
      // legacy ('A') es conocido, la página queda sin match.
      expect(aObjeto(res.unidades)).toEqual({});
      expect(res.paginasSinMatch).toEqual([1]);
    });

    it.each([
      ['guion largo (–)', 'Local 2 – Norte'],
      ['raya (—)', 'Local 2 — Norte'],
      ['barra (/)', 'Local 2 / Norte'],
      ['guion pegado al siguiente token', 'Local 2 -Norte'],
    ])('también se rechaza con %s', (_nombre, impreso) => {
      const res = construirMapaPaginas(
        [`${ETIQUETA_UNIDAD}: ${impreso}`],
        REGEX_ETIQUETA_POR_DEFECTO,
        known('LOCAL 2'),
      );
      expect(aObjeto(res.unidades)).not.toHaveProperty('LOCAL 2');
    });

    it.each([
      ['paréntesis', 'Torre A (302)'],
      ['numeral pegado', 'Torre A #302'],
      ['numeral separado', 'Torre A # 302'],
      ['dos puntos', 'Torre A : 302'],
      ['coma', 'Torre A , 302'],
      ['barra vertical', 'Torre A | 302'],
      ['guion Unicode U+2010', 'Torre A ‐ 302'],
      ['guion no separable U+2011', 'Torre A ‑ 302'],
      ['signo menos U+2212', 'Torre A − 302'],
      ['guion ancho completo U+FF0D', 'Torre A － 302'],
    ])(
      'rechaza la continuación con %s (no se asigna a TORRE A)',
      (_nombre, impreso) => {
        const res = construirMapaPaginas(
          [`${ETIQUETA_UNIDAD}: ${impreso}`],
          REGEX_ETIQUETA_POR_DEFECTO,
          known('TORRE A'),
        );
        expect(aObjeto(res.unidades)).not.toHaveProperty('TORRE A');
        // Legacy: primer token, que no es una unidad conocida → se reporta.
        expect(aObjeto(res.unidades)).toEqual({ TORRE: [1] });
      },
    );

    it('palabras o dígitos ordinarios tras el prefijo conocido siguen matcheando como antes', () => {
      const res = construirMapaPaginas(
        [
          `${ETIQUETA_UNIDAD}: Local 2 Fecha 12/07`,
          `${ETIQUETA_UNIDAD}: 301 Total`,
          `${ETIQUETA_UNIDAD}: 301 2024`,
        ],
        REGEX_ETIQUETA_POR_DEFECTO,
        known('LOCAL 2', '301'),
      );
      expect(aObjeto(res.unidades)).toEqual({ 'LOCAL 2': [1], '301': [2, 3] });
    });

    it('un match exacto del candidato completo no se ve afectado', () => {
      const res = construirMapaPaginas(
        [`${ETIQUETA_UNIDAD}: Torre A - 301`],
        REGEX_ETIQUETA_POR_DEFECTO,
        known('TORRE A', 'TORRE A - 301'),
      );
      expect(aObjeto(res.unidades)).toEqual({ 'TORRE A - 301': [1] });
    });

    it('301 - 2024 con 301 conocida se rechaza: falla segura deliberada (se reportan los fallos, no se entregan mal)', () => {
      const res = construirMapaPaginas(
        [`${ETIQUETA_UNIDAD}: 301 - 2024`],
        REGEX_ETIQUETA_POR_DEFECTO,
        known('301'),
      );
      // El primer token legacy ("301") coincide con la unidad conocida: asignarlo
      // sería justo la entrega errónea que la guarda evita, así que la página
      // queda sin match en vez de caer a esa unidad.
      expect(aObjeto(res.unidades)).toEqual({});
      expect(res.paginasSinMatch).toEqual([1]);
    });

    it('si el primer token legacy de un candidato rechazado es otra unidad conocida, la página queda sin match', () => {
      const res = construirMapaPaginas(
        [`${ETIQUETA_UNIDAD}: Torre A - 302`],
        REGEX_ETIQUETA_POR_DEFECTO,
        known('TORRE', 'TORRE A'),
      );
      expect(aObjeto(res.unidades)).toEqual({});
      expect(res.paginasSinMatch).toEqual([1]);
    });

    describe('refusedByGuard: candidatos rechazados por la guarda', () => {
      it('registra página y unidad conocida (solo códigos) de cada rechazo, incluso si el legacy no es conocido', () => {
        const res = construirMapaPaginas(
          [
            `${ETIQUETA_UNIDAD}: Torre A - 302 Total`,
            `${ETIQUETA_UNIDAD}: Torre A - 301`,
            `${ETIQUETA_UNIDAD}: Local 2 / Norte`,
          ],
          REGEX_ETIQUETA_POR_DEFECTO,
          known('TORRE A', 'TORRE A - 301', 'LOCAL 2', 'LOCAL'),
        );
        expect(res.rechazadasPorGuarda).toEqual([
          { pagina: 1, unidad: 'TORRE A' },
          { pagina: 3, unidad: 'LOCAL 2' },
        ]);
        expect(res.paginasSinMatch).toEqual([3]);
      });

      it('queda vacío cuando no hay rechazos o no hay unidades conocidas', () => {
        const pages = [`${ETIQUETA_UNIDAD}: Torre A - 301`, 'portada'];
        expect(
          construirMapaPaginas(
            pages,
            REGEX_ETIQUETA_POR_DEFECTO,
            known('TORRE A - 301'),
          ).rechazadasPorGuarda,
        ).toEqual([]);
        expect(construirMapaPaginas(pages).rechazadasPorGuarda).toEqual([]);
      });
    });

    it('con regex personalizado, el candidato rechazado queda como captura completa normalizada', () => {
      const res = construirMapaPaginas(
        ['Apto Torre A - 302 fin'],
        /Apto\s+([A-Za-z0-9][^\r\n]{0,63})/i,
        known('TORRE A'),
      );
      expect(aObjeto(res.unidades)).toEqual({ 'TORRE A - 302 FIN': [1] });
    });
  });

  it('el regex personalizado sigue funcionando con unidades conocidas', () => {
    const res = construirMapaPaginas(
      ['Apto Torre A - 301 fin'],
      /Apto\s+([A-Za-z0-9][^\r\n]{0,63})/i,
      known('TORRE A - 301'),
    );
    expect(aObjeto(res.unidades)).toEqual({ 'TORRE A - 301': [1] });
  });

  it('el regex personalizado sin match conocido conserva el comportamiento legacy', () => {
    const res = construirMapaPaginas(
      ['Apto Torre A fin'],
      /Apto\s+([A-Za-z ]+)/i,
      known('X'),
    );
    expect(aObjeto(res.unidades)).toEqual({ 'TORRE A FIN': [1] });
  });
});

describe('crearRegexEtiqueta', () => {
  it('recorta los dos puntos finales de la etiqueta para no duplicarlos', () => {
    expect('Unidad: 301'.match(crearRegexEtiqueta('Unidad:'))?.[1]).toBe('301');
  });

  it('escapa los caracteres especiales de la etiqueta (no son regex)', () => {
    const regex = crearRegexEtiqueta('N.º (inm)');
    expect('N.º (inm): 12B'.match(regex)?.[1]).toBe('12B');
    expect('NXº (inm): 12B'.match(regex)).toBeNull();
  });
});
