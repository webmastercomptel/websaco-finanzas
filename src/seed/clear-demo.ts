// src/seed/clear-demo.ts
// MUST stay the first import: it sets the process DNS resolvers before the
// Mongo driver performs its SRV lookup. See common/dns-setup.ts.
import '../common/dns-setup';

import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppModule } from '../app.module';

// — Financial documents —
import {
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../database/schemas/recibos/aplicacion-cartera.schema';
import {
  NotaCredito,
  NotaCreditoDocument,
} from '../database/schemas/notas-credito/nota-credito.schema';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../database/schemas/notas-debito/nota-debito.schema';
import {
  NotaContable,
  NotaContableDocument,
} from '../database/schemas/notas-contables/nota-contable.schema';
import {
  Recibo,
  ReciboDocument,
} from '../database/schemas/recibos/recibo.schema';
import {
  AsientoContable,
  AsientoContableDocument,
} from '../database/schemas/facturacion/asiento-contable.schema';
import {
  SaldoCartera,
  SaldoCarteraDocument,
} from '../database/schemas/facturacion/saldo-cartera.schema';
import {
  Factura,
  FacturaDocument,
} from '../database/schemas/facturacion/factura.schema';
import {
  LoteFacturacion,
  LoteFacturacionDocument,
} from '../database/schemas/facturacion/lote-facturacion.schema';
import {
  ConsecutivoDocumento,
  ConsecutivoDocumentoDocument,
} from '../database/schemas/numeracion/consecutivo-documento.schema';
import {
  ConsecutivoLote,
  ConsecutivoLoteDocument,
} from '../database/schemas/facturacion/consecutivo-lote.schema';
import {
  PeriodoContable,
  PeriodoContableDocument,
} from '../database/schemas/contabilidad/periodo-contable.schema';
import {
  CuentaContable,
  CuentaContableDocument,
} from '../database/schemas/contabilidad/cuenta-contable.schema';
import {
  ResolucionFacturacion,
  ResolucionFacturacionDocument,
} from '../database/schemas/numeracion/resolucion-facturacion.schema';
import {
  ValorRecurrente,
  ValorRecurrenteDocument,
} from '../database/schemas/conceptos/valor-recurrente.schema';
import {
  RegistroAuditoria,
  RegistroAuditoriaDocument,
} from '../database/schemas/auditoria/registro-auditoria.schema';

// — Catalog (demo seed) —
import {
  Inmueble,
  InmuebleDocument,
} from '../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroDocument,
} from '../database/schemas/terceros/tercero.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../database/schemas/conceptos/concepto-cobro.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../database/schemas/copropiedades/copropiedad.schema';
import {
  EntidadAdministradora,
  EntidadAdministradoraDocument,
} from '../database/schemas/entidades/entidad-administradora.schema';

/**
 * Removes every document except `usuarios` and `asignaciones`.
 *
 * Collections are wiped in dependency order so that no orphan-reference error
 * can occur mid-run.  Financial documents go first (they reference catalog
 * entities), then the catalog itself.
 *
 *   npm run clear:demo
 */
async function clearDemo(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    // ---------- helper ----------
    const cleared: Array<{ label: string; count: number }> = [];

    async function wipe<T>(label: string, model: Model<T>): Promise<void> {
      const { deletedCount } = await model.deleteMany({});
      cleared.push({ label, count: deletedCount });
    }

    // ---------- 1. Financial documents (downstream) ----------
    const aplicaciones = app.get<Model<AplicacionCarteraDocument>>(
      getModelToken(AplicacionCartera.name),
    );
    const notasCredito = app.get<Model<NotaCreditoDocument>>(
      getModelToken(NotaCredito.name),
    );
    const notasDebito = app.get<Model<NotaDebitoDocument>>(
      getModelToken(NotaDebito.name),
    );
    const notasContables = app.get<Model<NotaContableDocument>>(
      getModelToken(NotaContable.name),
    );
    const recibos = app.get<Model<ReciboDocument>>(getModelToken(Recibo.name));
    const asientos = app.get<Model<AsientoContableDocument>>(
      getModelToken(AsientoContable.name),
    );
    const saldos = app.get<Model<SaldoCarteraDocument>>(
      getModelToken(SaldoCartera.name),
    );
    const facturas = app.get<Model<FacturaDocument>>(
      getModelToken(Factura.name),
    );
    const lotes = app.get<Model<LoteFacturacionDocument>>(
      getModelToken(LoteFacturacion.name),
    );
    const consecutivosDoc = app.get<Model<ConsecutivoDocumentoDocument>>(
      getModelToken(ConsecutivoDocumento.name),
    );
    const consecutivosLote = app.get<Model<ConsecutivoLoteDocument>>(
      getModelToken(ConsecutivoLote.name),
    );
    const periodos = app.get<Model<PeriodoContableDocument>>(
      getModelToken(PeriodoContable.name),
    );
    const cuentasContables = app.get<Model<CuentaContableDocument>>(
      getModelToken(CuentaContable.name),
    );
    const resoluciones = app.get<Model<ResolucionFacturacionDocument>>(
      getModelToken(ResolucionFacturacion.name),
    );
    const valoresRecurrentes = app.get<Model<ValorRecurrenteDocument>>(
      getModelToken(ValorRecurrente.name),
    );

    await wipe('aplicaciones_cartera', aplicaciones);
    await wipe('notas_credito', notasCredito);
    await wipe('notas_debito', notasDebito);
    await wipe('notas_contables', notasContables);
    await wipe('recibos', recibos);
    await wipe('asientos_contables', asientos);
    await wipe('saldos_cartera', saldos);
    await wipe('facturas', facturas);
    await wipe('lotes_facturacion', lotes);
    await wipe('consecutivos_documento', consecutivosDoc);
    await wipe('consecutivos_lote', consecutivosLote);
    await wipe('periodos_contables', periodos);
    await wipe('cuentas_contables', cuentasContables);
    await wipe('resoluciones_facturacion', resoluciones);
    await wipe('valores_recurrentes', valoresRecurrentes);

    // ---------- 2. Audit log ----------
    const auditLog = app.get<Model<RegistroAuditoriaDocument>>(
      getModelToken(RegistroAuditoria.name),
    );
    await wipe('audit_log_entries', auditLog);

    // ---------- 3. Demo catalog (leaf to root) ----------
    const inmuebles = app.get<Model<InmuebleDocument>>(
      getModelToken(Inmueble.name),
    );
    const terceros = app.get<Model<TerceroDocument>>(
      getModelToken(Tercero.name),
    );
    const conceptos = app.get<Model<ConceptoCobroDocument>>(
      getModelToken(ConceptoCobro.name),
    );
    const copropiedades = app.get<Model<CopropiedadDocument>>(
      getModelToken(Copropiedad.name),
    );
    const entidades = app.get<Model<EntidadAdministradoraDocument>>(
      getModelToken(EntidadAdministradora.name),
    );

    await wipe('inmuebles', inmuebles);
    await wipe('terceros', terceros);
    await wipe('conceptos_cobro', conceptos);
    await wipe('copropiedades', copropiedades);
    await wipe('entidades_administradoras', entidades);

    // ---------- summary ----------
    console.log('\n--- Colecciones limpiadas ---');
    for (const { label, count } of cleared) {
      console.log(`  ${label}: ${count} eliminados`);
    }
    console.log('\nusuarios y asignaciones NO fueron tocados.');
  } finally {
    await app.close();
  }
}

void clearDemo().catch((error) => {
  console.error('La limpieza falló:', error);
  process.exitCode = 1;
});
