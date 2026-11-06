import { Types } from 'mongoose';
import { toTercero } from './terceros.mapper';
import type { TerceroDocument } from '../../database/schemas/terceros/tercero.schema';

describe('toTercero', () => {
  it('no expone la cuenta vinculada en ninguna parte de la respuesta', () => {
    const cuenta = new Types.ObjectId();
    const doc = {
      _id: new Types.ObjectId(),
      tipoPersona: 'natural',
      nombre: 'Ana Pérez',
      emails: ['ana@ejemplo.com'],
      responsabilidadesFiscales: [],
      estado: 'active',
      accountId: cuenta,
    } as unknown as TerceroDocument;

    const contrato = toTercero(doc);

    expect(JSON.stringify(contrato)).not.toContain(cuenta.toString());
    expect(Object.keys(contrato)).not.toContain('accountId');
  });
});
