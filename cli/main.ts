import { runTaskChatCommand } from './taskChatCommand.js';

const args = process.argv.slice(2);
if (args[0] === 'task-chat') {
  process.exitCode = await runTaskChatCommand(
    args.slice(1),
    process.cwd(),
    (text) => console.log(text),
    (text) => console.error(text),
  );
} else {
  const { fileProjectManifestReader } =
    await import('../adapters/project/fileProjectManifestReader.js');
  const { fileConnectionReader } = await import('../adapters/project/fileConnectionReader.js');
  const { runAgentWorkflow } = await import('./runAgentWorkflow.js');
  const { connectionCommands, runTaskConnectionCommand } =
    await import('./taskConnectionCommand.js');
  const { chatCommands, runChatCommand } = await import('./chatCommand.js');
  process.exitCode = chatCommands.includes(args[0] as (typeof chatCommands)[number])
    ? await runChatCommand(
        args,
        (text) => console.log(text),
        (text) => console.error(text),
      )
    : connectionCommands.includes(args[0] as (typeof connectionCommands)[number])
      ? await runTaskConnectionCommand(
          args,
          process.cwd(),
          (text) => console.log(text),
          (text) => console.error(text),
        )
      : await runAgentWorkflow(args, {
          projectReader: fileProjectManifestReader,
          connectionReader: fileConnectionReader,
          cwd: process.cwd(),
          write: (text) => console.log(text),
          writeError: (text) => console.error(text),
        });
}
