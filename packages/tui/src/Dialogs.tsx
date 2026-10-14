import React from 'react';
import { OverlayPicker } from './OverlayPicker';
import { PermissionModal } from './PermissionModal';
import { QuestionDialog } from './QuestionDialog';
import { RewindPicker } from './RewindPicker';
import { SessionPicker } from './SessionPicker';
import { SudoPasswordModal } from './SudoPasswordModal';
import type { AppView } from './view';

export interface DialogsProps {
  view: AppView;
  /** Rows the permission prompt may take, for a layout that does not fix its own height. */
  permissionMaxHeight?: number;
}

/** The prompts and pickers that take the keyboard from the prompt box. */
export function Dialogs({ view, permissionMaxHeight }: DialogsProps): React.ReactElement {
  const { pending, sudoAuthentication, overlayPicker, sessionPicker, rewindPicker } = view;
  return (
    <>
      {sudoAuthentication ? (
        <SudoPasswordModal
          status={sudoAuthentication.status}
          error={sudoAuthentication.error}
          onSubmit={(password) => void view.submitSudoPassword(password)}
          onCancel={view.cancelSudoAuthentication}
        />
      ) : pending ? (
        <PermissionModal
          key={pending.requestId}
          command={pending.command}
          reason={pending.reason}
          reviewerReason={pending.reviewerReason}
          systemOneNote={pending.systemOneNote}
          target="host"
          policyAnalysis={pending.policyAnalysis}
          mcp={pending.mcp}
          header={
            pending.subagent
              ? `[subagent ${pending.subagent.id.slice(-8)}: ${pending.subagent.purpose}]`
              : undefined
          }
          maxHeight={permissionMaxHeight}
          scrollerRef={view.dialogScrollerRef}
          onResolve={view.onResolve}
        />
      ) : view.question ? (
        // After the permission prompt: that one holds up a tool that is already running.
        <QuestionDialog
          key={view.question.requestId}
          request={view.question}
          onResolve={view.answerQuestion}
        />
      ) : null}
      {overlayPicker && (
        <OverlayPicker entries={overlayPicker} onResolve={view.applyOverlaySelection} />
      )}
      {sessionPicker && (
        <SessionPicker
          sessions={sessionPicker}
          currentSessionId={view.activeSession.sessionId}
          onCancel={view.cancelSessionPicker}
          onSelect={view.selectSession}
        />
      )}
      {rewindPicker && (
        <RewindPicker
          checkpoints={rewindPicker}
          onCancel={view.cancelRewind}
          onRewind={view.rewindTo}
          onFork={view.forkFrom}
        />
      )}
    </>
  );
}
