// src/modules/envio-facturas/testing/coleccion-memoria.ts
//
// A tiny in-memory stand-in for the Mongoose model of the send queue, used only
// by specs. It implements the handful of operators the queue uses with MongoDB's
// semantics where they matter for these tests: every write is applied to a
// document only if the filter still matches it AT WRITE TIME (that is the
// atomicity the claim protocol relies on), and each call yields once so two
// concurrent callers really interleave.

import { Types } from 'mongoose';

type Doc = Record<string, unknown>;

const esNulo = (v: unknown): boolean => v === null || v === undefined;

/** Equality the way MongoDB compares the values used here (ids, dates, scalars). */
function igual(a: unknown, b: unknown): boolean {
  if (esNulo(a) || esNulo(b)) return esNulo(a) && esNulo(b);
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  if (typeof a === 'object' || typeof b === 'object') {
    return String(a) === String(b);
  }
  return a === b;
}

function orden(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  return Number(v);
}

function cumple(valor: unknown, condicion: unknown): boolean {
  const esOperador =
    condicion !== null &&
    typeof condicion === 'object' &&
    !(condicion instanceof Date) &&
    Object.keys(condicion).some((k) => k.startsWith('$'));
  if (!esOperador) {
    if (Array.isArray(valor)) return valor.some((x) => igual(x, condicion));
    return igual(valor, condicion);
  }
  const ops = condicion as Record<string, unknown>;
  return Object.entries(ops).every(([op, esperado]) => {
    switch (op) {
      case '$in':
        return (esperado as unknown[]).some((x) => igual(valor, x));
      case '$ne':
        // On an array path, `$ne` means NO element equals the value.
        return Array.isArray(valor)
          ? !valor.some((x) => igual(x, esperado))
          : !igual(valor, esperado);
      case '$lt':
        return !esNulo(valor) && orden(valor) < orden(esperado);
      case '$lte':
        return !esNulo(valor) && orden(valor) <= orden(esperado);
      case '$gt':
        return !esNulo(valor) && orden(valor) > orden(esperado);
      default:
        throw new Error(`Operador de filtro no soportado: ${op}`);
    }
  });
}

/** MongoDB filter matching for the operators the queue uses. */
export function coincide(doc: Doc, filtro: Record<string, unknown>): boolean {
  return Object.entries(filtro).every(([clave, condicion]) => {
    if (clave === '$or') {
      return (condicion as Record<string, unknown>[]).some((f) =>
        coincide(doc, f),
      );
    }
    if (clave === '$and') {
      return (condicion as Record<string, unknown>[]).every((f) =>
        coincide(doc, f),
      );
    }
    return cumple(valorDeRuta(doc, clave), condicion);
  });
}

/** `a.b` over arrays of subdocuments yields the array of their `b`. */
function valorDeRuta(doc: Doc, ruta: string): unknown {
  if (!ruta.includes('.')) return doc[ruta];
  let actual: unknown = doc;
  for (const parte of ruta.split('.')) {
    if (Array.isArray(actual)) {
      actual = actual.map((x) => (x as Doc | null)?.[parte]);
    } else if (actual !== null && typeof actual === 'object') {
      actual = (actual as Doc)[parte];
    } else {
      return undefined;
    }
  }
  return actual;
}

function clonar<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map(clonar) as unknown as T;
  if (valor instanceof Date) return new Date(valor.getTime()) as unknown as T;
  if (
    valor !== null &&
    typeof valor === 'object' &&
    Object.getPrototypeOf(valor) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(valor).map(([k, v]) => [k, clonar(v)]),
    ) as T;
  }
  return valor;
}

function aplicar(doc: Doc, update: Record<string, unknown>): void {
  for (const [op, campos] of Object.entries(update)) {
    for (const [campo, valor] of Object.entries(
      campos as Record<string, unknown>,
    )) {
      if (op === '$set') doc[campo] = valor;
      else if (op === '$setOnInsert') continue;
      else if (op === '$push') {
        const lista = (doc[campo] as unknown[] | undefined) ?? [];
        lista.push(clonar(valor));
        doc[campo] = lista;
      } else if (op === '$min') {
        if (esNulo(doc[campo]) || orden(valor) < orden(doc[campo])) {
          doc[campo] = valor;
        }
      } else if (op === '$inc') {
        doc[campo] = Number(doc[campo] ?? 0) + Number(valor);
      } else if (op === '$addToSet') {
        const lista = (doc[campo] as unknown[]) ?? [];
        if (!lista.some((x) => igual(x, valor))) lista.push(valor);
        doc[campo] = lista;
      } else throw new Error(`Operador de actualización no soportado: ${op}`);
    }
  }
}

const ceder = (): Promise<void> => Promise.resolve();

