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
  { nombre: 'Administración', tipo: 'administracion' as const, orden: 1 },
  { nombre: 'Intereses por Mora', tipo: 'intereses' as const, orden: 2 },
  { nombre: 'Multas', tipo: 'otro' as const, orden: 3 },
];

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const copropiedades = app.get<Model<CopropiedadDocument>>(
    getModelToken(Copropiedad.name),
  );
  const conceptos = app.get<Model<ConceptoCobroDocument>>(
    getModelToken(ConceptoCobro.name),
  );

  const cop = await copropiedades.findOne({ codigo: COPROPIEDAD_CODE }).exec();
  if (!cop) {
    console.error(
      `No se encontró la copropiedad con código ${COPROPIEDAD_CODE}`,
    );
    await app.close();
    process.exit(1);
  }

  console.log(`Copropiedad: ${cop.nombre} (${cop._id.toString()})`);

  const existentes = await conceptos.find({ copropiedadId: cop._id }).exec();
  console.log(`Conceptos existentes: ${existentes.length}`);
  existentes.forEach((c) =>
    console.log(`  - ${c.nombre} (sistema: ${c.sistema})`),
  );

  const nuevos = CARGOS_SISTEMA.filter(
    (s) => !existentes.some((e) => e.tipo === s.tipo && e.nombre === s.nombre),
  );

  if (nuevos.length === 0) {
    console.log('Ya existen todos los cargos de sistema.');
  } else {
    const docs = nuevos.map((c) => ({
      copropiedadId: cop._id,
      nombre: c.nombre,
      tipo: c.tipo,
      tasaImpuesto: 0,
      orden: c.orden,
      accountingIncomeAccount: null,
      cargaXls: false,
      active: true,
      sistema: true,
    }));
    const r = await conceptos.insertMany(docs);
    console.log(`${r.length} cargos de sistema insertados.`);
  }

  const todos = await conceptos
    .find({ copropiedadId: cop._id })
    .sort({ orden: 1 })
    .exec();
  console.log(`Total conceptos: ${todos.length}`);
  todos.forEach((c) =>
    console.log(`  - ${c.nombre} | ${c.tipo} | sistema: ${c.sistema}`),
  );

  await app.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
