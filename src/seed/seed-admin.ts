// src/seed/seed-admin.ts
// MUST stay the first import: it sets the process DNS resolvers before the
// Mongo driver performs its SRV lookup. See common/dns-setup.ts.
import '../common/dns-setup';
// MUST stay the second import, before `../app.module`: it loads `.env.<name>`
// from `--env=<name>` before the config is validated. See load-script-env.ts.
import { confirmScriptEnv } from '../common/scripts/load-script-env';

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
 * The environment is chosen with `--env=<ambiente>` (reads `.env.<ambiente>`;
 * the `--` is required or npm swallows the flag). `ROOT_ADMIN_EMAIL` must be
 * defined in that file: the file is the only source of variables in script
 * mode, so one exported in the shell is discarded (and reported).
 *
 *   npm run seed:admin -- --env=<ambiente>
 */
async function seedAdmin(): Promise<void> {
  await confirmScriptEnv();
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
      existente.esAdministradorPlataforma = true;
      existente.estado = 'active';
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
      nombreCompleto: 'Administrador de plataforma',
      esAdministradorPlataforma: true,
      estado: 'active',
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
