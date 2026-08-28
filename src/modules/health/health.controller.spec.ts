import type {
  HealthCheckService,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import { HealthController } from './health.controller';
import type { RedisHealthIndicator } from './redis.health';

describe('HealthController', () => {
  let health: jest.Mocked<Pick<HealthCheckService, 'check'>>;
  let mongoose: jest.Mocked<Pick<MongooseHealthIndicator, 'pingCheck'>>;
  let redis: jest.Mocked<Pick<RedisHealthIndicator, 'pingCheck'>>;
  let controller: HealthController;

  beforeEach(() => {
    health = {
      check: jest.fn().mockResolvedValue({ status: 'ok', details: {} }),
    };
    mongoose = {
      pingCheck: jest.fn().mockResolvedValue({ mongodb: { status: 'up' } }),
    };
    redis = {
      pingCheck: jest.fn().mockResolvedValue({ redis: { status: 'up' } }),
    };

    controller = new HealthController(
      health as unknown as HealthCheckService,
      mongoose as unknown as MongooseHealthIndicator,
      redis as unknown as RedisHealthIndicator,
    );
  });

  it('responde ok en el chequeo de liveness sin tocar dependencias', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(health.check).not.toHaveBeenCalled();
  });

  it('delega en HealthCheckService chequeando Mongo y Redis en /health/ready', async () => {
    await controller.ready();

    expect(health.check).toHaveBeenCalledTimes(1);
    const checks = health.check.mock.calls[0][0] as Array<() => unknown>;
    expect(checks).toHaveLength(2);

    await checks[0]();
    await checks[1]();
    expect(mongoose.pingCheck).toHaveBeenCalledWith('mongodb');
    expect(redis.pingCheck).toHaveBeenCalledWith('redis');
  });

  it('el endpoint por defecto también chequea Mongo y Redis', async () => {
    await controller.check();

    expect(health.check).toHaveBeenCalledTimes(1);
    const checks = health.check.mock.calls[0][0] as Array<() => unknown>;
    expect(checks).toHaveLength(2);
  });
});
