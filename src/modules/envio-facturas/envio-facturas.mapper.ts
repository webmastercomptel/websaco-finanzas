// src/modules/envio-facturas/envio-facturas.mapper.ts
import type { EnvioFactura as EnvioContrato } from '../../contracts';
import type { EnvioFacturaDocument } from '../../database/schemas/facturacion/envio-factura.schema';

/**
 * Queue row as staff sees it. Picks fields one by one: lease tokens, the run id
 * and the account ids of the people reached never leave the server — the screen
 * only needs how many.
 */
export function toEnvioFactura(doc: EnvioFacturaDocument): EnvioContrato {
  return {
    id: doc._id.toString(),
    facturaId: doc.facturaId.toString(),
    inmuebleId: doc.inmuebleId.toString(),
    codigoInmueble: doc.codigoInmueble,
    numeroCompleto: doc.numeroCompleto,
    loteId: doc.loteId ? doc.loteId.toString() : null,
    estado: doc.estado,
    marcadoPor: doc.marcadoPorNombre,
    marcadoEn: doc.marcadoEn.toISOString(),
    procesadoPor: doc.procesadoPorNombre || null,
    liberadaEn: doc.liberadaEn ? doc.liberadaEn.toISOString() : null,
    enviadoEn: doc.enviadoEn ? doc.enviadoEn.toISOString() : null,
    destinatarios: doc.destinatariosTotal,
    notificados: doc.notificadosIds.length,
    correosEnviados: doc.correosEnviadosIds.length,
    intentos: doc.intentos,
    ultimoError: doc.ultimoError,
  };
}
