import process from 'node:process';
import { discoverChat } from '../adapters/codex/chatDiscovery.js';
import type { NativeReaderSource } from '../src/adapters/codex/readerAuthority.js';
import { requireContract } from '../src/contracts/project.js';
import {
  h06NativeSessionsRoot,
  observeH06NativePrimaryGrant,
} from './comparisonH06NativeAttempt.js';

type GrantPlan = Parameters<typeof observeH06NativePrimaryGrant>[0];
type Chat = GrantPlan['request']['chat'];

/** Locate the primary input in the current native chat without manufacturing an authority record. */
export async function currentH06HumanAuthority(chat: Chat, comparisonSource = false) {
  requireContract(process.env.CODEX_THREAD_ID === chat.threadId, 'h06-native-current-thread');
  const {
    transcript,
    anchor,
    human_source: source,
  } = await discoverChat(
    chat.workspace,
    h06NativeSessionsRoot(),
    chat.threadId,
    undefined,
    comparisonSource,
  );
  return { transcript, turnId: anchor.turn_id, source };
}

/** Resolve one exact attempt or server grant, leaving the operator's one-shot claim untouched. */
export async function resolveH06NativeGrant(plan: GrantPlan) {
  const authority = await currentH06HumanAuthority(plan.request.chat);
  await observeH06NativePrimaryGrant(plan, authority);
  return authority;
}

/** Locate a phase command. The phase's native authority checker validates its exact text. */
export async function readH06NativeReaderSource(chat: Chat): Promise<NativeReaderSource> {
  const { transcript, turnId, source } = await currentH06HumanAuthority(chat);
  const line = Number(source.locator.slice(transcript.length + 2));
  return {
    schemaVersion: 1,
    kind: 'codex-user-command',
    transcript,
    threadId: chat.threadId,
    turnId,
    user: { line, sha256: source.hash },
  };
}
