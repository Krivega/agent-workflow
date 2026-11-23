import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { handler, pilotAddress } from '../examples/mobile-control/server.mjs';

test('private bind and exact device, route and response projection', async (t) => {
  for (const ip of ['0.0.0.0', '::', '8.8.8.8', '100.128.0.1', '172.32.0.1'])
    assert.equal(pilotAddress(ip), false);
  for (const ip of ['127.0.0.1', '100.127.0.1', '172.16.1.2', '192.168.1.2', '10.0.0.1'])
    assert.equal(pilotAddress(ip), true);
  const dir = mkdtempSync(join(tmpdir(), 'mobile-status-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const devicePin = join(dir, 'device');
  const pin = Array(32).fill('AF').join(':');
  const workflowId = 'aw/task/demo/one';
  let readStatus = () => ({
    workflowId,
    status: 'running',
    phase: 'waiting-human',
    reason: 'task-execution-held',
    evidence: 'private',
  });
  const serve = handler({ devicePin, workflowId, readStatus: () => readStatus() });
  const socket = {
    authorized: true,
    getPeerCertificate: () => ({ fingerprint256: pin, valid_to: 'Jan 1 2100 GMT' }),
  };
  async function request(url = '/api/' + workflowId, method = 'GET', peer = socket) {
    let status, body;
    await serve(
      { url, method, socket: peer },
      {
        writeHead(code, headers) {
          assert.equal(headers['Cache-Control'], 'no-store');
          status = code;
        },
        end(value) {
          body = value;
        },
      },
    );
    return { status, body };
  }
  assert.equal((await request()).status, 403);
  writeFileSync(devicePin, pin);
  assert.equal((await request('/', 'GET', { ...socket, authorized: false })).status, 403);
  assert.equal(
    (
      await request('/', 'GET', {
        ...socket,
        getPeerCertificate: () => ({ fingerprint256: 'other' }),
      })
    ).status,
    403,
  );
  assert.equal((await request('/api/aw/task/other/one')).status, 404);
  assert.equal((await request('/api/aw/task/demo/two')).status, 404);
  assert.equal((await request(undefined, 'POST')).status, 405);
  assert.match((await request('/')).body, /data-url="\/api\/aw\/task\/demo\/one"/u);
  let data = JSON.parse((await request()).body);
  assert.deepEqual(Object.keys(data).sort(), [
    'confirmedAt',
    'phase',
    'project',
    'reason',
    'status',
    'task',
  ]);
  assert.equal(data.reason, 'Исполнение приостановлено');
  readStatus = () => ({ workflowId, status: 'failed', reason: '/private/log', phase: 'private' });
  data = JSON.parse((await request()).body);
  assert.equal(data.phase, null);
  assert.equal(data.reason, 'Подробности в локальном клиенте');
  readStatus = () => ({ workflowId: 'other', status: 'running' });
  assert.equal((await request()).status, 503);
  readStatus = () => {
    rmSync(devicePin);
    return { workflowId, status: 'done' };
  };
  assert.equal((await request()).status, 403);
});

test('phone keeps last confirmation offline and reads again on foreground return', async () => {
  const fields = new Map();
  const events = new Map();
  const element = (id) => {
    if (!fields.has(id)) fields.set(id, { textContent: '', addEventListener() {} });
    return fields.get(id);
  };
  const document = {
    hidden: false,
    body: { dataset: { url: '/api/aw/task/demo/one' } },
    getElementById: element,
    addEventListener: (event, fn) => events.set(event, fn),
    querySelectorAll: () => [element('task'), element('confirmedAt')],
  };
  let status = 200;
  let reads = 0;
  const context = {
    document,
    window: { addEventListener: (event, fn) => events.set(event, fn) },
    AbortController,
    setInterval() {},
    setTimeout,
    clearTimeout,
    fetch: async () => {
      reads++;
      return {
        status,
        ok: status === 200,
        json: async () => ({
          project: 'demo',
          task: 'one',
          status: 'running',
          confirmedAt: '2026-11-23T09:00:00Z',
        }),
      };
    },
  };
  runInNewContext(
    readFileSync(new URL('../examples/mobile-control/status.js', import.meta.url), 'utf8'),
    context,
  );
  await events.get('pageshow')();
  assert.equal(element('status').textContent, 'В работе');
  const time = element('confirmedAt').textContent;
  events.get('offline')();
  assert.match(element('fresh').textContent, /устарели/u);
  document.hidden = true;
  await events.get('visibilitychange')();
  assert.equal(reads, 1);
  document.hidden = false;
  status = 503;
  await events.get('visibilitychange')();
  assert.equal(reads, 2);
  assert.equal(element('confirmedAt').textContent, time);
  status = 403;
  await events.get('online')();
  assert.equal(element('task').textContent, '—');
  assert.match(element('fresh').textContent, /отозван/u);
});

test('catalog reads current assignments across projects and binds same-named tasks to their project', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-catalog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pin = Array(32).fill('FA').join(':');
  const devicePin = join(dir, 'pin');
  writeFileSync(devicePin, pin);
  const socket = {
    authorized: true,
    getPeerCertificate: () => ({ fingerprint256: pin, valid_to: 'Jan 1 2100 GMT' }),
  };
  const ids = ['one'];
  const projects = new Map([
    ['a', { tasks: () => ids }],
    ['b', { tasks: () => ['one'] }],
  ]);
  const serve = handler({
    loadProjects: () => projects,
    devicePin,
    readStatus: async (id, project) => {
      assert.equal(project, projects.get(id.split('/')[2]));
      return { workflowId: id, status: 'running' };
    },
  });
  async function get(url) {
    let status, body;
    await serve(
      { url, method: 'GET', socket },
      {
        writeHead(code) {
          status = code;
        },
        end(value) {
          body = value;
        },
      },
    );
    return { status, body };
  }
  assert.match((await get('/')).body, /href="\/project\/b"/u);
  assert.match((await get('/project/a')).body, /href="\/task\/aw\/task\/a\/one"/u);
  ids.push('new');
  assert.match((await get('/project/a')).body, /aw\/task\/a\/new/u);
  assert.equal((await get('/api/aw/task/b/new')).status, 404);
  assert.equal((await get('/project/c')).status, 404);
  assert.match((await get('/task/aw/task/a/new')).body, /data-url="\/api\/aw\/task\/a\/new"/u);
  for (const project of ['a', 'b']) {
    const result = await get('/api/aw/task/' + project + '/one');
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).project, project);
  }
  rmSync(devicePin);
  assert.equal((await get('/project/a')).status, 403);
});
