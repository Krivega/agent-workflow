import { repeatCouncil } from '../core/council.js';
import { refuseUnroutedBackendConsumer } from '../src/adapters/project/taskBackend.js';
import type { Council, CouncilRole, ReviewTarget, Selection } from '../core/council.js';
import { checkReadiness } from '../adapters/project/checkReadiness.js';
import type { CriterionCheckPlan } from '../adapters/project/checkReadiness.js';
import type { EvidenceGrant, InputManifest } from '../core/evidence.js';
import { retainStore, type RetentionRequest } from '../adapters/storage/retentionMaintenance.js';
import { readChatArtifact } from './chatContinuation.js';
import { dirname, resolve } from 'node:path';
import { decodeChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { hasArchive } from '../adapters/storage/archiveJson.js';
import { object, requireWorkflow, textField } from '../core/connection.js';
import type { ChatAnchor } from '../core/currentChat.js';
import { FileCurrentChatHost } from '../adapters/codex/currentChatHost.js';
import { connectChatTask } from '../adapters/project/chatTaskConnection.js';
import type { ChatTaskRequest } from '../adapters/project/chatTaskConnection.js';
import { existsSync } from 'node:fs';
import {
  projectDescriptor,
  fileConnectionReader,
} from '../adapters/project/fileConnectionReader.js';

import { chatRuntimeCommands, executeChatRequest } from './chatRuntime.js';
import { NativeUserCommands } from '../adapters/codex/userCommands.js';
import { briefChatResult, fullChatResult, chatFailureGuidance } from './chatOutput.js';
import {
  relocateTaskFiles,
  materializeTaskFiles,
  type TaskFileRequest,
} from '../adapters/storage/taskFileMaintenance.js';
import { privateFileSource, readPrivateFile } from '../adapters/storage/storeFiles.js';
import { projectPath } from '../adapters/project/projectFiles.js';
import { FileWorkflowInputs } from '../adapters/project/workflowInputs.js';
import { refreshCouncilInputs, restoreCouncilSelection } from './refreshCouncilInputs.js';
import { waitCouncilProgress } from './councilProgress.js';
import { freezeChecks, packageChecks } from '../adapters/project/preparedChecks.js';
import type { ChatCheckRequest } from '../adapters/project/chatChecks.js';
import type { InputRef } from '../core/localRun.js';
import type { NativeStartup } from '../adapters/project/nativeStartup.js';
import { councilRoleView } from '../adapters/codex/councilRequestFile.js';
import type { CouncilReviewRequest } from '../core/council.js';

async function validationCommands(root: string, explicit: unknown) {
  const path = explicit === undefined ? projectDescriptor(root) : textField(explicit);
  if (explicit === undefined && !existsSync(resolve(root, path))) return undefined;
  return (await fileConnectionReader.load(root, path)).descriptor.validation_commands;
}

export const chatCommands = [
  'retain-store',
  'relocate-files',
  'materialize-files',
  'resolve-tool',
  'read-artifact',
  'preflight-chat',
  'repeat-council',
  'refresh-council',
  'wait-council',
  'freeze-checks',
  'package-checks',
  'observe-chat',
  'read-chat',
  'connect-chat',
  'authorize-chat',
  ...chatRuntimeCommands,
] as const;
export const chatUsage =
  'freeze-checks | package-checks | retain-store | relocate-files | materialize-files | resolve-tool | repeat-council | refresh-council | wait-council <request.json> | preflight-chat <plan.json> | read-artifact <ref.json> | observe-chat | read-chat | connect-chat | authorize-chat | continue-chat | prepare-chat | bootstrap-chat | execution-chat | check-chat | checks-chat | preflight-checks-chat | project-chat | status-chat | compact-context-chat | observe-audit-chat | messages-chat | council-chat | council-run-chat | coordination-chat | coder-chat | control-chat | cancel-project-chat <agent-request.json> [--brief|--full]';
export async function runChatCommand(
  args: readonly string[],
  write: (message: string) => void,
  error: (message: string) => void,
) {
  if (
    !chatCommands.includes(args[0] as (typeof chatCommands)[number]) ||
    (args.length !== 2 && (args.length !== 3 || !['--brief', '--full'].includes(args[2]!))) ||
    !args[1]
  ) {
    error(chatUsage);
    return 2;
  }
  try {
    const request = object(
      decodeChatArtifact(dirname(args[1]), readPrivateFile(args[1]).toString('utf8'), false),
    );
    if (args[0] === 'read-artifact') {
      requireWorkflow(
        request.view === undefined || request.view === 'council-role',
        'unsupported-artifact-view',
      );
      const ref = { locator: textField(request.locator), hash: textField(request.hash) };
      const artifact = readChatArtifact(ref);
      write(
        JSON.stringify(
          request.view === 'council-role'
            ? councilRoleView(artifact as CouncilReviewRequest, ref)
            : artifact,
        ),
      );
      return 0;
    }
    requireWorkflow(request.schema_version === 1, 'unsupported-chat-request');
    const root = textField(request.root);
    if (
      [
        'freeze-checks',
        'package-checks',
        'refresh-council',
        'repeat-council',
        'retain-store',
        'relocate-files',
        'materialize-files',
      ].includes(args[0]!)
    )
      refuseUnroutedBackendConsumer(root);
    if (args[0] === 'freeze-checks') {
      write(
        JSON.stringify({
          prepared: true,
          details: await freezeChecks(
            root,
            textField(request.evidence_root),
            textField(request.card),
            request.checks as CriterionCheckPlan[],
            request.probes as ChatCheckRequest[] | undefined,
            request.native as NativeStartup | undefined,
            await validationCommands(root, request.descriptor),
          ),
        }),
      );
      return 0;
    }
    if (args[0] === 'package-checks') {
      write(
        JSON.stringify(
          await packageChecks(
            root,
            textField(request.evidence_root),
            request.check_plan as InputRef,
            request.proofs as InputRef[],
            request.artifacts as string[] | undefined,
            await validationCommands(root, request.descriptor),
          ),
        ),
      );
      return 0;
    }
    if (args[0] === 'wait-council') {
      write(
        JSON.stringify(
          await waitCouncilProgress(
            resolve(textField(request.evidence_root), 'council'),
            request.after === undefined ? null : textField(request.after),
            request.timeout_ms === undefined ? 60_000 : (request.timeout_ms as number),
            { until: (request.until ?? 'changed') as 'changed' | 'settled' },
          ),
        ),
      );
      return 0;
    }
    if (args[0] === 'refresh-council') {
      const result = await refreshCouncilInputs(
        request.council as Council,
        request.target as ReviewTarget,
        new FileWorkflowInputs(root, textField(request.evidence_root)),
      );
      write(JSON.stringify(briefChatResult('council-chat', result, request)));
      return 0;
    }
    if (args[0] === 'relocate-files') {
      const storage = object(request.storage);
      write(
        JSON.stringify(
          relocateTaskFiles(
            textField(request.namespace),
            textField(storage.root),
            storage.grant as EvidenceGrant,
            request.relocation as TaskFileRequest,
          ),
        ),
      );
      return 0;
    }
    if (args[0] === 'materialize-files') {
      const storage = object(request.storage);
      write(
        JSON.stringify(
          materializeTaskFiles(
            textField(request.namespace),
            textField(request.destination),
            textField(storage.root),
            storage.grant as EvidenceGrant,
          ),
        ),
      );
      return 0;
    }
    if (args[0] === 'resolve-tool') {
      const source = privateFileSource(
        await projectPath(textField(request.namespace), textField(request.locator)),
      );
      requireWorkflow(source.kind === 'tool', 'tool-not-cached');
      write(JSON.stringify(source));
      return 0;
    }
    if (args[0] === 'retain-store') {
      const storage = object(request.storage);
      write(
        JSON.stringify(
          retainStore(
            textField(storage.root),
            storage.grant as EvidenceGrant,
            request.retention as RetentionRequest,
          ),
        ),
      );
      return 0;
    }
    if (args[0] === 'repeat-council') {
      const council = request.council as Council;
      const selection =
        request.selection === undefined
          ? undefined
          : await restoreCouncilSelection(
              council,
              request.selection as Selection,
              new FileWorkflowInputs(root, textField(request.evidence_root)),
            );
      const result = repeatCouncil(
        council,
        request.target as ReviewTarget,
        request.roles as CouncilRole[],
        selection,
      );
      write(JSON.stringify(briefChatResult('council-chat', result, request)));
      return 0;
    }
    if (args[0] === 'preflight-chat') {
      requireWorkflow(Array.isArray(request.checks), 'readiness-map-required');
      write(
        JSON.stringify(
          await checkReadiness(
            root,
            textField(request.evidence_root),
            textField(request.card),
            request.checks as CriterionCheckPlan[],
            request.acceptance_inputs as InputManifest | undefined,
          ),
        ),
      );
      return 0;
    }
    if (chatRuntimeCommands.includes(args[0] as (typeof chatRuntimeCommands)[number])) {
      const result = await executeChatRequest(
        args[0] as (typeof chatRuntimeCommands)[number],
        request,
      );
      if (args[0] === 'compact-context-chat') {
        write(JSON.stringify(result));
        return 0;
      }
      const brief = args[2] !== '--full';
      if (!brief && hasArchive(result)) {
        write(JSON.stringify(fullChatResult(result, request)));
      } else write(JSON.stringify(brief ? briefChatResult(args[0]!, result, request) : result));
    } else if (args[0] === 'authorize-chat') {
      write(JSON.stringify(await new NativeUserCommands(root).issue(request)));
    } else if (args[0] === 'read-chat') {
      const loaded = await fileConnectionReader.load(root, textField(request.descriptor));
      const allowed = [...loaded.procedures, ...loaded.rules];
      requireWorkflow(
        Array.isArray(request.locators) && request.locators.length > 0,
        'chat-read-selection-required',
      );
      for (const locator of request.locators) {
        const entry = allowed.find((e) => e.locator === locator);
        requireWorkflow(entry !== undefined, 'chat-read-outside-rules');
        write(
          JSON.stringify({
            chat_read: textField(request.marker),
            locator: entry.locator,
            hash: entry.hash,
            content: entry.content,
          }),
        );
      }
    } else {
      if (args[0] === 'observe-chat')
        requireWorkflow(
          object(request.anchor).thread_id === process.env.CODEX_THREAD_ID,
          'chat-environment-identity-mismatch',
        );
      const result =
        args[0] === 'connect-chat'
          ? await connectChatTask(root, request as unknown as ChatTaskRequest)
          : await new FileCurrentChatHost(
              root,
              textField(request.transcript),
              request.anchor as ChatAnchor,
            ).observe();
      write(JSON.stringify(result));
    }
    return 0;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'Не удалось выполнить операцию чата.';
    error(reason);
    try {
      write(JSON.stringify(chatFailureGuidance(reason, args[1]!)));
    } catch {
      return 1;
    }
    return 1;
  }
}