/** Query-like object: chainable, awaited through `exec()`. */
function consulta<T>(resolver: () => Promise<T>) {
  const q = {
    sort: () => q,
    limit: () => q,
    skip: () => q,
    select: () => q,
    lean: () => q,
    exec: resolver,
  };
  return q;
}

/** The queue's collection, with the model methods the services call. */
export class ColeccionMemoria {
  readonly docs: Doc[] = [];
  /** Every `updateMany`/`updateOne`/`bulkWrite` call, for assertions. */
  readonly escrituras: string[] = [];
  /**
   * Microtask ticks each upcoming `updateMany` waits before it applies, consumed
   * one per call. Lets a spec put the second caller's write AFTER the first
   * caller finished claiming, the adversarial order a filter-less claim fails.
   */
  retrasoUpdateMany: number[] = [];

  constructor(private readonly unica: string[] = []) {}

  insertar(doc: Doc): Doc {
    this.docs.push(doc);
    return doc;
  }

  find(filtro: Record<string, unknown> = {}) {
    let limite = Infinity;
    let claves: string[] | null = null;
    const q = consulta(async () => {
      await ceder();
      return this.docs
        .filter((d) => coincide(d, filtro))
        .slice(0, limite)
        .map((d) => clonar(d));
    });
    q.limit = ((n: number) => {
      limite = n;
      return q;
    }) as typeof q.limit;
    q.select = ((s: string) => {
      claves = s.split(' ');
      return q;
    }) as typeof q.select;
    void claves;
    return q;
  }

  findOne(filtro: Record<string, unknown> = {}) {
    return consulta(async () => {
      await ceder();
      const d = this.docs.find((x) => coincide(x, filtro));
      return d ? clonar(d) : null;
    });
  }

  findById(id: unknown) {
    return this.findOne({ _id: id });
  }

  /** Inserts one document; the keys of `unica` act as a unique index. */
  async create(doc: Doc): Promise<Doc> {
    await ceder();
    const nuevo: Doc = { _id: new Types.ObjectId(), ...clonar(doc) };
    if (
      this.unica.length > 0 &&
      this.docs.some((d) => this.unica.every((k) => igual(d[k], nuevo[k])))
    ) {
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
    this.docs.push(nuevo);
    return clonar(nuevo);
  }

  exists(filtro: Record<string, unknown>) {
    return consulta(async () => {
      await ceder();
      const d = this.docs.find((x) => coincide(x, filtro));
      return d ? { _id: d._id } : null;
    });
  }

  countDocuments(filtro: Record<string, unknown> = {}) {
    return consulta(async () => {
      await ceder();
      return this.docs.filter((d) => coincide(d, filtro)).length;
    });
  }

  updateMany(filtro: Record<string, unknown>, update: Record<string, unknown>) {
    return consulta(async () => {
      await ceder();
      for (let i = this.retrasoUpdateMany.shift() ?? 0; i > 0; i -= 1) {
        await ceder();
      }
      this.escrituras.push('updateMany');
      let encontrados = 0;
      let modificados = 0;
      for (const d of this.docs) {
        if (!coincide(d, filtro)) continue;
        encontrados += 1;
        aplicar(d, update);
        modificados += 1;
      }
      return { matchedCount: encontrados, modifiedCount: modificados };
    });
  }

  updateOne(filtro: Record<string, unknown>, update: Record<string, unknown>) {
    return consulta(async () => {
      await ceder();
      this.escrituras.push('updateOne');
      const d = this.docs.find((x) => coincide(x, filtro));
      if (!d) return { matchedCount: 0, modifiedCount: 0 };
      aplicar(d, update);
      return { matchedCount: 1, modifiedCount: 1 };
    });
  }

  /** Only `updateOne` upserts with `$setOnInsert`, the one shape the queue uses. */
  async bulkWrite(
    ops: {
      updateOne: {
        filter: Record<string, unknown>;
        update: Record<string, Record<string, unknown>>;
        upsert?: boolean;
      };
    }[],
  ) {
    await ceder();
    this.escrituras.push('bulkWrite');
    let upsertedCount = 0;
    for (const { updateOne } of ops) {
      const existente = this.docs.find((d) => coincide(d, updateOne.filter));
      if (existente) {
        aplicar(existente, updateOne.update);
        continue;
      }
      if (!updateOne.upsert) continue;
      const nuevo: Doc = {
        _id: new Types.ObjectId(),
        ...clonar(updateOne.update.$setOnInsert ?? {}),
      };
      if (
        this.unica.length > 0 &&
        this.docs.some((d) => this.unica.every((k) => igual(d[k], nuevo[k])))
      ) {
        continue;
      }
      this.docs.push(nuevo);
      upsertedCount += 1;
    }
    return { upsertedCount };
  }
}
