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

function listing(title, links, observedAt) {
  const items = links.map(([url, label]) => `<li><a href="${url}">${label}</a></li>`);
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body><main><h1>${title}</h1>
${observedAt ? '<p>Каталог с Mac · ' + observedAt + '</p>' : ''}
${items.length ? '<ul>' + items.join('') + '</ul>' : '<p>Пока нет задач.</p>'}
</main></body></html>`;
}

export function handler({ workflowId, devicePin, readStatus, loadProjects, proxyCertificate }) {
  if (!loadProjects && !workflowPattern.test(workflowId)) throw Error('Некорректный Workflow ID');
  const pending = new Map();
  function permitted(req) {
    try {
      const pin = readFileSync(devicePin, 'utf8').trim();
      if (!proxyCertificate && !req.socket.authorized) return false;
      const peer = proxyCertificate ? proxyCertificate(req) : req.socket.getPeerCertificate();
      return (
        Date.parse(peer.valid_to) > Date.now() &&
        /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(pin) &&
        peer.fingerprint256 === pin
      );
    } catch {
      return false;
    }
  }
  async function observe(id, project) {
    const match = workflowPattern.exec(id);
    const data = await readStatus(id, project);
    if (data.workflowId !== id || !['running', 'done', 'cancelled', 'failed'].includes(data.status))
      throw Error('Неподтверждённый статус');
    return JSON.stringify({
      project: match[1],
      task: match[2],
      status: data.status,
      phase: phases.has(data.phase) ? data.phase : null,
      reason: reasons.get(data.reason) ?? (data.reason ? 'Подробности в локальном клиенте' : null),
      confirmedAt: project?.snapshot ? data.confirmedAt : new Date().toISOString(),
      ...(project?.snapshot ? { snapshot: true } : {}),
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
    if (!permitted(req)) return send(403);
    if (req.method !== 'GET') return send(405);
    if (req.url === '/status.js') return send(200, script, 'text/javascript');
    try {
      let id = workflowId;
      let project;
      const projects = loadProjects?.();
      if (projects) {
        if (req.url === '/') {
          const links = [...projects.keys()].sort().map((key) => ['/project/' + key, key]);
          return send(200, listing('Проекты', links, projects.observedAt), 'text/html');
        }
        const parts = /^\/(project|task|api)\/(.+)$/u.exec(req.url);
        if (!parts) return send(404);
        const [, view, target] = parts;
        const match = view === 'project' ? null : workflowPattern.exec(target);
        const key = view === 'project' ? target : match?.[1];
        project = projects.get(key);
        if (!project) return send(404);
        const tasks = await project.tasks();
        if (!permitted(req)) return send(403);
        if (view === 'project') {
          const links = tasks.map((task) => ['/task/aw/task/' + key + '/' + task, task]);
          return send(200, listing(key, links, projects.observedAt), 'text/html');
        }
        if (!tasks.includes(match[2])) return send(404);
        id = target;
        if (view === 'task')
          return send(200, page.toString().replace('WORKFLOW_ID', id), 'text/html');
      } else {
        if (req.url === '/')
          return send(200, page.toString().replace('WORKFLOW_ID', id), 'text/html');
        if (req.url !== '/api/' + id) return send(404);
      }
      let result;
      if (project) {
        result = await observe(id, project);
        if (loadProjects().get(workflowPattern.exec(id)[1])?.binding !== project.binding)
          return send(403);
      } else {
        if (!pending.has(id))
          pending.set(
            id,
            observe(id).finally(() => pending.delete(id)),
          );
        result = await pending.get(id);
      }
      if (!permitted(req)) return send(403);
      return send(200, result, 'application/json');
    } catch (error) {
      if (!permitted(req)) return send(403);
      const reason =
        error.message === 'backend-policy-required'
          ? 'Для проекта требуется действующая политика Temporal на Mac.'
          : 'Сведения о задачах временно недоступны.';
      return send(503, reason);
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
  let loadProjects;
  if ('workerConfig' in config) {
    if ('workflowId' in config) throw Error('Выберите одну конфигурацию каталога');
    const { workerProjects } = await import('./workerProjects.mjs');
    loadProjects = () => workerProjects(config.workerConfig);
    loadProjects();
  }
  const readStatus = async (id, project = config) => {
    let result;
    const code = await runTemporalTaskChat(
      ['status', '--workflow-id', id, '--temporal-registration', project.registration],
      project.workspace,
      (message) => {
        result = message;
      },
      () => {},
    );
    if (code !== 0) throw Error('Статус недоступен');
    return JSON.parse(result);
  };
  const serve = handler({ ...config, loadProjects, readStatus });
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
