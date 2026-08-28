// src/seed/seed-admin.ts
// MUST stay the first import: it sets the process DNS resolvers before the
// Mongo driver performs its SRV lookup. See common/dns-setup.ts.
import '../common/dns-setup';

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppModule } from '../app.module';
import {
  Account,
  AccountDocument,
} from '../database/schemas/cuentas/account.schema';

/**
 * Creates the platform administrator account, so somebody can sign in at all.
 *
 * The chicken-and-egg this solves: the API grants nothing without a local
 * account, and accounts are created through the API. One account has to arrive
 * from outside, and this is it.
 *
 * What it deliberately does NOT do is touch the identity provider. The person
 * is created by hand in the Firebase console; this only records that the
 * address is a platform administrator here. The account is bound to a provider
 * identity on first sign-in — see CuentaService.
 *
 * Idempotent: running it twice re-asserts the platform-admin flag and changes
 * nothing else. It never rewrites a name somebody has since corrected.
 *
 *   ROOT_ADMIN_EMAIL=alguien@ejemplo.com npm run seed:admin
 */
async function seedAdmin(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const config = app.get(ConfigService);
    const email = config
      .get<string>('app.rootAdminEmail')
      ?.trim()
      .toLowerCase();

    if (!email) {
      // Unreachable with a validated environment — Joi requires it — but a
      // seed that silently creates nothing is worse than one that says why.
      throw new Error('ROOT_ADMIN_EMAIL no está definida.');
    }

    const accounts = app.get<Model<AccountDocument>>(
      getModelToken(Account.name),
    );

    const existente = await accounts.findOne({ email }).exec();

    if (existente) {
      existente.isPlatformAdmin = true;
      existente.status = 'active';
      await existente.save();
      console.log(
        `Cuenta ${email} ya existía. Confirmado: administrador de plataforma y activa.`,
      );
      return;
    }

    await accounts.create({
      // Empty until the person signs in and CuentaService binds the real one.
      // Not a placeholder value: an invented uid would match nobody and would
      // quietly shadow the correct binding.
      firebaseUid: `pendiente:${email}`,
      email,
      fullName: 'Administrador de plataforma',
      isPlatformAdmin: true,
      status: 'active',
    });

    console.log(`Cuenta ${email} creada como administrador de plataforma.`);
    console.log(
      'Falta crear esa misma dirección como usuario en la consola de Firebase, si todavía no existe.',
    );
  } finally {
    await app.close();
  }
}

void seedAdmin().catch((error) => {
  console.error('El seed falló:', error);
  process.exitCode = 1;
});
