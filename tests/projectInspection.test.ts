import { inspectProject } from '../application/inspectProject.js';
import { inspectProjectManifest } from '../core/projectInspection.js';
import { runAgentWorkflow } from '../cli/runAgentWorkflow.js';

const manifest = {
  engines: { node: '^22.22.2 || ^24.15.0 || >=26.0.0' },
  scripts: { validate: 'yarn lint && yarn test:coverage' },
};

describe('project configuration inspection', () => {
  it('reads the requested project through the port and reports only configuration', async () => {
    const read = vi.fn().mockResolvedValue(manifest);
    const result = await inspectProject('/other/project', { read });
    expect(read).toHaveBeenCalledExactlyOnceWith('/other/project');
    expect(result).toEqual({
      scope: 'configuration-only',
      nodeRange: manifest.engines.node,
      validation: { command: 'yarn validate', script: manifest.scripts.validate },
    });
  });

  it.each([
    undefined,
    null,
    [],
    1,
    'project',
    { engines: null },
    { engines: { node: '24' }, scripts: [] },
  ])('rejects a malformed manifest: %j', (input) => {
    expect(() => inspectProjectManifest(input)).toThrow('Ожидался объект');
  });

  it.each([undefined, 24, '', '  '])('rejects an absent Node range: %j', (node) => {
    expect(() => inspectProjectManifest({ ...manifest, engines: { node } })).toThrow(
      'engines.node',
    );
  });

  it.each([undefined, false, '', '\n'])('rejects an absent validation command: %j', (validate) => {
    expect(() => inspectProjectManifest({ ...manifest, scripts: { validate } })).toThrow(
      'scripts.validate',
    );
  });
});

describe('workflow CLI', () => {
  const dependencies = () => ({
    projectReader: { read: vi.fn().mockResolvedValue(manifest) },
    connectionReader: { load: vi.fn() },
    cwd: '/current/project',
    write: vi.fn(),
    writeError: vi.fn(),
  });

  it.each([['inspect-project'], ['inspect-project', '/chosen/project']])(
    'inspects with %j',
    async (...args) => {
      const io = dependencies();
      expect(await runAgentWorkflow(args, io)).toBe(0);
      expect(io.projectReader.read).toHaveBeenCalledExactlyOnceWith(args[1] ?? io.cwd);
      expect(JSON.parse(io.write.mock.calls[0]![0] as string)).toEqual(
        inspectProjectManifest(manifest),
      );
      expect(io.writeError).not.toHaveBeenCalled();
    },
  );

  it('shows help without reading or executing project commands', async () => {
    const io = dependencies();
    expect(await runAgentWorkflow(['--help'], io)).toBe(0);
    expect(io.write).toHaveBeenCalledWith(expect.stringContaining('inspect-project'));
    expect(io.projectReader.read).not.toHaveBeenCalled();
  });

  it.each([[], ['start'], ['inspect-project', 'a', 'b'], ['inspect-project', ''], ['--help', 'a']])(
    'rejects unsupported arguments: %j',
    async (...args) => {
      const io = dependencies();
      expect(await runAgentWorkflow(args, io)).toBe(2);
      expect(io.writeError).toHaveBeenCalledWith(expect.stringContaining('Использование'));
      expect(io.projectReader.read).not.toHaveBeenCalled();
      expect(io.write).not.toHaveBeenCalled();
    },
  );

  it.each([new Error('read failed'), 'unknown failure'])(
    'reports read failure: %j',
    async (error) => {
      const io = dependencies();
      io.projectReader.read.mockRejectedValue(error);
      expect(await runAgentWorkflow(['inspect-project'], io)).toBe(1);
      expect(io.write).not.toHaveBeenCalled();
      expect(io.writeError).toHaveBeenCalledWith(
        error instanceof Error ? error.message : 'Не удалось прочитать проект.',
      );
    },
  );
});
