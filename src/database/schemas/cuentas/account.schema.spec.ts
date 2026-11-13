import mongoose from 'mongoose';
import { AccountSchema } from './account.schema';

const AccountModel = mongoose.model('AccountSpec', AccountSchema);

describe('AccountSchema — address proof fields', () => {
  it('starts with no proof and no portal entry', () => {
    const cuenta = new AccountModel({
      firebaseUid: 'u1',
      email: 'ana@example.com',
      nombreCompleto: 'Ana',
    });
    expect(cuenta.correoProbadoClave).toBeNull();
    expect(cuenta.correoProbadoEn).toBeNull();
    expect(cuenta.ultimoIngresoPortalEn).toBeNull();
  });

  it('stores the proof fields when set', () => {
    const cuando = new Date('2026-11-12T10:00:00Z');
    const cuenta = new AccountModel({
      firebaseUid: 'u1',
      email: 'ana@example.com',
      nombreCompleto: 'Ana',
      correoProbadoClave: 'a'.repeat(64),
      correoProbadoEn: cuando,
      ultimoIngresoPortalEn: cuando,
    });
    expect(cuenta.correoProbadoClave).toBe('a'.repeat(64));
    expect(cuenta.correoProbadoEn).toEqual(cuando);
    expect(cuenta.ultimoIngresoPortalEn).toEqual(cuando);
  });

  it('adds no index: lookups go by _id or by the existing unique email', () => {
    const campos = AccountSchema.indexes()
      .map(([c]) => Object.keys(c).join(','))
      .sort();
    expect(campos).toEqual(['email', 'firebaseUid']);
  });
});
