import { X509Certificate } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { handler } from '../server.mjs';
import { snapshotProjects } from './catalog.mjs';

const socket = '/run/mobile/site.sock';
const pin = '/config/phone.sha256';
const loadProjects = () => snapshotProjects('/catalog/current.json');
const serve = handler({
  devicePin: pin,
  loadProjects,
  readStatus: (id, project) => project.read(id),
  proxyCertificate(req) {
    if (req.headers['x-mobile-verified'] !== 'SUCCESS') throw Error('certificate-required');
    const cert = new X509Certificate(decodeURIComponent(req.headers['x-mobile-certificate']));
    return { valid_to: cert.validTo, fingerprint256: cert.fingerprint256 };
  },
});
if (lstatSync(socket, { throwIfNoEntry: false })?.isSocket()) unlinkSync(socket);
createServer((req, res) => {
  if (req.url !== '/health') return serve(req, res);
  try {
    loadProjects();
    if (!/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(readFileSync(pin, 'utf8').trim()))
      throw Error('pin');
    res.writeHead(204);
  } catch {
    res.writeHead(503);
  }
  res.end();
}).listen(socket, () => chmodSync(socket, 0o660));
