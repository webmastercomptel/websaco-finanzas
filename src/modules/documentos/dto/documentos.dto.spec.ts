import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ActualizarCarpetaDto } from './actualizar-carpeta.dto';
import { ActualizarDocumentoDto } from './actualizar-documento.dto';
import { CrearCarpetaDto } from './guardar-carpeta.dto';
import { CrearDocumentoDto } from './guardar-documento.dto';
import {
  ListarCarpetasDto,
  ListarDocumentosDto,
} from './listar-documentos.dto';

type Clase<T> = new () => T;

/** Names of the properties that fail validation, nested ones included. */
const invalidas = async <T extends object>(
  clase: Clase<T>,
  plano: Record<string, unknown>,
): Promise<string[]> => {
  const aplanar = (
    errores: Awaited<ReturnType<typeof validate>>,
    prefijo = '',
  ): string[] =>
    errores.flatMap((e) => [
      ...(e.constraints ? [`${prefijo}${e.property}`] : []),
      ...aplanar(e.children ?? [], `${prefijo}${e.property}.`),
    ]);
  return aplanar(await validate(plainToInstance(clase, plano)));
};

const ID = '507f1f77bcf86cd799439011';

describe('CrearCarpetaDto', () => {
  it('acepta una carpeta mínima', async () => {
    expect(await invalidas(CrearCarpetaDto, { nombre: 'Actas' })).toEqual([]);
  });

  it('exige nombre no vacío', async () => {
    expect(await invalidas(CrearCarpetaDto, { nombre: '' })).toContain(
      'nombre',
    );
    expect(await invalidas(CrearCarpetaDto, {})).toContain('nombre');
  });

  it('parentId debe ser un id válido, pero puede ser null', async () => {
    expect(
      await invalidas(CrearCarpetaDto, { nombre: 'X', parentId: 'abc' }),
    ).toContain('parentId');
    expect(
      await invalidas(CrearCarpetaDto, { nombre: 'X', parentId: null }),
    ).toEqual([]);
    expect(
      await invalidas(CrearCarpetaDto, { nombre: 'X', parentId: ID }),
    ).toEqual([]);
  });

  it('acepta reglas de rol y de residentes', async () => {
    expect(
      await invalidas(CrearCarpetaDto, {
        nombre: 'X',
        acls: [
          { tipo: 'rol', rolId: ID, puedeLeer: true, puedeEscribir: false },
          {
            tipo: 'residentes',
            rol: 'arrendatario',
            puedeLeer: true,
            puedeEscribir: false,
          },
        ],
      }),
    ).toEqual([]);
  });

  it('una regla de rol exige un rolId válido', async () => {
    expect(
      await invalidas(CrearCarpetaDto, {
        nombre: 'X',
        acls: [{ tipo: 'rol', puedeLeer: true, puedeEscribir: false }],
      }),
    ).toContain('acls.0.rolId');
    expect(
      await invalidas(CrearCarpetaDto, {
        nombre: 'X',
        acls: [
          { tipo: 'rol', rolId: 'nope', puedeLeer: true, puedeEscribir: false },
        ],
      }),
    ).toContain('acls.0.rolId');
  });

  it('una regla de residentes rechaza un rol desconocido', async () => {
    expect(
      await invalidas(CrearCarpetaDto, {
        nombre: 'X',
        acls: [
          {
            tipo: 'residentes',
            rol: 'visitante',
            puedeLeer: true,
            puedeEscribir: false,
          },
        ],
      }),
    ).toContain('acls.0.rol');
  });

  it('rechaza un tipo de regla desconocido y banderas que no son booleanas', async () => {
    const res = await invalidas(CrearCarpetaDto, {
      nombre: 'X',
      acls: [{ tipo: 'grupo', puedeLeer: 'si', puedeEscribir: 1 }],
    });
    expect(res).toEqual(
      expect.arrayContaining([
        'acls.0.tipo',
        'acls.0.puedeLeer',
        'acls.0.puedeEscribir',
      ]),
    );
  });
});

