import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Response } from 'express';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  CHECK_ANY_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { InformeGestionController } from './informe-gestion.controller';
import type { InformeGestionService } from './informe-gestion.service';

// The controller imports the service, which imports the @react-pdf builder.
jest.mock('../../common/pdf/informe-gestion-pdf', () => ({
  generarPdfInformeGestion: jest.fn(),
}));

describe('InformeGestionController', () => {
  const handler = Object.getOwnPropertyDescriptor(
    InformeGestionController.prototype,
    'generarPdf',
  )?.value as object;

  it('cuelga de informe-gestion/pdf por GET', () => {
    expect(Reflect.getMetadata(PATH_METADATA, InformeGestionController)).toBe(
      'informe-gestion',
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('pdf');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(0);
  });

  it('es del módulo administracion y exige leer alguna de las tres entidades', () => {
    expect(Reflect.getMetadata(MODULO_KEY, InformeGestionController)).toBe(
      'administracion',
    );
    const reglas = Reflect.getMetadata(
      CHECK_ANY_ABILITY_KEY,
      handler,
    ) as RequiredRule[];
    expect(reglas.map((r) => `${r.action}:${r.subject}`).sort()).toEqual([
      'read:Actividad',
      'read:Mantenimiento',
      'read:Pqr',
    ]);
  });

  it('responde el PDF inline con el nombre del período', async () => {
    const bytes = Buffer.from('pdf');
    const service = { generarPdf: jest.fn().mockResolvedValue(bytes) };
    const controller = new InformeGestionController(
      service as unknown as InformeGestionService,
    );
    const res = { set: jest.fn(), send: jest.fn() };
    const user = { uid: 'u' } as IRequestUser;
    const dto = { desde: '2026-03-01', hasta: '2026-03-31' };

    await controller.generarPdf(user, dto, res as unknown as Response);

    expect(service.generarPdf).toHaveBeenCalledWith(user, dto);
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        'inline; filename="soporte-infogestion-2026-03-01-a-2026-03-31.pdf"',
    });
    expect(res.send).toHaveBeenCalledWith(bytes);
  });
});
