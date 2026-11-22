import { join } from 'node:path';
import { maintainStore } from '../adapters/storage/storageMaintenance.js';
import { body, fixture, grant } from './storageFixtures.js';

it('requires management authority and exposes explicit initialization/backup/restore without migrations', async () => {
  const f = fixture();
  const request = { context: grant.context, command: { type: 'state' as const } };
  try {
    const created = join(f.parent, 'created');
    expect(
      await maintainStore(created, { ...grant, permissions: ['read'] }, request, {
        type: 'initialize',
      }),
    ).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    expect(await maintainStore(created, grant, request, { type: 'initialize' })).toEqual({
      ok: true,
      value: { status: 'initialized' },
    });
    expect(await maintainStore(created, grant, request, { type: 'initialize' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    f.claim();
    f.mutate({ type: 'write', id: 'proof', body }, 1);
    f.mutate({ type: 'freeze' }, 2);
    const destination = join(f.parent, 'backup');
    const exported = await maintainStore(f.root, grant, request, { type: 'backup', destination });
    expect(exported).toMatchObject({ ok: true, value: { revision: 3 } });
    expect(
      await maintainStore(join(f.parent, 'restored'), grant, request, {
        type: 'restore',
        source: destination,
      }),
    ).toEqual(exported);
  } finally {
    f.dispose();
  }
});