describe('ActualizarCarpetaDto', () => {
  it('acepta un cuerpo vacío, nombre, descripción y reglas vacías', async () => {
    expect(await invalidas(ActualizarCarpetaDto, {})).toEqual([]);
    expect(
      await invalidas(ActualizarCarpetaDto, { nombre: 'N', acls: [] }),
    ).toEqual([]);
  });

  it('un nombre presente no puede ser vacío', async () => {
    expect(await invalidas(ActualizarCarpetaDto, { nombre: '' })).toContain(
      'nombre',
    );
  });
});

describe('CrearDocumentoDto', () => {
  const valido = {
    nombre: 'Acta.pdf',
    mimeType: 'application/pdf',
    carpeta: 'actas',
    tamanoBytes: 100,
  };

  it('acepta una declaración de archivo válida', async () => {
    expect(await invalidas(CrearDocumentoDto, valido)).toEqual([]);
  });

  it.each(['pdf', 'application', 'application/', '/pdf', 'a b/c', 'text/<x>'])(
    'rechaza el mimeType mal formado %s',
    async (mimeType) => {
      expect(
        await invalidas(CrearDocumentoDto, { ...valido, mimeType }),
      ).toContain('mimeType');
    },
  );

  it.each([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/svg+xml',
    'text/plain',
  ])('acepta el mimeType real %s', async (mimeType) => {
    expect(await invalidas(CrearDocumentoDto, { ...valido, mimeType })).toEqual(
      [],
    );
  });

  it.each([0, -5, 1.5, '10'])('rechaza tamanoBytes=%s', async (tamanoBytes) => {
    expect(
      await invalidas(CrearDocumentoDto, { ...valido, tamanoBytes }),
    ).toContain('tamanoBytes');
  });

  it('exige nombre y carpeta', async () => {
    const res = await invalidas(CrearDocumentoDto, {
      mimeType: valido.mimeType,
      tamanoBytes: 1,
    });
    expect(res).toEqual(expect.arrayContaining(['nombre', 'carpeta']));
  });

  it('limita etiquetas y su longitud', async () => {
    expect(
      await invalidas(CrearDocumentoDto, {
        ...valido,
        etiquetas: Array.from({ length: 21 }, () => 'x'),
      }),
    ).toContain('etiquetas');
    expect(
      await invalidas(CrearDocumentoDto, {
        ...valido,
        etiquetas: ['x'.repeat(41)],
      }),
    ).toContain('etiquetas');
  });
});

describe('ActualizarDocumentoDto', () => {
  it('acepta cualquier combinación de campos válidos', async () => {
    expect(
      await invalidas(ActualizarDocumentoDto, {
        destacado: true,
        etiquetas: ['a'],
        carpeta: 'actas',
      }),
    ).toEqual([]);
    expect(await invalidas(ActualizarDocumentoDto, {})).toEqual([]);
  });

  it('rechaza destacado no booleano y carpeta vacía', async () => {
    expect(
      await invalidas(ActualizarDocumentoDto, { destacado: 'si' }),
    ).toContain('destacado');
    expect(await invalidas(ActualizarDocumentoDto, { carpeta: '' })).toContain(
      'carpeta',
    );
  });
});

describe('ListarDocumentosDto y ListarCarpetasDto', () => {
  it('aceptan la consulta vacía', async () => {
    expect(await invalidas(ListarDocumentosDto, {})).toEqual([]);
    expect(await invalidas(ListarCarpetasDto, {})).toEqual([]);
  });

  it('parent debe ser un id válido: un id mal formado es 400, no se ignora', async () => {
    expect(await invalidas(ListarCarpetasDto, { parent: 'abc' })).toContain(
      'parent',
    );
    expect(await invalidas(ListarCarpetasDto, { parent: ID })).toEqual([]);
  });

  it('limita el largo de la búsqueda', async () => {
    expect(
      await invalidas(ListarDocumentosDto, { q: 'x'.repeat(101) }),
    ).toContain('q');
  });
});
