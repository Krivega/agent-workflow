import { z } from 'zod';
import type { AppServerRpc } from './appServerTransport.js';

export const harness2Request = z
  .object({
    root: z.string().min(1),
    output: z.string().min(1),
    binary: z.string().min(1),
    mcpNames: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)),
    prompt: z.string().min(1),
    rules: z.string().min(1),
    instructionSources: z.array(z.string()),
    model: z.literal('gpt-6-astra'),
    effort: z.literal('high'),
  })
  .strict();
export type Harness2Request = z.infer<typeof harness2Request>;

// Retained entry points reject old callers before transport, input reads or writes.
export async function modelCall(
  _rpc: AppServerRpc,
  _request: Harness2Request,
  _signal: AbortSignal,
): Promise<never> {
  throw new Error('h2-new-model-runs-disabled');
}

export async function harness2Bridge(_file: string, _signal: AbortSignal): Promise<never> {
  throw new Error('h2-new-model-runs-disabled');
}
