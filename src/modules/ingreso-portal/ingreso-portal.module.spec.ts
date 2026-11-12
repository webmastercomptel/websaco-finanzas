import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ClsService } from 'nestjs-cls';
import { CuentaService } from '../../common/cuentas/cuenta.service';
import { AccesoService } from '../../common/acceso/acceso.service';
import { ResidenciaService } from '../../common/acceso/residencia.service';
import { CorreoService } from '../../common/correo/correo.service';
import { FIREBASE_AUTH } from '../../common/firebase/firebase.constants';
import { FirebaseUsuariosService } from '../../common/firebase/firebase-usuarios.service';
import { LimiteIntentosService } from '../../common/redis/limite-intentos.service';
import { Account } from '../../database/schemas/cuentas/account.schema';
import { Asignacion } from '../../database/schemas/cuentas/asignacion.schema';
import { EnlaceIngreso } from '../../database/schemas/cuentas/enlace-ingreso.schema';
import { RegistroAuditoria } from '../../database/schemas/auditoria/registro-auditoria.schema';
import { Tercero } from '../../database/schemas/terceros/tercero.schema';
import { IngresoPortalController } from './ingreso-portal.controller';
import { IngresoPortalModule } from './ingreso-portal.module';
import { IngresoPortalService } from './ingreso-portal.service';

const vacio = {};
// `MongooseModule.forFeature` (the audit module) asks the connection for its models.
const conexion = { models: {}, model: () => ({}) };

/**
 * Stand-ins for what the @Global DatabaseModule and CommonModule provide, so
 * the test proves the module DECLARES everything else it needs (the local
 * providers and the audit module). It does not prove the globals export what
 * is listed here: the first `start:dev` or a deploy readiness check does.
 */
@Global()
@Module({
  providers: [
    ...[Account, Asignacion, EnlaceIngreso, Tercero, RegistroAuditoria].map(
      (modelo) => ({ provide: getModelToken(modelo.name), useValue: vacio }),
    ),
    { provide: getConnectionToken(), useValue: conexion },
    ...[
      AccesoService,
      ResidenciaService,
      CorreoService,
      LimiteIntentosService,
      FirebaseUsuariosService,
      ConfigService,
      ClsService,
      CuentaService,
    ].map((token) => ({ provide: token, useValue: vacio })),
    { provide: FIREBASE_AUTH, useValue: vacio },
  ],
  exports: [
    getConnectionToken(),
    ...[Account, Asignacion, EnlaceIngreso, Tercero, RegistroAuditoria].map(
      (modelo) => getModelToken(modelo.name),
    ),
    AccesoService,
    ResidenciaService,
    CorreoService,
    LimiteIntentosService,
    FirebaseUsuariosService,
    ConfigService,
    ClsService,
    CuentaService,
    FIREBASE_AUTH,
  ],
})
class GlobalesDePrueba {}

@Module({ imports: [GlobalesDePrueba, IngresoPortalModule] })
class RaizDePrueba {}

describe('IngresoPortalModule', () => {
  it('wires the controller and the service with the global modules only', async () => {
    const app = await NestFactory.createApplicationContext(RaizDePrueba, {
      logger: false,
      abortOnError: false,
    });

    expect(app.get(IngresoPortalController)).toBeInstanceOf(
      IngresoPortalController,
    );
    expect(app.get(IngresoPortalService)).toBeInstanceOf(IngresoPortalService);
    await app.close();
  });
});
