import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import mongoose, { Types } from 'mongoose';
import { RegistroAuditoriaSchema } from '../../database/schemas/auditoria/registro-auditoria.schema';
import { FiltrosAuditoriaDto } from './dto/filtros-auditoria.dto';
import { AuditoriaService, type EntradaAuditoria } from './auditoria.service';

const Registro = mongoose.model(
  'RegistroAuditoriaOrganoSpec',
  RegistroAuditoriaSchema,
);

const entrada = (over: Partial<EntradaAuditoria> = {}): EntradaAuditoria => ({
  actorAccountId: new Types.ObjectId().toString(),
  actorNombre: 'Ana',
  accion: 'crear',
  entidadTipo: 'integrante-organo',
  entidadId: new Types.ObjectId().toString(),
  entidadEtiqueta: 'Consejo de Administración: Ana',
  ...over,
});

describe('vocabulario de auditoría de Consejo y Comité', () => {
  it.each(['crear', 'eliminar'] as const)(
    'el registro acepta entidadTipo integrante-organo con accion %s',
    (accion) => {
      expect(
        new Registro({ ...entrada({ accion }) }).validateSync(),
      ).toBeUndefined();
    },
  );

  it('el servicio escribe el tipo tal cual', async () => {
    const create = jest.fn().mockResolvedValue({});
    await new AuditoriaService({ create } as never).registrar(entrada());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ entidadTipo: 'integrante-organo' }),
    );
  });

  it('el filtro de auditoría acepta el tipo', async () => {
    const dto = plainToInstance(FiltrosAuditoriaDto, {
      entidadTipo: 'integrante-organo',
    });
    expect(await validate(dto)).toHaveLength(0);
  });
});
