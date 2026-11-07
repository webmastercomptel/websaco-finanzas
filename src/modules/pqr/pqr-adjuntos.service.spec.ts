import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  MAXIMO_ADJUNTOS_POR_PQR,
  PqrAdjuntosService,
  TAMANO_MAXIMO_ADJUNTO_BYTES,
} from './pqr-adjuntos.service';

interface Consulta {
  exec: jest.Mock;
  select: jest.Mock;
  populate: jest.Mock;
}

const consulta = (valor: unknown): Consulta => {
  const q = {} as Consulta;
  q.exec = jest.fn().mockResolvedValue(valor);
  q.select = jest.fn().mockReturnValue(q);
  q.populate = jest.fn().mockReturnValue(q);
  return q;
};

const COPROPIEDAD = new Types.ObjectId();
const PQR = new Types.ObjectId();
const CUENTA = new Types.ObjectId();

const adjunto = (extra: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  tipo: 'pdf',
  nombre: 'archivo.pdf',
  url: null,
  rutaAlmacenamiento: 'pqrs/ruta/archivo.pdf',
  estado: 'pendiente',
  ...extra,
});

const pqrDoc = (extra: Record<string, unknown> = {}) => ({
  _id: PQR,
  copropiedadId: COPROPIEDAD,
  autorId: CUENTA,
  codigo: 'PQR-001',
  titulo: 'T',
  descripcion: '',
  descripcionCompleta: '',
  categoria: '',
  tipo: 'reclamos',
  estado: 'pendiente',
  prioridad: 'normal',
  unidad: 'A-101',
  residente: { nombre: 'Juan', rol: 'Propietario' },
  archivosAdjuntos: [] as ReturnType<typeof adjunto>[],
  seguimientos: [],
  tecnicoId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...extra,
});

const residente: IRequestUser = {
  uid: 'u',
  email: 'r@x.co',
  accountId: CUENTA.toString(),
};

function montar() {
  const pqrs = {
    findOne: jest.fn().mockReturnValue(consulta(pqrDoc())),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    }),
  };
  const getSignedUrl = jest
    .fn()
    .mockResolvedValue(['https://storage.example.com/firmada']);
  const getMetadata = jest.fn().mockResolvedValue([{ size: 1024 }]);
  const borrar = jest.fn().mockResolvedValue([{}]);
  const file = jest.fn(() => ({ getSignedUrl, getMetadata, delete: borrar }));
  const bucket = { file };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const servicio = new PqrAdjuntosService(
    pqrs as never,
    bucket as never,
    tenant as never,
  );
  return { servicio, pqrs, file, getSignedUrl, getMetadata, borrar };
}

const dtoPdf = {
  nombre: 'reporte.pdf',
  mimeType: 'application/pdf',
  tamanoBytes: 2048,
};

