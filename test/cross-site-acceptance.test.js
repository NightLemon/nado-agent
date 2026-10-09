import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  acceptanceEvidenceTemplate,
  buildCrossSiteAcceptanceReport,
  recordAcceptanceEvidence,
} from '../src/cross-site-acceptance.js';
import {
  runAgentCollaborationExercise,
  runLargeArtifactResumeExercise,
  runLargeInputResumeExercise,
  runLongDisconnectRecoveryExercise,
  runRemoteCancellationExercise,
  runShortDisconnectExercise,
  runVmRestartRecoveryExercise,
  runWorkerRestartRecoveryExercise,
} from '../src/acceptance-exercises.js';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { startWorker } from '../src/worker-client.js';
import { ensureEnrolledWorker, readWorkerIdentity, rotateEnrolledWorkerToken } from '../src/worker-enrollment.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src', 'cli.js');

function completeEvidence() {
  const evidence = acceptanceEvidenceTemplate();
  for (const [key, scenario] of Object.entries(evidence.scenarios)) {
    scenario.status = 'passed';
    scenario.evidence = `Observed ${key} on the VM/home-host acceptance pair`;
    scenario.references = [`evidence/${key}.log`];
    scenario.observedAt = new Date().toISOString();
  }
  return evidence;
}

function passingInputs() {
  const nowMs = Date.now();
  const revocationCheckedAt = new Date(nowMs).toISOString();
  const originalControlStartedAt = new Date(nowMs - 20_000).toISOString();
  const backupSourceCreatedAt = new Date(nowMs - 30_000).toISOString();
  const controlOutageAt = new Date(nowMs - 11_000).toISOString();
  const backupRestoredAt = new Date(nowMs - 10_500).toISOString();
  const restartedControlStartedAt = new Date(nowMs - 10_000).toISOString();
  const transferStartedAt = new Date(nowMs - 9_000).toISOString();
  const transferInitialEventAt = new Date(nowMs - 8_000).toISOString();
  const transferStalledEventAt = new Date(nowMs - 6_000).toISOString();
  const transferDisconnectAt = new Date(nowMs - 5_000).toISOString();
  const transferRecoveredAt = new Date(nowMs - 2_000).toISOString();
  const shortGapAt = new Date(nowMs - 5_000).toISOString();
  const shortGapLastSeenAt = new Date(nowMs - 8_000).toISOString();
  const shortRecoveryAt = new Date(nowMs - 2_000).toISOString();
  const shortGapLeaseExpiresAt = new Date(nowMs + 10_000).toISOString();
  const shortRecoveryLeaseExpiresAt = new Date(nowMs + 50_000).toISOString();
  const originalWorkerStartedAt = new Date(nowMs - 90_000).toISOString();
  const workerOfflineLastSeenAt = new Date(nowMs - 55_000).toISOString();
  const workerOfflineObservedAt = new Date(nowMs - 8_000).toISOString();
  const restartedWorkerStartedAt = new Date(nowMs - 7_000).toISOString();
  const workerRuntimeEventAt = new Date(nowMs - 6_500).toISOString();
  const workerRestartTaskCreatedAt = new Date(nowMs - 6_000).toISOString();
  const planSha256 = 'a'.repeat(64);
  const finalSha256 = 'b'.repeat(64);
  const transcriptSha256 = 'c'.repeat(64);
  const longDisconnectSha256 = 'e'.repeat(64);
  const vmRestartSha256 = 'f'.repeat(64);
  const largeArtifactSha256 = '1'.repeat(64);
  const largeInputSha256 = '2'.repeat(64);
  const largeInputResultSha256 = '3'.repeat(64);
  const backupManifestSha256 = '6'.repeat(64);
  const backupMarkerSha256 = '7'.repeat(64);
  const backupPostSha256 = '8'.repeat(64);
  const shortDisconnectSha256 = '0'.repeat(64);
  const workerRestartSha256 = '4'.repeat(64);
  const restoreReceipt = {
    format: 'nado-control-restore-receipt',
    formatVersion: 1,
    id: 'restore_00000000-0000-4000-8000-000000000000',
    restoredAt: backupRestoredAt,
    sourceCreatedAt: backupSourceCreatedAt,
    manifestSha256: backupManifestSha256,
    backend: 'sqlite',
    stateVersion: 2,
    sqliteSchemaVersion: 1,
    fileCount: 5,
    totalBytes: 4096,
  };
  const manualEvidence = completeEvidence();
  manualEvidence.scenarios.credentialRevocation = {
    status: 'passed',
    evidence: 'Control-triggered rotation accepted the replacement and rejected the predecessor with HTTP 401.',
    references: ['worker:home-gpu', 'worker-command:cmd_rotation'],
    observedAt: revocationCheckedAt,
    source: 'automated_exercise',
    details: {
      mode: 'control_triggered_rotation',
      workerId: 'home-gpu',
      commandId: 'cmd_rotation',
      replacementTokenId: 'wtok_home_gpu',
      predecessorTokenId: 'wtok_home_gpu_previous',
      verification: {
        passed: true,
        newTokenAccepted: true,
        previousTokenRejected: true,
        previousTokenStatus: 401,
        checkedAt: revocationCheckedAt,
      },
    },
  };
  manualEvidence.scenarios.remoteCancellation = {
    status: 'passed',
    evidence: 'Automated remote cancellation exercise cancelled and released the target process.',
    references: ['task:task_remote_cancel', 'task:task_remote_cancel:attempt:attempt_remote_cancel'],
    observedAt: revocationCheckedAt,
    source: 'automated_exercise',
    details: {
      version: 1,
      exercise: 'remoteCancellation',
      ok: true,
      startedAt: revocationCheckedAt,
      completedAt: revocationCheckedAt,
      workerId: 'home-gpu',
      taskId: 'task_remote_cancel',
      attemptId: 'attempt_remote_cancel',
      taskStatus: 'cancelled',
      commandEvent: {
        at: revocationCheckedAt,
        type: 'command_applied',
        action: 'cancel_current',
        taskId: 'task_remote_cancel',
      },
      processReleasedEvent: {
        at: revocationCheckedAt,
        type: 'task_released',
        taskId: 'task_remote_cancel',
        attemptId: 'attempt_remote_cancel',
      },
    },
  };
  manualEvidence.scenarios.agentCollaboration = {
    status: 'passed',
    evidence: 'Automated two-turn terminal-Agent collaboration completed with verified handoff artifacts.',
    references: ['session:session_agent_collab', 'task:task_agent_plan', 'task:task_agent_final'],
    observedAt: revocationCheckedAt,
    source: 'automated_exercise',
    details: {
      version: 1,
      exercise: 'agentCollaboration',
      ok: true,
      startedAt: revocationCheckedAt,
      completedAt: revocationCheckedAt,
      workerId: 'home-gpu',
      sessionId: 'session_agent_collab',
      sessionStatus: 'closed',
      taskIds: ['task_agent_plan', 'task_agent_final'],
      tasks: [{
        id: 'task_agent_plan',
        status: 'succeeded',
        assignedWorkerId: 'home-gpu',
        attemptId: 'attempt_agent_plan',
      }, {
        id: 'task_agent_final',
        status: 'succeeded',
        assignedWorkerId: 'home-gpu',
        attemptId: 'attempt_agent_final',
      }],
      artifacts: [{
        taskId: 'task_agent_plan', id: 'artifact_agent_plan', path: 'agent-plan.md', sha256: planSha256, size: 128,
      }, {
        taskId: 'task_agent_final', id: 'artifact_agent_final', path: 'agent-final.md', sha256: finalSha256, size: 160,
      }, {
        taskId: 'task_agent_final', id: 'artifact_agent_transcript', path: '.nado-session/transcript.md', sha256: transcriptSha256, size: 512,
      }],
      markerSha256: 'd'.repeat(64),
    },
  };
  manualEvidence.scenarios.longDisconnectRecovery = {
    status: 'passed',
    evidence: 'Supervised lease-expiry recovery completed with stale-result rejection and attempt-2 output.',
    references: ['task:task_long_disconnect', 'task:task_long_disconnect:attempt:attempt_long_1', 'task:task_long_disconnect:attempt:attempt_long_2'],
    observedAt: revocationCheckedAt,
    source: 'supervised_exercise',
    details: {
      version: 1,
      exercise: 'longDisconnectRecovery',
      ok: true,
      startedAt: revocationCheckedAt,
      completedAt: revocationCheckedAt,
      workerId: 'home-gpu',
      taskId: 'task_long_disconnect',
      leaseDurationMs: 30_000,
      recoveryScanIntervalMs: 5_000,
      firstAttemptMs: 50_000,
      attempts: [{
        id: 'attempt_long_1', seq: 1, workerId: 'home-gpu', status: 'lease_expired',
      }, {
        id: 'attempt_long_2', seq: 2, workerId: 'home-gpu', status: 'succeeded',
      }],
      recoveryEvent: {
        at: revocationCheckedAt,
        type: 'lease_recovered',
        recoveryReason: 'lease_expired_and_worker_offline',
        previousWorkerId: 'home-gpu',
      },
      staleResultRejection: {
        at: revocationCheckedAt,
        type: 'stale_result_ignored',
        resultAttemptId: 'attempt_long_1',
        currentAttemptId: 'attempt_long_2',
      },
      finalWorkerId: 'home-gpu',
      originalWorkerReconnected: true,
      artifact: {
        id: 'artifact_long_disconnect', path: 'long-disconnect.json', sha256: longDisconnectSha256, size: 128,
      },
      deliverySemantics: 'at-least-once',
    },
  };
  manualEvidence.scenarios.vmRestartRecovery = {
    status: 'passed',
    evidence: 'Supervised control restart replaced the runtime while preserving the original SQLite task attempt.',
    references: ['control:control_original', 'control:control_restarted', 'task:task_vm_restart'],
    observedAt: revocationCheckedAt,
    source: 'supervised_exercise',
    details: {
      version: 1,
      exercise: 'vmRestartRecovery',
      ok: true,
      startedAt: originalControlStartedAt,
      completedAt: revocationCheckedAt,
      workerId: 'home-gpu',
      taskId: 'task_vm_restart',
      attemptId: 'attempt_vm_restart',
      taskStatus: 'succeeded',
      attemptCount: 1,
      storage: { backend: 'sqlite' },
      controlRestart: {
        original: { instanceId: 'control_original', startedAt: originalControlStartedAt },
        restarted: { instanceId: 'control_restarted', startedAt: restartedControlStartedAt },
        outageObserved: true,
        unavailableObservations: [{ at: controlOutageAt, error: 'connection refused' }],
        recoveredAt: restartedControlStartedAt,
      },
      workerRecovery: {
        recoveredAt: revocationCheckedAt,
        gatewayState: 'idle',
        lastSeenAt: revocationCheckedAt,
        ageMs: 0,
      },
      artifact: {
        id: 'artifact_vm_restart',
        path: 'vm-restart-recovery.json',
        sha256: vmRestartSha256,
        size: 192,
        executionCount: 1,
        completionCount: 1,
      },
    },
  };
  manualEvidence.scenarios.workerRestartRecovery = {
    status: 'passed',
    evidence: 'Supervised home Worker service stop reached offline state, then the same signed token reconnected as a new runtime and ran a probe.',
    references: ['worker:home-gpu:runtime:wrun_original', 'worker:home-gpu:runtime:wrun_restarted', 'task:task_worker_restart'],
    observedAt: revocationCheckedAt,
    source: 'supervised_exercise',
    details: {
      version: 1,
      exercise: 'workerRestartRecovery',
      ok: true,
      startedAt: workerOfflineLastSeenAt,
      completedAt: revocationCheckedAt,
      workerId: 'home-gpu',
      tokenContinuity: { workerTokenId: 'wtok_home_gpu', unchanged: true },
      runtimeRestart: {
        original: { id: 'wrun_original', startedAt: originalWorkerStartedAt, pid: 100 },
        restarted: { id: 'wrun_restarted', startedAt: restartedWorkerStartedAt, pid: 200 },
        eventAt: workerRuntimeEventAt,
        previousRuntimeId: 'wrun_original',
        previousLastSeenAt: workerOfflineLastSeenAt,
      },
      offlineObservation: {
        observedAt: workerOfflineObservedAt,
        lastSeenAt: workerOfflineLastSeenAt,
        ageMs: 47_000,
        runtimeId: 'wrun_original',
      },
      workerRecovery: {
        reconnectedAt: workerRuntimeEventAt,
        lastSeenAt: revocationCheckedAt,
        gatewayState: 'idle',
      },
      taskId: 'task_worker_restart',
      attemptId: 'attempt_worker_restart',
      taskStatus: 'succeeded',
      artifact: {
        id: 'artifact_worker_restart',
        path: 'worker-restart-recovery.json',
        sha256: workerRestartSha256,
        size: 192,
        runtimeId: 'wrun_restarted',
        runtimeStartedAt: restartedWorkerStartedAt,
      },
    },
  };
  manualEvidence.scenarios.largeArtifactResume = {
    status: 'passed',
    evidence: 'Supervised artifact upload stalled after a durable partial offset and resumed on the same upload.',
    references: ['task:task_large_artifact', 'upload:task_large_artifact:upload_large_artifact'],
    observedAt: revocationCheckedAt,
    source: 'supervised_exercise',
    details: {
      version: 1,
      exercise: 'largeArtifactResume',
      ok: true,
      startedAt: transferStartedAt,
      completedAt: revocationCheckedAt,
      workerId: 'home-gpu',
      taskId: 'task_large_artifact',
      attemptId: 'attempt_large_artifact',
      attemptCount: 1,
      upload: {
        id: 'upload_large_artifact',
        path: 'large-artifact-resume.bin',
        size: 262_144,
        sha256: largeArtifactSha256,
        firstObservedOffset: 65_536,
        stalledOffset: 131_072,
        stalledForMs: 3_000,
        finalizedOffset: 262_144,
      },
      disconnect: { observedAt: transferDisconnectAt, workerAgeMs: 3_000, workerLastSeenAt: transferInitialEventAt },
      recovery: { recoveredAt: transferRecoveredAt, workerLastSeenAt: transferRecoveredAt, workerAgeMs: 0 },
      artifact: {
        id: 'artifact_large_artifact',
        uploadId: 'upload_large_artifact',
        path: 'large-artifact-resume.bin',
        size: 262_144,
        sha256: largeArtifactSha256,
      },
    },
  };
  manualEvidence.scenarios.largeInputResume = {
    status: 'passed',
    evidence: 'Supervised input download resumed with a positive Range offset and returned a verified hash artifact.',
    references: ['task:task_large_input', 'input:task_large_input:input_large'],
    observedAt: revocationCheckedAt,
    source: 'supervised_exercise',
    details: {
      version: 1,
      exercise: 'largeInputResume',
      ok: true,
      startedAt: transferStartedAt,
      completedAt: revocationCheckedAt,
      workerId: 'home-gpu',
      taskId: 'task_large_input',
      attemptId: 'attempt_large_input',
      attemptCount: 1,
      input: {
        id: 'input_large',
        path: 'large-input-resume.bin',
        size: 262_144,
        sha256: largeInputSha256,
        initialOffset: 0,
        resumedOffset: 65_536,
      },
      disconnect: { observedAt: transferDisconnectAt, workerAgeMs: 3_000, workerLastSeenAt: transferInitialEventAt },
      recovery: {
        recoveredAt: transferRecoveredAt,
        workerLastSeenAt: transferRecoveredAt,
        workerAgeMs: 0,
        rangeEventAt: transferRecoveredAt,
      },
      artifact: {
        id: 'artifact_large_input_result',
        path: 'large-input-resume.json',
        sha256: largeInputResultSha256,
        size: 192,
      },
    },
  };
  manualEvidence.scenarios.backupRestore = {
    status: 'passed',
    evidence: 'Supervised verified backup restored into fresh state and accepted a post-restore write task.',
    references: ['restore:restore_00000000-0000-4000-8000-000000000000', 'task:task_backup_marker', 'task:task_backup_post'],
    observedAt: revocationCheckedAt,
    source: 'supervised_exercise',
    details: {
      version: 1,
      exercise: 'backupRestore',
      ok: true,
      startedAt: originalControlStartedAt,
      completedAt: revocationCheckedAt,
      workerId: 'home-gpu',
      controlRestart: {
        original: { instanceId: 'control_original', startedAt: originalControlStartedAt },
        restarted: { instanceId: 'control_restarted', startedAt: restartedControlStartedAt },
        outageObserved: true,
        unavailableObservations: [{ at: controlOutageAt, error: 'connection refused' }],
      },
      restoreReceipt: { ...restoreReceipt },
      workerRecovery: { recoveredAt: revocationCheckedAt, lastSeenAt: revocationCheckedAt, ageMs: 0 },
      markerTask: {
        id: 'task_backup_marker',
        attemptId: 'attempt_backup_marker',
        artifactId: 'artifact_backup_marker',
        artifactSha256: backupMarkerSha256,
      },
      postRestoreTask: {
        id: 'task_backup_post',
        attemptId: 'attempt_backup_post',
        artifactId: 'artifact_backup_post',
        artifactSha256: backupPostSha256,
      },
    },
  };
  manualEvidence.scenarios.shortDisconnect = {
    status: 'passed',
    evidence: 'Supervised heartbeat gap recovered through a same-attempt lease renewal before expiry.',
    references: ['task:task_short_disconnect', 'task:task_short_disconnect:attempt:attempt_short_disconnect'],
    observedAt: revocationCheckedAt,
    source: 'supervised_exercise',
    details: {
      version: 1,
      exercise: 'shortDisconnect',
      ok: true,
      startedAt: shortGapLastSeenAt,
      completedAt: revocationCheckedAt,
      workerId: 'home-gpu',
      taskId: 'task_short_disconnect',
      attemptId: 'attempt_short_disconnect',
      taskStatus: 'succeeded',
      attemptCount: 1,
      minDisconnectMs: 2_000,
      observedGap: {
        observedAt: shortGapAt,
        ageMs: 3_000,
        lastSeenAt: shortGapLastSeenAt,
        leaseRenewedAt: shortGapLastSeenAt,
        leaseExpiresAt: shortGapLeaseExpiresAt,
      },
      recovery: {
        recoveredAt: shortRecoveryAt,
        workerLastSeenAt: shortRecoveryAt,
        workerAgeMs: 100,
        leaseRenewedAt: shortRecoveryAt,
        leaseExpiresAt: shortRecoveryLeaseExpiresAt,
      },
      artifact: {
        id: 'artifact_short_disconnect',
        path: 'short-disconnect.txt',
        sha256: shortDisconnectSha256,
        size: 20,
      },
    },
  };
  return {
    workerId: 'home-gpu',
    requireGpu: true,
    requireAgent: true,
    manualEvidence,
    network: {
      requestUrl: 'http://127.0.0.1:8765',
      publicControlUrl: 'https://nado.example.com',
      preferredRemoteControlUrl: 'https://nado.example.com',
      remoteWorkerReady: true,
      nextAction: { code: 'generate_worker_bundle' },
    },
    status: {
      storage: {
        backend: 'sqlite',
        stateVersion: 2,
        sqliteSchemaVersion: 1,
        restoreReceipt,
        dataLease: {
          enabled: true,
          status: 'owned',
          writeFencing: true,
          heartbeatMs: 10_000,
          timeoutMs: 60_000,
        },
      },
      runtime: {
        instanceId: 'control_restarted',
        startedAt: restartedControlStartedAt,
        build: {
          version: '0.1.0',
          protocolVersion: 1,
          buildId: 'release-test',
          sourceFingerprint: `sha256:${'a'.repeat(64)}`,
        },
      },
    },
    capabilities: {
      networking: { workerConnectionModel: 'workers call the control HTTP API with outbound requests' },
      features: {
        workerScopedTokens: true,
        signedWorkerRequests: true,
        signedWorkerRequestReplayProtection: true,
        workerTokenRotation: true,
        workerTokenRotationCrashRecovery: true,
        taskLeases: true,
        offlineRecovery: true,
        automaticOfflineRecovery: true,
        resumableArtifactUploads: true,
        resumableTaskInputUploads: true,
      },
      reliability: { taskDelivery: 'at-least-once', taskLeases: true, idempotencyKeys: true },
      storage: {
        singleWriterLease: {
          enabled: true,
          status: 'owned',
          writeFencing: true,
          heartbeatMs: 10_000,
          timeoutMs: 60_000,
        },
      },
    },
    workers: [{
      id: 'home-gpu',
      host: 'home-host',
      lastSeenAt: revocationCheckedAt,
      active: true,
      gatewayState: 'idle',
      adminState: 'enabled',
      identity: {
        type: 'worker_token',
        scoped: true,
        signed: true,
        workerTokenId: 'wtok_home_gpu',
        signatureAlgorithm: 'ed25519',
        signatureSignedAt: new Date().toISOString(),
        signatureClockSkewMs: 25,
        signatureMaxClockSkewMs: 300_000,
        observedAt: new Date().toISOString(),
      },
      connection: {
        remoteAddress: '198.51.100.23',
        addressSource: 'x-forwarded-for',
        protocol: 'https',
        trustedProxy: true,
        proxyAuthenticated: true,
        observedAt: new Date().toISOString(),
      },
      runtime: {
        id: 'wrun_restarted',
        startedAt: restartedWorkerStartedAt,
        pid: 200,
        build: {
          version: '0.1.0',
          protocolVersion: 1,
          buildId: 'release-test',
          sourceFingerprint: `sha256:${'a'.repeat(64)}`,
        },
      },
      events: [{
        at: workerRuntimeEventAt,
        type: 'runtime_started',
        workerId: 'home-gpu',
        data: {
          controlObserved: true,
          runtimeId: 'wrun_restarted',
          runtimeStartedAt: restartedWorkerStartedAt,
          pid: 200,
          previousRuntimeId: 'wrun_original',
          previousRuntimeStartedAt: originalWorkerStartedAt,
          previousLastSeenAt: workerOfflineLastSeenAt,
          authenticationType: 'worker_token',
          workerTokenId: 'wtok_home_gpu',
        },
      }],
      capabilities: ['code', 'gpu', 'agent'],
      resources: {
        cpu: { logicalCores: 24, utilizationPercent: 37.5 },
        memory: { totalBytes: 128 * 1024 ** 3, usedPercent: 62.5 },
        disk: { available: true, totalBytes: 2 * 1024 ** 4 },
        network: {
          roundTripMs: 28,
          lastSuccessAt: new Date().toISOString(),
          bandwidth: { available: true, uploadBytesPerSecond: 10_000_000, downloadBytesPerSecond: 50_000_000 },
        },
        gpu: { detected: true, count: 1, memoryTotalBytes: 24 * 1024 ** 3 },
      },
      readiness: {
        agent: {
          realTerminalAgent: true,
          readyForAgentTasks: true,
          selfTest: { status: 'succeeded' },
        },
      },
      commands: [{
        id: 'cmd_rotation',
        action: 'rotate_token',
        status: 'completed',
        completedAt: revocationCheckedAt,
        result: {
          workerTokenId: 'wtok_home_gpu',
          previousTokenId: 'wtok_home_gpu_previous',
          verification: {
            passed: true,
            newTokenAccepted: true,
            previousTokenRejected: true,
            previousTokenStatus: 401,
            checkedAt: revocationCheckedAt,
          },
        },
      }],
    }],
    tasks: [{
      id: 'task_remote_cancel',
      title: 'nado cross-site remote cancellation exercise',
      type: 'shell',
      status: 'cancelled',
      maxAttempts: 1,
      requestedWorkerId: 'home-gpu',
      assignedWorkerId: 'home-gpu',
      attempts: [{ id: 'attempt_remote_cancel', workerId: 'home-gpu', status: 'cancelled' }],
      events: [{ at: revocationCheckedAt, type: 'cancelled' }, {
        at: revocationCheckedAt,
        type: 'worker_cancel_applied',
        workerId: 'home-gpu',
        attemptId: null,
      }, {
        at: revocationCheckedAt,
        type: 'worker_process_released',
        workerId: 'home-gpu',
        attemptId: 'attempt_remote_cancel',
      }],
    }, {
      id: 'task_short_disconnect',
      title: 'nado cross-site short disconnect exercise',
      type: 'shell',
      status: 'succeeded',
      maxAttempts: 1,
      requestedWorkerId: 'home-gpu',
      assignedWorkerId: 'home-gpu',
      attempts: [{ id: 'attempt_short_disconnect', seq: 1, workerId: 'home-gpu', status: 'succeeded' }],
      events: [{
        at: shortGapAt,
        type: 'short_disconnect_gap_observed',
        workerId: 'home-gpu',
        attemptId: 'attempt_short_disconnect',
        data: {
          minDisconnectMs: 2_000,
          workerAgeMs: 3_000,
          workerLastSeenAt: shortGapLastSeenAt,
          leaseRenewedAt: shortGapLastSeenAt,
          leaseExpiresAt: shortGapLeaseExpiresAt,
        },
      }, {
        at: shortRecoveryAt,
        type: 'short_disconnect_recovered',
        workerId: 'home-gpu',
        attemptId: 'attempt_short_disconnect',
        data: {
          gapObservedAt: shortGapAt,
          workerAgeMs: 100,
          workerLastSeenAt: shortRecoveryAt,
          leaseRenewedAt: shortRecoveryAt,
          leaseExpiresAt: shortRecoveryLeaseExpiresAt,
        },
      }],
      artifacts: [{
        id: 'artifact_short_disconnect', path: 'short-disconnect.txt', sha256: shortDisconnectSha256, size: 20,
      }],
    }, {
      id: 'task_agent_plan',
      title: 'Nado Agent collaboration plan',
      type: 'agent',
      sessionId: 'session_agent_collab',
      status: 'succeeded',
      maxAttempts: 1,
      requestedWorkerId: 'home-gpu',
      assignedWorkerId: 'home-gpu',
      attempts: [{ id: 'attempt_agent_plan', workerId: 'home-gpu', status: 'succeeded' }],
      artifacts: [{ id: 'artifact_agent_plan', path: 'agent-plan.md', sha256: planSha256, size: 128 }],
    }, {
      id: 'task_agent_final',
      title: 'Nado Agent collaboration review and handoff',
      type: 'agent',
      sessionId: 'session_agent_collab',
      status: 'succeeded',
      maxAttempts: 1,
      requestedWorkerId: 'home-gpu',
      assignedWorkerId: 'home-gpu',
      attempts: [{ id: 'attempt_agent_final', workerId: 'home-gpu', status: 'succeeded' }],
      artifacts: [
        { id: 'artifact_agent_final', path: 'agent-final.md', sha256: finalSha256, size: 160 },
        { id: 'artifact_agent_transcript', path: '.nado-session/transcript.md', sha256: transcriptSha256, size: 512 },
      ],
    }, {
      id: 'task_long_disconnect',
      title: 'nado cross-site long disconnect recovery exercise',
      type: 'shell',
      status: 'succeeded',
      maxAttempts: 2,
      retryBackoffMs: 0,
      maxRetryBackoffMs: 0,
      requestedWorkerId: 'home-gpu',
      assignedWorkerId: 'home-gpu',
      attempts: [
        { id: 'attempt_long_1', seq: 1, workerId: 'home-gpu', status: 'lease_expired' },
        { id: 'attempt_long_2', seq: 2, workerId: 'home-gpu', status: 'succeeded' },
      ],
      events: [{
        at: revocationCheckedAt,
        type: 'stdout',
        message: 'nado-long-disconnect-attempt-1-ready',
      }, {
        at: revocationCheckedAt,
        type: 'lease_recovered',
        data: { previousWorkerId: 'home-gpu', recoveryReason: 'lease_expired_and_worker_offline' },
      }, {
        at: revocationCheckedAt,
        type: 'stale_result_ignored',
        data: { resultAttemptId: 'attempt_long_1', currentAttemptId: 'attempt_long_2' },
      }],
      artifacts: [{
        id: 'artifact_long_disconnect', path: 'long-disconnect.json', sha256: longDisconnectSha256, size: 128,
      }],
    }, {
      id: 'task_vm_restart',
      title: 'nado cross-site VM restart recovery exercise',
      type: 'shell',
      status: 'succeeded',
      maxAttempts: 1,
      requestedWorkerId: 'home-gpu',
      assignedWorkerId: 'home-gpu',
      createdControlInstanceId: 'control_original',
      attempts: [{ id: 'attempt_vm_restart', seq: 1, workerId: 'home-gpu', status: 'succeeded' }],
      artifacts: [{
        id: 'artifact_vm_restart', path: 'vm-restart-recovery.json', sha256: vmRestartSha256, size: 192,
      }],
    }, {
      id: 'task_worker_restart',
      title: 'nado cross-site Worker restart recovery exercise',
      type: 'shell',
      status: 'succeeded',
      createdAt: workerRestartTaskCreatedAt,
      maxAttempts: 1,
      requestedWorkerId: 'home-gpu',
      assignedWorkerId: 'home-gpu',
      attempts: [{ id: 'attempt_worker_restart', seq: 1, workerId: 'home-gpu', status: 'succeeded' }],
      artifacts: [{
        id: 'artifact_worker_restart', path: 'worker-restart-recovery.json', sha256: workerRestartSha256, size: 192,
      }],
    }, {
      id: 'task_large_artifact',
      title: 'nado cross-site large artifact resume exercise',
      type: 'shell',
      status: 'succeeded',
      maxAttempts: 1,
      requestedWorkerId: 'home-gpu',
      assignedWorkerId: 'home-gpu',
      attempts: [{ id: 'attempt_large_artifact', seq: 1, workerId: 'home-gpu', status: 'succeeded' }],
      events: [{
        at: transferInitialEventAt,
        type: 'artifact_upload_progress',
        workerId: 'home-gpu',
        attemptId: 'attempt_large_artifact',
        data: { uploadId: 'upload_large_artifact', committedBytes: 65_536, size: 262_144, sha256: largeArtifactSha256 },
      }, {
        at: transferStalledEventAt,
        type: 'artifact_upload_progress',
        workerId: 'home-gpu',
        attemptId: 'attempt_large_artifact',
        data: { uploadId: 'upload_large_artifact', committedBytes: 131_072, size: 262_144, sha256: largeArtifactSha256 },
      }, {
        at: transferRecoveredAt,
        type: 'artifact_upload_finalized',
        workerId: 'home-gpu',
        attemptId: 'attempt_large_artifact',
        data: { uploadId: 'upload_large_artifact', committedBytes: 262_144, size: 262_144, sha256: largeArtifactSha256 },
      }],
      artifacts: [{
        id: 'artifact_large_artifact', uploadId: 'upload_large_artifact', path: 'large-artifact-resume.bin', sha256: largeArtifactSha256, size: 262_144,
      }],
    }, {
      id: 'task_large_input',
      title: 'nado cross-site large input resume exercise',
      type: 'shell',
      status: 'succeeded',
      maxAttempts: 1,
      requestedWorkerId: 'home-gpu',
      assignedWorkerId: 'home-gpu',
      attempts: [{ id: 'attempt_large_input', seq: 1, workerId: 'home-gpu', status: 'succeeded' }],
      inputFiles: [{
        inputUploadId: 'input_large', path: 'large-input-resume.bin', size: 262_144, sha256: largeInputSha256, ready: true,
      }],
      events: [{
        at: transferInitialEventAt,
        type: 'input_download_range',
        workerId: 'home-gpu',
        attemptId: 'attempt_large_input',
        data: { inputId: 'input_large', attemptId: 'attempt_large_input', offset: 0, resumed: false },
      }, {
        at: transferRecoveredAt,
        type: 'input_download_range',
        workerId: 'home-gpu',
        attemptId: 'attempt_large_input',
        data: { inputId: 'input_large', attemptId: 'attempt_large_input', offset: 65_536, resumed: true },
      }],
      artifacts: [{
        id: 'artifact_large_input_result', path: 'large-input-resume.json', sha256: largeInputResultSha256, size: 192,
      }],
    }, {
      id: 'task_backup_marker',
      title: 'nado backup restore pre-backup marker',
      type: 'shell',
      status: 'succeeded',
      maxAttempts: 1,
      requestedWorkerId: 'home-gpu',
      assignedWorkerId: 'home-gpu',
      createdControlInstanceId: 'control_original',
      attempts: [{ id: 'attempt_backup_marker', seq: 1, workerId: 'home-gpu', status: 'succeeded' }],
      artifacts: [{
        id: 'artifact_backup_marker', path: 'backup-restore-marker.json', sha256: backupMarkerSha256, size: 160,
      }],
    }, {
      id: 'task_backup_post',
      title: 'nado backup restore post-restore write probe',
      type: 'shell',
      status: 'succeeded',
      maxAttempts: 1,
      requestedWorkerId: 'home-gpu',
      assignedWorkerId: 'home-gpu',
      createdControlInstanceId: 'control_restarted',
      attempts: [{ id: 'attempt_backup_post', seq: 1, workerId: 'home-gpu', status: 'succeeded' }],
      artifacts: [{
        id: 'artifact_backup_post', path: 'backup-restore-post.json', sha256: backupPostSha256, size: 192,
      }],
    }],
    sessions: [{
      id: 'session_agent_collab',
      title: 'Nado cross-site Agent collaboration 12345678',
      status: 'closed',
      requestedWorkerId: 'home-gpu',
      assignedWorkerId: 'home-gpu',
      requiredCapabilities: ['agent'],
      taskIds: ['task_agent_plan', 'task_agent_final'],
      events: [{ at: revocationCheckedAt, type: 'closed' }],
    }],
    verifyResult: {
      ok: true,
      problems: [],
      summary: { taskId: 'task_verify', batchId: 'batch_verify' },
    },
  };
}

