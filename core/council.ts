import { parseCouncilConfiguration } from './connection.js';
import type { CouncilConfiguration } from './connection.js';
import { requireLoadedProcedures } from './localRun.js';
import { requireWorkflow, textField } from './connection.js';
import { compareInputs, targetEvidenceInputs } from './evidence.js';
import type { ArchiveRef, InputManifest } from './evidence.js';
import { assertRunAction, confirmLoad } from './localRun.js';
import type { InputRef, LocalRun } from './localRun.js';
import { copyState, sameValue } from './equality.js';
import { confirmDesignReview, designEvidenceApplicable } from './designReview.js';
import type { DesignReview } from './designReview.js';

export const councilRoles = [
  'architect',
  'product',
  'system-analyst',
  'backend',
  'frontend',
  'dba',
  'devops',
  'mobile-game-developer',
  'methodologist-literary-editor',
  'ui-ux-designer',
] as const;
type LegacyRole = (typeof councilRoles)[number];
export type CouncilRole = LegacyRole | (string & { readonly __projectRole: unique symbol });
export function configuredRoles(configuration?: CouncilConfiguration): readonly CouncilRole[] {
  return configuration === undefined
    ? councilRoles
    : (Object.keys(parseCouncilConfiguration(configuration).profiles) as CouncilRole[]);
}
const adviserNames: Record<string, string> = {
  architect: 'Архитектор',
  product: 'Продукт',
  'system-analyst': 'Системный аналитик',
  backend: 'Сервер',
  frontend: 'Интерфейс',
  dba: 'Базы данных',
  devops: 'Сборка и эксплуатация',
  'mobile-game-developer': 'Мобильная игра',
  'methodologist-literary-editor': 'Методист и литературный редактор',
  'ui-ux-designer': 'Дизайнер UI/UX',
};
export function councilAdviserName(role: CouncilRole): string {
  return `Советник: ${adviserNames[role] ?? role}`;
}
export function councilAdviserTaskName(role: CouncilRole): string {
  return `council_${role.replaceAll('-', '_')}`;
}
export function councilProfileLocators(role: CouncilRole): string[] {
  return ['tools/agent-workflow/roles/README.md', `tools/agent-workflow/roles/${role}.md`];
}
export function configuredProfileLocators(
  role: CouncilRole,
  configuration?: CouncilConfiguration,
): string[] {
  if (configuration !== undefined) {
    const profile = configuration.profiles[role];
    requireWorkflow(typeof profile === 'string', 'unknown-council-role');
    return [configuration.catalog, profile];
  }
  return councilProfileLocators(role);
}
export function councilProfileRefs(
  role: CouncilRole,
  requirements: InputRef[],
  configuration?: CouncilConfiguration,
): InputRef[] {
  return configuredProfileLocators(role, configuration).map((locator) => {
    const refs = requirements.filter((ref) => ref.locator === locator);
    requireWorkflow(
      refs.length === 1 && /^[a-f0-9]{64}$/u.test(refs[0]!.hash),
      'council-profile-required',
    );
    return refs[0]!;
  });
}
function confirmCouncilProfile(council: Council, role: CouncilRole, run: LocalRun) {
  const refs = councilProfileRefs(
    role,
    selectedRole(council.selection, role).requirements,
    council.configuration,
  );
  requireWorkflow(run.loaded !== null, 'council-profile-not-loaded');
  confirmLoad(run, run.loaded);
  requireLoadedProcedures(run, ['council']);
  requireWorkflow(
    refs.every((ref) =>
      [run.spec.rules, run.spec.sources].every((inputs) =>
        inputs.some((input) => input.locator === ref.locator && input.hash === ref.hash),
      ),
    ),
    'council-profile-not-loaded',
  );
}
export function councilCurrentProfileRefs(council: Council): InputRef[] {
  return configuredRoles(council.configuration).flatMap((role) =>
    selectedRole(council.selection, role).trigger === true
      ? councilProfileRefs(
          role,
          selectedRole(council.selection, role).requirements,
          council.configuration,
        )
      : [],
  );
}
export type Applicability = {
  trigger: boolean | null;
  reason: string;
  requirements: InputRef[];
  inputs: InputManifest;
};
export type Selection = Record<CouncilRole, Applicability>;
export function selectedRole(selection: Selection, role: CouncilRole): Applicability {
  const entry = selection[role];
  requireWorkflow(entry !== undefined, 'missing-role-selection');
  return entry;
}
export interface ReviewTarget {
  scope: string;
  base: string;
  diff: InputRef;
  inputs: InputManifest;
  evidence_inputs?: InputManifest;
}
export interface ReviewFinding {
  id: string;
  scope: string;
  condition: string;
  reason: string;
  blocking: boolean;
  waivable?: boolean;
  sources: InputRef[];
}
export interface ReviewAnswer {
  verdict: 'PASS' | 'FAIL' | 'NOT RUN' | 'N/A';
  scope: string;
  target: ReviewTarget;
  coverage: 'complete' | 'partial';
  sources: InputRef[];
  limitations: string[];
  findings: ReviewFinding[];
  evidence: InputRef;
  binding?: ReviewBinding;
  design?: DesignReview;
}
export interface CouncilReviewRequest {
  reader?: 'runtime-cli';
  schema_version: 1;
  phase: Council['phase'];
  role: CouncilRole;
  run_id: string;
  project_id: string;
  parent_run_id: string | null;
  identity: LocalRun['spec']['identity'];
  session_id: string;
  assignment: InputRef;
  sources: InputRef[];
  requirements: InputRef[];
  inputs: InputManifest;
  target: ReviewTarget;
  load: InputRef;
  origin: InputRef;
  reads: InputRef[];
}
export interface ReviewBinding {
  schema_version: 1;
  request: CouncilReviewRequest;
  load_turn: string;
  answer_turn: string;
  answer_evidence: InputRef;
  evidence: InputRef;
  request_file?: InputRef;
}
export function councilReviewRequest(
  council: Council,
  role: CouncilRole,
  run: LocalRun,
): CouncilReviewRequest {
  confirmCouncilProfile(council, role, run);
  const load = run.loaded!.native;
  requireWorkflow(load !== undefined, 'native-council-load-required');
  textField(load.locator);
  textField(load.hash);
  const origin = run.loaded!.origin;
  requireWorkflow(origin !== undefined, 'native-council-origin-required');
  textField(origin.locator);
  textField(origin.hash);
  return copyState({
    schema_version: 1,
    ...(council.configuration === undefined ? {} : { reader: 'runtime-cli' as const }),
    phase: council.phase,
    role,
    run_id: run.spec.run_id,
    project_id: run.spec.project_id,
    parent_run_id: run.spec.parent_run_id,
    identity: run.spec.identity,
    session_id: run.spec.session_id,
    assignment: run.spec.assignment,
    sources: run.spec.sources,
    requirements: selectedRole(council.selection, role).requirements,
    inputs: selectedRole(council.selection, role).inputs,
    target: council.target,
    load,
    origin,
    reads: [...run.spec.procedures, ...run.spec.rules].map(({ locator, hash }) => ({
      locator,
      hash,
    })),
  });
}
function confirmReviewBinding(
  council: Council,
  role: CouncilRole,
  run: LocalRun,
  answer: ReviewAnswer,
) {
  const binding = answer.binding;
  requireWorkflow(
    binding !== undefined && binding.schema_version === 1,
    'native-review-binding-required',
  );
  requireWorkflow(
    sameValue(
      binding.request,
      councilReviewRequest({ ...council, target: answer.target }, role, run),
    ) && sameRefs([binding.answer_evidence], [answer.evidence]),
    'review-input-binding-mismatch',
  );
  [binding.load_turn, binding.answer_turn, binding.evidence.locator, binding.evidence.hash].forEach(
    textField,
  );
  requireWorkflow(binding.load_turn !== binding.answer_turn, 'review-before-load');
}
export interface Adviser {
  run: LocalRun;
  status: 'running' | 'answered';
  answer: ReviewAnswer | null;
  reviewed: Pick<Applicability, 'requirements' | 'inputs'> | null;
}
export type CouncilHistoryEntry = { role: CouncilRole; session: string } & (
  | { answer: ReviewAnswer; archive?: never; retained?: never }
  | {
      answer: Pick<ReviewAnswer, 'verdict' | 'coverage' | 'findings' | 'evidence' | 'design'> & {
        binding?: Pick<ReviewBinding, 'answer_turn'>;
      };
      archive: ArchiveRef;
      retained?: never;
    }
  | {
      answer: Pick<ReviewAnswer, 'verdict' | 'coverage' | 'findings' | 'evidence' | 'design'> & {
        binding?: Pick<ReviewBinding, 'answer_turn'>;
      };
      archive?: never;
      retained: true;
    }
);
export interface Council {
  configuration?: CouncilConfiguration;
  phase: 'planning' | 'acceptance';
  selection: Selection;
  target: ReviewTarget;
  advisers: Record<string, Adviser>;
  history: CouncilHistoryEntry[];
  review_turns?: { role: CouncilRole; session: string; turn: string }[];
}
export function sameRefs(a: InputRef[], b: InputRef[]): boolean {
  return (
    a.length === b.length &&
    new Set(a.map((ref) => ref.locator)).size === a.length &&
    new Set(b.map((ref) => ref.locator)).size === b.length &&
    a.every((ref) => b.some((item) => item.locator === ref.locator && item.hash === ref.hash))
  );
}
export function sameTarget(a: ReviewTarget, b: ReviewTarget): boolean {
  return (
    a.scope === b.scope &&
    a.base === b.base &&
    sameRefs([a.diff], [b.diff]) &&
    compareInputs(a.inputs, b.inputs) === 'applicable' &&
    compareInputs(targetEvidenceInputs(a), targetEvidenceInputs(b)) === 'applicable'
  );
}
export function createCouncil(
  phase: Council['phase'],
  selection: Selection,
  target: ReviewTarget,
  configuration?: CouncilConfiguration,
): Council {
  const roles = configuredRoles(configuration);
  requireWorkflow(Object.keys(selection).length === roles.length, 'missing-role-selection');
  textField(target.scope);
  textField(target.base);
  textField(target.diff.locator);
  textField(target.diff.hash);
  targetEvidenceInputs(target);
  for (const role of roles) {
    const rule = selectedRole(selection, role);
    requireWorkflow(
      rule.trigger === true || rule.trigger === false || rule.trigger === null,
      'invalid-role-trigger',
    );
    textField(rule.reason);
    requireWorkflow(rule.requirements.length > 0, 'missing-role-requirements');
    requireWorkflow(rule.inputs !== undefined, 'missing-role-inputs');
  }
  return {
    phase,
    ...(configuration === undefined ? {} : { configuration: copyState(configuration) }),
    selection: copyState(selection),
    target: copyState(target),
    advisers: {},
    history: [],
  };
}
export function assignAdviser(council: Council, role: CouncilRole, run: LocalRun): Council {
  requireWorkflow(selectedRole(council.selection, role).trigger === true, 'role-not-applicable');
  requireWorkflow(council.advisers[role] === undefined, 'adviser-already-assigned');
  assertRunAction(run, 'read');
  requireWorkflow(run.spec.role === 'council-adviser', 'not-council-adviser');
  requireWorkflow(
    ['bootstrap', 'evidence', 'boundary-review', 'council'].every((id) =>
      run.loaded?.procedures.some((p) => p.id === id),
    ),
    'council-not-loaded',
  );
  confirmCouncilProfile(council, role, run);
  return {
    ...council,
    advisers: {
      ...council.advisers,
      [role]: { run: copyState(run), status: 'running', answer: null, reviewed: null },
    },
  };
}
export function councilReviewTurnUsed(
  council: Council,
  role: CouncilRole,
  session: string,
  turn: string,
): boolean {
  return (
    council.review_turns?.some(
      (entry) => entry.role === role && entry.session === session && entry.turn === turn,
    ) === true ||
    council.history.some(
      (entry) =>
        entry.role === role &&
        entry.session === session &&
        entry.answer.binding?.answer_turn === turn,
    )
  );
}
export function answerCouncil(
  council: Council,
  role: CouncilRole,
  session: string,
  answer: ReviewAnswer,
): Council {
  const adviser = council.advisers[role];
  requireWorkflow(
    adviser !== undefined && adviser.run.spec.session_id === session,
    'wrong-adviser-identity',
  );
  requireWorkflow(adviser.status === 'running', 'adviser-already-answered');
  confirmCouncilProfile(council, role, adviser.run);
  requireWorkflow(
    sameTarget(council.target, answer.target) && answer.scope === council.target.scope,
    'wrong-review-target',
  );
  requireWorkflow(answer.verdict !== 'N/A', 'mandatory-role-cannot-be-na');
  if (role === 'ui-ux-designer') confirmDesignReview(council.phase, answer);
  requireWorkflow(answer.sources.length > 0, 'missing-review-sources');
  textField(answer.evidence.locator);
  textField(answer.evidence.hash);
  requireWorkflow(
    new Set(answer.findings.map((f) => f.id)).size === answer.findings.length,
    'duplicate-finding',
  );
  for (const finding of answer.findings) {
    [finding.id, finding.scope, finding.condition, finding.reason].forEach(textField);
    requireWorkflow(finding.sources.length > 0, 'missing-finding-sources');
  }
  requireWorkflow(
    answer.verdict !== 'PASS' || !answer.findings.some((f) => f.blocking),
    'pass-with-blocker',
  );
  confirmReviewBinding(council, role, adviser.run, answer);
  requireWorkflow(
    !councilReviewTurnUsed(council, role, session, answer.binding!.answer_turn),
    'review-turn-already-used',
  );
  return {
    ...council,
    ...retainCouncilHistory(
      [...council.history, retainedAnswer(role, session, answer)],
      council.review_turns,
    ),
    advisers: {
      ...council.advisers,
      [role]: {
        ...adviser,
        status: 'answered',
        answer: copyState(answer),
        reviewed: copyState(selectedRole(council.selection, role)),
      },
    },
  };
}
export function councilBlockers(council: Council, excepted: CouncilRole[] = []): string[] {
  createCouncil(council.phase, council.selection, council.target, council.configuration);
  return configuredRoles(council.configuration).flatMap((role) => {
    const applicability = selectedRole(council.selection, role);
    if (applicability.trigger === null) return [`${role}:applicability-unknown`];
    if (!applicability.trigger) {
      for (let i = council.history.length - 1; i >= 0; i--) {
        const entry = council.history[i]!;
        if (entry.role !== role) continue;
        if (entry.answer.verdict === 'FAIL') return [`${role}:unresolved-failure`];
        if (entry.answer.verdict === 'PASS' && entry.answer.coverage === 'complete') return [];
      }
      return [];
    }
    const adviser = council.advisers[role];
    if (!adviser) return [`${role}:NOT RUN`];
    if (adviser.status === 'running') return [`${role}:running`];
    const answer = adviser.answer;
    if (
      !answer ||
      answer.coverage !== 'complete' ||
      (answer.verdict !== 'PASS' &&
        !(council.phase === 'acceptance' && answer.verdict === 'FAIL' && excepted.includes(role)))
    )
      return [`${role}:not-accepted`];
    if (
      answer.target.scope !== council.target.scope ||
      adviser.reviewed === null ||
      !sameRefs(adviser.reviewed.requirements, applicability.requirements) ||
      compareInputs(adviser.reviewed.inputs, applicability.inputs) !== 'applicable'
    )
      return [`${role}:review-no-longer-applicable`];
    confirmCouncilProfile(council, role, adviser.run);
    confirmReviewBinding(council, role, adviser.run, answer);
    if (role === 'ui-ux-designer') {
      confirmDesignReview(council.phase, answer);
      if (!designEvidenceApplicable(answer.design!, targetEvidenceInputs(council.target)))
        return [`${role}:review-no-longer-applicable`];
      if (Object.values(answer.design!).some((assessment) => assessment.verdict === 'NOT RUN'))
        return [`${role}:not-accepted`];
    }
    return [];
  });
}
// Scope growth reopens only the roles whose obligations changed, not every old reviewer.
export function changedPlanningRoles(
  planning: Council,
  actual: Selection,
  target = planning.target,
): CouncilRole[] {
  const roles = configuredRoles(planning.configuration);
  requireWorkflow(Object.keys(actual).length === roles.length, 'missing-role-selection');
  return roles.filter((role) => {
    const before = planning.selection[role];
    const after = selectedRole(actual, role);
    return (
      after.trigger !== false &&
      (before === undefined ||
        before.trigger !== after.trigger ||
        before.reason !== after.reason ||
        !sameRefs(before.requirements, after.requirements) ||
        compareInputs(before.inputs, after.inputs) !== 'applicable' ||
        (role === 'ui-ux-designer' &&
          planning.advisers[role]?.answer?.design !== undefined &&
          !designEvidenceApplicable(
            planning.advisers[role]!.answer!.design!,
            targetEvidenceInputs(target),
          )))
    );
  });
}
export function councilReviewBasis(council: Council, role: CouncilRole) {
  const reviewed = council.advisers[role]?.reviewed;
  const previous =
    council.advisers[role]?.answer ??
    council.history
      .slice()
      .reverse()
      .find((entry) => entry.role === role)?.answer;
  const unavailable = previous === undefined ? 'initial' : 'unknown';
  return {
    phase: council.phase,
    scope: council.target.scope,
    previous:
      previous === undefined
        ? null
        : {
            verdict: previous.verdict,
            coverage: previous.coverage,
            scope: 'scope' in previous ? previous.scope : null,
          },
    rationale:
      reviewed == null
        ? unavailable
        : 'reason' in reviewed && typeof reviewed.reason === 'string'
          ? reviewed.reason === selectedRole(council.selection, role).reason
            ? 'unchanged'
            : 'changed'
          : 'unknown',
    requirements:
      reviewed == null
        ? unavailable
        : sameRefs(reviewed.requirements, selectedRole(council.selection, role).requirements)
          ? 'unchanged'
          : 'changed',
    inputs:
      reviewed == null
        ? unavailable
        : compareInputs(reviewed.inputs, selectedRole(council.selection, role).inputs),
  };
}
export function repeatCouncil(
  council: Council,
  target: ReviewTarget,
  roles: CouncilRole[],
  selection?: Selection,
): Council {
  requireWorkflow(
    roles.length > 0 && new Set(roles).size === roles.length,
    'missing-affected-roles',
  );
  const next = copyState(council);
  next.target = copyState(target);
  if (selection !== undefined) {
    createCouncil(council.phase, selection, target, council.configuration);
    next.selection = copyState(selection);
  }
  const changed = selection === undefined ? [] : changedPlanningRoles(council, selection, target);
  for (const role of configuredRoles(council.configuration)) {
    if (selectedRole(next.selection, role).trigger && !roles.includes(role))
      requireWorkflow(
        selection === undefined
          ? compareInputs(council.target.inputs, target.inputs) === 'applicable' &&
              compareInputs(targetEvidenceInputs(council.target), targetEvidenceInputs(target)) ===
                'applicable'
          : council.target.scope === target.scope &&
              !changed.includes(role) &&
              council.advisers[role]?.answer?.verdict === 'PASS',
        'unreviewed-input-change',
      );
  }
  for (const role of roles) {
    const adviser = next.advisers[role];
    requireWorkflow(
      adviser !== undefined && adviser.status === 'answered',
      'reviewer-still-running-or-missing',
    );
    adviser.status = 'running';
    adviser.answer = null;
  }
  return next;
}

