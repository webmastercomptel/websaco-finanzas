// src/modules/factura-publica/factura-publica.module.ts
import { Module } from '@nestjs/common';
import { EnlaceFacturaService } from './enlace-factura.service';
import { FacturaPublicaController } from './factura-publica.controller';

/**
 * Public, account-less access to ONE invoice PDF through an emailed link.
 *
 * Models come from the @Global DatabaseModule; the Redis limiter, the stored
 * PDF lookup and the storage service from the @Global CommonModule. Exports the
 * link service so the invoice send (`envio-facturas`) can mint and revoke
 * links. It imports no financial module: it reads the invoice by id, scoped by
 * the tenant of the link row.
 */
@Module({
  controllers: [FacturaPublicaController],
  providers: [EnlaceFacturaService],
  exports: [EnlaceFacturaService],
})
export class FacturaPublicaModule {}
