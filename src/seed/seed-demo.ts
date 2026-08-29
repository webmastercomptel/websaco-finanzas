// src/seed/seed-demo.ts
// MUST stay the first import: it sets the process DNS resolvers before the
// Mongo driver performs its SRV lookup. See common/dns-setup.ts.
import '../common/dns-setup';

import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppModule } from '../app.module';
import {
  EntidadAdministradora,
  EntidadAdministradoraDocument,
} from '../database/schemas/entidades/entidad-administradora.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../database/schemas/copropiedades/copropiedad.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../database/schemas/conceptos/concepto-cobro.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroDocument,
} from '../database/schemas/terceros/tercero.schema';

/**
 * Loads a plausible set of buildings to work against.
 *
 * Twelve of them, and that number is the point: a managing company runs ten or
 * more, so anything built on top — the picker above all — has to be exercised
 * at a size where scrolling a list stops being reasonable. Seeding two would
 * make a bad picker look fine.
 *
 * Idempotent, keyed by code: run it as often as you like. It never overwrites a
 * name somebody has since corrected, because re-running a seed must not undo
 * real work.
 *
 *   npm run seed:demo
 */

/** Concepts every building starts with. The first two are not optional. */
const CONCEPTOS_BASE = [
  { name: 'Administración', kind: 'administracion' as const, sortOrder: 10 },
  { name: 'Intereses', kind: 'intereses' as const, sortOrder: 20 },
  { name: 'Multas', kind: 'otro' as const, sortOrder: 30 },
  { name: 'Cuota parqueadero', kind: 'otro' as const, sortOrder: 40 },
  { name: 'Servicios públicos', kind: 'otro' as const, sortOrder: 50 },
];

const EDIFICIOS_ADMINISTRADOS = [
  'Terrazas de Granada',
  'Portal del Río',
  'Altos de la Colina',
  'Miradores del Parque',
  'Balcones de San José',
  'Reserva del Bosque',
  'Torres del Lago',
  'Alameda Real',
  'Cañaveral Plaza',
  'Bosques de Santa Ana',
];

const EDIFICIOS_INDEPENDIENTES = ['Conjunto El Nogal', 'Edificio Palma Verde'];

const NOMBRES = [
  'Carlos Mendoza',
  'Lucía Fernández',
  'Roberto Salazar',
  'Ana María Gutiérrez',
  'Jorge Iván Restrepo',
  'Claudia Patricia Ríos',
  'Grupo Inversor S.A.',
  'Miguel Ángel Torres',
  'Sandra Milena Ochoa',
  'Boutique Bella Ltda.',
  'Fernando Arboleda',
  'Beatriz Elena Cardona',
];

/**
 * How many units each building gets.
 *
 * The first one gets more than a page-worth on purpose: pagination that is only
 * ever exercised against twelve rows is pagination nobody has tested.
 */
const UNIDADES_PRIMER_EDIFICIO = 60;
const UNIDADES_RESTO = 10;

