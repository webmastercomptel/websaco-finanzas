import { Module } from '@nestjs/common';
import { ComptableClient } from './comptable.client';

/**
 * Just the signed Comptable client, with no dependencies of its own
 * (ConfigModule is global). Split from `InterfazComptableModule` so
 * `CopropiedadesModule` can validate a `comptableEmpresaId` without pulling
 * in the facturación/contabilidad graph that the send flow needs.
 */
@Module({
  providers: [ComptableClient],
  exports: [ComptableClient],
})
export class ComptableClientModule {}
