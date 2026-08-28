// src/common/firebase/firebase.provider.ts
import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  cert,
  getApps,
  initializeApp,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { FIREBASE_AUTH } from './firebase.constants';

/**
 * The credential as Google actually writes it: snake_case keys. The SDK's
 * `ServiceAccount` interface is camelCase, so the decoded JSON is validated
 * against this shape and only then normalized — never cast straight across.
 */
type RawServiceAccount = Partial<
  Record<'project_id' | 'private_key' | 'client_email', string>
>;

/**
 * Decodes the base64 service account and returns it as a `ServiceAccount`.
 *
 * Both spellings are accepted because the file downloaded from the Firebase
 * console is snake_case while the SDK's own type is camelCase; a credential
 * hand-assembled from the SDK type is just as valid.
 *
 * A malformed credential is fatal and must say so precisely: the alternative is
 * a process that boots fine and then rejects every login with a generic 401,
 * which is a miserable thing to debug.
 */
const parseServiceAccount = (base64: string): ServiceAccount => {
  let decoded: string;
  try {
    decoded = Buffer.from(base64, 'base64').toString('utf-8');
  } catch {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_BASE64 no es Base64 válido. Volvé a generarlo.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_BASE64 no contiene un JSON válido. ' +
        'Asegurate de haber codificado el archivo .json completo, en una sola línea.',
    );
  }

  const account = parsed as Partial<ServiceAccount> & RawServiceAccount;
  // The project id is what makes token verification possible at all: it is
  // what the `aud`/`iss` claims are checked against.
  const projectId = account.projectId ?? account.project_id;
  const privateKey = account.privateKey ?? account.private_key;
  const clientEmail = account.clientEmail ?? account.client_email;

  if (!projectId || !privateKey || !clientEmail) {
    throw new Error(
      'La credencial de Firebase no tiene los campos esperados ' +
        '(project_id, private_key, client_email). ¿Codificaste el archivo correcto?',
    );
  }

  return { projectId, privateKey, clientEmail };
};

/**
 * The shared Firebase Auth instance.
 *
 * Only ever used to VERIFY tokens. This project does not create, list, update
 * or delete users: accounts are provisioned by hand in the Firebase console.
 * That is a deliberate limit, not a missing feature — see AGENTS.md.
 *
 * `getApps()` is checked first because Jest can load this module more than once
 * in a single process, and initializing twice throws.
 */
export const firebaseAuthProvider: Provider = {
  provide: FIREBASE_AUTH,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Auth => {
    const logger = new Logger('Firebase');
    const base64 = config.get<string>('app.firebaseServiceAccountBase64');

    if (!base64) {
      // Unreachable in a validated environment: Joi requires this variable.
      // Kept as a guard so a future refactor of the schema fails loudly here
      // instead of producing an SDK that silently authenticates nobody.
      throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 no está definida.');
    }

    const serviceAccount = parseServiceAccount(base64);
    const app =
      getApps()[0] ??
      initializeApp({
        credential: cert(serviceAccount),
        // Passed explicitly: `initializeApp` does not lift the project id out
        // of the credential, so without this `app.options.projectId` is
        // undefined and every diagnostic below it reads "desconocido".
        projectId: serviceAccount.projectId,
      });

    logger.log(
      `Firebase Admin inicializado (proyecto ${app.options.projectId ?? 'desconocido'})`,
    );
    return getAuth(app);
  },
};
