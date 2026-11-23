import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { isIPv4 } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const asset = (name) => readFileSync(new URL(name, import.meta.url));
const page = asset('status.html');
const script = asset('status.js');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const workflowPattern =
  /^aw\/task\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/u;
const phases = new Set(
  'admitting planning preparing baseline writing candidate-checks integration integrated-checks acceptance finishing stopping stop-unknown budget-unknown checkpoint-unknown waiting-human waiting-human-gates human-paused restoring human-admission-unknown done cancelled'.split(
    ' ',
  ),
);
const reasons = new Map([
  ['task-human-decision-required', 'Ожидается решение владельца'],
  ['task-execution-held', 'Исполнение приостановлено'],
  ['task-human-paused', 'Владелец поставил задачу на паузу'],
  ['task-cancelled', 'Задача отменена'],
]);

export function handler({ workflowId, devicePin, readStatus }) {
  const match = workflowPattern.exec(workflowId);
  if (!match) throw Error('Некорректный Workflow ID');
  let pending;
  function permitted(socket) {
    try {
      const pin = readFileSync(devicePin, 'utf8').trim();
      const peer = socket.getPeerCertificate();
      return (
        socket.authorized &&
        Date.parse(peer.valid_to) > Date.now() &&
        /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(pin) &&
        peer.fingerprint256 === pin
      );
    } catch {
      return false;
    }
  }
  async function observe() {
    const data = await readStatus();
    if (
      data.workflowId !== workflowId ||
      !['running', 'done', 'cancelled', 'failed'].includes(data.status)
    )
      throw Error('Неподтверждённый статус');
    return JSON.stringify({
      project: match[1],
      task: match[2],
      status: data.status,
      phase: phases.has(data.phase) ? data.phase : null,
      reason: reasons.get(data.reason) ?? (data.reason ? 'Подробности в локальном клиенте' : null),
      confirmedAt: new Date().toISOString(),
    });
  }
  return async (req, res) => {
    const send = (status, body = '', type = 'text/plain') => {
      res.writeHead(status, {
        'Content-Type': type + '; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      res.end(body);
    };
    if (!permitted(req.socket)) return send(403);
    if (req.method !== 'GET') return send(405);
    if (req.url === '/')
      return send(200, page.toString().replace('WORKFLOW_ID', workflowId), 'text/html');
    if (req.url === '/status.js') return send(200, script, 'text/javascript');
    if (req.url !== '/api/' + workflowId) return send(404);
    try {
      pending ??= observe().finally(() => {
        pending = undefined;
      });
      const result = await pending;
      if (!permitted(req.socket)) return send(403);
      return send(200, result, 'application/json');
    } catch {
      return send(503);
    }
  };
}

export function pilotAddress(ip) {
  return (
    isIPv4(ip) &&
    /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/u.test(
      ip,
    )
  );
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = readJson(process.argv[2]);
  if (!pilotAddress(config.address)) throw Error('Укажите IPv4 частного интерфейса');
  const { runTemporalTaskChat } = await import('../../cli/temporalStart.ts');
  const readStatus = async () => {
    let result;
    const code = await runTemporalTaskChat(
      [
        'status',
        '--workflow-id',
        config.workflowId,
        '--temporal-registration',
        config.registration,
      ],
      config.workspace,
      (message) => {
        result = message;
      },
      () => {},
    );
    if (code !== 0) throw Error('Статус недоступен');
    return JSON.parse(result);
  };
  const serve = handler({ ...config, readStatus });
  createServer(
    {
      cert: readFileSync(config.cert),
      key: readFileSync(config.key),
      ca: readFileSync(config.ca),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
    },
    serve,
  ).listen(8443, config.address);
}
