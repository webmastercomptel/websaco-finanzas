import { Logger } from '@nestjs/common';
import { claveCorreo } from '../../common/utils/email.utils';
import {
  COP,
  OTRA_COP,
  cuenta,
  inmueble,
  montar,
  tercero,
} from './testing/montar-residentes-correos';

describe('ResidentesCorreosService.listar', () => {
  it('SEC: Residentes list is tenant-scoped', async () => {
    const mia = tercero({ nombre: 'Mía' });
    const ajena = tercero({ nombre: 'Ajena', copropiedadId: OTRA_COP });
    const m = montar({
      terceros: [mia, ajena],
      inmuebles: [
        inmueble(mia),
        inmueble(ajena, { copropiedadId: OTRA_COP, codigo: '900' }),
      ],
    });

    const r = await m.servicio.listar({});

    expect(r.items.map((f) => f.nombre)).toEqual(['Mía']);
    // Every read names the ACTIVE coproperty explicitly, as an ObjectId.
    for (const filtro of [...m.filtrosInmuebles, ...m.filtrosTerceros]) {
      expect(filtro.copropiedadId).toBe(COP);
    }
    expect(m.residencia.clavesRevocadas).toHaveBeenCalledWith(
      expect.any(Array),
      COP.toString(),
    );
  });

  it('un tercero de otra copropiedad con unidad de la mía no aparece', async () => {
    const forastero = tercero({ nombre: 'Forastero', copropiedadId: OTRA_COP });
    const m = montar({
      terceros: [forastero],
      // A unit of THIS coproperty that points at a party of another one.
      inmuebles: [inmueble(forastero)],
    });
    const r = await m.servicio.listar({});
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('un tercero que perdió su última unidad no se lista', async () => {
    const quedo = tercero({ nombre: 'Quedó' });
    const vendio = tercero({ nombre: 'Vendió' });
    const m = montar({
      terceros: [quedo, vendio],
      inmuebles: [
        inmueble(quedo),
        inmueble(vendio, { estado: 'inactive', codigo: '202' }),
      ],
    });
    const r = await m.servicio.listar({});
    expect(r.items.map((f) => f.nombre)).toEqual(['Quedó']);
  });

  it('arma las filas con estado, prueba, revocación y unidades por rol', async () => {
    const ana = tercero({ emails: ['ana@correo.co', 'b@correo.co'] });
    const beto = tercero({ nombre: 'Beto', emails: ['beto@correo.co'] });
    const entro = new Date('2026-10-02T10:00:00.000Z');
    const m = montar({
      terceros: [ana, beto],
      inmuebles: [
        inmueble(ana, { codigo: '101' }),
        inmueble(beto, {
          codigo: '202',
          titularId: null,
          arrendatarioId: beto._id,
        }),
      ],
      cuentas: [
        cuenta({
          correoProbadoClave: claveCorreo('ana@correo.co'),
          ultimoIngresoPortalEn: entro,
        }),
      ],
      revocadas: [claveCorreo('b@correo.co')],
    });

    const r = await m.servicio.listar({});

    expect(r.items.map((f) => [f.nombre, f.correo, f.estado])).toEqual([
      ['Ana Pérez', 'ana@correo.co', 'ingreso'],
      ['Ana Pérez', 'b@correo.co', 'revocado'],
      ['Beto', 'beto@correo.co', 'sin-ingreso'],
    ]);
    expect(r.items[0].ultimoIngresoEn).toBe(entro.toISOString());
    expect(r.items[2].unidades).toEqual([
      expect.objectContaining({ codigo: '202', rol: 'arrendatario' }),
    ]);
  });

  it('marca como a corregir los correos compartidos que le informa ResidenciaService', async () => {
    const t = tercero({ emails: ['porteria@correo.co'] });
    const m = montar({
      terceros: [t],
      inmuebles: [inmueble(t)],
      genericos: [['porteria@correo.co', 'correo-compartido']],
    });
    const r = await m.servicio.listar({});
    expect(r.items[0]).toMatchObject({
      requiereCorreccion: true,
      motivoCorreccion: 'correo-compartido',
    });
    // One batch call for the whole page, never one per address.
    expect(m.residencia.motivosCorreoGenerico).toHaveBeenCalledTimes(1);
  });

  it('una cuenta vinculada con otro correo aparece como acceso heredado', async () => {
    const c = cuenta({ email: 'viejo@correo.co' });
    const t = tercero({ emails: ['nuevo@correo.co'], accountId: c._id });
    const m = montar({
      terceros: [t],
      inmuebles: [inmueble(t)],
      cuentas: [c],
    });
    const r = await m.servicio.listar({});
    expect(r.items.map((f) => [f.correo, f.estado])).toEqual([
      ['nuevo@correo.co', 'sin-ingreso'],
      ['viejo@correo.co', 'heredado'],
    ]);
    expect(JSON.stringify(r)).not.toContain(c._id.toString());
  });

  it('busca, filtra por estado y pagina sobre las filas ya armadas', async () => {
    const a = tercero({ nombre: 'Ana', emails: ['ana@x.co'] });
    const b = tercero({ nombre: 'Beto', emails: ['beto@x.co'] });
    const c = tercero({ nombre: 'Carla', emails: ['carla@x.co'] });
    const m = montar({
      terceros: [a, b, c],
      inmuebles: [
        inmueble(a, { codigo: 'A1' }),
        inmueble(b, { codigo: 'B2' }),
        inmueble(c, { codigo: 'C3' }),
      ],
      revocadas: [claveCorreo('beto@x.co')],
    });

    expect((await m.servicio.listar({ buscar: 'b2' })).items).toHaveLength(1);
    expect(
      (await m.servicio.listar({ estado: 'revocado' })).items.map(
        (f) => f.nombre,
      ),
    ).toEqual(['Beto']);
    const p = await m.servicio.listar({ pagina: 2, porPagina: 2 });
    expect(p.items.map((f) => f.nombre)).toEqual(['Carla']);
    expect(p).toMatchObject({ total: 3, pagina: 2, porPagina: 2 });
  });

  it('el número de consultas no depende de cuántos terceros hay (sin N+1)', async () => {
    const contar = async (n: number) => {
      const personas = Array.from({ length: n }, (_, i) =>
        tercero({ nombre: `P${i}`, emails: [`p${i}@x.co`, `q${i}@x.co`] }),
      );
      const m = montar({
        terceros: personas,
        inmuebles: personas.map((p, i) => inmueble(p, { codigo: String(i) })),
        cuentas: personas.map((p, i) => cuenta({ email: `p${i}@x.co` })),
      });
      await m.servicio.listar({});
      return [
        m.modeloInmuebles.find.mock.calls.length,
        m.modeloTerceros.find.mock.calls.length,
        m.modeloCuentas.find.mock.calls.length,
        m.residencia.clavesRevocadas.mock.calls.length,
        m.residencia.motivosCorreoGenerico.mock.calls.length,
      ];
    };
    expect(await contar(3)).toEqual([1, 1, 1, 1, 1]);
    expect(await contar(30)).toEqual([1, 1, 1, 1, 1]);
  });

  it('sin unidades no consulta terceros, cuentas ni revocaciones', async () => {
    const m = montar({ terceros: [tercero()], inmuebles: [] });
    const r = await m.servicio.listar({});
    expect(r).toMatchObject({ items: [], total: 0, pagina: 1, porPagina: 50 });
    expect(m.modeloTerceros.find).not.toHaveBeenCalled();
    expect(m.modeloCuentas.find).not.toHaveBeenCalled();
    expect(m.residencia.clavesRevocadas).not.toHaveBeenCalled();
  });

  it('SEC: el correo nunca llega a un log', async () => {
    const espias = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (nivel) => jest.spyOn(Logger.prototype, nivel),
    );
    const t = tercero({ emails: ['secreto@correo.co'] });
    const m = montar({
      terceros: [t],
      inmuebles: [inmueble(t)],
      genericos: [['secreto@correo.co', 'correo-compartido']],
    });
    await m.servicio.listar({ buscar: 'secreto@correo.co' });
    const impreso = JSON.stringify(espias.flatMap((e) => e.mock.calls));
    expect(impreso).not.toContain('secreto@correo.co');
    espias.forEach((e) => e.mockRestore());
  });
});
