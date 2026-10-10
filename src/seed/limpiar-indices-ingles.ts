// src/seed/limpiar-indices-ingles.ts
// MUST stay the first import: it sets the process DNS resolvers before the
// Mongo driver performs its SRV lookup. See common/dns-setup.ts.
import '../common/dns-setup';

import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import mongoose from 'mongoose';

const RAIZ_SCHEMAS = resolve(__dirname, '../database/schemas');

/** A dynamic `import()` of an absolute Windows path goes through the ESM
 *  loader and throws; `createRequire` uses the same CJS hook ts-node already
 *  registered for the static imports above. */
const cargar = createRequire(__filename);

/** The options that change what an index enforces or covers. */
interface Firma {
  clave: string;
  unico: boolean;
  sparse: boolean;
  ttl: number | null;
  parcial: string;
}

type Declarados = Map<string, Map<string, Firma>>;

/** Stable JSON: same content, same string, whatever the key order. */
function ordenado(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(ordenado).join(',')}]`;
  if (valor && typeof valor === 'object') {
    const entradas = Object.entries(valor as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${ordenado(v)}`);
    return `{${entradas.join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'undefined';
}

interface OpcionesIndice {
  name?: string;
  /** Mongoose also accepts `[true, 'message']` here. */
  unique?: boolean | [true, string];
  sparse?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: unknown;
}

function firmaDe(clave: unknown, opciones: OpcionesIndice): Firma {
  return {
    // Key order matters in a compound index, so it is NOT sorted.
    clave: JSON.stringify(clave),
    unico: opciones.unique === true || Array.isArray(opciones.unique),
    sparse: opciones.sparse === true,
    ttl: opciones.expireAfterSeconds ?? null,
    parcial:
      opciones.partialFilterExpression === undefined
        ? ''
        : ordenado(opciones.partialFilterExpression),
  };
}

/** The name Mongoose gives an index unless the schema sets one explicitly. */
function nombreDe(
  campos: Record<string, unknown>,
  opciones: OpcionesIndice,
): string {
  return (
    opciones.name ??
    Object.entries(campos)
      .map(([campo, direccion]) => `${campo}_${String(direccion)}`)
      .join('_')
  );
}

/** Human-readable list of what differs between two index signatures. */
function diferencias(esperada: Firma, viva: Firma): string[] {
  const dif: string[] = [];
  if (esperada.clave !== viva.clave) {
    dif.push(`clave: schema ${esperada.clave} / base ${viva.clave}`);
  }
  if (esperada.unico !== viva.unico) {
    dif.push(`unique: schema ${esperada.unico} / base ${viva.unico}`);
  }
  if (esperada.sparse !== viva.sparse) {
    dif.push(`sparse: schema ${esperada.sparse} / base ${viva.sparse}`);
  }
  if (esperada.ttl !== viva.ttl) {
    dif.push(`ttl: schema ${esperada.ttl} / base ${viva.ttl}`);
  }
  if (esperada.parcial !== viva.parcial) {
    dif.push(
      `partialFilterExpression: schema ${esperada.parcial || '(ninguno)'} / base ${viva.parcial || '(ninguno)'}`,
    );
  }
  return dif;
}

/**
 * Loads every schema file and collects, per collection, the indexes the code
 * declares today. The schemas are the source of truth: an index in the
 * database that none of them declares can never be created again by the app.
 */
function leerDeclarados(): Declarados {
  const archivos = (
    readdirSync(RAIZ_SCHEMAS, { recursive: true }) as string[]
  ).filter((f) => f.endsWith('.schema.ts') || f.endsWith('.schema.js'));

  const declarados: Declarados = new Map();
  for (const archivo of archivos) {
    const modulo = cargar(join(RAIZ_SCHEMAS, archivo)) as Record<
      string,
      unknown
    >;
    for (const valor of Object.values(modulo)) {
      // Only top-level schemas name a collection; subdocument schemas don't.
      if (!(valor instanceof mongoose.Schema)) continue;
      const coleccion: unknown = valor.get('collection');
      if (typeof coleccion !== 'string') continue;
      const indices = declarados.get(coleccion) ?? new Map<string, Firma>();
      for (const [campos, opciones] of valor.indexes()) {
        indices.set(nombreDe(campos, opciones), firmaDe(campos, opciones));
      }
      declarados.set(coleccion, indices);
    }
  }
  return declarados;
}

/**
 * One-off cleanup (owner, 2026-10-02): Mongoose creates the indexes the
 * schemas declare but never drops the ones they used to declare, so after the
 * Spanish rename every collection kept a dead English twin that costs storage
 * and slows each write. Drops every index that no current schema declares
 * (never `_id_`). A collection with no schema is reported, never touched.
 *
 * It also compares the options of every surviving index against its schema
 * and REPORTS differences (never fixes them): `createIndex` silently keeps an
 * old index whose name matches but whose options changed, so a unique or
 * partial index can be quietly wrong.
 *
 * Dry run by default — pass `--aplicar` to actually drop.
 *
 * Connects with Mongoose only (not `AppModule`) so it does not open a Redis
 * client: the Redis plan has a low connection cap.
 *
 *   npm run limpiar:indices-ingles -- --db=production
 *   npm run limpiar:indices-ingles -- --db=production --aplicar
 */
async function limpiar(): Promise<void> {
  const aplicar = process.argv.includes('--aplicar');
  const declarados = leerDeclarados();
  console.log(`Schemas con colección propia: ${declarados.size}`);

  process.loadEnvFile('.env');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in .env');

  // The URI in `.env` names no database, so Mongo falls back to `test`.
  // Dropping is irreversible in practice, so `--aplicar` demands `--db=`.
  const dbNombre = process.argv
    .find((a) => a.startsWith('--db='))
    ?.slice('--db='.length);
  if (aplicar && !dbNombre) {
    throw new Error('--aplicar requires an explicit --db=<name>');
  }

  await mongoose.connect(uri, dbNombre ? { dbName: dbNombre } : {});
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error('No database handle after connect');
    console.log(`Base de datos: ${db.databaseName}`);
    if (db.databaseName !== 'production') {
      console.warn('  (no es "production" — revisá que sea la que querés)');
    }

    let huerfanos = 0;
    const sinSchema: string[] = [];
    const faltantes: string[] = [];
    const distintos: string[] = [];
    const colecciones = (await db.listCollections().toArray())
      .map((c) => c.name)
      .sort();

    for (const nombre of colecciones) {
      const esperados = declarados.get(nombre);
      if (!esperados) {
        sinSchema.push(nombre);
        continue;
      }
      const vivos = await db.collection(nombre).indexes();
      const vivosNombres = new Set(vivos.map((i) => String(i.name)));

      for (const indice of vivos) {
        const nombreIndice = String(indice.name);
        if (nombreIndice === '_id_') continue;
        const esperada = esperados.get(nombreIndice);
        if (!esperada) {
          huerfanos += 1;
          console.log(
            `${aplicar ? 'DROP' : '[simulación]'} ${nombre}.${nombreIndice}`,
          );
          if (aplicar) await db.collection(nombre).dropIndex(nombreIndice);
          continue;
        }
        const dif = diferencias(esperada, firmaDe(indice.key, indice));
        if (dif.length > 0) {
          distintos.push(`${nombre}.${nombreIndice} → ${dif.join('; ')}`);
        }
      }
      for (const esperado of esperados.keys()) {
        if (!vivosNombres.has(esperado))
          faltantes.push(`${nombre}.${esperado}`);
      }
    }

    console.log(
      `${aplicar ? 'Eliminados' : 'Por eliminar'}: ${huerfanos} índices huérfanos.`,
    );
    if (distintos.length > 0) {
      console.warn(
        `Índices con opciones distintas al schema (revisar a mano, no se tocan):\n  ${distintos.join('\n  ')}`,
      );
    } else {
      console.log('Opciones de los índices vivos: coinciden con los schemas.');
    }
    if (sinSchema.length > 0) {
      console.warn(
        `Colecciones sin schema (no tocadas): ${sinSchema.join(', ')}`,
      );
    }
    if (faltantes.length > 0) {
      console.warn(
        `Declarados por el código pero ausentes en la base (no se crean acá): ${faltantes.join(', ')}`,
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

void limpiar()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