test('cross-site report passes only with automatic and operator evidence complete', () => {
  const report = buildCrossSiteAcceptanceReport(passingInputs());
  assert.equal(report.overall, 'passed');
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.pending, 0);
  assert.ok(report.automatedChecks.every((item) => item.status === 'passed'));
  assert.ok(report.manualChecks.every((item) => item.status === 'passed'));

  const unfencedControl = passingInputs();
  unfencedControl.status.storage.dataLease.status = 'unavailable';
  unfencedControl.status.storage.dataLease.writeFencing = false;
  const unfencedReport = buildCrossSiteAcceptanceReport(unfencedControl);
  const singleWriter = unfencedReport.automatedChecks.find(
    (item) => item.key === 'controlDataSingleWriter',
  );
  assert.equal(unfencedReport.overall, 'failed');
  assert.equal(singleWriter.status, 'failed');
  assert.match(singleWriter.nextAction, /only one instance/);

  const incomplete = passingInputs();
  incomplete.verifyResult = null;
  incomplete.manualEvidence.scenarios.credentialRevocation = {
    status: 'pending', evidence: '', references: [],
  };
  const pending = buildCrossSiteAcceptanceReport(incomplete);
  assert.equal(pending.overall, 'pending');
  assert.ok(pending.nextActions.some((item) => item.key === 'endToEndVerify'));
  assert.ok(pending.nextActions.some((item) => item.key === 'credentialRevocation'));
  assert.ok(pending.nextActions.some((item) => item.key === 'credentialRevocationReceipt'));

  const forgedRevocation = passingInputs();
  forgedRevocation.manualEvidence.scenarios.credentialRevocation.source = 'operator';
  forgedRevocation.manualEvidence.scenarios.credentialRevocation.details.verification.previousTokenStatus = 200;
  const forged = buildCrossSiteAcceptanceReport(forgedRevocation);
  const receiptCheck = forged.automatedChecks.find((item) => item.key === 'credentialRevocationReceipt');
  assert.equal(forged.overall, 'failed');
  assert.equal(receiptCheck.status, 'failed');
  assert.match(receiptCheck.nextAction, /rotate_token/);

  const forgedCancellation = passingInputs();
  forgedCancellation.manualEvidence.scenarios.remoteCancellation.source = 'operator';
  forgedCancellation.manualEvidence.scenarios.remoteCancellation.details.processReleasedEvent.type = 'operator_claim';
  const forgedCancellationReport = buildCrossSiteAcceptanceReport(forgedCancellation);
  const cancellationReceipt = forgedCancellationReport.automatedChecks.find(
    (item) => item.key === 'remoteCancellationReceipt',
  );
  assert.equal(forgedCancellationReport.overall, 'failed');
  assert.equal(cancellationReceipt.status, 'failed');
  assert.match(cancellationReceipt.nextAction, /remote-cancellation/);

  const forgedCollaboration = passingInputs();
  forgedCollaboration.manualEvidence.scenarios.agentCollaboration.source = 'operator';
  forgedCollaboration.manualEvidence.scenarios.agentCollaboration.details.artifacts[1].sha256 = 'e'.repeat(64);
  const forgedCollaborationReport = buildCrossSiteAcceptanceReport(forgedCollaboration);
  const collaborationReceipt = forgedCollaborationReport.automatedChecks.find(
    (item) => item.key === 'agentCollaborationReceipt',
  );
  assert.equal(forgedCollaborationReport.overall, 'failed');
  assert.equal(collaborationReceipt.status, 'failed');
  assert.equal(collaborationReceipt.evidence.artifactStateMatches, false);
  assert.match(collaborationReceipt.nextAction, /agent-collaboration/);

  const forgedLongDisconnect = passingInputs();
  forgedLongDisconnect.manualEvidence.scenarios.longDisconnectRecovery.source = 'operator';
  forgedLongDisconnect.manualEvidence.scenarios.longDisconnectRecovery.details.staleResultRejection.resultAttemptId = 'attempt_forged';
  const forgedLongReport = buildCrossSiteAcceptanceReport(forgedLongDisconnect);
  const longReceipt = forgedLongReport.automatedChecks.find(
    (item) => item.key === 'longDisconnectRecoveryReceipt',
  );
  assert.equal(forgedLongReport.overall, 'failed');
  assert.equal(longReceipt.status, 'failed');
  assert.equal(longReceipt.evidence.staleResultRejectionMatched, false);
  assert.match(longReceipt.nextAction, /long-disconnect-recovery/);

  const forgedRestart = passingInputs();
  forgedRestart.manualEvidence.scenarios.vmRestartRecovery.details.controlRestart.original.instanceId = 'forged_original';
  const forgedRestartReport = buildCrossSiteAcceptanceReport(forgedRestart);
  const restartReceipt = forgedRestartReport.automatedChecks.find(
    (item) => item.key === 'vmRestartRecoveryReceipt',
  );
  assert.equal(forgedRestartReport.overall, 'failed');
  assert.equal(restartReceipt.status, 'failed');
  assert.equal(restartReceipt.evidence.runtimeMatches, false);
  assert.match(restartReceipt.nextAction, /vm-restart-recovery/);

  const forgedWorkerRestart = passingInputs();
  forgedWorkerRestart.manualEvidence.scenarios.workerRestartRecovery.details.runtimeRestart.restarted.id = 'wrun_forged';
  const forgedWorkerRestartReport = buildCrossSiteAcceptanceReport(forgedWorkerRestart);
  const workerRestartReceipt = forgedWorkerRestartReport.automatedChecks.find(
    (item) => item.key === 'workerRestartRecoveryReceipt',
  );
  assert.equal(forgedWorkerRestartReport.overall, 'failed');
  assert.equal(workerRestartReceipt.status, 'failed');
  assert.equal(workerRestartReceipt.evidence.controlRuntimeEventMatched, false);
  assert.match(workerRestartReceipt.nextAction, /worker-restart-recovery/);

  const forgedArtifactResume = passingInputs();
  forgedArtifactResume.manualEvidence.scenarios.largeArtifactResume.details.upload.stalledOffset = 196_608;
  const forgedArtifactReport = buildCrossSiteAcceptanceReport(forgedArtifactResume);
  const artifactReceipt = forgedArtifactReport.automatedChecks.find(
    (item) => item.key === 'largeArtifactResumeReceipt',
  );
  assert.equal(forgedArtifactReport.overall, 'failed');
  assert.equal(artifactReceipt.evidence.uploadStateMatches, false);

  const forgedInputResume = passingInputs();
  forgedInputResume.manualEvidence.scenarios.largeInputResume.details.input.resumedOffset = 131_072;
  const forgedInputReport = buildCrossSiteAcceptanceReport(forgedInputResume);
  const inputReceipt = forgedInputReport.automatedChecks.find((item) => item.key === 'largeInputResumeReceipt');
  assert.equal(forgedInputReport.overall, 'failed');
  assert.equal(inputReceipt.evidence.inputStateMatches, false);

  const forgedRestore = passingInputs();
  forgedRestore.manualEvidence.scenarios.backupRestore.details.restoreReceipt.manifestSha256 = '9'.repeat(64);
  const forgedRestoreReport = buildCrossSiteAcceptanceReport(forgedRestore);
  const backupReceipt = forgedRestoreReport.automatedChecks.find((item) => item.key === 'backupRestoreReceipt');
  assert.equal(forgedRestoreReport.overall, 'failed');
  assert.equal(backupReceipt.evidence.receiptMatches, false);

  const forgedShortDisconnect = passingInputs();
  forgedShortDisconnect.manualEvidence.scenarios.shortDisconnect.details.observedGap.ageMs = 10_000;
  const forgedShortReport = buildCrossSiteAcceptanceReport(forgedShortDisconnect);
  const shortReceipt = forgedShortReport.automatedChecks.find((item) => item.key === 'shortDisconnectReceipt');
  assert.equal(forgedShortReport.overall, 'failed');
  assert.equal(shortReceipt.evidence.gapMatched, false);

  const adminAuthenticated = passingInputs();
  adminAuthenticated.workers[0].identity = {
    type: 'admin', scoped: false, signed: false, observedAt: new Date().toISOString(),
  };
  const insecure = buildCrossSiteAcceptanceReport(adminAuthenticated);
  const identityCheck = insecure.automatedChecks.find((item) => item.key === 'workerIdentity');
  assert.equal(insecure.overall, 'failed');
  assert.equal(identityCheck.status, 'failed');
  assert.match(identityCheck.nextAction, /Re-enroll/);

  const driftedBuild = passingInputs();
  driftedBuild.workers[0].runtime.build.sourceFingerprint = `sha256:${'b'.repeat(64)}`;
  const driftedBuildReport = buildCrossSiteAcceptanceReport(driftedBuild);
  const buildCheck = driftedBuildReport.automatedChecks.find(
    (item) => item.key === 'runtimeBuildCompatibility',
  );
  assert.equal(driftedBuildReport.overall, 'failed');
  assert.equal(buildCheck.status, 'failed');
  assert.equal(buildCheck.evidence.compatibility, 'build_mismatch');
  assert.match(buildCheck.nextAction, /same immutable build/);

  const legacyBuild = passingInputs();
  delete legacyBuild.workers[0].runtime.build;
  const legacyBuildReport = buildCrossSiteAcceptanceReport(legacyBuild);
  const legacyBuildCheck = legacyBuildReport.automatedChecks.find(
    (item) => item.key === 'runtimeBuildCompatibility',
  );
  assert.equal(legacyBuildReport.overall, 'pending');
  assert.equal(legacyBuildCheck.status, 'pending');
  assert.equal(legacyBuildCheck.evidence.compatibility, 'unknown');

  const driftedClock = passingInputs();
  driftedClock.workers[0].identity.signatureClockSkewMs = 90_000;
  const driftedClockReport = buildCrossSiteAcceptanceReport(driftedClock);
  const clockCheck = driftedClockReport.automatedChecks.find(
    (item) => item.key === 'workerClockSynchronization',
  );
  assert.equal(driftedClockReport.overall, 'failed');
  assert.equal(clockCheck.status, 'failed');
  assert.equal(clockCheck.evidence.controlMinusWorkerMs, 90_000);
  assert.match(clockCheck.nextAction, /NTP\/Windows Time/);

  const warmingTelemetry = passingInputs();
  warmingTelemetry.workers[0].resources.cpu.utilizationPercent = null;
  const warmingReport = buildCrossSiteAcceptanceReport(warmingTelemetry);
  const resourceCheck = warmingReport.automatedChecks.find(
    (item) => item.key === 'workerResourceTelemetry',
  );
  assert.equal(warmingReport.overall, 'pending');
  assert.equal(resourceCheck.status, 'pending');
  assert.match(resourceCheck.nextAction, /two heartbeats/);

  const loopbackWorker = passingInputs();
  loopbackWorker.workers[0].connection = {
    remoteAddress: '::ffff:127.0.0.1', addressSource: 'socket', protocol: 'http', trustedProxy: false,
  };
  const localOnly = buildCrossSiteAcceptanceReport(loopbackWorker);
  const sourceCheck = localOnly.automatedChecks.find((item) => item.key === 'targetWorkerRemoteSource');
  assert.equal(localOnly.overall, 'failed');
  assert.equal(sourceCheck.status, 'failed');
  assert.match(sourceCheck.nextAction, /X-Forwarded-For/);

  const httpsBypass = passingInputs();
  httpsBypass.workers[0].connection = {
    remoteAddress: '198.51.100.23',
    addressSource: 'socket',
    protocol: 'http',
    trustedProxy: false,
    observedAt: new Date().toISOString(),
  };
  const bypassed = buildCrossSiteAcceptanceReport(httpsBypass);
  const transportCheck = bypassed.automatedChecks.find((item) => item.key === 'encryptedTransport');
  assert.equal(bypassed.overall, 'failed');
  assert.equal(transportCheck.status, 'failed');
  assert.equal(transportCheck.evidence.publicHttpsAdvertised, true);
  assert.equal(transportCheck.evidence.observedHttps, false);
  assert.match(transportCheck.nextAction, /bypassed HTTPS/);

  const unauthenticatedProxy = passingInputs();
  unauthenticatedProxy.workers[0].connection.proxyAuthenticated = false;
  const untrusted = buildCrossSiteAcceptanceReport(unauthenticatedProxy);
  const untrustedTransport = untrusted.automatedChecks.find((item) => item.key === 'encryptedTransport');
  const untrustedSource = untrusted.automatedChecks.find((item) => item.key === 'targetWorkerRemoteSource');
  assert.equal(untrusted.overall, 'failed');
  assert.equal(untrustedTransport.status, 'failed');
  assert.equal(untrustedSource.status, 'failed');
  assert.match(untrustedTransport.nextAction, /NADO_TRUST_PROXY_SECRET/);

  const privateOverlay = passingInputs();
  privateOverlay.network.publicControlUrl = 'http://100.64.10.20:8765';
  privateOverlay.network.preferredRemoteControlUrl = 'http://100.64.10.20:8765';
  privateOverlay.workers[0].connection = {
    remoteAddress: '100.64.20.30',
    addressSource: 'socket',
    protocol: 'http',
    trustedProxy: false,
    observedAt: new Date().toISOString(),
  };
  const overlayReport = buildCrossSiteAcceptanceReport(privateOverlay);
  const overlayTransport = overlayReport.automatedChecks.find((item) => item.key === 'encryptedTransport');
  assert.equal(overlayReport.overall, 'passed');
  assert.equal(overlayTransport.status, 'passed');
  assert.equal(overlayTransport.evidence.observedHttps, false);
  assert.match(overlayTransport.evidence.privateOverlayEvidence.note, /encryptedPrivateOverlay/);
});

