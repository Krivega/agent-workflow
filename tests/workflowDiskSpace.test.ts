import { statfs } from 'node:fs/promises';
import type { StatsFs } from 'node:fs';
import { requireWorkflowDiskSpace } from '../adapters/project/workflowDiskSpace.js';

vi.mock('node:fs/promises', () => ({ statfs: vi.fn() }));
const space = (bavail: number): StatsFs => ({
  type: 0,
  bsize: 4096,
  frsize: 4096,
  blocks: 1_000_000,
  bfree: bavail,
  bavail,
  files: 1000,
  ffree: 900,
});
beforeEach(() => {
  vi.mocked(statfs).mockReset();
  vi.mocked(statfs).mockResolvedValue(space(262_144));
});
it('requires one GiB available on each volume and checks identical directories once', async () => {
  await requireWorkflowDiskSpace('/project', '/evidence');
  expect(statfs).toHaveBeenNthCalledWith(1, '/project');
  expect(statfs).toHaveBeenNthCalledWith(2, '/evidence');
  vi.mocked(statfs).mockClear();
  await requireWorkflowDiskSpace('/same', '/same');
  expect(statfs).toHaveBeenCalledTimes(1);
});
it.each([1, 2])(
  'rejects insufficient space on volume %s without writing or cleaning',
  async (index) => {
    if (index === 2) vi.mocked(statfs).mockResolvedValueOnce(space(262_144));
    vi.mocked(statfs).mockResolvedValueOnce(space(262_143));
    await expect(requireWorkflowDiskSpace('/project', '/evidence')).rejects.toThrow(
      'workflow-disk-space-low:' + (index === 1 ? '/project' : '/evidence'),
    );
  },
);
it('fails closed when filesystem capacity cannot be read', async () => {
  vi.mocked(statfs).mockRejectedValueOnce(new Error('unavailable'));
  await expect(requireWorkflowDiskSpace('/project', '/evidence')).rejects.toThrow('unavailable');
});
