import { resolve } from 'node:path';
import { object, requireWorkflow, textField } from '../core/connection.js';
import { assertCoderParent } from '../core/coder.js';
import type { Connection } from '../core/connection.js';
import type { CoderBrief, CoderRun } from '../core/coder.js';
import { requiredProcedures } from '../core/localRun.js';
import { sameValue } from '../core/equality.js';
import type { ChatDependencies } from '../application/currentChatWorkflow.js';
import { cancelCoder, integrateCoder, runCoder, startCoder } from '../application/coderWorkflow.js';
import type { CoderDependencies } from '../application/coderWorkflow.js';
import type { CoderSessions } from '../ports/coder.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { FileCoderWorkspaces } from '../adapters/project/coderWorkspaces.js';
import type { AppServerCoderSessions } from '../adapters/codex/appServerCoder.js';
import { coderCreationRefusal, refuseCoderCreation } from '../adapters/codex/coderCreation.js';
import { nativeCreationProof } from '../adapters/codex/transportJournal.js';
import type { StdioAppServer } from '../adapters/codex/appServerTransport.js';
import { NativeWriterProcesses } from '../adapters/codex/writerProcesses.js';
import { openNativeCoderSessions } from './nativeCoderSessions.js';

export async function executeCoderRequest(
  request: Record<string, unknown>,
  deps: Pick<ChatDependencies, 'runs' | 'journal'>,
  assertRuntime: () => void,
  connection?: { locator: string; descriptor: Connection },
) {
  const options = object(request.coder),
    action = textField(options.action);
  requireWorkflow(
    ['run', 'integrate', 'cancel', 'status'].includes(action),
    'invalid-coder-action',
  );
  const id = textField(options.id);
  requireWorkflow(/^[a-zA-Z0-9_-]+$/u.test(id), 'unsafe-coder-id');
  const root = textField(request.root),
    evidence = textField(request.evidence_root);
  const local = await deps.runs.read();
  requireWorkflow(local !== null && 'task_id' in local.spec.identity, 'coder-parent-missing');
  const current = (await deps.journal.read()).coders?.[id];
  if (action === 'status') {
    requireWorkflow(current !== undefined, 'coder-not-found');
    return current;
  }
  const authorize = async (brief: CoderBrief, phase: CoderRun['status'] | null) => {
    assertRuntime();
    requireWorkflow(
      !interrupted || (phase !== null && ['stopping', 'stopped', 'released'].includes(phase)),
      'coder-interrupted',
    );
    const parent = await deps.runs.read();
    requireWorkflow(parent !== null, 'coder-parent-missing');
    assertCoderParent(parent, brief);
    const child = (await deps.journal.read()).coders?.[id];
    requireWorkflow(
      phase === null
        ? child === undefined
        : child !== undefined && child.status === phase && sameValue(child.brief, brief),
      'coder-ownership-changed',
    );
  };
  const workspaces = new FileCoderWorkspaces(root, evidence, authorize);
  const directory = resolve(evidence, 'coders', id),
    journal = resolve(directory, 'transport.jsonl');
  let rpc: StdioAppServer | null = null,
    native: AppServerCoderSessions | null = null;
  let interrupted = false;
  const processes = new NativeWriterProcesses();
  const cancellation: { pending: Promise<CoderRun> | null } = { pending: null };
  const cleanup: { pending: Promise<void> | null } = { pending: null };
  let lastRun: CoderRun | null = null;
  const sessions = async () => {
    if (native !== null) return native;
    const child = (await deps.journal.read()).coders?.[id];
    requireWorkflow(child !== undefined && child.copy !== null, 'coder-copy-missing');
    const binary = request.binary === undefined ? 'codex' : textField(request.binary);
    native = await openNativeCoderSessions({
      run: child,
      binary,
      journal,
      processes,
      adopt(raw) {
        rpc = raw;
        return raw;
      },
      verifyCopy: (run) => workspaces.verifyCopy(run),
      authorize: async (run) => {
        requireWorkflow(!interrupted || run.status === 'stopping', 'coder-interrupted');
        await authorize(run.brief, run.status);
      },
    });
    return native;
  };
  const port: CoderSessions = {
    create: async (run) => {
      lastRun = run;
      const refusal = coderCreationRefusal(directory, journal, run);
      if (refusal !== null) return refusal;
      try {
        return await (await sessions()).create(run);
      } catch (error) {
        if (native !== null || nativeCreationProof(journal, `coder:${id}:create`) !== null)
          throw error;
        rpc?.close();
        return refuseCoderCreation(directory, journal, run, 'coder-bootstrap-unconfirmed');
      }
    },
    recoverCreate: async (run) => {
      lastRun = run;
      return (
        coderCreationRefusal(directory, journal, run) ??
        (await (await sessions()).recoverCreate(run))
      );
    },
    load: async (run, fresh) => {
      lastRun = run;
      return (await sessions()).load(run, fresh);
    },
    send: async (run, fresh) => {
      lastRun = run;
      return (await sessions()).send(run, fresh);
    },
    result: async (run) => {
      lastRun = run;
      return (await sessions()).result(run);
    },
    stop: async (run) => {
      lastRun = run;
      return (await sessions()).stop(run);
    },
  };
  const coder: CoderDependencies = {
    journal: deps.journal,
    runs: deps.runs,
    workspaces,
    sessions: port,
  };
  const stop = () => {
    interrupted = true;
    if (action === 'run' && cancellation.pending === null) {
      cancellation.pending = cancelCoder(id, coder);
      void cancellation.pending.catch(() => {
        cleanup.pending = (async () => {
          try {
            if (native !== null && lastRun !== null) await native.stopOwned(lastRun);
          } finally {
            rpc?.close();
          }
        })();
        void cleanup.pending.catch(() => {});
      });
    }
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    if (action === 'run') {
      let brief: CoderBrief;
      if (current !== undefined) {
        requireWorkflow(options.assignment === undefined, 'coder-brief-replay-conflict');
        brief = current.brief;
      } else {
        const assignment = object(options.assignment);
        requireWorkflow(
          Array.isArray(assignment.paths) &&
            assignment.paths.every((path) => typeof path === 'string') &&
            Array.isArray(assignment.files) &&
            assignment.files.every((path) => typeof path === 'string') &&
            Array.isArray(assignment.checks) &&
            assignment.checks.every((check) => typeof check === 'string'),
          'incomplete-coder-brief',
        );
        const files = new FileWorkflowInputs(root, evidence);
        const rules = (connection?.descriptor.rules ?? ['AGENTS.md']).map((locator) => {
          const rule = local.spec.rules.find((entry) => entry.locator === locator);
          requireWorkflow(rule !== undefined, 'coder-parent-rules-missing');
          return rule;
        });
        if (connection) rules.push(await files.ref(connection.locator));
        rules.push(
          await files.ref(
            connection?.descriptor.coder_profile ?? 'tools/agent-workflow/roles/coder.md',
          ),
        );
        const procedures = local.spec.procedures.filter((procedure) =>
          requiredProcedures('role', 'coder').includes(procedure.id),
        );
        const sources = await Promise.all(
          [
            ...new Set([
              ...(assignment.files as string[]),
              ...rules.map((ref) => ref.locator),
              ...procedures.map((ref) => ref.locator),
            ]),
          ].map((path) => files.ref(path)),
        );
        const route = local.spec.route;
        requireWorkflow(
          (route.kind === 'local' || route.kind === 'substantial') && route.accepted_plan !== null,
          'coder-authority-mismatch',
        );
        brief = {
          id,
          project_id: local.spec.project_id,
          task_id: local.spec.identity.task_id,
          parent_run_id: local.spec.run_id,
          parent_session_id: local.spec.session_id,
          generation: local.generation,
          card: local.spec.identity.card,
          authority: route.accepted_plan,
          source_root: root,
          copy_root: resolve(evidence, 'coder-workspaces', id),
          paths: assignment.paths as string[],
          files: sources,
          goal: textField(assignment.goal),
          criterion: textField(assignment.criterion),
          checks: assignment.checks as string[],
          profile: { model: local.spec.requested.model, effort: local.spec.requested.effort },
          rules,
          procedures,
        };
      }
      await startCoder(brief, coder);
      const result = await runCoder(id, coder);
      return cancellation.pending === null ? result : await cancellation.pending;
    }
    return action === 'integrate' ? await integrateCoder(id, coder) : await cancelCoder(id, coder);
  } catch (error) {
    if (interrupted && action === 'run') {
      await cancellation.pending?.catch(() => {});
      return await cancelCoder(id, coder);
    }
    throw error;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await cancellation.pending?.catch(() => {});
    await cleanup.pending?.catch(() => {});
    try {
      if (native !== null) {
        requireWorkflow(lastRun !== null, 'coder-runtime-unbound');
        let child: CoderRun = lastRun;
        try {
          child = (await deps.journal.read()).coders?.[id] ?? child;
        } catch {
          /* Lost ownership still permits stopping this process's own writer. */
        }
        await (native as AppServerCoderSessions).stopOwned(child);
      }
    } finally {
      if (rpc !== null) (rpc as StdioAppServer).close();
    }
  }
}