test('cross-site report can require and bind the deployment boundary receipt', () => {
  const inputs = passingInputs();
  const keys = [
    'controlContainerHardening', 'httpsUrl', 'publicHealth', 'certificate', 'publicNetwork', 'proxyAuthenticated',
    'forwardedHttps', 'advertisedPublicUrl', 'backendSeparated', 'backendPrivateAddress',
    'backendHealth', 'backendNetwork', 'backendNotProxyAuthenticated', 'backendProxyBoundaryConfigured',
  ];
  inputs.requireDeploymentEvidence = true;
  inputs.deploymentEvidence = {
    reportVersion: 2,
    ok: true,
    mode: 'public_https',
    generatedAt: new Date().toISOString(),
    publicControlUrl: 'https://nado.example.com',
    checks: keys.map((key) => ({ key, status: 'passed' })),
  };
  const passed = buildCrossSiteAcceptanceReport(inputs);
  assert.equal(passed.overall, 'passed');
  assert.equal(passed.requirements.requireDeploymentEvidence, true);
  assert.equal(
    passed.automatedChecks.find((item) => item.key === 'deploymentBoundaryReceipt').status,
    'passed',
  );

  inputs.deploymentEvidence.publicControlUrl = 'https://wrong.example.com';
  const failed = buildCrossSiteAcceptanceReport(inputs);
  assert.equal(failed.overall, 'failed');
  assert.equal(
    failed.automatedChecks.find((item) => item.key === 'deploymentBoundaryReceipt').status,
    'failed',
  );

  inputs.deploymentEvidence.publicControlUrl = 'https://nado.example.com';
  inputs.deploymentEvidence.generatedAt = new Date(Date.now() - (25 * 60 * 60 * 1000)).toISOString();
  const expired = buildCrossSiteAcceptanceReport(inputs);
  const expiredReceipt = expired.automatedChecks
    .find((item) => item.key === 'deploymentBoundaryReceipt');
  assert.equal(expiredReceipt.status, 'failed');
  assert.equal(expiredReceipt.evidence.generatedAtValid, true);
  assert.equal(expiredReceipt.evidence.generatedAtFresh, false);
  assert.ok(expiredReceipt.evidence.ageMs > expiredReceipt.evidence.maxAgeMs);

  inputs.deploymentEvidence.generatedAt = new Date(Date.now() + (10 * 60 * 1000)).toISOString();
  const future = buildCrossSiteAcceptanceReport(inputs);
  const futureReceipt = future.automatedChecks
    .find((item) => item.key === 'deploymentBoundaryReceipt');
  assert.equal(futureReceipt.status, 'failed');
  assert.equal(futureReceipt.evidence.generatedAtFresh, false);
  assert.ok(futureReceipt.evidence.ageMs < -futureReceipt.evidence.maxFutureSkewMs);
});