describe('PqrAdjuntosService.iniciarSubida', () => {
  it('registra el adjunto pendiente con ruta propia del backend y firma la URL de escritura', async () => {
    const { servicio, pqrs, file, getSignedUrl } = montar();
    let empujado: ReturnType<typeof adjunto> | undefined;
    pqrs.findOneAndUpdate.mockImplementation(
      (
        _filtro: unknown,
        cambio: { $push: { archivosAdjuntos: Record<string, unknown> } },
      ) => {
        empujado = adjunto(cambio.$push.archivosAdjuntos);
        return consulta(pqrDoc({ archivosAdjuntos: [empujado] }));
      },
    );

    const resultado = await servicio.iniciarSubida(PQR.toString(), dtoPdf);

    expect(pqrs.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: PQR.toString(),
        copropiedadId: COPROPIEDAD,
        [`archivosAdjuntos.${MAXIMO_ADJUNTOS_POR_PQR - 1}`]: { $exists: false },
      },
      {
        $push: {
          archivosAdjuntos: {
            creadoEn: expect.any(Date) as Date,
            tipo: 'pdf',
            nombre: 'reporte.pdf',
            url: null,
            rutaAlmacenamiento: expect.stringMatching(
              new RegExp(
                `^pqrs/${COPROPIEDAD.toString()}/${PQR.toString()}/[0-9a-f-]{36}-reporte\\.pdf$`,
              ),
            ) as string,
            estado: 'pendiente',
          },
        },
      },
      { new: true },
    );
    expect(file).toHaveBeenCalledWith(empujado?.rutaAlmacenamiento);
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 'v4',
        action: 'write',
        contentType: 'application/pdf',
      }),
    );
    expect(resultado.uploadUrl).toBe('https://storage.example.com/firmada');
    expect(resultado.attachmentId).toBe(empujado?._id.toString());
    expect(resultado.pqr.archivosAdjuntos[0].estado).toBe('pendiente');
  });

  it('deriva el tipo del MIME y sanea el nombre dentro de la ruta', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOneAndUpdate.mockImplementation(
      (
        _f: unknown,
        cambio: { $push: { archivosAdjuntos: Record<string, unknown> } },
      ) =>
        consulta(
          pqrDoc({
            archivosAdjuntos: [adjunto(cambio.$push.archivosAdjuntos)],
          }),
        ),
    );

    await servicio.iniciarSubida(PQR.toString(), {
      nombre: '../mi foto (1).png',
      mimeType: 'image/png',
      tamanoBytes: 10,
    });

    const empujado = (
      pqrs.findOneAndUpdate.mock.calls[0] as [
        unknown,
        {
          $push: {
            archivosAdjuntos: { tipo: string; rutaAlmacenamiento: string };
          };
        },
      ]
    )[1].$push.archivosAdjuntos;
    expect(empujado.tipo).toBe('imagen');
    expect(empujado.rutaAlmacenamiento).not.toContain(' ');
    expect(empujado.rutaAlmacenamiento).not.toContain('(');
    expect(empujado.rutaAlmacenamiento).not.toMatch(/\.\.\//);
  });

  it('rechaza con 400 un archivo declarado por encima del límite, sin escribir', async () => {
    const { servicio, pqrs } = montar();

    await expect(
      servicio.iniciarSubida(PQR.toString(), {
        ...dtoPdf,
        tamanoBytes: TAMANO_MAXIMO_ADJUNTO_BYTES + 1,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('404 si la PQR no existe en la copropiedad (antes de hablar del tamaño)', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.iniciarSubida(PQR.toString(), {
        ...dtoPdf,
        tamanoBytes: TAMANO_MAXIMO_ADJUNTO_BYTES + 1,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('un id de PQR mal formado es 404 sin tocar la base', async () => {
    const { servicio, pqrs } = montar();

    await expect(servicio.iniciarSubida('mal', dtoPdf)).rejects.toThrow(
      NotFoundException,
    );
    expect(pqrs.findOne).not.toHaveBeenCalled();
  });
});

describe('PqrAdjuntosService — residente', () => {
  it('solo adjunta a una PQR que ella presentó: la autoría va dentro del filtro', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOneAndUpdate.mockImplementation(
      (
        _f: unknown,
        cambio: { $push: { archivosAdjuntos: Record<string, unknown> } },
      ) =>
        consulta(
          pqrDoc({
            archivosAdjuntos: [adjunto(cambio.$push.archivosAdjuntos)],
          }),
        ),
    );

    await servicio.iniciarSubidaResidente(PQR.toString(), dtoPdf, residente);

    expect(pqrs.findOne).toHaveBeenCalledWith({
      _id: PQR.toString(),
      copropiedadId: COPROPIEDAD,
      autorId: CUENTA,
    });
    expect(pqrs.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: PQR.toString(),
        copropiedadId: COPROPIEDAD,
        autorId: CUENTA,
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('adjuntar a la PQR de otra persona es 404 y no firma nada', async () => {
    const { servicio, pqrs, getSignedUrl } = montar();
    pqrs.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.iniciarSubidaResidente(PQR.toString(), dtoPdf, residente),
    ).rejects.toThrow(NotFoundException);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('confirmar en la PQR de otra persona es 404', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.confirmarSubidaResidente(
        PQR.toString(),
        new Types.ObjectId().toString(),
        residente,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('sin una cuenta utilizable es 403', async () => {
    const { servicio, pqrs } = montar();

    await expect(
      servicio.iniciarSubidaResidente(PQR.toString(), dtoPdf, {
        ...residente,
        accountId: undefined,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(pqrs.findOne).not.toHaveBeenCalled();
  });
});

describe('PqrAdjuntosService.confirmarSubida', () => {
  it('pasa el adjunto a listo tras comprobar que el objeto existe en el almacenamiento', async () => {
    const { servicio, pqrs, getMetadata } = montar();
    const pendiente = adjunto();
    pqrs.findOne.mockReturnValue(
      consulta(pqrDoc({ archivosAdjuntos: [pendiente] })),
    );
    pqrs.findOneAndUpdate.mockReturnValue(
      consulta(
        pqrDoc({ archivosAdjuntos: [{ ...pendiente, estado: 'listo' }] }),
      ),
    );

    const resultado = await servicio.confirmarSubida(
      PQR.toString(),
      pendiente._id.toString(),
    );

    expect(getMetadata).toHaveBeenCalled();
    expect(resultado.archivosAdjuntos[0].estado).toBe('listo');
    expect(pqrs.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: PQR.toString(),
        copropiedadId: COPROPIEDAD,
        archivosAdjuntos: {
          $elemMatch: { _id: pendiente._id, estado: 'pendiente' },
        },
      },
      { $set: { 'archivosAdjuntos.$.estado': 'listo' } },
      { new: true },
    );
  });

  it('409 si el adjunto ya estaba listo', async () => {
    const { servicio, pqrs } = montar();
    const listo = adjunto({ estado: 'listo' });
    pqrs.findOne.mockReturnValue(
      consulta(pqrDoc({ archivosAdjuntos: [listo] })),
    );

    await expect(
      servicio.confirmarSubida(PQR.toString(), listo._id.toString()),
    ).rejects.toThrow(ConflictException);
    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('400 si el objeto no existe en el almacenamiento (la subida falló)', async () => {
    const { servicio, pqrs, getMetadata } = montar();
    const pendiente = adjunto();
    pqrs.findOne.mockReturnValue(
      consulta(pqrDoc({ archivosAdjuntos: [pendiente] })),
    );
    getMetadata.mockRejectedValueOnce(new Error('not found'));

    await expect(
      servicio.confirmarSubida(PQR.toString(), pendiente._id.toString()),
    ).rejects.toThrow(BadRequestException);
    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('409 si otra confirmación ganó entre la lectura y la escritura', async () => {
    const { servicio, pqrs } = montar();
    const pendiente = adjunto();
    pqrs.findOne.mockReturnValue(
      consulta(pqrDoc({ archivosAdjuntos: [pendiente] })),
    );
    pqrs.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.confirmarSubida(PQR.toString(), pendiente._id.toString()),
    ).rejects.toThrow(ConflictException);
  });

  it('404 si el id del adjunto no corresponde a ninguno de la PQR, o está mal formado', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(
      consulta(pqrDoc({ archivosAdjuntos: [adjunto()] })),
    );

    await expect(
      servicio.confirmarSubida(PQR.toString(), new Types.ObjectId().toString()),
    ).rejects.toThrow(NotFoundException);
    await expect(
      servicio.confirmarSubida(PQR.toString(), 'mal'),
    ).rejects.toThrow(NotFoundException);
  });

  it('404 si la PQR no existe en la copropiedad', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.confirmarSubida(PQR.toString(), new Types.ObjectId().toString()),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('PqrAdjuntosService — límites de almacenamiento', () => {
  it('el límite declarado es razonable para evidencia (no 200 MB)', () => {
    expect(TAMANO_MAXIMO_ADJUNTO_BYTES).toBeLessThanOrEqual(25 * 1024 * 1024);
  });

  it('una PQR con el máximo de adjuntos responde 409 y no firma nada', async () => {
    const { servicio, pqrs, getSignedUrl } = montar();
    pqrs.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.iniciarSubidaResidente(PQR.toString(), dtoPdf, residente),
    ).rejects.toThrow(ConflictException);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('al confirmar mide el objeto REAL: si supera el límite lo quita de la PQR, borra el objeto y responde 400', async () => {
    const { servicio, pqrs, getMetadata, borrar } = montar();
    const pendiente = adjunto({
      rutaAlmacenamiento: `pqrs/${COPROPIEDAD.toString()}/${PQR.toString()}/x.pdf`,
    });
    pqrs.findOne.mockReturnValue(
      consulta(pqrDoc({ archivosAdjuntos: [pendiente] })),
    );
    getMetadata.mockResolvedValueOnce([
      { size: String(TAMANO_MAXIMO_ADJUNTO_BYTES + 1) },
    ]);

    await expect(
      servicio.confirmarSubidaResidente(
        PQR.toString(),
        pendiente._id.toString(),
        residente,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(pqrs.updateOne).toHaveBeenCalledWith(
      {
        _id: PQR.toString(),
        copropiedadId: COPROPIEDAD,
        autorId: CUENTA,
      },
      {
        $pull: {
          archivosAdjuntos: { _id: pendiente._id, estado: 'pendiente' },
        },
      },
    );
    expect(borrar).toHaveBeenCalled();
    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('PqrAdjuntosService.descargar', () => {
  const ruta = `pqrs/${COPROPIEDAD.toString()}/${PQR.toString()}/a.pdf`;

  it('firma una URL de lectura corta para un adjunto listo', async () => {
    const { servicio, pqrs, getSignedUrl } = montar();
    const listo = adjunto({ estado: 'listo', rutaAlmacenamiento: ruta });
    pqrs.findOne.mockReturnValue(
      consulta(pqrDoc({ archivosAdjuntos: [listo] })),
    );

    const descarga = await servicio.descargarAdjunto(
      PQR.toString(),
      listo._id.toString(),
    );

    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v4', action: 'read' }),
    );
    expect(descarga).toEqual({
      url: 'https://storage.example.com/firmada',
      nombre: 'archivo.pdf',
    });
  });

  it('un adjunto pendiente (no verificado) es 404', async () => {
    const { servicio, pqrs, getSignedUrl } = montar();
    const pendiente = adjunto({ rutaAlmacenamiento: ruta });
    pqrs.findOne.mockReturnValue(
      consulta(pqrDoc({ archivosAdjuntos: [pendiente] })),
    );

    await expect(
      servicio.descargarAdjunto(PQR.toString(), pendiente._id.toString()),
    ).rejects.toThrow(NotFoundException);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('una ruta fuera de pqrs/ nunca se firma', async () => {
    const { servicio, pqrs, getSignedUrl } = montar();
    const raro = adjunto({
      estado: 'listo',
      rutaAlmacenamiento: 'facturas/otra/x.pdf',
    });
    pqrs.findOne.mockReturnValue(
      consulta(pqrDoc({ archivosAdjuntos: [raro] })),
    );

    await expect(
      servicio.descargarAdjunto(PQR.toString(), raro._id.toString()),
    ).rejects.toThrow(NotFoundException);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('el residente solo descarga de una PQR que presentó: la autoría va en el filtro', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.descargarAdjuntoResidente(
        PQR.toString(),
        new Types.ObjectId().toString(),
        residente,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(pqrs.findOne).toHaveBeenCalledWith({
      _id: PQR.toString(),
      copropiedadId: COPROPIEDAD,
      autorId: CUENTA,
    });
  });
});
