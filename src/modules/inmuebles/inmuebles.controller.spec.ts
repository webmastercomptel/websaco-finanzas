import { describirRutaGuardada } from '../casl/testing/politica-de-ruta';
import { InmueblesController } from './inmuebles.controller';

// The controller imports the report service, which pulls in the PDF renderer
// (not loadable under jest) — the roster PDF is irrelevant here.
jest.mock('../../common/pdf/inmuebles-listado-pdf', () => ({
  generarPdfListadoInmuebles: jest.fn(),
}));

describirRutaGuardada(
  'DELETE /inmuebles/:id (borrado de una unidad sin facturas)',
  {
    controlador: InmueblesController,
    handler: 'eliminar',
    regla: { action: 'purge', subject: 'Inmueble' },
    claveQueAbre: 'inmuebles.depurar',
    clavesQueNoAbren: ['inmuebles.ver', 'inmuebles.crear', 'inmuebles.editar'],
    clavesConvertidas: [
      'inmuebles.ver',
      'inmuebles.crear',
      'inmuebles.editar',
      'inmuebles.depurar',
    ],
    gestionarViejo: 'inmuebles.gestionar',
  },
);
