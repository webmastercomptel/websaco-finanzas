import { LockService } from './lock.service';

/** Redis stub: `set` answers `OK` (lock won) or null (held elsewhere). */
const redisCon = (set: jest.Mock) =>
  ({ set, eval: jest.fn().mockResolvedValue(1) }) as never;

describe('LockService.runExclusive', () => {
  it('corre la tarea cuando gana el lock y lo suelta al terminar', async () => {
    const set = jest.fn().mockResolvedValue('OK');
    const redis = redisCon(set);
    const tarea = jest.fn().mockResolvedValue(undefined);

    const corrio = await new LockService(redis).runExclusive('k', 1000, tarea);

    expect(corrio).toBe(true);
    expect(tarea).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('k', expect.any(String), 'PX', 1000, 'NX');
    expect((redis as unknown as { eval: jest.Mock }).eval).toHaveBeenCalled();
  });

  it('no corre la tarea cuando otra instancia tiene el lock', async () => {
    const tarea = jest.fn();

    const corrio = await new LockService(
      redisCon(jest.fn().mockResolvedValue(null)),
    ).runExclusive('k', 1000, tarea);

    expect(corrio).toBe(false);
    expect(tarea).not.toHaveBeenCalled();
  });

  it('si Redis falla no corre la tarea ni propaga el error', async () => {
    const tarea = jest.fn();

    const corrio = await new LockService(
      redisCon(jest.fn().mockRejectedValue(new Error('caído'))),
    ).runExclusive('k', 1000, tarea);

    expect(corrio).toBe(false);
    expect(tarea).not.toHaveBeenCalled();
  });

  it('suelta el lock aunque la tarea falle', async () => {
    const redis = redisCon(jest.fn().mockResolvedValue('OK'));

    await expect(
      new LockService(redis).runExclusive('k', 1000, () =>
        Promise.reject(new Error('falló')),
      ),
    ).rejects.toThrow('falló');
    expect((redis as unknown as { eval: jest.Mock }).eval).toHaveBeenCalled();
  });
});
