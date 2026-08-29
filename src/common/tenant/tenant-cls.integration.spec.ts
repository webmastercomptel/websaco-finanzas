import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Server } from 'node:http';
import { Types } from 'mongoose';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { TenantContextService } from './tenant-context.service';
import {
  ACTIVE_COPROPERTY_KEY,
  COPROPERTY_HEADER,
} from './tenant-context.constants';

/**
 * Does a value written into CLS by a GUARD survive to be read by a SERVICE?
 *
 * Nothing had ever exercised that. The guard writes the active coproperty and
 * the services read it, but until a service actually needed the tenant, both
 * halves were only ever tested against their own stubs — the same "each piece
 * works, the wiring does not" shape that has bitten this project three times.
 *
 * If this passes, a missing tenant at runtime is a missing header, not a lost
 * context. That distinction is the whole value of the test.
 */
@Injectable()
class GuardQueEscribeElTenant implements CanActivate {
  constructor(private readonly cls: ClsService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
    }>();
    const solicitada = req.headers[COPROPERTY_HEADER]?.trim();
    if (solicitada) this.cls.set(ACTIVE_COPROPERTY_KEY, solicitada);
    return true;
  }
}

@Controller('sonda')
@UseGuards(GuardQueEscribeElTenant)
class SondaController {
  constructor(private readonly tenant: TenantContextService) {}

  @Get()
  leer(): { coPropertyId: string } {
    return { coPropertyId: this.tenant.resolveCoPropertyId().toString() };
  }
}

@Module({
  imports: [ClsModule.forRoot({ global: true, middleware: { mount: true } })],
  controllers: [SondaController],
  providers: [TenantContextService, GuardQueEscribeElTenant],
})
class SondaModule {}

const COP = new Types.ObjectId().toString();

describe('CLS entre guard y servicio', () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await NestFactory.create(SondaModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('el servicio lee el tenant que escribió el guard', async () => {
    const res = await request(server())
      .get('/sonda')
      .set('X-CoProperty-Id', COP)
      .expect(200);

    expect(res.body).toEqual({ coPropertyId: COP });
  });

  it('sin header falla cerrado', async () => {
    await request(server()).get('/sonda').expect(403);
  });

  it('no arrastra el tenant de una petición a la siguiente', async () => {
    // El store es por petición. Si se compartiera, la segunda llamada
    // heredaría el edificio de la primera — y serviría datos ajenos.
    await request(server())
      .get('/sonda')
      .set('X-CoProperty-Id', COP)
      .expect(200);

    await request(server()).get('/sonda').expect(403);
  });
});
