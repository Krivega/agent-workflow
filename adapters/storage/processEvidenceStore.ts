import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  EvidenceContext,
  EvidenceGrant,
  MaintenanceAction,
  StoreReply,
  StoreRequest,
} from '../../core/evidence.js';
import type { EvidenceMaintenance, EvidenceStore } from '../../ports/evidenceStore.js';
import { failure } from './storeCodec.js';

export class ProcessEvidenceStore implements EvidenceStore, EvidenceMaintenance {
  constructor(
    private readonly root: string,
    private readonly grant: EvidenceGrant,
  ) {}
  execute(request: StoreRequest): Promise<StoreReply> {
    return this.send(request, null);
  }
  administer(context: EvidenceContext, action: MaintenanceAction): Promise<StoreReply> {
    return this.send({ context, command: { type: 'state' } }, action);
  }
  private send(request: StoreRequest, maintenance: MaintenanceAction | null): Promise<StoreReply> {
    return new Promise((resolve) => {
      const failed = (error: unknown) =>
        resolve(
          failure(
            error,
            request,
            this.root,
            request.command.type === 'mutate' || maintenance !== null,
          ),
        );
      const child = spawn(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          fileURLToPath(new URL('../../cli/storageWorker.ts', import.meta.url)),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const output: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      child.stderr.resume();
      child.on('error', failed);
      child.stdin.on('error', failed);
      child.on('close', (code) => {
        if (code !== 0) {
          failed(new Error('storage process did not return a receipt'));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(output).toString('utf8')) as StoreReply);
        } catch (error) {
          failed(error);
        }
      });
      child.stdin.end(JSON.stringify({ root: this.root, grant: this.grant, request, maintenance }));
    });
  }
}
