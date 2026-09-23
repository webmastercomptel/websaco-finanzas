// src/common/storage/gcs-bucket.provider.ts
import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getStorage } from 'firebase-admin/storage';
import type { App } from 'firebase-admin/app';
import type { Bucket } from '@google-cloud/storage';
import { FIREBASE_APP } from '../firebase/firebase.constants';
import { GCS_BUCKET } from './storage.constants';

/**
 * The one Cloud Storage bucket this backend writes generated documents into.
 *
 * Reuses `firebase-admin/storage` (already a transitive dependency of the
 * `firebase-admin` package this project already has, and already carrying
 * the same credential `firebase.provider.ts` parses) instead of adding
 * `@google-cloud/storage` as a direct dependency — there is nothing left to
 * configure separately, it rides on the same service account.
 *
 * Built from the shared `FIREBASE_APP`, not a second `initializeApp` call —
 * see that provider's own docblock for why initializing twice is unsafe.
 */
export const gcsBucketProvider: Provider = {
  provide: GCS_BUCKET,
  inject: [FIREBASE_APP, ConfigService],
  useFactory: (app: App, config: ConfigService): Bucket => {
    const bucketName = config.get<string>('app.firebaseStorageBucket');

    if (!bucketName) {
      // Unreachable in a validated environment: Joi requires this variable.
      // Kept so a future refactor of the schema fails loudly here instead of
      // silently resolving to this SDK's own "default bucket" guess.
      throw new Error('FIREBASE_STORAGE_BUCKET no está definida.');
    }

    return getStorage(app).bucket(bucketName);
  },
};
