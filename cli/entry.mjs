#!/usr/bin/env node
import { register } from 'tsx/esm/api';

register();
const [action, ...args] = process.argv.slice(2);
const usage =
  'Использование: agent-workflow init | doctor | task-chat start --temporal-input <file> --temporal-registration <file>';
try {
  if (action === 'init' || action === 'doctor') {
    if (args.length) throw Error('Использование: agent-workflow ' + action);
    const { setupConsumer } = await import('./consumerSetup.mjs');
    console.log(JSON.stringify(setupConsumer(action, process.cwd())));
  } else if (action === 'task-chat' && args[0] === 'start') {
    const { taskBackendPolicy } = await import('../src/adapters/project/taskBackend.ts');
    const { runTemporalStart } = await import('./temporalStart.ts');
    const root = process.cwd();
    await runTemporalStart(args, root, taskBackendPolicy(root), (text) => console.log(text));
  } else if (action === '--help' || action === '-h') {
    console.log(usage);
  } else {
    throw Error('backend-consumer-not-qualified');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
