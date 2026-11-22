import { basename, dirname, join, sep } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { decodeChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import type { ComparisonParticipant } from '../adapters/codex/comparisonUsage.js';
import { digest } from '../adapters/storage/storeCodec.js';
import { councilRoles } from '../core/council.js';
import {
  exactFields,
  identifier,
  object,
  requireContract,
  text,
} from '../src/contracts/project.js';
import { h04Pin, readH04Pin } from './comparisonH04Contract.js';
import { checkH06NativeUsage } from './comparisonH06NativeUsage.js';

function json(value: unknown) {
  return object(JSON.parse(readH04Pin(h04Pin(value)).toString()));
}

/** Account for evidenced council sessions without inferring that the supplied roster is complete. */
export function checkH06NativeLegacyCouncilUsage(value: unknown) {
  const input = object(value);
  exactFields(input, ['started', 'roles']);
  const started = h04Pin(input.started);
  const root = dirname(started.path);
  const start = json(started);
  const claimPin = h04Pin(start.claim);
  const claim = json(claimPin);
  const request = object(claim.request);
  const binding = object(request.binding);
  const context = object(start.context);
  const workspace = text(binding.workspaceRoot);
  const sessionsRoot = text(object(claim.grant).sessionsRoot);
  const run = identifier(context.run_id);
  requireContract(
    same(
      [
        started.path,
        claimPin.path,
        start.kind,
        claim.kind,
        request.evidenceRoot,
        binding.variant,
        binding.operationId,
      ],
      [
        join(root, 'legacy-operator-start.json'),
        join(root, 'attempt-claim.json'),
        'h06-native-legacy-operator-start',
        'h06-native-attempt-claim',
        root,
        'legacy',
        context.task_id,
      ],
    ),
    'h06-legacy-council-attempt',
  );
  requireContract(Array.isArray(input.roles), 'h06-legacy-council-roles');
  const participants = input.roles.map((value) => {
    const row = object(value);
    exactFields(row, ['intent', 'progress', 'transcript']);
    const intent = h04Pin(row.intent);
    const progress = h04Pin(row.progress);
    const directory = dirname(intent.path);
    requireContract(
      directory.startsWith(root + sep) && basename(directory) === 'council',
      'h06-legacy-council-directory',
    );
    const read = (pin: typeof intent) =>
      object(decodeChatArtifact(directory, readH04Pin(pin).toString()));
    const created = read(intent);
    const role = text(created.role);
    requireContract(
      councilRoles.includes(role as (typeof councilRoles)[number]) &&
        same(
          [intent.path, progress.path, created.parent_run],
          [join(directory, `create-${role}.json`), join(directory, `${role}.json`), run],
        ),
      'h06-legacy-council-role',
    );
    const saved = read(progress);
    const session = object(saved.session);
    const id = identifier(session.id);
    const spec = object(object(saved.run).spec);
    const profile = object(created.profile);
    const creation = object(session.receipt);
    const receipt = h04Pin({ path: creation.locator, sha256: creation.hash });
    requireContract(
      receipt.path === join(directory, `${id}.json.${receipt.sha256}`),
      'h06-legacy-council-receipt',
    );
    const primary = read(receipt);
    const native = object(primary.session);
    const thread = object(native.thread);
    const sandbox = object(native.sandbox);
    requireContract(
      id !== context.actor_id &&
        same(
          {
            role: spec.role,
            parentRun: spec.parent_run_id,
            run: spec.run_id,
            session: spec.session_id,
            workspace: spec.workspace,
          },
          {
            role: 'council-adviser',
            parentRun: run,
            run: `${run}-${role}`,
            session: id,
            workspace,
          },
        ) &&
        same([session.workspace, session.project_id], [workspace, context.project_id]) &&
        same(
          {
            operation: primary.operation,
            parent: primary.parent,
            thread: { id: thread.id, cwd: thread.cwd, turns: thread.turns },
            cwd: native.cwd,
            model: native.model,
            effort: native.reasoningEffort,
            approval: native.approvalPolicy,
            sandbox: sandbox.type,
            network: sandbox.networkAccess,
          },
          {
            operation: 'thread/start',
            parent: null,
            thread: { id, cwd: workspace, turns: [] },
            cwd: workspace,
            model: text(profile.model),
            effort: text(profile.effort),
            approval: 'never',
            sandbox: 'readOnly',
            network: false,
          },
        ),
      'h06-legacy-council-session',
    );
    const transcript = h04Pin(row.transcript);
    requireContract(
      transcript.path.startsWith(sessionsRoot + sep),
      'h06-legacy-council-transcript',
    );
    const bytes = readH04Pin(transcript);
    const body = bytes.toString();
    requireContract(
      Buffer.from(body).equals(bytes) && body.endsWith('\n'),
      'h06-legacy-council-transcript',
    );
    const lines = body.slice(0, -1).split('\n');
    const sessionRow = object(JSON.parse(lines[0]!));
    const meta = object(sessionRow.payload);
    requireContract(
      same([sessionRow.type, meta.id, meta.cwd], ['session_meta', id, workspace]),
      'h06-legacy-council-transcript',
    );
    const expected: ComparisonParticipant = {
      session: id,
      transcript: transcript.path,
      run,
      stage: 'council',
    };
    const sealed = {
      ...expected,
      through: {
        locator: `${transcript.path}#L${lines.length}`,
        hash: digest(lines.at(-1)! + '\n'),
      },
    };
    return { expected, sealed, transcript };
  });
  const budget = object(request.budget);
  const councilUsage = checkH06NativeUsage({
    expected: participants.map(({ expected }) => expected),
    participants: participants.map(({ sealed }) => sealed),
    budget: {
      maxInputUncached: budget.maxInputUncached as number,
      maxOutput: budget.maxOutput as number,
    },
  });
  for (const { transcript } of participants) readH04Pin(transcript);
  return { councilUsage, qualification: false } as const;
}
