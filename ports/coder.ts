import type {
  CoderBaseline,
  CoderBrief,
  CoderCopy,
  CoderIntegration,
  CoderResult,
  CoderRun,
  CoderSession,
} from '../core/coder.js';
import type { InputRef, LoadReceipt } from '../core/localRun.js';

export interface CoderWorkspaces {
  capture(brief: CoderBrief): Promise<CoderBaseline>;
  copy(run: CoderRun): Promise<CoderCopy>;
  verifyCopy(run: CoderRun): Promise<void>;
  integration(run: CoderRun): Promise<CoderIntegration>;
  integrate(run: CoderRun): Promise<InputRef>;
}
export interface CoderSessions {
  create(run: CoderRun): Promise<CoderCreation>;
  recoverCreate(run: CoderRun): Promise<CoderCreation | null>;
  load(run: CoderRun, fresh: boolean): Promise<LoadReceipt>;
  send(run: CoderRun, fresh: boolean): Promise<string>;
  result(run: CoderRun): Promise<CoderResult>;
  stop(run: CoderRun): Promise<InputRef>;
}
export type CoderCreation =
  { outcome: 'created'; session: CoderSession } | { outcome: 'not-started'; receipt: InputRef };
