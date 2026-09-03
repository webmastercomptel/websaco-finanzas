// src/seed/seed-cargos.ts
import '../common/dns-setup';

import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppModule } from '../app.module';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../database/schemas/conceptos/concepto-cobro.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../database/schemas/copropiedades/copropiedad.schema';

const COPROPIEDAD_CODE = '0001';

const CARGOS_SISTEMA = [
  { name: 'Administración', kind: 'administracion' as const, sortOrder: 1 },
  { name: 'Intereses por Mora', kind: 'intereses' as const, sortOrder: 2 },
  { name: 'Multas', kind: 'otro' as const, sortOrder: 3 },
];

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const copropiedades = app.get<Model<CopropiedadDocument>>(
    getModelToken(Copropiedad.name),
  );
  const conceptos = app.get<Model<ConceptoCobroDocument>>(
    getModelToken(ConceptoCobro.name),
  );

  const cop = await copropiedades.findOne({ code: COPROPIEDAD_CODE }).exec();
  if (!cop) {
    console.error(`No se encontró la copropiedad con código ${COPROPIEDAD_CODE}`);
    await app.close();
    process.exit(1);
  }

  console.log(`Copropiedad: ${cop.name} (${cop._id})`);

  const existentes = await conceptos
    .find({ coPropertyId: cop._id })
    .exec();
  console.log(`Conceptos existentes: ${existentes.length}`);
  existentes.forEach((c) => console.log(`  - ${c.name} (isSystem: ${c.isSystem})`));

  const nuevos = CARGOS_SISTEMA.filter(
    (s) => !existentes.some((e) => e.kind === s.kind && e.name === s.name),
  );

  if (nuevos.length === 0) {
    console.log('Ya existen todos los cargos de sistema.');
  } else {
    const docs = nuevos.map((c) => ({
      coPropertyId: cop._id,
      name: c.name,
      kind: c.kind,
      taxRate: 0,
      sortOrder: c.sortOrder,
      accountingIncomeAccount: null,
      availableAsNovedad: false,
      active: true,
      isSystem: true,
    }));
    const r = await conceptos.insertMany(docs);
    console.log(`${r.length} cargos de sistema insertados.`);
  }

  const todos = await conceptos
    .find({ coPropertyId: cop._id })
    .sort({ sortOrder: 1 })
    .exec();
  console.log(`Total conceptos: ${todos.length}`);
  todos.forEach((c) => console.log(`  - ${c.name} | ${c.kind} | isSystem: ${c.isSystem}`));

  await app.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
