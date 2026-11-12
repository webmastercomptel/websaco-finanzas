import { Types } from 'mongoose';
import { claveCorreo } from '../utils/email.utils';
import { destinosDeUnidad, ROLES_QUE_RECIBEN } from './destinos-correo';

const parte = (nombre: string, emails: string[]) => ({
  _id: new Types.ObjectId(),
  nombre,
  emails,
});

describe('destinosDeUnidad', () => {
  it('lista primero las direcciones del titular y luego las del arrendatario, con rol, clave y nombre', () => {
    const titular = parte('Ana', ['a1@x.com', 'a2@x.com', 'a3@x.com']);
    const arrendatario = parte('Luis', ['l1@x.com']);

    const destinos = destinosDeUnidad(titular, arrendatario);

    expect(destinos.map((d) => [d.email, d.rol])).toEqual([
      ['a1@x.com', 'propietario'],
      ['a2@x.com', 'propietario'],
      ['a3@x.com', 'propietario'],
      ['l1@x.com', 'arrendatario'],
    ]);
    expect(destinos[0]).toEqual({
      clave: claveCorreo('a1@x.com'),
      email: 'a1@x.com',
      rol: 'propietario',
      terceroId: titular._id,
      nombre: 'Ana',
    });
    expect(destinos[3]).toMatchObject({
      terceroId: arrendatario._id,
      nombre: 'Luis',
    });
  });

  it('una dirección en ambas partes (cualquier mayúscula o relleno) es UNA entrada, del titular', () => {
    const titular = parte('Ana', ['Ana@X.com']);
    const arrendatario = parte('Luis', [' ana@x.COM ']);

    const destinos = destinosDeUnidad(titular, arrendatario);

    expect(destinos).toHaveLength(1);
    expect(destinos[0]).toMatchObject({
      rol: 'propietario',
      terceroId: titular._id,
    });
  });

  it('una dirección repetida dentro de una lista es una sola entrada', () => {
    expect(
      destinosDeUnidad(parte('Ana', ['a@x.com', 'A@x.com', 'a@x.com']), null),
    ).toHaveLength(1);
  });

  it('un arrendatario sin direcciones deja solo las del titular, sin error', () => {
    const destinos = destinosDeUnidad(
      parte('Ana', ['a@x.com']),
      parte('Luis', []),
    );

    expect(destinos.map((d) => d.email)).toEqual(['a@x.com']);
  });

  it('sin direcciones en ninguna parte, o sin partes, no hay destinos', () => {
    expect(destinosDeUnidad(parte('Ana', []), parte('Luis', []))).toEqual([]);
    expect(destinosDeUnidad(null, null)).toEqual([]);
    expect(destinosDeUnidad(undefined, undefined)).toEqual([]);
  });

  it('una unidad sin arrendatario recibe solo en el titular', () => {
    expect(destinosDeUnidad(parte('Ana', ['a@x.com']), undefined)).toHaveLength(
      1,
    );
  });

  it('una entrada inválida se omite sin bloquear las válidas', () => {
    const destinos = destinosDeUnidad(
      parte('Ana', ['no-es-correo', 'b@x.com', '  ', 'c@']),
      null,
    );

    expect(destinos.map((d) => d.email)).toEqual(['b@x.com']);
  });

  it('lee una lista heredada de 8 direcciones ENTERA, sin truncar', () => {
    const ocho = Array.from({ length: 8 }, (_, i) => `u${i}@x.com`);

    expect(destinosDeUnidad(parte('Ana', ocho), null)).toHaveLength(8);
  });

  it('el correo se entrega recortado (el relleno de lo guardado no llega al destino)', () => {
    const [destino] = destinosDeUnidad(parte('Ana', [' Ana@x.com ']), null);

    expect(destino.email).toBe('Ana@x.com');
    expect(destino.clave).toBe(claveCorreo('ana@x.com'));
  });

  it('un rol fuera de ROLES_QUE_RECIBEN no aporta nada (punto de giro del supuesto 1)', () => {
    const titular = parte('Ana', ['a@x.com']);
    const arrendatario = parte('Luis', ['l@x.com']);

    expect(ROLES_QUE_RECIBEN).toEqual(['propietario', 'arrendatario']);
    expect(
      destinosDeUnidad(titular, arrendatario, ['propietario']).map(
        (d) => d.email,
      ),
    ).toEqual(['a@x.com']);
  });
});
