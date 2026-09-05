import { CatalogosService } from './catalogos.service';

describe('CatalogosService', () => {
  const service = new CatalogosService();

  it('lista los 12 tipos de identificación DIAN', () => {
    const tipos = service.listarTiposIdentificacion();

    expect(tipos).toHaveLength(12);
    expect(tipos).toContainEqual({
      codigo: '13',
      nombre: 'Cedula de Ciudadania',
    });
    expect(tipos).toContainEqual({ codigo: '31', nombre: 'Nit' });
  });

  it('lista los 33 departamentos', () => {
    const departamentos = service.listarDepartamentos();

    expect(departamentos).toHaveLength(33);
    expect(departamentos).toContainEqual({ codigo: '11', nombre: 'Bogota' });
    expect(departamentos).toContainEqual({
      codigo: '76',
      nombre: 'Valle del Cauca',
    });
  });

  it('lista los 1123 municipios sin filtro', () => {
    const ciudades = service.listarCiudades();

    expect(ciudades).toHaveLength(1123);
    expect(ciudades).toContainEqual({
      codigo: '05001',
      nombre: 'Medellin',
      departamentoCodigo: '05',
    });
  });

  it('filtra los municipios por departamento', () => {
    const ciudades = service.listarCiudades('11');

    expect(ciudades).toHaveLength(1);
    expect(ciudades[0]).toEqual({
      codigo: '11001',
      nombre: 'Bogota D.C',
      departamentoCodigo: '11',
    });
  });

  it('un departamento sin municipios propios devuelve una lista vacía, no un error', () => {
    expect(service.listarCiudades('00')).toEqual([]);
  });
});
