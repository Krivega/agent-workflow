import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { PreparationInput } from '../../contracts/preparation.js';
import type { LocalProjectRegistration } from '../../contracts/preparation.js';
import type { TaskSnapshot } from '../../contracts/localTask.js';
import { requireContract, parseProject } from '../../contracts/project.js';
import { digest, readProjectFile } from '../artifacts/files.js';

export function captureRegistration(value: LocalProjectRegistration): LocalProjectRegistration {
  requireContract(
    value.taskBackend === undefined || value.taskBackend === 'required',
    'backend-registration-invalid',
  );
  return {
    ...value,
    project: parseProject(value.project),
    commands: structuredClone(value.commands),
  };
}

export function checkRegisteredCommands(
  registration: LocalProjectRegistration,
  checks: readonly string[],
): void {
  for (const check of checks) {
    requireContract(Object.hasOwn(registration.commands, check), 'unregistered-check');
    const command = registration.commands[check]!;
    requireContract(
      command.executable.length > 0 && Array.isArray(command.args),
      'invalid-registered-command',
    );
  }
}

export function resolveRegisteredCommands(
  registration: LocalProjectRegistration,
  checks: readonly string[],
): TaskSnapshot['commands'] {
  const commands: TaskSnapshot['commands'] = {};
  for (const name of new Set(checks)) {
    const command = registration.commands[name];
    requireContract(
      Object.hasOwn(registration.commands, name) &&
        command !== undefined &&
        command.executable.length > 0 &&
        Array.isArray(command.args) &&
        command.args.every((arg) => typeof arg === 'string'),
      'task-command-unregistered',
    );
    const timeoutMs = command.timeoutMs ?? 1200000;
    requireContract(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 1200000,
      'task-check-timeout-invalid',
    );
    const executable = realpathSync(
      isAbsolute(command.executable)
        ? command.executable
        : execFileSync('which', [command.executable], { encoding: 'utf8' }).trim(),
    );
    commands[name] = {
      executable,
      args: [...command.args],
      timeoutMs,
      sha256: digest(readFileSync(executable)),
    };
  }
  return commands;
}

export function preparationInputs(workspace: string, input: PreparationInput) {
  const paths = [
    ...new Set([
      ...input.project.rules,
      ...input.project.roles.map((role) => role.profile),
      input.card,
    ]),
  ];
  return paths.map((path) => {
    const bytes = readProjectFile(workspace, path);
    return { path, sha256: digest(bytes), bytes: bytes.length };
  });
}
