/* global document, window, AbortController, setTimeout, fetch, clearTimeout, setInterval */
const field = (id) => document.getElementById(id);
const labels = { running: 'В работе', done: 'Завершена', cancelled: 'Отменена', failed: 'Ошибка' };
let active;
function stale() {
  active?.abort();
  field('fresh').textContent = 'Данные устарели. Ожидаем подтверждение с Mac.';
}
async function refresh() {
  stale();
  if (document.hidden) return;
  const controller = new AbortController();
  active = controller;
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(document.body.dataset.url, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (controller.signal.aborted) return;
    if (response.status === 403) {
      for (const element of document.querySelectorAll('dd')) element.textContent = '—';
      field('fresh').textContent = 'Доступ отозван.';
      return;
    }
    if (!response.ok) return;
    const data = await response.json();
    if (controller.signal.aborted) return;
    for (const id of ['project', 'task', 'phase', 'reason'])
      field(id).textContent = data[id] ?? '—';
    field('status').textContent = labels[data.status];
    field('confirmedAt').textContent = new Date(data.confirmedAt).toLocaleString();
    field('fresh').textContent = data.snapshot
      ? 'Последнее сохранённое состояние с Mac.'
      : 'Подтверждено с Mac.';
  } catch {
    // Keep the timestamp and the last confirmed observation visible.
  } finally {
    clearTimeout(timer);
  }
}
document.addEventListener('visibilitychange', refresh);
window.addEventListener('offline', stale);
window.addEventListener('online', refresh);
window.addEventListener('pageshow', refresh);
field('refresh').addEventListener('click', refresh);
setInterval(refresh, 15000);