async function seedDemo(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const entidades = app.get<Model<EntidadAdministradoraDocument>>(
      getModelToken(EntidadAdministradora.name),
    );
    const copropiedades = app.get<Model<CopropiedadDocument>>(
      getModelToken(Copropiedad.name),
    );
    const conceptos = app.get<Model<ConceptoCobroDocument>>(
      getModelToken(ConceptoCobro.name),
    );
    const inmuebles = app.get<Model<InmuebleDocument>>(
      getModelToken(Inmueble.name),
    );
    const terceros = app.get<Model<TerceroDocument>>(
      getModelToken(Tercero.name),
    );

    // 1. The managing company.
    const entidad = await entidades.findOneAndUpdate(
      { code: 'ENT-001' },
      {
        $setOnInsert: {
          code: 'ENT-001',
          name: 'Administraciones Calad',
          status: 'active',
        },
      },
      { upsert: true, new: true },
    );
    console.log(`Entidad ${entidad.name} lista.`);

    // 2. The buildings. Ten under the company, two self-administered — enough
    // to show that both routes to access resolve, not just the common one.
    const definiciones = [
      ...EDIFICIOS_ADMINISTRADOS.map((name, i) => ({
        code: `COP-${String(i + 1).padStart(3, '0')}`,
        name,
        managingEntityId: entidad._id,
        administratorName: null,
      })),
      ...EDIFICIOS_INDEPENDIENTES.map((name, i) => ({
        code: `COP-${String(EDIFICIOS_ADMINISTRADOS.length + i + 1).padStart(3, '0')}`,
        name,
        managingEntityId: null,
        administratorName: 'Administración propia',
      })),
    ];

    let creadas = 0;
    for (const def of definiciones) {
      const resultado = await copropiedades.findOneAndUpdate(
        { code: def.code },
        { $setOnInsert: { ...def, status: 'active', city: 'Bogotá' } },
        { upsert: true, new: true, includeResultMetadata: true },
      );

      const copropiedad = resultado.value!;
      if (!resultado.lastErrorObject?.updatedExisting) creadas += 1;

      // 3. Base concepts for each building. Every one needs at least the two
      // the billing cycle is built around.
      for (const concepto of CONCEPTOS_BASE) {
        await conceptos.updateOne(
          { coPropertyId: copropiedad._id, name: concepto.name },
          {
            $setOnInsert: {
              coPropertyId: copropiedad._id,
              ...concepto,
              active: true,
            },
          },
          { upsert: true },
        );
      }
    }

    console.log(
      `${definiciones.length} copropiedades listas (${creadas} nuevas), ` +
        `cada una con ${CONCEPTOS_BASE.length} conceptos de cobro.`,
    );

    // 4. Units, each with the party responsible for it. Without these there is
    // nothing to bill and every screen downstream is empty.
    const todas = await copropiedades.find().select('_id code').lean().exec();
    let unidades = 0;

    for (const [indice, cop] of todas.entries()) {
      const cuantas = indice === 0 ? UNIDADES_PRIMER_EDIFICIO : UNIDADES_RESTO;

      for (let i = 1; i <= cuantas; i += 1) {
        // 101..1xx style codes: floor and door, the way residents say them.
        const piso = Math.floor((i - 1) / 4) + 1;
        const puerta = ((i - 1) % 4) + 1;
        const code = `${piso}0${puerta}`;
        const nombre = NOMBRES[(indice + i) % NOMBRES.length];
        const esEmpresa = nombre.includes('S.A.') || nombre.includes('Ltda.');

        const tercero = await terceros.findOneAndUpdate(
          { coPropertyId: cop._id, identificationNumber: `${cop.code}-${i}` },
          {
            $setOnInsert: {
              coPropertyId: cop._id,
              personType: esEmpresa ? 'juridica' : 'natural',
              name: nombre,
              identificationType: esEmpresa ? 'NIT' : 'CC',
              identificationNumber: `${cop.code}-${i}`,
              status: 'active',
            },
          },
          { upsert: true, new: true },
        );

        await inmuebles.updateOne(
          { coPropertyId: cop._id, code },
          {
            $setOnInsert: {
              coPropertyId: cop._id,
              code,
              block: piso <= 8 ? 'Torre A' : 'Torre B',
              area: 60 + ((i * 7) % 45),
              // Shares that vary per unit, as they really do — a building where
              // every unit has the same coefficient is not a building.
              participationFactor:
                Math.round((100 / cuantas + ((i % 5) - 2) * 0.05) * 10000) /
                10000,
              holderId: tercero._id,
              holderKind: i % 7 === 0 ? 'arrendatario' : 'propietario',
              holderResides: i % 9 !== 0,
              collectionStatus:
                i % 13 === 0
                  ? 'juridico'
                  : i % 11 === 0
                    ? 'dificil_recaudo'
                    : 'al_dia',
              status: i % 17 === 0 ? 'inactive' : 'active',
            },
          },
          { upsert: true },
        );
        unidades += 1;
      }
    }

    console.log(`${unidades} inmuebles listos, cada uno con su titular.`);
    console.log(
      'Entrá con la cuenta de administrador de plataforma: las ve todas.',
    );
  } finally {
    await app.close();
  }
}

void seedDemo().catch((error) => {
  console.error('El seed falló:', error);
  process.exitCode = 1;
});