test('cross-site evidence rejects unsupported scenarios and unsupported claims without notes', () => {
  const unknown = passingInputs();
  unknown.manualEvidence.scenarios.typoScenario = { status: 'passed', evidence: 'typo' };
  assert.throws(() => buildCrossSiteAcceptanceReport(unknown), /Unknown acceptance evidence scenario/);

  const noEvidence = passingInputs();
  noEvidence.manualEvidence.scenarios.vmRestartRecovery = { status: 'passed', evidence: '' };
  assert.throws(() => buildCrossSiteAcceptanceReport(noEvidence), /requires a non-empty evidence note/);
});

test('short-disconnect observations are computed by control and persisted on the live attempt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-short-gap-observation-'));
  const token = 'short-gap-admin-token';
  const running = await startControlServer({ host: '127.0.0.1', port: 0, token, dataDir: root });
  const controlUrl = `http://127.0.0.1:${running.port}`;
  const admin = new NadoClient({ controlUrl, token });
  try {
    const issued = await admin.createWorkerToken({ workerId: 'short-gap-worker' });
    const worker = new NadoClient({ controlUrl, token: issued.token });
    await worker.registerWorker({ id: 'short-gap-worker', capabilities: ['code'] });
    const created = await admin.createTask({
      title: 'nado cross-site short disconnect exercise',
      command: 'node -e "setTimeout(() => {}, 30000)"',
      workerId: 'short-gap-worker',
      maxAttempts: 1,
    });
    const claimed = await worker.claimTask('short-gap-worker');
    const task = running.store.state.tasks[created.task.id];
    const now = Date.now();
    running.store.state.workers['short-gap-worker'].lastSeenAt = new Date(now - 2_500).toISOString();
    task.lease.renewedAt = new Date(now - 2_500).toISOString();
    task.lease.expiresAt = new Date(now + 30_000).toISOString();
    await running.store.save();

    const gap = await admin.recordShortDisconnectObservation(task.id, {
      phase: 'gap',
      workerId: 'short-gap-worker',
      attemptId: claimed.task.currentAttemptId,
      minDisconnectMs: 2_000,
    });
    assert.equal(gap.event.type, 'short_disconnect_gap_observed');
    assert.ok(gap.event.data.workerAgeMs >= 2_000);

    running.store.state.workers['short-gap-worker'].lastSeenAt = new Date().toISOString();
    task.lease.renewedAt = new Date().toISOString();
    task.lease.expiresAt = new Date(Date.now() + 60_000).toISOString();
    await running.store.save();
    const recovered = await admin.recordShortDisconnectObservation(task.id, {
      phase: 'recovered',
      workerId: 'short-gap-worker',
      attemptId: claimed.task.currentAttemptId,
      minDisconnectMs: 2_000,
    });
    assert.equal(recovered.event.type, 'short_disconnect_recovered');
    assert.equal(recovered.event.data.gapObservedAt, gap.event.at);
    const durable = (await admin.listTaskEvents(task.id)).events;
    assert.ok(durable.some((item) => item.type === 'short_disconnect_gap_observed'));
    assert.ok(durable.some((item) => item.type === 'short_disconnect_recovered'));
    await admin.manageTask(task.id, 'cancel', { reason: 'short-gap observation test cleanup' });
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('remote cancellation exercise fails closed before creating work on an offline Worker', async () => {
  let created = false;
  const result = await runRemoteCancellationExercise({
    getWorker: async () => ({
      worker: { id: 'offline-home', active: false, adminState: 'enabled', gatewayState: 'offline' },
    }),
    createTask: async () => {
      created = true;
      throw new Error('must not create');
    },
  }, {
    workerId: 'offline-home',
    timeoutMs: 5_000,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /not active and enabled/);
  assert.equal(created, false);
});

test('Agent collaboration exercise proves two-turn session handoff with verified artifacts', async () => {
  let marker = null;
  let createdTurns = 0;
  let sessionClosed = false;
  const tasks = new Map();
  const client = {
    async getWorker() {
      return {
        worker: {
          id: 'real-agent-worker',
          active: true,
          adminState: 'enabled',
          gatewayState: 'idle',
          readiness: {
            agent: {
              realTerminalAgent: true,
              readyForAgentTasks: true,
              selfTest: { status: 'succeeded' },
            },
          },
        },
      };
    },
    async createSession(input) {
      assert.equal(input.workerId, 'real-agent-worker');
      assert.deepEqual(input.requiredCapabilities, ['agent']);
      return { session: { id: 'session-collaboration', status: 'open' } };
    },
    async createTask(input) {
      createdTurns += 1;
      const id = `task-agent-${createdTurns}`;
      if (createdTurns === 1) {
        marker = input.prompt.match(/NADO-COLLAB-[a-f0-9-]+/)?.[0] || null;
        assert.ok(marker);
        tasks.set(id, {
          id,
          status: 'succeeded',
          assignedWorkerId: 'real-agent-worker',
          attempts: [{ id: 'attempt-plan' }],
          artifacts: [{ id: 'artifact-plan', path: 'agent-plan.md', sha256: 'plan-sha' }],
        });
      } else {
        assert.equal(input.prompt.includes(marker), false, 'second prompt must inherit the marker instead of repeating it');
        tasks.set(id, {
          id,
          status: 'succeeded',
          assignedWorkerId: 'real-agent-worker',
          attempts: [{ id: 'attempt-final' }],
          artifacts: [
            { id: 'artifact-final', path: 'agent-final.md', sha256: 'final-sha' },
            { id: 'artifact-transcript', path: '.nado-session/transcript.md', sha256: 'transcript-sha' },
          ],
        });
      }
      return { task: { id } };
    },
    async getTask(taskId) {
      return { task: tasks.get(taskId) };
    },
    async downloadArtifact(taskId, artifactId) {
      if (artifactId === 'artifact-plan') {
        return { bytes: Buffer.from(`NADO_AGENT_COLLABORATION_PLAN\n${marker}\nPlan`) };
      }
      if (artifactId === 'artifact-final') {
        return { bytes: Buffer.from(`NADO_AGENT_COLLABORATION_OK\n${marker}\nReviewed`) };
      }
      assert.equal(artifactId, 'artifact-transcript');
      return { bytes: Buffer.from('Prior prompt: NADO_AGENT_COLLABORATION_PLAN') };
    },
    async closeSession(sessionId) {
      assert.equal(sessionId, 'session-collaboration');
      sessionClosed = true;
      return { session: { id: sessionId, status: 'closed' } };
    },
  };

  const result = await runAgentCollaborationExercise(client, {
    workerId: 'real-agent-worker',
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.exercise, 'agentCollaboration');
  assert.equal(result.sessionId, 'session-collaboration');
  assert.deepEqual(result.taskIds, ['task-agent-1', 'task-agent-2']);
  assert.equal(result.artifacts.length, 3);
  assert.match(result.markerSha256, /^[a-f0-9]{64}$/);
  assert.equal(sessionClosed, true);
});

test('Agent collaboration exercise rejects demo or unverified Agent workers', async () => {
  let sessionCreated = false;
  const result = await runAgentCollaborationExercise({
    async getWorker() {
      return {
        worker: {
          id: 'demo-agent-worker',
          active: true,
          adminState: 'enabled',
          gatewayState: 'idle',
          readiness: {
            agent: {
              realTerminalAgent: false,
              readyForAgentTasks: true,
              selfTest: { status: 'succeeded' },
            },
          },
        },
      };
    },
    async createSession() {
      sessionCreated = true;
      throw new Error('must not create');
    },
  }, {
    workerId: 'demo-agent-worker',
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /verified real terminal Agent/);
  assert.equal(sessionCreated, false);
});

test('short disconnect exercise proves a heartbeat gap and same-attempt recovery', async () => {
  const now = Date.now();
  const attemptId = 'attempt-short-disconnect';
  let workerCalls = 0;
  let taskCalls = 0;
  const progress = [];
  const runningTask = (renewedAt, expiresAt) => ({
    id: 'task-short-disconnect',
    status: 'running',
    assignedWorkerId: 'home-worker',
    currentAttemptId: attemptId,
    lease: {
      attemptId,
      durationMs: 60_000,
      renewedAt,
      expiresAt,
    },
    attempts: [{ id: attemptId, status: 'running' }],
  });
  const client = {
    async getWorker() {
      workerCalls += 1;
      if (workerCalls === 1) {
        return {
          worker: {
            id: 'home-worker', active: true, adminState: 'enabled', gatewayState: 'idle', ageMs: 50,
            lastSeenAt: new Date(now).toISOString(),
          },
        };
      }
      if (workerCalls === 2) {
        return {
          worker: {
            id: 'home-worker', active: true, adminState: 'enabled', gatewayState: 'running', ageMs: 2_500,
            lastSeenAt: new Date(now - 2_500).toISOString(),
          },
        };
      }
      return {
        worker: {
          id: 'home-worker', active: true, adminState: 'enabled', gatewayState: 'running', ageMs: 100,
          lastSeenAt: new Date(now + 3_000).toISOString(),
        },
      };
    },
    async createTask(input) {
      assert.equal(input.workerId, 'home-worker');
      assert.equal(input.maxAttempts, 1);
      assert.match(input.command, /nado-short-disconnect-ready/);
      return { task: { id: 'task-short-disconnect' } };
    },
    async getTask() {
      taskCalls += 1;
      if (taskCalls <= 2) {
        return {
          task: runningTask(
            new Date(now).toISOString(),
            new Date(now + 55_000).toISOString(),
          ),
        };
      }
      if (taskCalls === 3) {
        return {
          task: runningTask(
            new Date(now + 3_000).toISOString(),
            new Date(now + 63_000).toISOString(),
          ),
        };
      }
      return {
        task: {
          id: 'task-short-disconnect',
          status: 'succeeded',
          assignedWorkerId: 'home-worker',
          currentAttemptId: null,
          attempts: [{ id: attemptId, status: 'succeeded' }],
          artifacts: [{
            id: 'artifact-short-disconnect',
            path: 'short-disconnect.txt',
            sha256: 'short-disconnect-sha',
          }],
        },
      };
    },
    async recordShortDisconnectObservation(taskId, observation) {
      assert.equal(taskId, 'task-short-disconnect');
      assert.equal(observation.workerId, 'home-worker');
      assert.equal(observation.attemptId, attemptId);
      if (observation.phase === 'gap') {
        return {
          event: {
            at: new Date(now + 2_500).toISOString(),
            type: 'short_disconnect_gap_observed',
            data: {
              workerAgeMs: 2_500,
              workerLastSeenAt: new Date(now - 2_500).toISOString(),
              leaseRenewedAt: new Date(now).toISOString(),
              leaseExpiresAt: new Date(now + 55_000).toISOString(),
            },
          },
        };
      }
      assert.equal(observation.phase, 'recovered');
      return {
        event: {
          at: new Date(now + 3_000).toISOString(),
          type: 'short_disconnect_recovered',
          data: {
            workerAgeMs: 100,
            workerLastSeenAt: new Date(now + 3_000).toISOString(),
            leaseRenewedAt: new Date(now + 3_000).toISOString(),
            leaseExpiresAt: new Date(now + 63_000).toISOString(),
          },
        },
      };
    },
    async downloadArtifact(taskId, artifactId) {
      assert.equal(taskId, 'task-short-disconnect');
      assert.equal(artifactId, 'artifact-short-disconnect');
      return { bytes: Buffer.from('execution\ncompleted\n') };
    },
  };

  const result = await runShortDisconnectExercise(client, {
    workerId: 'home-worker',
    timeoutMs: 30_000,
    minDisconnectMs: 2_000,
    taskDurationMs: 12_000,
    onProgress: (entry) => progress.push(entry.phase),
  });
  assert.equal(result.ok, true);
  assert.equal(result.exercise, 'shortDisconnect');
  assert.equal(result.attemptId, attemptId);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.observedGap.ageMs, 2_500);
  assert.equal(result.artifact.path, 'short-disconnect.txt');
  assert.deepEqual(progress, ['disconnect_now', 'disconnect_observed', 'reconnected']);
});

test('long disconnect recovery exercise proves lease expiry stale rejection and a second attempt', async () => {
  const firstAttemptId = 'attempt-long-first';
  const secondAttemptId = 'attempt-long-second';
  const now = new Date().toISOString();
  let taskCalls = 0;
  const progress = [];
  const firstAttempt = {
    id: firstAttemptId,
    seq: 1,
    workerId: 'original-home-worker',
    status: 'running',
    claimedAt: now,
    completedAt: null,
  };
  const recoveryEvent = {
    at: now,
    type: 'lease_recovered',
    message: 'Recovered expired lease',
    data: {
      previousWorkerId: 'original-home-worker',
      targetWorkerId: null,
      recoveryReason: 'lease_expired_and_worker_offline',
    },
  };
  const client = {
    async capabilities() {
      return {
        reliability: {
          taskLeaseMs: 60_000,
          automaticOfflineRecovery: {
            enabled: true,
            scanIntervalMs: 15_000,
          },
        },
      };
    },
    async getWorker() {
      return {
        worker: {
          id: 'original-home-worker',
          active: true,
          adminState: 'enabled',
          gatewayState: 'running',
        },
      };
    },
    async createTask(input) {
      assert.equal(input.workerId, 'original-home-worker');
      assert.equal(input.maxAttempts, 2);
      assert.equal(input.retryBackoffMs, 0);
      assert.match(input.command, /NADO_ATTEMPT_SEQ/);
      return { task: { id: 'task-long-disconnect' } };
    },
    async getTask() {
      taskCalls += 1;
      if (taskCalls === 1) {
        return {
          task: {
            id: 'task-long-disconnect',
            status: 'running',
            assignedWorkerId: 'original-home-worker',
            currentAttemptId: firstAttemptId,
            lease: { durationMs: 60_000 },
            attempts: [firstAttempt],
            events: [],
          },
        };
      }
      if (taskCalls === 2) {
        return {
          task: {
            id: 'task-long-disconnect',
            status: 'running',
            assignedWorkerId: 'original-home-worker',
            currentAttemptId: firstAttemptId,
            attempts: [firstAttempt],
            events: [{
              at: now,
              type: 'stdout',
              message: 'nado-long-disconnect-attempt-1-ready',
            }],
          },
        };
      }
      if (taskCalls === 3) {
        return {
          task: {
            id: 'task-long-disconnect',
            status: 'queued',
            assignedWorkerId: null,
            currentAttemptId: null,
            attempts: [{ ...firstAttempt, status: 'lease_expired', completedAt: now }],
            events: [recoveryEvent],
          },
        };
      }
      return {
        task: {
          id: 'task-long-disconnect',
          status: 'succeeded',
          assignedWorkerId: 'recovery-worker',
          currentAttemptId: null,
          attempts: [
            { ...firstAttempt, status: 'lease_expired', completedAt: now },
            {
              id: secondAttemptId,
              seq: 2,
              workerId: 'recovery-worker',
              status: 'succeeded',
              claimedAt: now,
              completedAt: now,
            },
          ],
          events: [
            {
              at: now,
              type: 'stdout',
              message: 'nado-long-disconnect-attempt-1-ready',
            },
            recoveryEvent,
            {
              at: now,
              type: 'stale_result_ignored',
              data: { resultAttemptId: firstAttemptId, currentAttemptId: secondAttemptId },
            },
          ],
          artifacts: [{
            id: 'artifact-long-disconnect',
            path: 'long-disconnect.json',
            sha256: 'long-disconnect-sha',
          }],
        },
      };
    },
    async downloadArtifact(taskId, artifactId) {
      assert.equal(taskId, 'task-long-disconnect');
      assert.equal(artifactId, 'artifact-long-disconnect');
      return {
        bytes: Buffer.from(JSON.stringify({
          attemptId: secondAttemptId,
          attemptSeq: 2,
          workerId: 'recovery-worker',
        })),
      };
    },
  };

  const result = await runLongDisconnectRecoveryExercise(client, {
    workerId: 'original-home-worker',
    timeoutMs: 60_000,
    firstAttemptMs: 90_000,
    onProgress: (entry) => progress.push(entry.phase),
  });
  assert.equal(result.ok, true);
  assert.equal(result.exercise, 'longDisconnectRecovery');
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].status, 'lease_expired');
  assert.equal(result.attempts[1].status, 'succeeded');
  assert.equal(result.staleResultRejection.type, 'stale_result_ignored');
  assert.equal(result.finalWorkerId, 'recovery-worker');
  assert.equal(result.deliverySemantics, 'at-least-once');
  assert.deepEqual(progress, ['disconnect_until_requeued', 'lease_recovered']);
});

test('VM restart recovery exercise proves instance replacement SQLite durability and one attempt', async () => {
  const firstRuntime = {
    instanceId: 'control-instance-a',
    startedAt: '2026-08-19T00:00:00.000Z',
  };
  const secondRuntime = {
    instanceId: 'control-instance-b',
    startedAt: '2026-08-19T00:01:00.000Z',
  };
  const attemptId = 'attempt-vm-restart';
  const artifactBytes = Buffer.from(JSON.stringify({
    attemptId,
    attemptSeq: 1,
    workerId: 'home-worker',
    executionCount: 1,
    completionCount: 1,
    startedAt: '2026-08-19T00:00:30.000Z',
    completedAt: '2026-08-19T00:01:30.000Z',
  }));
  const progress = [];
  let healthCalls = 0;
  let statusCalls = 0;
  let taskCalls = 0;
  const running = (events = []) => ({
    id: 'task-vm-restart',
    status: 'running',
    assignedWorkerId: 'home-worker',
    currentAttemptId: attemptId,
    attempts: [{ id: attemptId, seq: 1, workerId: 'home-worker', status: 'running' }],
    events,
  });
  const client = {
    async health() {
      healthCalls += 1;
      if (healthCalls === 1) {
        return { ok: true, runtime: firstRuntime };
      }
      if (healthCalls === 2) {
        throw new TypeError('fetch failed: connection refused');
      }
      return { ok: true, runtime: secondRuntime };
    },
    async status() {
      statusCalls += 1;
      return {
        runtime: statusCalls === 1 ? firstRuntime : secondRuntime,
        storage: { backend: 'sqlite', stateVersion: 12, sqliteSchemaVersion: 2 },
      };
    },
    async getWorker(workerId) {
      assert.equal(workerId, 'home-worker');
      return {
        worker: {
          id: workerId,
          active: true,
          adminState: 'enabled',
          gatewayState: 'running',
          lastSeenAt: '2026-08-19T00:01:01.000Z',
          ageMs: 20,
        },
      };
    },
    async createTask(input) {
      assert.equal(input.workerId, 'home-worker');
      assert.equal(input.maxAttempts, 1);
      assert.equal(input.requireRoutable, true);
      assert.deepEqual(input.artifactPolicy.include, ['vm-restart-recovery.json']);
      assert.match(input.command, /nado-vm-restart-ready/);
      return { task: { id: 'task-vm-restart' } };
    },
    async getTask(taskId) {
      assert.equal(taskId, 'task-vm-restart');
      taskCalls += 1;
      if (taskCalls === 1) {
        return { task: running() };
      }
      if (taskCalls === 2) {
        return {
          task: running([{
            at: '2026-08-19T00:00:30.000Z',
            type: 'stdout',
            message: 'nado-vm-restart-ready',
          }]),
        };
      }
      if (taskCalls === 3) {
        return { task: running() };
      }
      return {
        task: {
          id: taskId,
          status: 'succeeded',
          assignedWorkerId: 'home-worker',
          currentAttemptId: null,
          attempts: [{ id: attemptId, seq: 1, workerId: 'home-worker', status: 'succeeded' }],
          artifacts: [{
            id: 'artifact-vm-restart',
            path: 'vm-restart-recovery.json',
          }],
        },
      };
    },
    async downloadArtifact(taskId, artifactId) {
      assert.equal(taskId, 'task-vm-restart');
      assert.equal(artifactId, 'artifact-vm-restart');
      return { bytes: artifactBytes };
    },
  };

  const result = await runVmRestartRecoveryExercise(client, {
    workerId: 'home-worker',
    timeoutMs: 30_000,
    taskDurationMs: 500,
    onProgress: (entry) => progress.push(entry.phase),
  });
  assert.equal(result.ok, true);
  assert.equal(result.exercise, 'vmRestartRecovery');
  assert.equal(result.controlRestart.original.instanceId, firstRuntime.instanceId);
  assert.equal(result.controlRestart.restarted.instanceId, secondRuntime.instanceId);
  assert.equal(result.controlRestart.outageObserved, true);
  assert.equal(result.controlRestart.unavailableObservations.length, 1);
  assert.equal(result.storage.backend, 'sqlite');
  assert.equal(result.attemptId, attemptId);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.artifact.executionCount, 1);
  assert.equal(result.artifact.completionCount, 1);
  assert.deepEqual(progress, [
    'restart_control_now',
    'control_unreachable',
    'control_restarted',
    'worker_reconnected',
  ]);
});

