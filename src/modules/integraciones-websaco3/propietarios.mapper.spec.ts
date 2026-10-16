import { Types } from 'mongoose';
import { mapearPropietarios } from './propietarios.mapper';

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
      titular: { nombre: 'Ana Pérez', email: 'a@x.co', telefono: '3001' },
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

  it('sin email ni teléfono: ambos null', () => {
    const id = oid();

    const [u] = mapear(
      [inmueble({ titularId: id })],
      [tercero(id, { emails: [], telefono: null })],
    );

    expect(u.titular).toEqual({
      nombre: 'Ana Pérez',
      email: null,
      telefono: null,
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
