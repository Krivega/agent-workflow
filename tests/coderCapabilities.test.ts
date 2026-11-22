import { expect, it } from 'vitest';
import { assertCoderCapabilities } from '../adapters/codex/coderCapabilities.js';

function disabled() {
  return {
    name: 'computer-use',
    runtimeStatus: null,
    pluginId: null,
    httpOrigin: null,
    serverInfo: null,
    serverCapabilities: null,
    toolsError: null,
    tools: {},
    resources: [],
    resourceTemplates: [],
  };
}
it('accepts empty inventory and the observed disabled catalog without making its tools available', () => {
  expect(assertCoderCapabilities({ data: [], nextCursor: null }, [])).toEqual([]);
  expect(
    assertCoderCapabilities({ data: [disabled()], nextCursor: null }, ['computer-use']),
  ).toEqual(['computer-use']);
  expect(
    assertCoderCapabilities({ data: [{ ...disabled(), runtimeStatus: 'disabled' }] }, [
      'computer-use',
    ]),
  ).toEqual(['computer-use']);
});
it('accepts the observed pinned-client inventory without newer optional metadata', () => {
  const names = ['computer-use', 'mcp-tts', 'node_repl', 'openaiDeveloperDocs'];
  const response = {
    data: names.map((name) => ({
      name,
      runtimeStatus: null,
      pluginId: null,
      serverInfo: null,
      tools: {},
      toolsError: null,
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported',
    })),
    nextCursor: null,
  };
  expect(assertCoderCapabilities(response, names)).toEqual([...names].sort());
});
it.each(['httpOrigin', 'serverCapabilities'])(
  'accepts absent optional %s while rejecting present non-null values',
  (key) => {
    const server: Record<string, unknown> = disabled();
    delete server[key];
    expect(assertCoderCapabilities({ data: [server] }, ['computer-use'])).toEqual(['computer-use']);
    for (const value of ['', {}, false, 0]) {
      server[key] = value;
      expect(() => assertCoderCapabilities({ data: [server] }, ['computer-use'])).toThrow(
        'coder-external-tools-enabled',
      );
    }
  },
);
it.each([
  'runtimeStatus',
  'pluginId',
  'serverInfo',
  'toolsError',
  'tools',
  'resources',
  'resourceTemplates',
])('still rejects missing %s', (key) => {
  const server: Record<string, unknown> = disabled();
  delete server[key];
  expect(() => assertCoderCapabilities({ data: [server] }, ['computer-use'])).toThrow();
});
it.each([
  'runtimeStatus',
  'pluginId',
  'httpOrigin',
  'serverInfo',
  'serverCapabilities',
  'toolsError',
  'tools',
  'resources',
  'resourceTemplates',
])('rejects available or unknown %s', (key) => {
  const server: Record<string, unknown> = disabled();
  server[key] = key === 'tools' ? { write: {} } : ['unknown'];
  expect(() => assertCoderCapabilities({ data: [server] }, ['computer-use'])).toThrow(
    'coder-external-tools-enabled',
  );
});
it('rejects an unknown server, duplicate, incomplete list and missing metadata', () => {
  expect(() => assertCoderCapabilities({ data: [disabled()] }, [])).toThrow(
    'coder-external-tools-enabled',
  );
  expect(() =>
    assertCoderCapabilities({ data: [disabled(), disabled()] }, ['computer-use']),
  ).toThrow('coder-mcp-inventory-incomplete');
  expect(() => assertCoderCapabilities({ data: [], nextCursor: 'more' }, [])).toThrow(
    'coder-mcp-inventory-incomplete',
  );
  expect(() => assertCoderCapabilities({ data: null }, [])).toThrow(
    'coder-mcp-inventory-incomplete',
  );
  expect(() =>
    assertCoderCapabilities({ data: [{ name: 'computer-use' }] }, ['computer-use']),
  ).toThrow('coder-external-tools-enabled');
});
