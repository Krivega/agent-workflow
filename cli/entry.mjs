#!/usr/bin/env node
import { register } from 'tsx/esm/api';
register();
const [action, ...args] = process.argv.slice(2);
if (action === 'init' || action === 'doctor') {
  try {
    if (args.length) throw Error('Использование: agent-workflow ' + action);
    const { setupConsumer } = await import('./consumerSetup.mjs');
    console.log(JSON.stringify(setupConsumer(action, process.cwd())));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else {
  await import('./main.ts');
}
