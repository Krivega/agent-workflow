// Consumer wrappers call this before dispatch. The CLI and SDK validate the actual admission.
export async function checkConsumerRelease(args) {
  const [action, subcommand] = args;
  if (action === 'task-chat' && subcommand === 'start' && args.includes('--temporal-input')) return;
  if (['init', 'doctor', '--help', '-h'].includes(action)) return;
  throw Error('backend-consumer-not-qualified');
}
