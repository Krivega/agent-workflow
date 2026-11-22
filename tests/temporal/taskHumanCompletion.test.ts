import { chmodSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import type { HumanManagedTaskInput, TaskSnapshot } from '../../src/contracts/localTask.js';
import type { ArtifactRef } from '../../src/contracts/preparation.js';
import type {
  TaskHumanFinishRequest,
  TaskHumanManifest,
  TaskHumanTechnicalCompletion,
} from '../../src/contracts/taskHuman.js';
import type {
  TaskStartAdmission,
  VerifiedStartAdmission,
} from '../../src/contracts/taskStartAdmission.js';
import type { WriterProcesses } from '../../src/contracts/writerProcesses.js';
import {
  inspectTaskHumanTechnical,
  requireTaskHumanCompletionSeal,
} from '../../src/activities/taskHumanCompletion.js';
import {
  taskHumanActivities,
  type TaskHumanActivityPorts,
} from '../../src/activities/taskHuman.js';
import { finalizationActivities } from '../../src/activities/finalization.js';
import { makeArchiveCommand } from '../../src/client/finalization.js';
import { finalizationTarget } from '../../src/policy/finalization.js';
import { taskControlTarget } from '../../src/policy/taskContinuation.js';
import { createTaskHumanState } from '../../src/policy/taskHuman.js';
import { localTaskKey } from '../../src/policy/localTask.js';
import { taskGate } from '../../src/adapters/project/taskGate.js';
import { taskFiles } from '../../src/adapters/project/taskFiles.js';
import { taskWriter } from '../../src/adapters/codex/taskWriter.js';
import { digest, privateDirectory, publishFile } from '../../src/adapters/artifacts/files.js';
import { object } from '../../src/contracts/project.js';
import { controlRef } from '../../src/policy/readerControl.js';
import { substantialTaskFixture } from './substantialTaskFixture.js';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const f = substantialTaskFixture(),
    files = taskFiles(f.registration.artifactRoot),
    input: HumanManagedTaskInput = {
      ...f.substantialInput,
      schemaVersion: 12,
      startAdmission: f.proof,
      continuation: { attempt: 0, previous: null },
    },
    target = { ...taskControlTarget(input), roleId: 'task' as const },
    card = {
      path: input.admission.preparation.card,
      ...f.store.publish(readFileSync(join(f.workspace, input.admission.preparation.card))),
    },
    admission: TaskStartAdmission = {
      schemaVersion: 1,
      kind: 'task-start-admission',
      previous: null,
      target,
      card,
      requirements: { sha256: card.sha256, bytes: card.bytes },
      principal: {
        owner: target.owner,
        threadId: 'unit-thread',
        turnId: 'unit-turn',
        source: { locator: 'unit://trusted-principal-port', hash: f.proof.sha256 },
        proof: f.proof,
      },
      criteria: [
        {
          id: 'validate',
          text: 'validate',
          kind: 'check',
          applicable: true,
          reason: 'Synthetic check-only unit floor; native authority is tested separately.',
        },
      ],
    };
  input.startAdmission = f.save(admission);
  const manifest: TaskHumanManifest = {
      schemaVersion: 1,
      kind: 'task-human-gate-manifest',
      target,
      card,
      requirements: admission.requirements,
      declaration: input.startAdmission,
      criteria: admission.criteria,
    },
    bound = { manifest, ref: f.save(manifest) },
    source = files.binding(f.workspace),
    copyRoot = privateDirectory(
      join(f.registration.artifactRoot, 'copies', digest(localTaskKey(input)) + '-a0'),
    );
  writeFileSync(join(copyRoot, 'candidate.txt'), 'Synthetic retained candidate bytes.\n');
  const binary = join(f.workspace, 'synthetic-check');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const tree = files.tree(copyRoot),
    body: TaskSnapshot = {
      schemaVersion: 3,
      kind: 'substantial-task',
      input,
      admission: f.proof,
      profile: f.profile,
      disabledServers: [],
      source,
      copy: files.binding(copyRoot),
      tree,
      commands: {
        unit: {
          executable: binary,
          args: [],
          timeoutMs: 1000,
          sha256: digest(readFileSync(binary)),
        },
      },
      plan: f.proposal,
      planning: { accepted: f.proof, sessions: [] },
    },
    snapshot = f.save(body),
    gate = taskGate(input, source, f.profile, f.registration.artifactRoot, 'prior-host');
  gate.install();
  publishFile(join(gate.directory, 'snapshot.json'), Buffer.from(JSON.stringify(snapshot)));
  const processes: WriterProcesses = {
      alive: vi.fn(async () => []),
      descendants: vi.fn(async () => []),
      terminate: vi.fn(async () => []),
      wait: vi.fn(async () => {}),
    },
    runtime = vi.fn(() => {
      throw Error('A Writer must not start in this readonly proof fixture.');
    }),
    writer = taskWriter(body, files, gate, runtime, processes, vi.fn()),
    writerStop = await writer.stop(),
    packet = {
      schemaVersion: 1 as const,
      preparation: input.admission.preparation,
      reviewId: 'unit-review',
      request: f.save(f.request),
    },
    check = f.save({
      kind: 'task-check',
      input,
      stage: 'integrated',
      stop: { confirmed: true, processes: [] },
    }),
    final = f.save({
      kind: 'task-checks',
      status: 'PASS',
      stage: 'integrated',
      input,
      snapshot,
      tree,
      outcomes: [{ proof: check }],
    }),
    accepted = {
      review: packet,
      result: { session: null, answer: f.proof, stop: writerStop, tree: f.save(tree) },
      finalChecks: final,
      intent: f.proof,
      packet: f.proof,
    };
  publishFile(
    join(gate.directory, 'checks-integrated-intent.json'),
    Buffer.from(JSON.stringify({ kind: 'synthetic-check-intent' })),
  );
  publishFile(
    join(gate.directory, 'checks-integrated.json'),
    Buffer.from(JSON.stringify({ status: 'PASS', manifest: final })),
  );
  publishFile(join(gate.directory, 'acceptance.json'), Buffer.from(JSON.stringify(accepted)));
  const acceptance = f.save({
      schemaVersion: 1,
      kind: 'reader-review-result',
      complete: true,
      input: packet,
      plan: f.proof,
      answers: [],
      reports: [],
    }),
    stopped = f.save({
      kind: 'task-stopped',
      input,
      confirmed: true,
      writer: writerStop,
      checksStopped: [],
    });
  publishFile(join(gate.directory, 'stopped.json'), Buffer.from(JSON.stringify(stopped)));
  gate.release();
  const technical: TaskHumanTechnicalCompletion = {
      input,
      snapshot,
      packet,
      acceptance,
      stopped,
      records: [final, writerStop],
    },
    declared: VerifiedStartAdmission = {
      ref: input.startAdmission,
      admission,
      initial: { ref: input.startAdmission, admission },
      manifest: bound,
    },
    inspect = () => inspectTaskHumanTechnical(f.registration, f.profile, [], processes, technical),
    environment = new MockActivityEnvironment({
      isLocal: false,
      workflowType: 'LocalTaskWorkflow',
      workflowExecution: { workflowId: localTaskKey(input), runId: 'unit-run' },
      activityType: 'finishTaskHuman',
      activityId: 'unit-finish',
      taskQueue: 'unit.queue',
      namespace: 'unit.namespace',
    }),
    ports: TaskHumanActivityPorts = {
      taskQueue: 'unit.queue',
      namespace: 'unit.namespace',
      declaration: vi.fn(async () => declared),
      technical: async (value) => {
        await inspectTaskHumanTechnical(f.registration, f.profile, [], processes, value);
      },
      finish: vi.fn(async () => ({
        status: 'done' as const,
        result: f.proof,
        projection: f.proof,
      })),
      control: async () => {
        throw Error('not used');
      },
      budget: async () => ({ limit: 1, used: 0, manifest: f.proof }),
    },
    service = taskHumanActivities(f.registration, ports),
    request: TaskHumanFinishRequest = {
      schemaVersion: 1,
      kind: 'task-human-finish',
      input,
      state: { ...createTaskHumanState(bound), closed: true },
      technical,
      expectedRevision: 0,
    },
    sealPath = join(gate.directory, '..', '..', 'human-completion', snapshot.sha256 + '.json');
  async function seal() {
    await environment.run(() => service.finishTaskHuman(request));
    return controlRef(JSON.parse(readFileSync(sealPath, 'utf8')) as unknown);
  }
  const read = (ref: ArtifactRef) =>
    object(JSON.parse(f.store.read(ref).toString('utf8')) as unknown);
  function changeSeal(mutate: (value: Record<string, unknown>) => void) {
    const old = controlRef(JSON.parse(readFileSync(sealPath, 'utf8')) as unknown),
      value = read(old);
    mutate(value);
    const ref = f.save(value);
    writeFileSync(sealPath, JSON.stringify(ref));
    return ref;
  }
  function done(sealRef: ArtifactRef) {
    const result = f.save({
        kind: 'local-task-result',
        input,
        snapshot,
        packet,
        review: acceptance,
        checks: final,
        writer: accepted.result,
        complete: true,
        humanCompletion: sealRef,
      }),
      projection = f.save({ kind: 'synthetic-projection' }),
      commit = f.save({
        kind: 'task-completion-intent',
        input,
        snapshot,
        packet,
        review: acceptance,
        result,
        projection,
        humanCompletion: sealRef,
      });
    publishFile(
      join(gate.directory, 'completion-intent.json'),
      Buffer.from(JSON.stringify(commit)),
    );
    publishFile(
      join(gate.directory, 'done.json'),
      Buffer.from(JSON.stringify({ status: 'done', result, projection })),
    );
    return { result, projection, commit };
  }
  return {
    ...f,
    input,
    body,
    source,
    copyRoot,
    binary,
    gate,
    technical,
    processes,
    runtime,
    inspect,
    environment,
    ports,
    request,
    sealPath,
    seal,
    changeSeal,
    done,
    read,
    packet,
    final,
    acceptance,
    stopped,
    snapshot,
  };
}
function inventory(root: string): unknown[] {
  const rows: unknown[] = [];
  function visit(path: string) {
    const s = statSync(path);
    rows.push({ path, mode: s.mode & 0o777, hash: s.isFile() ? digest(readFileSync(path)) : null });
    if (s.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  }
  visit(root);
  return rows;
}

describe('readonly retained technical and human completion issuance boundaries', () => {
  it('reads real retained stop evidence without granting a Writer or changing files', async () => {
    const f = await fixture(),
      before = inventory(f.root),
      observed = await f.inspect();
    expect(observed.source).toEqual(f.source);
    expect(observed.directory).toBe(f.gate.directory);
    expect(observed.inspection.outcome).toEqual(f.stopped);
    await observed.inspection.recheck();
    observed.assertBindings();
    expect(inventory(f.root)).toEqual(before);
    expect(f.runtime).not.toHaveBeenCalled();
    expect(() => f.gate.assert()).toThrow();
  });
  it('keeps a consistent captured input while observing an async stop and rechecks private acceptance bytes', async () => {
    const f = await fixture(),
      original = f.technical.snapshot;
    vi.mocked(f.processes.alive).mockImplementation(async () => {
      f.technical.snapshot = f.proof;
      return [];
    });
    const checked = await f.inspect();
    expect(checked.snapshot).toEqual(f.body);
    f.technical.snapshot = original;
    writeFileSync(join(f.gate.directory, 'acceptance.json'), '{}');
    await expect(checked.inspection.recheck()).rejects.toThrow('journal-changed');
  });
  it.each([
    'profile',
    'disabled',
    'input',
    'snapshot-pointer',
    'stop-pointer',
    'packet',
    'failed-review',
    'failed-checks',
    'writer-stop',
    'binary',
    'copy',
  ])('rejects retained technical substitution: %s', async (kind) => {
    const f = await fixture();
    let profile = f.profile,
      disabled: string[] = [];
    if (kind === 'profile') profile = { ...profile, effort: 'high' };
    if (kind === 'disabled') disabled = ['foreign'];
    if (kind === 'input') f.technical.input = { ...f.input, baseline: 'foreign' };
    if (kind === 'snapshot-pointer')
      writeFileSync(join(f.gate.directory, 'snapshot.json'), JSON.stringify(f.proof));
    if (kind === 'stop-pointer')
      writeFileSync(join(f.gate.directory, 'stopped.json'), JSON.stringify(f.proof));
    if (kind === 'packet') f.technical.packet = { ...f.packet, reviewId: 'foreign' };
    if (kind === 'failed-review')
      f.technical.acceptance = f.save({ ...f.read(f.acceptance), complete: false });
    if (kind === 'failed-checks') {
      const failed = f.save({ ...f.read(f.final), status: 'FAIL' }),
        accepted = object(
          JSON.parse(readFileSync(join(f.gate.directory, 'acceptance.json'), 'utf8')) as unknown,
        );
      accepted.finalChecks = failed;
      writeFileSync(join(f.gate.directory, 'acceptance.json'), JSON.stringify(accepted));
      writeFileSync(
        join(f.gate.directory, 'checks-integrated.json'),
        JSON.stringify({ manifest: failed }),
      );
    }
    if (kind === 'writer-stop') {
      const accepted = object(
        JSON.parse(readFileSync(join(f.gate.directory, 'acceptance.json'), 'utf8')) as unknown,
      );
      object(accepted.result).stop = f.proof;
      writeFileSync(join(f.gate.directory, 'acceptance.json'), JSON.stringify(accepted));
    }
    if (kind === 'binary') writeFileSync(f.binary, 'changed executable');
    if (kind === 'copy') writeFileSync(join(f.copyRoot, 'candidate.txt'), 'late writer');
    await expect(
      inspectTaskHumanTechnical(f.registration, profile, disabled, f.processes, f.technical),
    ).rejects.toThrow();
    expect(f.runtime).not.toHaveBeenCalled();
  });
  it('requires the actual private issuance pointer, then accepts an Activity-produced seal without current card SHA', async () => {
    const f = await fixture();
    expect(() => requireTaskHumanCompletionSeal(f.registration, f.input)).toThrow();
    const ref = await f.seal(),
      before = inventory(f.root),
      expected = {
        snapshot: f.snapshot,
        packet: f.packet,
        review: f.acceptance,
        seal: ref,
        producer: { namespace: 'unit.namespace', taskQueue: 'unit.queue' },
      };
    const checked = requireTaskHumanCompletionSeal(f.registration, f.input, expected);
    expect(checked.ref).toEqual(ref);
    expect(checked.seal.producer).toMatchObject({
      workflowType: 'LocalTaskWorkflow',
      isLocal: false,
      activityType: 'finishTaskHuman',
    });
    expect(inventory(f.root)).toEqual(before);
    writeFileSync(
      join(f.workspace, f.input.admission.preparation.card),
      'DONE card text after valid completion.\n',
    );
    expect(requireTaskHumanCompletionSeal(f.registration, f.input).ref).toEqual(ref);
    expect(() =>
      requireTaskHumanCompletionSeal(f.registration, f.input, {
        ...expected,
        producer: { namespace: 'foreign', taskQueue: 'unit.queue' },
      }),
    ).toThrow('producer-scope');
  });
  it.each([
    'workflow',
    'workflow-type',
    'local',
    'activity',
    'empty-run',
    'input',
    'open',
    'pending',
    'manifest',
    'revision',
    'snapshot',
    'packet',
    'review',
    'seal',
  ])('rejects incomplete or foreign retained seal: %s', async (kind) => {
    const f = await fixture(),
      ref = await f.seal();
    let expected: {
      snapshot?: ArtifactRef;
      packet?: typeof f.packet;
      review?: ArtifactRef;
      seal?: ArtifactRef;
    } = {};
    if (kind === 'review') expected = { review: f.proof };
    else if (kind === 'seal') expected = { seal: f.proof };
    else
      f.changeSeal((value) => {
        const producer = object(value.producer),
          request = object(value.request),
          state = object(request.state),
          technical = object(request.technical);
        if (kind === 'workflow') producer.workflowId = 'foreign';
        if (kind === 'workflow-type') producer.workflowType = 'ForeignWorkflow';
        if (kind === 'local') producer.isLocal = true;
        if (kind === 'activity') producer.activityType = 'foreign';
        if (kind === 'empty-run') producer.runId = '';
        if (kind === 'input') request.input = { ...f.input, baseline: 'foreign' };
        if (kind === 'open') state.closed = false;
        if (kind === 'pending')
          state.pending = {
            questionId: 'late',
            criterionId: 'validate',
            requirementsRevision: 1,
            askedRevision: 0,
          };
        if (kind === 'manifest') object(object(state.current).manifest).declaration = f.proof;
        if (kind === 'revision') request.expectedRevision = 1;
        if (kind === 'snapshot') technical.snapshot = f.proof;
        if (kind === 'packet')
          technical.packet = { ...f.packet, preparation: { ...f.packet.preparation, revision: 2 } };
      });
    expect(() => requireTaskHumanCompletionSeal(f.registration, f.input, expected)).toThrow();
    expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
  it('rejects an unchecked human gate even with closed=true and refuses unsafe pointer modes', async () => {
    const f = await fixture();
    await f.seal();
    f.changeSeal((value) => {
      const state = object(object(value.request).state),
        bound = object(state.current),
        manifest = object(bound.manifest);
      manifest.criteria = [
        { id: 'C1: принято', text: 'C1: принято', kind: 'human', applicable: true, reason: 'unit' },
      ];
      bound.ref = f.save(manifest);
    });
    expect(() => requireTaskHumanCompletionSeal(f.registration, f.input)).toThrow('gates-open');
    const g = await fixture();
    await g.seal();
    chmodSync(g.sealPath, 0o644);
    expect(() => requireTaskHumanCompletionSeal(g.registration, g.input)).toThrow('private-file');
  });
  it('requires matching seal in private commit/result/DONE and keeps valid historical reads after completion', async () => {
    const f = await fixture(),
      ref = await f.seal(),
      done = f.done(ref);
    expect(requireTaskHumanCompletionSeal(f.registration, f.input).ref).toEqual(ref);
    unlinkSync(join(f.gate.directory, 'done.json'));
    expect(requireTaskHumanCompletionSeal(f.registration, f.input).ref).toEqual(ref);
    writeFileSync(
      join(f.gate.directory, 'done.json'),
      JSON.stringify({ status: 'done', result: done.result, projection: done.projection }),
      { mode: 0o600 },
    );
    const commit = f.read(done.commit),
      badResult = f.save({ ...f.read(done.result), humanCompletion: f.proof });
    writeFileSync(
      join(f.gate.directory, 'completion-intent.json'),
      JSON.stringify(f.save({ ...commit, result: badResult })),
    );
    expect(() => requireTaskHumanCompletionSeal(f.registration, f.input)).toThrow('result-binding');
    writeFileSync(join(f.gate.directory, 'completion-intent.json'), JSON.stringify(done.commit));
    writeFileSync(
      join(f.gate.directory, 'done.json'),
      JSON.stringify({ status: 'done', result: f.proof, projection: done.projection }),
    );
    expect(() => requireTaskHumanCompletionSeal(f.registration, f.input)).toThrow('done-binding');
    unlinkSync(join(f.gate.directory, 'completion-intent.json'));
    expect(() => requireTaskHumanCompletionSeal(f.registration, f.input)).toThrow(
      'intent-required',
    );
  });
  it('guards the actual finalization consumer only for v12 before archive reconciliation effects', async () => {
    const f = await fixture(),
      ref = await f.seal(),
      done = f.done(ref),
      base = {
        preparation: f.input.admission.preparation,
        result: done.result,
        command: makeArchiveCommand({
          schemaVersion: 3,
          commandId: 'archive',
          target: taskControlTarget(f.input),
          expectedRevision: 0,
          author: f.input.admission.preparation.owner,
          action: 'archive',
          attempt: 0,
          source: f.proof,
          payload: f.proof,
        }),
      },
      command = makeArchiveCommand({ ...base.command, target: finalizationTarget(base) }),
      input = {
        schemaVersion: 1 as const,
        operation: 'archive' as const,
        preparation: base.preparation,
        result: done.result,
        command,
      },
      authority = {
        verify: vi.fn(async () => ({
          origin: 'human' as const,
          author: command.author,
          hash: command.hash,
          proof: f.proof,
        })),
      },
      service = finalizationActivities(f.registration, authority, join(f.root, 'finalization'));
    await expect(f.environment.run(() => service.reconcileFinalizedTask(input))).resolves.toEqual({
      status: 'unknown',
      reason: 'archive-effect-missing',
    });
    f.changeSeal((value) => {
      object(value.producer).activityType = 'forged-finish';
    });
    await expect(f.environment.run(() => service.reconcileFinalizedTask(input))).rejects.toThrow(
      'producer',
    );
    expect(authority.verify).not.toHaveBeenCalled();
  });
});
