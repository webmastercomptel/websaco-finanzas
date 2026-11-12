import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import mongoose, { Types } from 'mongoose';
import { RegistroAuditoriaSchema } from '../../database/schemas/auditoria/registro-auditoria.schema';
import { FiltrosAuditoriaDto } from './dto/filtros-auditoria.dto';
import { AuditoriaService, type EntradaAuditoria } from './auditoria.service';

const Registro = mongoose.model(
  'RegistroAuditoriaAccesoSpec',
  RegistroAuditoriaSchema,
);

const entrada = (over: Partial<EntradaAuditoria> = {}): EntradaAuditoria => ({
  actorAccountId: new Types.ObjectId().toString(),
  actorNombre: 'Ana',
  accion: 'crear',
  entidadTipo: 'acceso-residente',
  entidadId: new Types.ObjectId().toString(),
  entidadEtiqueta: 'Ingreso de residente: Ana (copropiedad X)',
  ...over,
});

describe('audit vocabulary of the resident portal', () => {
  it.each(['crear', 'retirar', 'restablecer', 'enviar'] as const)(
    'the stored entry accepts entidadTipo acceso-residente with accion %s',
    (accion) => {
      const registro = new Registro({
        ...entrada({ accion }),
      });
      expect(registro.validateSync()).toBeUndefined();
    },
  );

  it('still refuses an unknown action or entity type', () => {
    const accion = new Registro({
      ...entrada(),
      accion: 'inventada',
    }).validateSync();
    const tipo = new Registro({
      ...entrada(),
      entidadTipo: 'inventada',
    }).validateSync();

    expect(accion?.errors.accion).toBeDefined();
    expect(tipo?.errors.entidadTipo).toBeDefined();
  });

  it('the service writes the new action and type as given', async () => {
    const create = jest.fn().mockResolvedValue({});
    const servicio = new AuditoriaService({ create } as never);

    await servicio.registrar(entrada({ accion: 'restablecer' }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'restablecer',
        entidadTipo: 'acceso-residente',
      }),
    );
  });

  it('the audit filter accepts both new values', async () => {
    const dto = plainToInstance(FiltrosAuditoriaDto, {
      entidadTipo: 'acceso-residente',
      accion: 'restablecer',
    });

    expect(await validate(dto)).toHaveLength(0);
  });
});
