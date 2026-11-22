import { readFileSync } from 'node:fs';
import { Client, Connection } from '@temporalio/client';
import { startPreparation } from './preparation.js';
import { readReaderStatus } from './readerStatus.js';
import { backupCommand } from './backup.js';
import { bindTaskBackendClient, type TaskBackendRegistration } from './taskBackend.js';

const [file, ...args] = process.argv.slice(2);
if (file === '--backup') {
  console.log(JSON.stringify(backupCommand(args)));
} else {
  const [address, taskQueue, registrationFile] = args;
  if (
    !file ||
    !address ||
    !taskQueue ||
    (file !== '--status' && (file.startsWith('--') || !registrationFile))
  )
    throw new Error('Usage: prepare-project INPUT.json ADDRESS TASK_QUEUE REGISTRATION.json');
  const connection =
    file === '--status'
      ? await Connection.connect({ address: taskQueue })
      : Connection.lazy({ address });
  try {
    const client = new Client({ connection });
    if (file === '--status') console.log(JSON.stringify(await readReaderStatus(client, address)));
    else {
      bindTaskBackendClient(
        client,
        JSON.parse(readFileSync(registrationFile!, 'utf8')) as TaskBackendRegistration,
      );
      const handle = await startPreparation(
        client,
        JSON.parse(readFileSync(file, 'utf8')) as unknown,
        taskQueue,
      );
      console.log(JSON.stringify(await handle.result()));
    }
  } finally {
    await connection.close();
  }
}