export function revisePlanning(
  council: Council,
  selection: Selection,
  target: ReviewTarget,
  unstarted: readonly { role: CouncilRole; session: string; answer_turn: string }[] = [],
): Council {
  requireWorkflow(council.phase === 'planning', 'not-planning-council');
  const next = createCouncil('planning', selection, target, council.configuration);
  const changed = changedPlanningRoles(council, selection, target);
  next.history = copyState(council.history);
  next.review_turns = copyState(council.review_turns ?? []);
  for (const role of configuredRoles(council.configuration)) {
    const adviser = council.advisers[role];
    if (!adviser || !selectedRole(selection, role).trigger) continue;
    requireWorkflow(
      adviser.status === 'answered' ||
        unstarted.some(
          (proof) =>
            proof.role === role &&
            proof.session === adviser.run.spec.session_id &&
            councilReviewTurnUsed(council, role, proof.session, proof.answer_turn),
        ),
      'planning-adviser-running',
    );
    next.advisers[role] =
      changed.includes(role) ||
      council.target.scope !== target.scope ||
      adviser.answer?.verdict !== 'PASS' ||
      adviser.answer.coverage !== 'complete'
        ? { ...adviser, status: 'running', answer: null }
        : copyState(adviser);
  }
  return next;
}

export function answerSummary(answer: CouncilHistoryEntry['answer']) {
  return copyState({
    verdict: answer.verdict,
    coverage: answer.coverage,
    findings: answer.findings,
    evidence: answer.evidence,
    ...(answer.design === undefined ? {} : { design: answer.design }),
    ...(answer.binding === undefined
      ? {}
      : { binding: { answer_turn: answer.binding.answer_turn } }),
  });
}

