import { localFixture } from './localFixtures.js';
describe('CLI composition', () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each([
    { args: ['inspect-project'], code: 0, channel: 'log' as const },
    { args: ['unknown'], code: 2, channel: 'error' as const },
    { args: ['observe-chat'], code: 2, channel: 'error' as const },
  ])('wires process arguments, output and exit code: $args', async ({ args, code, channel }) => {
    process.argv = ['node', 'main.ts', ...args];
    const output = vi.spyOn(console, channel).mockImplementation(() => undefined);
    await import('../cli/main.js');
    expect(process.exitCode).toBe(code);
    expect(output).toHaveBeenCalledOnce();
    if (channel === 'log') {
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({
        scope: 'configuration-only',
      });
    }
  });
  it.each([true, false])(
    'wires explicit task connection commands without writes during preview (%s)',
    async (valid) => {
      const f = await localFixture();
      try {
        process.argv = [
          'node',
          'main.ts',
          'preview-task',
          ...(valid ? ['connection.json', f.card.locator, 'task', f.root] : []),
        ];
        const output = vi
          .spyOn(console, valid ? 'log' : 'error')
          .mockImplementation(() => undefined);
        await import('../cli/main.js');
        expect(process.exitCode).toBe(valid ? 0 : 2);
        expect(output).toHaveBeenCalledOnce();
      } finally {
        await f.dispose();
      }
    },
  );
  it('runs the new chat route through the actual CLI composition', async () => {
    const f = await localFixture();
    try {
      await f.file(
        'read-request.json',
        JSON.stringify({
          schema_version: 1,
          root: f.root,
          descriptor: 'connection.json',
          marker: 'probe',
          locators: ['AGENTS.md'],
        }),
      );
      process.argv = ['node', 'main.ts', 'read-chat', f.root + '/read-request.json'];
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await import('../cli/main.js');
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({
        chat_read: 'probe',
        locator: 'AGENTS.md',
      });
    } finally {
      await f.dispose();
    }
  });
  it.each([0, 1])(
    'dispatches the managed entrypoint and its output channels (%s)',
    async (code) => {
      const managed = await import('../cli/taskChatCommand.js');
      vi.spyOn(managed, 'runTaskChatCommand').mockImplementation(
        async (_args, _root, write, error) => {
          (code === 0 ? write : error)('managed-result');
          return code;
        },
      );
      const output = vi
        .spyOn(console, code === 0 ? 'log' : 'error')
        .mockImplementation(() => undefined);
      process.argv = ['node', 'main.ts', 'task-chat', 'continue', '--state', '/external/run'];
      await import('../cli/main.js');
      expect(process.exitCode).toBe(code);
      expect(output).toHaveBeenCalledWith('managed-result');
    },
  );
});
