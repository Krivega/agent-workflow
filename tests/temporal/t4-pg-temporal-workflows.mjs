import { condition, defineQuery, defineSignal, setHandler } from '@temporalio/workflow';

export const recoveryState = defineQuery('t4RecoveryState');
export const resumePending = defineSignal('t4ResumePending');
export async function t4StorageCase(input) {
  let signals = 0;
  if (input.resumePending === true)
    setHandler(resumePending, () => {
      signals += 1;
    });
  setHandler(recoveryState, () => ({
    waiting: input.pending && signals === 0,
    original: input.result,
  }));
  if (input.pending) await condition(() => input.resumePending === true && signals === 1);
  return input.result;
}
