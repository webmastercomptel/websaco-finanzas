import { Types } from 'mongoose';
import {
  MAX_EMAILS_TITULAR_WEBSACO3,
  mapearPropietarios,
} from './propietarios.mapper';

const oid = () => new Types.ObjectId();

const inmueble = (sobre: Record<string, unknown> = {}) => ({
  codigo: '101',
  titularId: null as Types.ObjectId | null,
  tipoTitular: 'propietario' as const,
  ...sobre,
});

const tercero = (id: Types.ObjectId, sobre: Record<string, unknown> = {}) => ({
  _id: id,
  nombre: 'Ana Pérez',
  emails: ['a@x.co', 'b@x.co'],
  telefono: '3001',
  estado: 'active' as const,
  ...sobre,
});

const mapear = (
  unidades: ReturnType<typeof inmueble>[],
  terceros: ReturnType<typeof tercero>[] = [],
) =>
  mapearPropietarios({ nombre: 'Edificio Demo' }, unidades, terceros).unidades;

describe('mapearPropietarios', () => {
  it('lleva el nombre de la copropiedad', () => {
    expect(
      mapearPropietarios({ nombre: 'Edificio Demo' }, [], []).copropiedad,
    ).toEqual({ nombre: 'Edificio Demo' });
  });

  it('titular activo: primer email, teléfono y tipo arrendatario', () => {
    const id = oid();

    const [u] = mapear(
      [inmueble({ titularId: id, tipoTitular: 'arrendatario' })],
      [tercero(id)],
    );

    expect(u).toEqual({
      codigo: '101',
      tipo: 'arrendatario',
      titular: {
        nombre: 'Ana Pérez',
        email: 'a@x.co',
        emails: ['a@x.co', 'b@x.co'],
        telefono: '3001',
      },
    });
  });

  it('sin titular: titular null y la unidad sigue presente', () => {
    expect(mapear([inmueble()])).toEqual([
      { codigo: '101', tipo: 'propietario', titular: null },
    ]);
  });

  it('titular que no se resolvió (otra copropiedad o inexistente): null', () => {
    const [u] = mapear([inmueble({ titularId: oid() })], [tercero(oid())]);

    expect(u.titular).toBeNull();
  });

  it('titular inactivo: null', () => {
    const id = oid();

    const [u] = mapear(
      [inmueble({ titularId: id })],
      [tercero(id, { estado: 'inactive' })],
    );

    expect(u.titular).toBeNull();
  });

  it('sin email ni teléfono: email y teléfono null, emails vacío', () => {
    const id = oid();

    const [u] = mapear(
      [inmueble({ titularId: id })],
      [tercero(id, { emails: [], telefono: null })],
    );

    expect(u.titular).toEqual({
      nombre: 'Ana Pérez',
      email: null,
      emails: [],
      telefono: null,
    });
  });

  describe('emails del titular', () => {
    const titularCon = (emails: string[]) => {
      const id = oid();
      const [u] = mapear(
        [inmueble({ titularId: id })],
        [tercero(id, { emails })],
      );
      return u.titular;
    };

    it('tres emails válidos: email es el primero y emails los tres en orden', () => {
      expect(titularCon(['a@x.com', 'b@x.com', 'c@x.com'])).toMatchObject({
        email: 'a@x.com',
        emails: ['a@x.com', 'b@x.com', 'c@x.com'],
      });
    });

    it('primero inválido: email es el primero VÁLIDO y el inválido no se publica', () => {
      expect(titularCon(['bad', 'b@x.com'])).toMatchObject({
        email: 'b@x.com',
        emails: ['b@x.com'],
      });
    });

    it('recorta espacios y quita duplicados conservando el orden', () => {
      expect(titularCon([' a@x.com ', 'a@x.com', 'b@x.com'])).toMatchObject({
        email: 'a@x.com',
        emails: ['a@x.com', 'b@x.com'],
      });
    });

    it('deduplica sin distinguir mayúsculas y conserva la primera grafía', () => {
      expect(
        titularCon(['Ana@X.com', 'ana@x.com', 'b@x.com', 'B@X.COM']),
      ).toMatchObject({
        email: 'Ana@X.com',
        emails: ['Ana@X.com', 'b@x.com'],
      });
    });

    it('todos inválidos o vacíos: email null y emails []', () => {
      expect(titularCon(['bad', '', '   '])).toMatchObject({
        email: null,
        emails: [],
      });
    });

    it('trunca a 50 emails y email sigue siendo el primero', () => {
      const muchos = Array.from({ length: 60 }, (_, i) => `u${i}@x.com`);

      const titular = titularCon(muchos);

      expect(titular?.emails).toHaveLength(MAX_EMAILS_TITULAR_WEBSACO3);
      expect(titular?.emails).toEqual(muchos.slice(0, 50));
      expect(titular?.email).toBe('u0@x.com');
    });

    it('email siempre coincide con emails[0]', () => {
      const titular = titularCon(['  ', 'x', ' c@x.co ', 'd@x.co']);

      expect(titular?.email).toBe(titular?.emails[0]);
    });
  });

  it('el primer email no vacío (recortado) gana; vacíos se saltan', () => {
    const id = oid();

    const [u] = mapear(
      [inmueble({ titularId: id })],
      [
        tercero(id, {
          emails: ['  ', '', ' c@x.co ', 'd@x.co'],
          telefono: '  ',
        }),
      ],
    );

    expect(u.titular).toMatchObject({ email: 'c@x.co', telefono: null });
  });

  it('el teléfono se recorta', () => {
    const id = oid();

    const [u] = mapear(
      [inmueble({ titularId: id })],
      [tercero(id, { telefono: ' 3001 ' })],
    );

    expect(u.titular?.telefono).toBe('3001');
  });

  it('conserva el orden recibido y varias unidades comparten titular', () => {
    const id = oid();

    const unidades = mapear(
      [
        inmueble({ codigo: '101', titularId: id }),
        inmueble({ codigo: '102', titularId: id }),
        inmueble({ codigo: '103' }),
      ],
      [tercero(id)],
    );

    expect(unidades.map((u) => u.codigo)).toEqual(['101', '102', '103']);
    expect(unidades[0].titular).toEqual(unidades[1].titular);
    expect(unidades[2].titular).toBeNull();
  });

  it('una unidad inactiva también aparece (el mapper no filtra por estado)', () => {
    const [u] = mapear([inmueble({ estado: 'inactive' })]);

    expect(u.codigo).toBe('101');
  });
});
