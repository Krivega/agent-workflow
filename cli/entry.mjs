#!/usr/bin/env node
import { register } from 'tsx/esm/api';

register();
const [action, ...args] = process.argv.slice(2);
try {
  if (action === 'init' || action === 'doctor') {
    if (args.length) throw Error('Использование: agent-workflow ' + action);
    const { setupConsumer } = await import('./consumerSetup.mjs');
    console.log(JSON.stringify(setupConsumer(action, process.cwd())));
  } else if (action === 'task-chat') {
    const { runTemporalTaskChat } = await import('./temporalStart.ts');
    process.exitCode = await runTemporalTaskChat(args, process.cwd(), console.log, console.error);
  } else if (action === '--help' || action === '-h') {
    console.log('Использование: agent-workflow init | doctor | task-chat --help');
  } else {
    throw Error('backend-consumer-not-qualified');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