test('Worker service restart exercise proves offline state, runtime replacement, token continuity, and a post-restart probe', async () => {
  const workerId = 'home-worker-restart';
  const tokenId = 'wtok_worker_restart';
  const originalRuntime = {
    id: 'wrun_before_restart',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    pid: 100,
  };
  let restartedAt = null;
  let runtimeEventAt = null;
  let getWorkerCalls = 0;
  let probeBytes = null;
  const artifactPayload = () => (probeBytes ||= Buffer.from(JSON.stringify({
    workerId,
    runtimeId: 'wrun_after_restart',
    runtimeStartedAt: restartedAt,
    attemptId: 'attempt-worker-restart',
    attemptSeq: 1,
    executedAt: new Date().toISOString(),
  })));
  const initialRuntimeEvent = {
    at: originalRuntime.startedAt,
    type: 'runtime_started',
    data: {
      controlObserved: true,
      runtimeId: originalRuntime.id,
      previousRuntimeId: null,
      workerTokenId: tokenId,
    },
  };
  const client = {
    async getWorker(id) {
      assert.equal(id, workerId);
      getWorkerCalls += 1;
      if (getWorkerCalls === 1) {
        return { worker: {
          id: workerId, active: true, adminState: 'enabled', gatewayState: 'idle',
          identity: { type: 'worker_token', signed: true, workerTokenId: tokenId },
          runtime: originalRuntime,
          lastSeenAt: new Date().toISOString(),
          ageMs: 0,
        } };
      }
      if (getWorkerCalls === 2) {
        return { worker: {
          id: workerId, active: false, adminState: 'enabled', gatewayState: 'offline',
          identity: { type: 'worker_token', signed: true, workerTokenId: tokenId },
          runtime: originalRuntime,
          lastSeenAt: new Date(Date.now() - 50_000).toISOString(),
          ageMs: 50_000,
        } };
      }
      return { worker: {
        id: workerId, active: true, adminState: 'enabled', gatewayState: 'idle',
        identity: { type: 'worker_token', signed: true, workerTokenId: tokenId },
        runtime: { id: 'wrun_after_restart', startedAt: restartedAt, pid: 200 },
        lastSeenAt: runtimeEventAt,
        ageMs: 0,
      } };
    },
    async listWorkerEvents(id) {
      assert.equal(id, workerId);
      return { events: runtimeEventAt ? [initialRuntimeEvent, {
        at: runtimeEventAt,
        type: 'runtime_started',
        data: {
          controlObserved: true,
          runtimeId: 'wrun_after_restart',
          runtimeStartedAt: restartedAt,
          previousRuntimeId: originalRuntime.id,
          previousLastSeenAt: new Date(Date.now() - 50_000).toISOString(),
          workerTokenId: tokenId,
        },
      }] : [initialRuntimeEvent] };
    },
    async createTask(input) {
      assert.equal(input.workerId, workerId);
      assert.equal(input.maxAttempts, 1);
      assert.deepEqual(input.artifactPolicy.include, ['worker-restart-recovery.json']);
      return { task: { id: 'task-worker-restart' } };
    },
    async getTask(id) {
      assert.equal(id, 'task-worker-restart');
      const bytes = artifactPayload();
      return { task: {
        id,
        status: 'succeeded',
        assignedWorkerId: workerId,
        attempts: [{ id: 'attempt-worker-restart', seq: 1, workerId, status: 'succeeded' }],
        artifacts: [{
          id: 'artifact-worker-restart',
          path: 'worker-restart-recovery.json',
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        }],
      } };
    },
    async downloadArtifact(taskId, artifactId) {
      assert.equal(taskId, 'task-worker-restart');
      assert.equal(artifactId, 'artifact-worker-restart');
      return { bytes: artifactPayload() };
    },
  };

  const phases = [];
  const result = await runWorkerRestartRecoveryExercise(client, {
    workerId,
    timeoutMs: 90_000,
    onProgress(progress) {
      phases.push(progress.phase);
      if (progress.phase === 'start_worker_now') {
        restartedAt = new Date().toISOString();
        runtimeEventAt = restartedAt;
      }
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(phases, ['stop_worker_now', 'start_worker_now']);
  assert.equal(result.runtimeRestart.original.id, originalRuntime.id);
  assert.equal(result.runtimeRestart.restarted.id, 'wrun_after_restart');
  assert.equal(result.tokenContinuity.workerTokenId, tokenId);
  assert.equal(result.tokenContinuity.unchanged, true);
  assert.equal(result.taskId, 'task-worker-restart');
  assert.equal(result.artifact.runtimeId, 'wrun_after_restart');
});

test('large artifact resume exercise proves a committed-offset stall and same-upload recovery', async () => {
  const attemptId = 'attempt-large-artifact';
  const uploadId = 'upload-large-artifact';
  const artifactBytes = 256 * 1024;
  const progress = [];
  let patternByte = null;
  let sourceBytes = null;
  let sourceSha256 = null;
  let disconnected = false;
  let reconnected = false;
  let taskCallsAfterReconnect = 0;
  const running = () => ({
    id: 'task-large-artifact',
    status: 'running',
    assignedWorkerId: 'home-worker',
    currentAttemptId: attemptId,
    attempts: [{ id: attemptId, seq: 1, workerId: 'home-worker', status: 'running' }],
    events: [{
      at: '2026-08-19T00:00:00.000Z',
      type: 'stdout',
      message: 'nado-large-artifact-ready',
    }],
  });
  const client = {
    async capabilities() {
      return { features: { resumableArtifactUploads: true } };
    },
    async getWorker(workerId) {
      assert.equal(workerId, 'home-worker');
      return {
        worker: {
          id: workerId,
          active: !disconnected || reconnected,
          adminState: 'enabled',
          gatewayState: disconnected && !reconnected ? 'offline' : 'running',
          ageMs: disconnected && !reconnected ? 3_000 : 10,
          lastSeenAt: reconnected ? '2099-01-01T00:00:00.000Z' : '2026-08-19T00:00:00.000Z',
        },
      };
    },
    async createTask(input) {
      assert.equal(input.workerId, 'home-worker');
      assert.equal(input.maxAttempts, 1);
      const matched = input.command.match(/Buffer\.alloc\(Math\.min\(1048576,total\),(\d+)\)/);
      assert.ok(matched);
      patternByte = Number(matched[1]);
      sourceBytes = Buffer.alloc(artifactBytes, patternByte);
      sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
      return { task: { id: 'task-large-artifact' } };
    },
    async getTask(taskId) {
      assert.equal(taskId, 'task-large-artifact');
      if (!reconnected) {
        return { task: running() };
      }
      taskCallsAfterReconnect += 1;
      if (taskCallsAfterReconnect === 1) {
        return { task: running() };
      }
      return {
        task: {
          id: taskId,
          status: 'succeeded',
          assignedWorkerId: 'home-worker',
          currentAttemptId: null,
          attempts: [{ id: attemptId, seq: 1, workerId: 'home-worker', status: 'succeeded' }],
          artifacts: [{
            id: 'artifact-large-resume',
            uploadId,
            path: 'large-artifact-resume.bin',
            size: artifactBytes,
            sha256: sourceSha256,
          }],
        },
      };
    },
    async listArtifactUploads(taskId) {
      assert.equal(taskId, 'task-large-artifact');
      return {
        uploads: [{
          id: uploadId,
          taskId,
          workerId: 'home-worker',
          attemptId,
          path: 'large-artifact-resume.bin',
          size: artifactBytes,
          sha256: sourceSha256,
          status: reconnected ? 'finalized' : 'pending',
          committedBytes: reconnected ? artifactBytes : 64 * 1024,
        }],
      };
    },
    async downloadArtifact(taskId, artifactId) {
      assert.equal(taskId, 'task-large-artifact');
      assert.equal(artifactId, 'artifact-large-resume');
      return { bytes: sourceBytes };
    },
  };

  const result = await runLargeArtifactResumeExercise(client, {
    workerId: 'home-worker',
    artifactBytes,
    minStallMs: 2_000,
    timeoutMs: 30_000,
    onProgress: (entry) => {
      progress.push(entry.phase);
      if (entry.phase === 'disconnect_worker_network') {
        disconnected = true;
      } else if (entry.phase === 'artifact_stall_observed') {
        reconnected = true;
      }
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.exercise, 'largeArtifactResume');
  assert.equal(result.attemptCount, 1);
  assert.equal(result.upload.id, uploadId);
  assert.equal(result.upload.firstObservedOffset, 64 * 1024);
  assert.equal(result.upload.stalledOffset, 64 * 1024);
  assert.equal(result.upload.finalizedOffset, artifactBytes);
  assert.equal(result.upload.sha256, sourceSha256);
  assert.equal(result.artifact.sha256, sourceSha256);
  assert.deepEqual(progress, [
    'disconnect_worker_network',
    'artifact_stall_observed',
    'artifact_upload_resumed',
  ]);
});

test('large input resume exercise proves a positive post-disconnect Range and Worker hash', async () => {
  const attemptId = 'attempt-large-input';
  const inputId = 'input-large-resume';
  const inputBytes = 256 * 1024;
  const progress = [];
  let expectedSha256 = null;
  let disconnected = false;
  let reconnected = false;
  let committedBytes = 0;
  let taskCallsAfterReconnect = 0;
  const rangeEvent = (offset, at) => ({
    at,
    type: 'input_download_range',
    workerId: 'home-worker',
    data: {
      inputId,
      path: 'large-input-resume.bin',
      attemptId,
      offset,
      size: inputBytes,
      resumed: offset > 0,
    },
  });
  const running = (events) => ({
    id: 'task-large-input',
    status: 'running',
    assignedWorkerId: 'home-worker',
    currentAttemptId: attemptId,
    lease: { durationMs: 60_000 },
    attempts: [{ id: attemptId, seq: 1, workerId: 'home-worker', status: 'running' }],
    events,
  });
  const client = {
    async capabilities() {
      return {
        features: {
          resumableTaskInputUploads: true,
          rangedTaskInputDownloads: true,
          inputDownloadRangeEvents: true,
        },
      };
    },
    async getWorker(workerId) {
      assert.equal(workerId, 'home-worker');
      return {
        worker: {
          id: workerId,
          active: !disconnected || reconnected,
          adminState: 'enabled',
          gatewayState: disconnected && !reconnected ? 'offline' : 'running',
          ageMs: disconnected && !reconnected ? 3_000 : 10,
          lastSeenAt: reconnected ? '2099-01-01T00:00:00.000Z' : '2026-08-19T00:00:00.000Z',
        },
      };
    },
    async createTask(input) {
      assert.equal(input.workerId, 'home-worker');
      assert.equal(input.maxAttempts, 1);
      assert.equal(input.inputFiles[0].transfer, 'chunked');
      return {
        task: {
          id: 'task-large-input',
          status: 'uploading_inputs',
          inputFiles: [{ ...input.inputFiles[0], inputUploadId: inputId }],
        },
      };
    },
    async uploadTaskInputChunk(taskId, actualInputId, offset, bytes) {
      assert.equal(taskId, 'task-large-input');
      assert.equal(actualInputId, inputId);
      assert.equal(offset, committedBytes);
      committedBytes += bytes.length;
      if (!expectedSha256) {
        expectedSha256 = crypto.createHash('sha256').update(Buffer.alloc(inputBytes, bytes[0])).digest('hex');
      }
      return { upload: { id: inputId, committedBytes } };
    },
    async finalizeTaskInputUpload(taskId, actualInputId) {
      assert.equal(taskId, 'task-large-input');
      assert.equal(actualInputId, inputId);
      return {
        upload: {
          id: inputId,
          status: 'finalized',
          committedBytes: inputBytes,
          sha256: expectedSha256,
        },
        task: { id: taskId, status: 'queued' },
      };
    },
    async getTask(taskId) {
      assert.equal(taskId, 'task-large-input');
      if (!reconnected) {
        return {
          task: running([rangeEvent(0, '2026-08-19T00:00:01.000Z')]),
        };
      }
      taskCallsAfterReconnect += 1;
      if (taskCallsAfterReconnect === 1) {
        return {
          task: running([
            rangeEvent(0, '2026-08-19T00:00:01.000Z'),
            rangeEvent(64 * 1024, '2099-01-01T00:00:00.000Z'),
          ]),
        };
      }
      const resultBytes = Buffer.from(JSON.stringify({
        sha256: expectedSha256,
        size: inputBytes,
        attemptId,
        attemptSeq: 1,
        workerId: 'home-worker',
      }));
      return {
        task: {
          id: taskId,
          status: 'succeeded',
          assignedWorkerId: 'home-worker',
          currentAttemptId: null,
          attempts: [{ id: attemptId, seq: 1, workerId: 'home-worker', status: 'succeeded' }],
          artifacts: [{
            id: 'artifact-large-input-result',
            path: 'large-input-resume.json',
            sha256: crypto.createHash('sha256').update(resultBytes).digest('hex'),
          }],
        },
      };
    },
    async downloadArtifact(taskId, artifactId) {
      assert.equal(taskId, 'task-large-input');
      assert.equal(artifactId, 'artifact-large-input-result');
      return {
        bytes: Buffer.from(JSON.stringify({
          sha256: expectedSha256,
          size: inputBytes,
          attemptId,
          attemptSeq: 1,
          workerId: 'home-worker',
        })),
      };
    },
  };

  const result = await runLargeInputResumeExercise(client, {
    workerId: 'home-worker',
    inputBytes,
    minStallMs: 2_000,
    timeoutMs: 30_000,
    onProgress: (entry) => {
      progress.push(entry.phase);
      if (entry.phase === 'disconnect_worker_network') {
        disconnected = true;
      } else if (entry.phase === 'input_download_stall_observed') {
        reconnected = true;
      }
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.exercise, 'largeInputResume');
  assert.equal(result.attemptCount, 1);
  assert.equal(result.input.id, inputId);
  assert.equal(result.input.initialOffset, 0);
  assert.equal(result.input.resumedOffset, 64 * 1024);
  assert.equal(result.input.sha256, expectedSha256);
  assert.deepEqual(progress, [
    'staging_input',
    'disconnect_worker_network',
    'input_download_stall_observed',
    'input_download_resumed',
  ]);
});

test('acceptance evidence records validated scenarios without losing the template', async () => {
  const template = acceptanceEvidenceTemplate();
  const recorded = recordAcceptanceEvidence(template, {
    scenario: 'shortDisconnect',
    status: 'passed',
    note: 'WAN link recovered on the same attempt',
    references: ['task:one', 'task:one', 'event:two'],
    observedAt: '2026-08-19T00:00:00.000Z',
  });
  assert.equal(recorded.scenarios.shortDisconnect.status, 'passed');
  assert.deepEqual(recorded.scenarios.shortDisconnect.references, ['task:one', 'event:two']);
  assert.equal(recorded.scenarios.longDisconnectRecovery.status, 'pending');
  const automated = recordAcceptanceEvidence(recorded, {
    scenario: 'remoteCancellation',
    status: 'passed',
    note: 'Target Worker acknowledged cancellation and released the process',
    source: 'automated_exercise',
    references: ['task:cancel-probe'],
    details: { exercise: 'remoteCancellation', ok: true, taskId: 'cancel-probe' },
  });
  assert.equal(automated.scenarios.remoteCancellation.source, 'automated_exercise');
  assert.equal(automated.scenarios.remoteCancellation.details.taskId, 'cancel-probe');
  const supervised = recordAcceptanceEvidence(automated, {
    scenario: 'shortDisconnect',
    status: 'passed',
    note: 'Operator disconnected the home link while the control side supervised the attempt',
    source: 'supervised_exercise',
    references: ['task:disconnect-probe'],
    details: { exercise: 'shortDisconnect', ok: true, taskId: 'disconnect-probe' },
  });
  assert.equal(supervised.scenarios.shortDisconnect.source, 'supervised_exercise');
  assert.equal(supervised.scenarios.shortDisconnect.details.exercise, 'shortDisconnect');
  assert.throws(
    () => recordAcceptanceEvidence(template, { scenario: 'shortDisconnect', status: 'passed' }),
    /requires a non-empty evidence note/,
  );
  assert.throws(
    () => recordAcceptanceEvidence(template, { scenario: 'typo', status: 'pending' }),
    /Unknown acceptance evidence scenario/,
  );

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-evidence-record-'));
  const file = path.join(root, 'evidence.json');
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'acceptance',
      'evidence',
      'record',
      '--file',
      file,
      '--scenario',
      'shortDisconnect',
      '--status',
      'passed',
      '--note',
      'Recovered before lease expiry',
      '--reference',
      'task:wan-test',
    ], { timeout: 8_000 });
    assert.match(stdout, /scenario=shortDisconnect/);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.scenarios.shortDisconnect.status, 'passed');
    assert.equal(saved.scenarios.shortDisconnect.evidence, 'Recovered before lease expiry');
    assert.equal(saved.scenarios.physicalSeparation.status, 'pending');
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('acceptance CLI runs target-worker verify and keeps unexercised WAN recovery pending', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-cross-site-acceptance-'));
  const token = 'acceptance-admin-token';
  const proxySecret = 'acceptance-test-proxy-secret';
  const running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
    storeBackend: 'sqlite',
    publicControlUrl: 'https://nado.example.com',
    autoRecoverOfflineMs: 120_000,
    trustProxy: true,
    trustProxySecret: proxySecret,
  });
  const controlUrl = `http://127.0.0.1:${running.port}`;
  const client = new NadoClient({ controlUrl, token });
  const evidenceFile = path.join(root, 'acceptance-evidence.json');
  const reportFile = path.join(root, 'acceptance-report.json');
  let worker;

  try {
    const stampedTask = await client.createTask({
      title: 'control instance stamp cannot be supplied by client',
      command: 'node -e "process.exit(0)"',
      controlInstanceId: 'forged-client-instance',
      maxAttempts: 1,
    });
    assert.equal(stampedTask.task.createdControlInstanceId, running.controlRuntime.instanceId);
    await client.manageTask(stampedTask.task.id, 'cancel', { reason: 'acceptance stamp test cleanup' });

    const initialEvidence = completeEvidence();
    initialEvidence.scenarios.longDisconnectRecovery = {
      ...initialEvidence.scenarios.longDisconnectRecovery,
      status: 'pending',
      evidence: '',
      references: [],
      observedAt: null,
    };
    initialEvidence.scenarios.vmRestartRecovery = {
      ...initialEvidence.scenarios.vmRestartRecovery,
      status: 'pending',
      evidence: '',
      references: [],
      observedAt: null,
    };
    for (const scenario of ['shortDisconnect', 'workerRestartRecovery', 'largeArtifactResume', 'largeInputResume', 'backupRestore']) {
      initialEvidence.scenarios[scenario] = {
        ...initialEvidence.scenarios[scenario],
        status: 'pending',
        evidence: '',
        references: [],
        observedAt: null,
      };
    }
    await fs.writeFile(evidenceFile, JSON.stringify(initialEvidence), 'utf8');
    const enrollment = await client.createWorkerEnrollmentToken({
      label: 'cross-site acceptance test',
      maxUses: 1,
    });
    const workerDataDir = path.join(root, 'home-worker');
    const identity = await ensureEnrolledWorker({
      id: 'home-test-worker',
      controlUrl,
      enrollmentToken: enrollment.token,
      dataDir: workerDataDir,
    });
    const workerClient = new NadoClient({
      controlUrl,
      token: identity.workerToken,
      workerId: identity.workerId,
      privateKeyPem: identity.privateKeyPem,
      defaultHeaders: {
        'x-forwarded-for': '198.51.100.23',
        'x-forwarded-proto': 'https',
        'x-nado-proxy-secret': proxySecret,
      },
    });
    worker = await startWorker({
      id: 'home-test-worker',
      controlUrl,
      token: identity.workerToken,
      privateKeyPem: identity.privateKeyPem,
      client: workerClient,
      dataDir: workerDataDir,
      capabilities: ['code'],
      pollMs: 50,
      longPollMs: 0,
      networkProbeIntervalMs: 60_000,
      credentialRotationIntervalMs: 0,
      rotateCredentials: ({ client: runtimeClient, verifyPreviousToken }) => rotateEnrolledWorkerToken({
        dataDir: workerDataDir,
        controlUrl,
        client: runtimeClient,
        verifyPreviousToken,
      }),
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < 10_000) {
      const { worker: current } = await client.getWorker('home-test-worker');
      if (current.active
        && current.resources?.disk?.available
        && current.resources?.network?.lastSuccessAt
        && current.resources?.network?.bandwidth?.available) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const failedAgentEvidenceFile = path.join(root, 'failed-agent-evidence.json');
    await assert.rejects(
      () => execFileAsync(process.execPath, [
        cliPath,
        'acceptance',
        'exercise',
        'agent-collaboration',
        '--control', controlUrl,
        '--worker', 'home-test-worker',
        '--evidence', failedAgentEvidenceFile,
        '--timeout', '30000',
        '--json',
      ], {
        env: { ...process.env, NADO_TOKEN: token },
        timeout: 30_000,
      }),
      (error) => error.code === 2 && /verified real terminal Agent/.test(error.stdout),
    );
    const failedAgentEvidence = JSON.parse(await fs.readFile(failedAgentEvidenceFile, 'utf8'));
    assert.equal(failedAgentEvidence.scenarios.agentCollaboration.status, 'failed');
    assert.equal(failedAgentEvidence.scenarios.agentCollaboration.source, 'automated_exercise');
    assert.equal(failedAgentEvidence.scenarios.agentCollaboration.details.exercise, 'agentCollaboration');

    const exerciseRun = await execFileAsync(process.execPath, [
      cliPath,
      'acceptance',
      'exercise',
      'remote-cancellation',
      '--control', controlUrl,
      '--worker', 'home-test-worker',
      '--evidence', evidenceFile,
      '--timeout', '10000',
      '--json',
    ], {
      env: { ...process.env, NADO_TOKEN: token },
      timeout: 30_000,
    });
    const exercise = JSON.parse(exerciseRun.stdout);
    assert.equal(exercise.ok, true);
    assert.equal(exercise.exercise, 'remoteCancellation');
    assert.equal(exercise.workerId, 'home-test-worker');
    assert.equal(exercise.taskStatus, 'cancelled');
    assert.equal(exercise.commandEvent.action, 'cancel_current');
    assert.equal(exercise.processReleasedEvent.type, 'task_released');
    const exerciseEvidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8'));
    assert.equal(exerciseEvidence.scenarios.remoteCancellation.status, 'passed');
    assert.equal(exerciseEvidence.scenarios.remoteCancellation.source, 'automated_exercise');
    assert.equal(exerciseEvidence.scenarios.remoteCancellation.details.taskId, exercise.taskId);

    const rotationRun = await execFileAsync(process.execPath, [
      cliPath,
      'worker',
      'manage',
      '--control', controlUrl,
      '--id', 'home-test-worker',
      '--action', 'rotate_token',
      '--wait',
      '--evidence', evidenceFile,
      '--timeout', '10000',
    ], {
      env: { ...process.env, NADO_TOKEN: token },
      timeout: 30_000,
    });
    assert.match(rotationRun.stdout, /previousTokenRejected=true/);
    const rotatedIdentity = await readWorkerIdentity(workerDataDir);
    const rotationEvidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8')).scenarios.credentialRevocation;
    assert.equal(rotationEvidence.source, 'automated_exercise');
    assert.equal(rotationEvidence.details.mode, 'control_triggered_rotation');
    assert.equal(rotationEvidence.details.replacementTokenId, rotatedIdentity.workerTokenId);

    const result = await execFileAsync(process.execPath, [
      cliPath,
      'acceptance',
      '--control', controlUrl,
      '--worker', 'home-test-worker',
      '--no-require-agent',
      '--run-verify',
      '--evidence', evidenceFile,
      '--out', reportFile,
      '--json',
      '--timeout', '30000',
    ], {
      env: { ...process.env, NADO_TOKEN: token },
      timeout: 60_000,
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.overall, 'pending');
    assert.equal(report.control.storage.backend, 'sqlite');
    assert.equal(report.worker.id, 'home-test-worker');
    assert.equal(report.worker.identity.signed, true);
    assert.equal(report.worker.identity.workerTokenId, rotatedIdentity.workerTokenId);
    assert.equal(report.worker.connection.remoteAddress, '198.51.100.23');
    assert.equal(report.worker.connection.trustedProxy, true);
    assert.equal(report.worker.connection.proxyAuthenticated, true);
    assert.equal(
      report.manualChecks.find((item) => item.key === 'remoteCancellation').evidence.source,
      'automated_exercise',
    );
    assert.equal(
      report.automatedChecks.find((item) => item.key === 'credentialRevocationReceipt').status,
      'passed',
    );
    const cancellationReceipt = report.automatedChecks.find((item) => item.key === 'remoteCancellationReceipt');
    assert.equal(cancellationReceipt.status, 'passed');
    assert.equal(cancellationReceipt.evidence.durableCommandApplied, true);
    assert.equal(cancellationReceipt.evidence.durableProcessReleased, true);
    const longDisconnectReceipt = report.automatedChecks.find(
      (item) => item.key === 'longDisconnectRecoveryReceipt',
    );
    assert.equal(longDisconnectReceipt.status, 'pending');
    const vmRestartReceipt = report.automatedChecks.find((item) => item.key === 'vmRestartRecoveryReceipt');
    assert.equal(vmRestartReceipt.status, 'pending');
    assert.equal(report.automatedChecks.find((item) => item.key === 'largeArtifactResumeReceipt').status, 'pending');
    assert.equal(report.automatedChecks.find((item) => item.key === 'largeInputResumeReceipt').status, 'pending');
    assert.equal(report.automatedChecks.find((item) => item.key === 'backupRestoreReceipt').status, 'pending');
    assert.equal(report.automatedChecks.find((item) => item.key === 'shortDisconnectReceipt').status, 'pending');
    assert.equal(report.verify.ok, true);
    assert.ok(report.verify.summary.taskId);
    assert.ok(report.verify.summary.batchId);
    assert.equal(JSON.parse(await fs.readFile(reportFile, 'utf8')).overall, 'pending');

    let strictWithoutDeploymentError;
    await assert.rejects(
      () => execFileAsync(process.execPath, [
        cliPath,
        'acceptance',
        '--control', controlUrl,
        '--worker', 'home-test-worker',
        '--no-require-agent',
        '--evidence', evidenceFile,
        '--require-complete',
        '--json',
      ], {
        env: { ...process.env, NADO_TOKEN: token },
        timeout: 30_000,
      }),
      (error) => {
        strictWithoutDeploymentError = error;
        return error.code === 2;
      },
    );
    const strictWithoutDeployment = JSON.parse(strictWithoutDeploymentError.stdout);
    assert.equal(strictWithoutDeployment.requirements.requireDeploymentEvidence, true);
    assert.equal(
      strictWithoutDeployment.automatedChecks
        .find((item) => item.key === 'deploymentBoundaryReceipt').status,
      'failed',
    );

    const templateFile = path.join(root, 'fresh-evidence.json');
    const template = await execFileAsync(process.execPath, [
      cliPath, 'acceptance', 'template', '--out', templateFile,
    ]);
    assert.match(template.stdout, /acceptanceEvidence=/);
    assert.equal(JSON.parse(await fs.readFile(templateFile, 'utf8')).version, 1);
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => running.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
