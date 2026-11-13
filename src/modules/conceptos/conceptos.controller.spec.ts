import { describirRutaGuardada } from '../casl/testing/politica-de-ruta';
import { ConceptosController } from './conceptos.controller';

describirRutaGuardada('DELETE /conceptos/:id (borrado de un cargo sin uso)', {
  controlador: ConceptosController,
  handler: 'delete',
  regla: { action: 'purge', subject: 'ConceptoCobro' },
  claveQueAbre: 'conceptos.depurar',
  clavesQueNoAbren: ['conceptos.ver', 'conceptos.crear', 'conceptos.editar'],
  clavesConvertidas: [
    'conceptos.ver',
    'conceptos.crear',
    'conceptos.editar',
    'conceptos.depurar',
  ],
  gestionarViejo: 'conceptos.gestionar',
});