export function retainCouncilHistory(
  history: CouncilHistoryEntry[],
  previous: NonNullable<Council['review_turns']> = [],
) {
  const turns = new Map(previous.map((entry) => [JSON.stringify(entry), entry]));
  const passes = new Map<CouncilRole, CouncilHistoryEntry>();
  const latest = new Map<CouncilRole, CouncilHistoryEntry>();
  for (const entry of history) {
    latest.set(entry.role, entry);
    const turn = entry.answer.binding?.answer_turn;
    if (turn !== undefined) {
      const value = { role: entry.role, session: entry.session, turn };
      turns.set(JSON.stringify(value), value);
    }
    if (entry.answer.verdict === 'PASS' && entry.answer.coverage === 'complete')
      passes.set(entry.role, entry);
  }
  return {
    history: history
      .filter(
        (entry) =>
          entry.answer.verdict === 'FAIL' ||
          passes.get(entry.role) === entry ||
          latest.get(entry.role) === entry,
      )
      .map((entry): CouncilHistoryEntry => ({
        role: entry.role,
        session: entry.session,
        retained: true,
        answer: answerSummary(entry.answer),
      })),
    review_turns: [...turns.values()],
  };
}

export function retainedAnswer(role: CouncilRole, session: string, answer: ReviewAnswer) {
  return { role, session, retained: true as const, answer: answerSummary(answer) };
}
