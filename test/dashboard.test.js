import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-dashboard-'));
}

test('control server serves a durable authenticated dashboard shell', async () => {
  const root = await makeTempDir();
  const token = 'dashboard-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;

  try {
    const response = await fetch(`${controlUrl}/dashboard`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const contentSecurityPolicy = response.headers.get('content-security-policy');
    assert.match(contentSecurityPolicy, /script-src 'nonce-[^']+'/);
    assert.match(contentSecurityPolicy, /style-src 'nonce-[^']+'/);
    assert.match(contentSecurityPolicy, /object-src 'none'/);
    assert.match(contentSecurityPolicy, /frame-ancestors 'none'/);
    const html = await response.text();
    assert.match(html, /Nado Control/);
    assert.match(html, /aria-label="NADO_TOKEN"/);
    assert.doesNotMatch(html, /dashboard-token/);
    assert.match(html, /id="locale"/);
    assert.match(html, /zh-CN/);
    assert.match(html, /工作端接入/);
    assert.match(html, /readinessStrip/);
    assert.match(html, /renderControlReadiness/);
    assert.match(html, /crossSiteTopology/);
    assert.match(html, /renderCrossSiteTopology/);
    assert.match(html, /Cross-Site Topology/);
    assert.match(html, /VM Control Plane/);
    assert.match(html, /runtime\.instanceId/);
    assert.match(html, /storage\.sqliteSchemaVersion/);
    assert.match(html, /storage\.restoreReceipt/);
    assert.match(html, /storage\.dataLease/);
    assert.match(html, /write fenced/);
    assert.match(html, /receipt\.manifestSha256/);
    assert.match(html, /connection\.remoteAddress/);
    assert.match(html, /identity\.signed/);
    assert.match(html, /identity\.type === 'admin'/);
    assert.match(html, /Workers initiate outbound poll and heartbeat requests/);
    assert.match(html, /Remote Workers/);
    assert.match(html, /Verified terminal agent ready/);
    assert.match(html, /IPv6 literals must use brackets/);
    assert.match(html, /GPU worker advertised only/);
    assert.match(html, /amdSmi/);
    assert.match(html, /Task text can infer gpu, docs, ppt/);
    assert.match(html, /view-tabs/);
    assert.match(html, /data-view-tab="workbench"/);
    assert.match(html, /data-view-tab="onboarding"/);
    assert.match(html, /workbenchMode/);
    assert.match(html, /data-active-view/);
    assert.match(html, /rerenderViewTables/);
    assert.match(html, /main\[data-active-view="workbench"\] \.section-tools/);
    assert.match(html, /applyView/);
    assert.match(html, /nadoDashboardView/);
    assert.match(html, /DASHBOARD_UI_VERSION/);
    assert.match(html, /cross-site-ops-v3/);
    assert.match(html, /DASHBOARD_VIEWS/);
    assert.match(html, /nadoDashboardUiVersion/);
    assert.match(html, /initialDashboardView/);
    assert.match(html, /nadoLocale/);
    assert.match(html, /applyLocale/);
    assert.match(html, /statusHoldUntil/);
    assert.match(html, /refreshStatusText/);
    assert.match(html, /Date\.now\(\) < state\.statusHoldUntil/);
    assert.match(html, /Worker Onboarding/);
    assert.match(html, /openWorkerOnboarding/);
    assert.match(html, /Add Worker/);
    assert.match(html, /Fixed Worker ID/);
    assert.match(html, /Issue Fixed-ID Invite/);
    assert.match(html, /Control Console/);
    assert.match(html, /consoleAgentNotice/);
    assert.match(html, /Demo echo agent is active/);
    assert.match(html, /consoleForm/);
    assert.match(html, /runConsoleDistributed/);
    assert.match(html, /Run Distributed/);
    assert.match(html, /\/api\/planner\/run/);
    assert.match(html, /consoleDistributedRequestFromForm/);
    assert.match(html, /console-routing-options/);
    assert.match(html, /console-routing-grid/);
    assert.match(html, /Routing Options/);
    assert.match(html, /consoleRoutingOptions/);
    assert.match(html, /console-examples/);
    assert.match(html, /data-console-example="gpu"/);
    assert.match(html, /applyConsoleExample/);
    assert.match(html, /consoleRoutingSummary/);
    assert.match(html, /updateConsoleRoutingSummary/);
    assert.match(html, /routingOptions\.open = true/);
    assert.match(html, /consoleWorkerId/);
    assert.match(html, /runConsoleTask/);
    assert.match(html, /submitConsoleForm/);
    assert.match(html, /consolePrompt'\)\.addEventListener\('keydown'/);
    assert.match(html, /requestSubmit/);
    assert.match(html, /consoleOutput/);
    assert.match(html, /consoleResultPanel/);
    assert.match(html, /renderConsoleResultPanel/);
    assert.match(html, /clearConsoleResultState/);
    assert.match(html, /bindConsoleResultButtons/);
    assert.match(html, /downloadConsoleArtifacts/);
    assert.match(html, /Download Result ZIP/);
    assert.match(html, /stopConsoleTask/);
    assert.match(html, /Stop Task/);
    assert.match(html, /Console stop requested/);
    assert.match(html, /Cancelled from Control Console/);
    assert.match(html, /previewConsoleDispatch/);
    assert.match(html, /Preview Route/);
    assert.match(html, /checkConsoleRoutes/);
    assert.match(html, /Check Routes/);
    assert.match(html, /renderConsoleRouteCheck/);
    assert.match(html, /runConsoleRouteCheck/);
    assert.match(html, /Console route check ok/);
    assert.match(html, /consoleTaskSpecFromForm/);
    assert.match(html, /renderConsoleDispatchPlan/);
    assert.match(html, /consolePlanBlocker/);
    assert.match(html, /路由预览/);
    assert.match(html, /推断说明/);
    assert.match(html, /候选工作端/);
    assert.match(html, /Previewed console route/);
    assert.match(html, /Console route blocked/);
    assert.match(html, /if \(!task\.prompt\)/);
    assert.match(html, /newConsoleSession/);
    assert.match(html, /clearConsoleSession/);
    assert.match(html, /New Session/);
    assert.match(html, /Clear Session/);
    assert.match(html, /createConsoleSession/);
    assert.match(html, /clearConsoleSession/);
    assert.match(html, /emptyConsoleSession/);
    assert.match(html, /Console empty session /);
    assert.match(html, /\/api\/sessions\/prune-empty/);
    assert.match(html, /Console empty session .* removed/);
    assert.match(html, /Console session /);
    assert.match(html, / ready/);
    assert.match(html, /consoleArtifactTaskId/);
    assert.match(html, /consoleArtifactPreview/);
    assert.match(html, /base64ToText/);
    assert.match(html, /previewableArtifact/);
    assert.match(html, /loadConsoleArtifactPreview/);
    assert.match(html, /renderArtifactPreviewText/);
    assert.match(html, /Artifact Preview/);
    assert.match(html, /\/artifacts\/content/);
    assert.match(html, /artifact preview:/);
    assert.match(html, /route=/);
    assert.match(html, /capabilities inferred=/);
    assert.match(html, /No console task artifacts available/);
    assert.match(html, /Worker Tokens/);
    assert.match(html, /nado worker token rotate/);
    assert.match(html, /rotation pending/);
    assert.match(html, /Rotation Deadline/);
    assert.match(html, /Doctor/);
    assert.match(html, /Readiness Verify/);
    assert.match(html, /Cross-Site Acceptance/);
    assert.match(html, /acceptanceWorker/);
    assert.match(html, /acceptanceRequireGpu/);
    assert.match(html, /acceptanceDeploymentMode/);
    assert.match(html, /acceptanceOverlayInterface/);
    assert.match(html, /acceptanceDeploymentEvidence/);
    assert.match(html, /acceptanceManualEvidence/);
    assert.match(html, /acceptanceRunbookProgress/);
    assert.match(html, /renderAcceptanceRunbookProgress/);
    assert.match(html, /loadAcceptanceJsonFile/);
    assert.match(html, /requireDeploymentEvidence: true/);
    assert.match(html, /deploymentEvidence: state\.acceptanceDeploymentEvidence/);
    assert.match(html, /manualEvidence: state\.acceptanceManualEvidence/);
    assert.match(html, /downloadAcceptanceEvidence/);
    assert.match(html, /已下载跨站点验收证据模板/);
    assert.match(html, /renderAcceptanceCommand/);
    assert.match(html, /acceptanceCommand'\)\.textContent/);
    assert.match(html, /\/api\/acceptance\/template/);
    assert.match(html, /\/api\/acceptance\/runbook/);
    assert.match(html, /loadAcceptanceRunbook/);
    assert.match(html, /copyAcceptanceCommand/);
    assert.match(html, /Copy Shared Runbook/);
    assert.match(html, /runAcceptanceGate/);
    assert.match(html, /acceptanceReportResult/);
    assert.match(html, /downloadAcceptanceReport/);
    assert.match(html, /\/api\/acceptance\/report/);
    assert.match(html, /Automatic Checks/);
    assert.match(html, /Manual Evidence/);
    assert.match(html, /Agent Context/);
    assert.match(html, /Gateway Manifest/);
    assert.match(html, /MCP Config/);
    assert.match(html, /Offline Recovery/);
    assert.match(html, /Submit Task/);
    assert.match(html, /Failure Retry Policy/);
    assert.match(html, /retryFailureKinds/);
    assert.match(html, /retryExitCodes/);
    assert.match(html, /retryPolicy:/);
    assert.match(html, /task\.failureKind/);
    assert.match(html, /task\.notBeforeAt/);
    assert.match(html, /uploadDashboardInput/);
    assert.match(html, /input-uploads/);
    assert.match(html, /digestMode: 'server'/);
    assert.match(html, /Uploading .*: /);
    assert.match(html, /Distributed Planner/);
    assert.match(html, /plannerForm/);
    assert.match(html, /part_a@docker-report-a/);
    assert.match(html, /workerSeparator = keyPart\.indexOf\('@'\)/);
    assert.match(html, /Plan Distributed Task/);
    assert.match(html, /Run Distributed Plan/);
    assert.match(html, /has\('#plannerForm'\).*return \['batches'\]/);
    assert.match(html, /Plan Batch/);
    assert.match(html, /Submit Batch JSON/);
    assert.match(html, /Create Session/);
    assert.match(html, /Worker Detail/);
    assert.match(html, /Task Detail/);
    assert.match(html, /Needs Attention/);
    assert.match(html, /No routing issues/);
    assert.match(html, /attentionTasks/);
    assert.match(html, /cancelRoutingIssues/);
    assert.match(html, /Cancel Issues/);
    assert.match(html, /Cancelled from Dashboard Needs Attention/);
    assert.match(html, /userTasks/);
    assert.match(html, /hidden system/);
    assert.match(html, /taskStatsText/);
    assert.match(html, /batchStatsText/);
    assert.match(html, /个用户任务/);
    assert.match(html, /data-task-filter="user"/);
    assert.match(html, /data-task-filter="all"/);
    assert.match(html, /data-task-search/);
    assert.match(html, /id="resourcePlatform"/);
    assert.match(html, /id="resourceArch"/);
    assert.match(html, /id="sessionResourcePlatform"/);
    assert.match(html, /id="sessionResourceArch"/);
    assert.match(html, /platform: form\.get\('resourcePlatform'\)/);
    assert.match(html, /nadoTaskSearch/);
    assert.match(html, /renderConsoleProgress/);
    assert.match(html, /data-console-stage="prepare"/);
    assert.match(html, /data-console-stage="result"/);
    assert.match(html, /taskPruneKeep/);
    assert.match(html, /pruneTaskHistory/);
    assert.match(html, /clearWorkbenchCompleted/);
    assert.match(html, /Reset Demo/);
    assert.match(html, /resetWorkbenchDemo/);
    assert.match(html, /Demo reset cleared/);
    assert.match(html, /Demo already clean/);
    assert.match(html, /pruneSystemHistory/);
    assert.match(html, /\/api\/system-history\/prune/);
    assert.match(html, /\/api\/sessions\/prune-empty/);
    assert.match(html, /Clear System History/);
    assert.match(html, /Clear completed verify\/doctor system history/);
    assert.match(html, /Clear Completed/);
    assert.match(html, /nadoTaskFilter/);
    assert.match(html, /isSystemTask/);
    assert.match(html, /Batch Detail/);
    assert.match(html, /Session Detail/);
    assert.match(html, /\/api\/status/);
    assert.match(html, /\/api\/worker-tokens/);
    assert.match(html, /\/api\/context/);
    assert.match(html, /\/api\/capabilities/);
    assert.match(html, /\/api\/mcp-config/);
    assert.match(html, /\/api\/doctor/);
    assert.match(html, /\/api\/verify/);
    assert.match(html, /\/api\/demo\/health/);
    assert.match(html, /\/api\/recovery\/offline-tasks/);
    assert.match(html, /\/api\/tasks\//);
    assert.match(html, /events\/stream/);
    assert.match(html, /renderScheduler/);
    assert.match(html, /renderTaskRuntime/);
    assert.match(html, /waiting_for_session_worker/);
    assert.match(html, /reconnect_session_worker/);
    assert.match(html, /taskNeedsAttention/);
    assert.match(html, /renderAttentionTasks/);
    assert.match(html, /Route Issue/);
    assert.match(html, /nextActionForTask/);
    assert.match(html, /fix_target_or_reschedule/);
    assert.match(html, /wait_or_add_capacity/);
    assert.match(html, /Next Action/);
    assert.match(html, /Routing/);
    assert.match(html, /Auto Route/);
    assert.match(html, /data-task-auto-route/);
    assert.match(html, /localizeSchedulerReason/);
    assert.match(html, /localizeInferenceReason/);
    assert.match(html, /localizeEventMessage/);
    assert.match(html, /Inferred Capabilities/);
    assert.match(html, /Effective Capabilities/);
    assert.match(html, /Inference Explanation/);
    assert.match(html, /inferenceReasons/);
    assert.match(html, /自动推断能力/);
    assert.match(html, /最终必需能力/);
    assert.match(html, /\/api\/batches/);
    assert.match(html, /\/api\/batches\/plan/);
    assert.match(html, /\/api\/planner\/plan/);
    assert.match(html, /\/api\/planner\/run/);
    assert.match(html, /\/api\/dispatch\/plan/);
    assert.match(html, /showDispatchPlanError/);
    assert.match(html, /Routing blocked; dispatch plan shown/);
    assert.match(html, /Routable/);
    assert.match(html, /Inferred/);
    assert.match(html, /Effective/);
    assert.match(html, /\/api\/sessions/);
    assert.match(html, /\/api\/sessions\/.*artifacts/);
    assert.match(html, /inviteOutput/);
    assert.match(html, /downloadInvite/);
    assert.match(html, /downloadBundle/);
    assert.match(html, /downloadBootstrapBundle/);
    assert.match(html, /Download Self-Service Bundle/);
    assert.match(html, /inviteStrictLocalReadiness/);
    assert.match(html, /Strict local readiness before self-service start/);
    assert.match(html, /strictLocalReadiness: options\.strictLocalReadiness/);
    assert.match(html, /refreshNetworkInfo/);
    assert.match(html, /networkInfo/);
    assert.match(html, /loadNetworkInfo/);
    assert.match(html, /\/api\/network/);
    assert.match(html, /Current browser URL is loopback/);
    assert.match(html, /container-internal Docker bridge address/);
    assert.match(html, /NADO_PUBLIC_CONTROL_URL/);
    assert.match(html, /renderNetworkActionCommands/);
    assert.match(html, /Restart Docker demo on IPv6/);
    assert.match(html, /Build self-service worker bundle/);
    assert.match(html, /Not for remote workers/);
    assert.match(html, /Use URL/);
    assert.match(html, /inviteControlWarning/);
    assert.match(html, /loopbackControlUrlReason/);
    assert.match(html, /updateInviteControlWarning/);
    assert.match(html, /inviteControlTouched/);
    assert.match(html, /preferredControlUrlCandidate/);
    assert.match(html, /shouldAutoFillInviteControl/);
    assert.match(html, /maybeAutoFillInviteControl/);
    assert.match(html, /maybeAutoFillInviteControl\(info\)/);
    assert.match(html, /state\.inviteControlTouched && value !== window\.location\.origin && !warning/);
    assert.match(html, /state\.inviteControlTouched = true/);
    assert.match(html, /Remote workers cannot reach a loopback control URL/);
    assert.match(html, /selfTestInvite/);
    assert.match(html, /downloadInviteScript/);
    assert.match(html, /downloadWorkerBundle/);
    assert.match(html, /\/api\/workers\/bundle/);
    assert.match(html, /\/api\/workers\/bootstrap-bundle/);
    assert.match(html, /generatedWorkerId/);
    assert.match(html, /worker preflight --control/);
    assert.match(html, /selfTestInviteWorker/);
    assert.match(html, /inviteAgentPreset/);
    assert.match(html, /buildWorkerInvite/);
    assert.match(html, /workerTokenFilter/);
    assert.match(html, /loadWorkerTokens/);
    assert.match(html, /data-worker-token-revoke/);
    assert.match(html, /renderWorkerTokens/);
    assert.match(html, /Enrollment Tokens/);
    assert.match(html, /loadWorkerEnrollmentTokens/);
    assert.match(html, /renderWorkerEnrollmentTokens/);
    assert.match(html, /pruneWorkerEnrollmentTokens/);
    assert.match(html, /showEnrollmentHistory/);
    assert.match(html, /Showing active enrollment tokens/);
    assert.ok(html.includes('[/^Showing active enrollment tokens \\((\\d+) hidden\\)$/'));
    assert.match(html, /enrollmentTokenStatus/);
    assert.match(html, /bindWorkerEnrollmentTokenButtons/);
    assert.match(html, /data-worker-enrollment-token-revoke/);
    assert.match(html, /\/api\/worker-enrollment-tokens/);
    assert.match(html, /\/api\/worker-enrollment-tokens\/prune/);
    assert.match(html, /Loaded .* worker enrollment tokens/);
    assert.match(html, /Revoked worker enrollment token/);
    assert.match(html, /Pruned .* unused worker enrollment token/);
    assert.match(html, /data-worker-view/);
    assert.match(html, /data-worker-use/);
    assert.match(html, /data-worker-events/);
    assert.match(html, /loadWorkerEvents/);
    assert.match(html, /\/api\/workers\/.*events/);
    assert.match(html, /shutdown/);
    assert.match(html, /workerManagementActions/);
    assert.match(html, /credentialRotationConfigured/);
    assert.match(html, /rotate_token/);
    assert.match(html, /rotate token/);
    assert.match(html, /Queued worker command/);
    assert.match(html, /Forget/);
    assert.match(html, /data-worker-forget/);
    assert.match(html, /\/api\/workers\/.*forget/);
    assert.match(html, /renderWorkerDetail/);
    assert.match(html, /loadWorkerDetail/);
    assert.match(html, /useWorker/);
    assert.match(html, /doctorForm/);
    assert.match(html, /doctorAgentSelfTest/);
    assert.match(html, /runDashboardDoctor/);
    assert.match(html, /data-worker-agent-self-test/);
    assert.match(html, /runWorkerAgentSelfTest/);
    assert.match(html, /Run an agent self-test on this worker/);
    assert.match(html, /renderDoctor/);
    assert.match(html, /Agent Test/);
    assert.match(html, /Agent Self Tests/);
    assert.match(html, /Authentication/);
    assert.match(html, /Signed Worker token/);
    assert.match(html, /renderWorkerIdentity/);
    assert.match(html, /Source Address/);
    assert.match(html, /renderWorkerConnection/);
    assert.match(html, /verifyForm/);
    assert.match(html, /runDashboardVerify/);
    assert.match(html, /renderVerify/);
    assert.match(html, /verifyResult/);
    assert.match(html, /runDemoHealth/);
    assert.match(html, /runDashboardDemoHealth/);
    assert.match(html, /renderDemoHealth/);
    assert.match(html, /demoHealthResult/);
    assert.match(html, /loadAgentContext/);
    assert.match(html, /downloadAgentContext/);
    assert.match(html, /agentContext/);
    assert.match(html, /loadCapabilities/);
    assert.match(html, /downloadCapabilities/);
    assert.match(html, /capabilitiesManifest/);
    assert.match(html, /loadMcpConfig/);
    assert.match(html, /downloadMcpConfig/);
    assert.match(html, /mcpConfigName/);
    assert.match(html, /recoveryForm/);
    assert.match(html, /Allow session migration \(worker-local workspace may be lost\)/);
    assert.match(html, /Enabled for ordinary tasks and same-worker sessions/);
    assert.match(html, /loadRecoveryCandidates/);
    assert.match(html, /recoverOfflineTasks/);
    assert.match(html, /recoveryCandidates/);
    assert.match(html, /taskType/);
    assert.match(html, /sessionId/);
    assert.match(html, /envText/);
    assert.match(html, /artifactInclude/);
    assert.match(html, /artifactExclude/);
    assert.match(html, /inputFiles/);
    assert.match(html, /workspacePolicy/);
    assert.match(html, /sandboxProfile/);
    assert.match(html, /requireRoutable/);
    assert.match(html, /batchRequireRoutable/);
    assert.match(html, /readInputFiles/);
    assert.match(html, /artifactPolicyFromForm/);
    assert.match(html, /parseEnvText/);
    assert.match(html, /Agent tasks require a prompt/);
    assert.match(html, /artifacts:/);
    assert.match(html, /batchForm/);
    assert.match(html, /batchPlanForm/);
    assert.match(html, /batchPlanTasks/);
    assert.match(html, /parsePlanTasks/);
    assert.match(html, /Planned .* batch task/);
    assert.match(html, /planDispatchFromBatch/);
    assert.match(html, /previewDispatchFromBatchJson/);
    assert.match(html, /renderDispatchPlan/);
    assert.match(html, /dispatchPlan/);
    assert.match(html, /sessionForm/);
    assert.match(html, /Control RTT/);
    assert.match(html, /Control bandwidth/);
    assert.match(html, /Disk available/);
    assert.match(html, /Temperatures/);
    assert.equal((html.match(/const formElement = event\.currentTarget;/g) || []).length, 2);
    assert.equal((html.match(/formElement\.reset\(\);/g) || []).length, 2);
    assert.doesNotMatch(html, /event\.currentTarget\.reset\(\)/);
    assert.match(html, /Manage Task/);
    assert.match(html, /data-task-view/);
    assert.match(html, /data-task-events/);
    assert.match(html, /data-task-stream/);
    assert.match(html, /streamSse/);
    assert.match(html, /decodeSseBlock/);
    assert.match(html, /stopEventStream/);
    assert.match(html, /loadTaskEvents/);
    assert.match(html, /taskEvents/);
    assert.match(html, /data-task-manage/);
    assert.match(html, /data-task-action/);
    assert.match(html, /data-batch-view/);
    assert.match(html, /data-batch-report/);
    assert.match(html, /data-batch-events/);
    assert.match(html, /data-batch-stream/);
    assert.match(html, /data-batch-manage/);
    assert.match(html, /data-batch-action/);
    assert.match(html, /data-batch-artifacts/);
    assert.match(html, /data-batch-download/);
    assert.match(html, /\/api\/batches\/.*artifacts\/download/);
    assert.match(html, /Manage Batch/);
    assert.match(html, /downloadBatchArtifacts/);
    assert.match(html, /zipBlob/);
    assert.match(html, /data-session-view/);
    assert.match(html, /data-session-use/);
    assert.match(html, /data-session-close/);
    assert.match(html, /data-session-artifacts/);
    assert.match(html, /data-session-download/);
    assert.match(html, /\/api\/sessions\/.*artifacts\/download/);
    assert.match(html, /downloadSessionArtifacts/);
    assert.match(html, /renderSessionArtifacts/);
    assert.match(html, /selectedSessionArtifactsId/);
    assert.match(html, /selectedSessionArtifacts/);
    assert.match(html, /data-artifact-task/);
    assert.match(html, /downloadArtifact/);
    assert.match(html, /data-task-artifacts-download/);
    assert.match(html, /downloadTaskArtifacts/);
    assert.match(html, /Downloaded task artifacts ZIP/);
    assert.match(html, /binaryApi/);
    assert.match(html, /fileNameFromDisposition/);
    assert.match(html, /artifacts\/download/);
    assert.match(html, /artifacts\/.*download/);
    assert.match(html, /manageTask/);
    assert.match(html, /manageBatch/);
    assert.match(html, /loadBatchDetail/);
    assert.match(html, /renderBatchEvents/);
    assert.match(html, /batchEventTimeline/);
    assert.match(html, /bindBatchNavigationButtons/);
    assert.match(html, /loadSessionDetail/);
    assert.match(html, /authorization: 'Bearer '/);
    assert.match(html, /Audit Trail/);
    assert.match(html, /Audit Shipping/);
    assert.match(html, /External audit mirror degraded/);
    assert.match(html, /CPU utilization/);
    assert.match(html, /Memory available/);
    assert.match(html, /'Run agent self-test task': '运行 Agent 自测任务'/);
    assert.match(html, /'Network deployment': '网络部署方式'/);
    assert.match(html, /'Audit Trail': '审计记录'/);
    assert.match(html, /'CPU utilization': 'CPU 使用率'/);
    assert.match(html, /'Capture the network deployment boundary receipt': '采集网络部署边界回执'/);
    assert.match(html, /'Run the strict final completeness gate': '运行最终严格完整性门禁'/);
    assert.match(html, /chinese \? ' 个逻辑核心 · 负载 ' : ' logical cores · load '/);
    assert.match(html, /chinese \? '下行 ' : 'Down '/);
    assert.match(html, /const acceptanceCheckCopyZh = \{/);
    assert.match(html, /workerIdentity: \['所选工作端使用最小权限、已签名且可撤销的身份'/);
    assert.match(html, /acceptanceCheckCopy\(item, 'summary'\)/);
    assert.match(html, /acceptanceCheckCopy\(item, 'action'\)/);
    assert.match(html, /acceptanceCheckCopy\(validated, 'nextAction'\)/);
    assert.match(html, /downloadAuditTrail/);
    assert.match(html, /\/api\/audit\/export/);
    assert.match(html, /localStorage\.removeItem\('nadoToken'\)/);
    assert.match(html, /sessionStorage\.removeItem\('nadoToken'\)/);
    assert.doesNotMatch(html, /(?:localStorage|sessionStorage)\.setItem\('nadoToken'/);
    const nonce = contentSecurityPolicy.match(/script-src 'nonce-([^']+)'/)?.[1];
    assert.ok(nonce);
    assert.match(html, new RegExp(`<style nonce="${nonce}">`));
    const script = html.match(new RegExp(`<script nonce="${nonce}">([\\s\\S]*)<\\/script>`))?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));

    const rootResponse = await fetch(`${controlUrl}/`);
    assert.equal(rootResponse.status, 200);
    assert.match(await rootResponse.text(), /Nado Control/);

    const denied = await fetch(`${controlUrl}/api/status`);
    assert.equal(denied.status, 401);

    const deniedContext = await fetch(`${controlUrl}/api/context`);
    assert.equal(deniedContext.status, 401);
    const deniedCapabilities = await fetch(`${controlUrl}/api/capabilities`);
    assert.equal(deniedCapabilities.status, 401);
    const deniedAcceptanceTemplate = await fetch(`${controlUrl}/api/acceptance/template`);
    assert.equal(deniedAcceptanceTemplate.status, 401);
    const deniedAcceptanceRunbook = await fetch(`${controlUrl}/api/acceptance/runbook?workerId=home-worker`);
    assert.equal(deniedAcceptanceRunbook.status, 401);
    const deniedAcceptanceEvidenceRecord = await fetch(`${controlUrl}/api/acceptance/evidence/record`, { method: 'POST' });
    assert.equal(deniedAcceptanceEvidenceRecord.status, 401);
    const deniedAcceptanceReport = await fetch(`${controlUrl}/api/acceptance/report`, { method: 'POST' });
    assert.equal(deniedAcceptanceReport.status, 401);
    const deniedNetwork = await fetch(`${controlUrl}/api/network`);
    assert.equal(deniedNetwork.status, 401);
    const deniedMcpConfig = await fetch(`${controlUrl}/api/mcp-config`);
    assert.equal(deniedMcpConfig.status, 401);
    const deniedVerify = await fetch(`${controlUrl}/api/verify`, { method: 'POST' });
    assert.equal(deniedVerify.status, 401);
    const deniedDemoHealth = await fetch(`${controlUrl}/api/demo/health`, { method: 'POST' });
    assert.equal(deniedDemoHealth.status, 401);
    const deniedDispatchPlan = await fetch(`${controlUrl}/api/dispatch/plan`, { method: 'POST' });
    assert.equal(deniedDispatchPlan.status, 401);
    const deniedPlannerPlan = await fetch(`${controlUrl}/api/planner/plan`, { method: 'POST' });
    assert.equal(deniedPlannerPlan.status, 401);
    const deniedPlannerRun = await fetch(`${controlUrl}/api/planner/run`, { method: 'POST' });
    assert.equal(deniedPlannerRun.status, 401);

    const client = new NadoClient({ controlUrl, token });
    const health = await client.health();
    assert.match(health.runtime.instanceId, /^control_[0-9a-f-]{36}$/);
    assert.ok(Date.parse(health.runtime.startedAt));
    assert.equal(health.runtime.build.protocolVersion, 1);
    assert.match(health.runtime.build.sourceFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Date.parse(health.clock.serverTime));
    assert.equal(health.clock.signedWorkerMaxSkewMs, 300_000);
    const status = await client.status();
    assert.equal(status.workers.total, 0);
    assert.equal(status.runtime.instanceId, health.runtime.instanceId);
    assert.equal(status.runtime.startedAt, health.runtime.startedAt);
    const capabilities = await client.capabilities();
    assert.equal(capabilities.name, 'nado-agent');
    assert.equal(capabilities.auth.type, 'bearer');
    assert.equal(capabilities.auth.configuredAdminTokenLogging, 'redacted');
    assert.equal(capabilities.security.administratorCredential.remoteStartRequiresExplicitCredential, true);
    assert.equal(capabilities.security.administratorCredential.generatedTokenFileOutsideControlData, true);
    assert.equal(capabilities.security.administratorCredential.remoteQuickstartDashboardTokenInjection, false);
    assert.deepEqual(capabilities.runtime, health.runtime);
    assert.ok(capabilities.mcp.tools.includes('nado_capabilities'));
    assert.ok(capabilities.mcp.tools.includes('nado_demo_health'));
    assert.equal(capabilities.features.workerPreflight, true);
    assert.equal(capabilities.features.workerEvents, true);
    assert.equal(capabilities.features.workerBundles, true);
    assert.deepEqual(capabilities.features.workerServiceInstallers, ['systemd', 'windows_scheduled_task', 'macos_launch_agent']);
    assert.equal(capabilities.features.workerSelfServiceEnrollment, true);
    assert.equal(capabilities.features.signedWorkerRequests, true);
    assert.equal(capabilities.features.workerClockSkewDiagnostics, true);
    assert.equal(capabilities.security.workerIdentity.signedRequestMaxClockSkewMs, 300_000);
    assert.equal(capabilities.security.workerIdentity.acceptanceRecommendedMaxClockSkewMs, 60_000);
    assert.equal(capabilities.features.batches, true);
    assert.equal(capabilities.features.eventStreams, true);
    assert.equal(capabilities.features.automaticOfflineRecovery, false);
    assert.equal(capabilities.features.sameWorkerSessionRecovery, true);
    assert.equal(capabilities.features.taskRuntimeDiagnostics, true);
    assert.equal(capabilities.reliability.taskDelivery, 'at-least-once');
    assert.equal(capabilities.reliability.staleAttemptResultProtection, true);
    assert.equal(capabilities.reliability.taskEventDelivery.stableIds, true);
    assert.equal(capabilities.reliability.taskEventDelivery.orderedPerAttempt, true);
    assert.equal(capabilities.reliability.taskEventDelivery.boundedPendingEvents, true);
    assert.equal(capabilities.reliability.taskEventDelivery.defaultMaxPendingEvents, 256);
    assert.equal(capabilities.reliability.taskEventDelivery.explicitGapEvents, true);
    assert.match(capabilities.reliability.processTreeTermination.windows, /descendant-first/);
    assert.match(capabilities.reliability.processTreeTermination.posix, /process group/);
    assert.equal(
      capabilities.reliability.processTreeTermination.gracefulWorkerStopWaitsForReleaseEvidence,
      true,
    );
    assert.equal(
      capabilities.reliability.automaticOfflineRecovery.sessionTasksIncluded,
      'same-worker-only',
    );
    assert.match(
      capabilities.reliability.automaticOfflineRecovery.crossWorkerSessionRecovery,
      /manual opt-in/,
    );
    assert.equal(capabilities.features.groupedArtifactZipDownload, true);
    assert.equal(capabilities.features.doctorAgentSelfTest, true);
    assert.equal(capabilities.features.readinessVerification, true);
    assert.equal(capabilities.features.demoHealth, true);
    assert.equal(capabilities.features.acceptanceRunbook, true);
    assert.equal(capabilities.features.dispatchPlanning, true);
    assert.equal(capabilities.features.requireRoutableSubmit, true);
    assert.equal(capabilities.features.routingActionHints, true);
    assert.equal(capabilities.features.workerResourceDiagnostics, true);
    assert.equal(capabilities.features.workerOperationalTelemetry, true);
    assert.equal(capabilities.features.workerBandwidthProbe, true);
    assert.equal(capabilities.features.platformArchitectureScheduling, true);
    assert.equal(capabilities.features.runtimeBuildProvenance, true);
    assert.equal(capabilities.features.workerServiceUpgradeRollback, true);
    assert.equal(capabilities.features.protocolAwareScheduling, true);
    assert.equal(capabilities.routingPolicy.protocolCompatibility.controlProtocolVersion, 1);
    assert.equal(capabilities.routingPolicy.protocolCompatibility.rejectKnownMismatch, true);
    assert.equal(capabilities.routingPolicy.protocolCompatibility.allowLegacyUnknown, true);
    assert.equal(capabilities.features.inputDownloadRangeEvents, true);
    assert.equal(capabilities.features.retryableFailurePolicies, true);
    assert.deepEqual(capabilities.reliability.processFailureRetries.failureKinds, [
      'timeout', 'process_error', 'worker_error', 'nonzero_exit',
    ]);
    assert.equal(capabilities.reliability.processFailureRetries.cancellationRetried, false);
    assert.equal(capabilities.observability.workerDiskCapacity, true);
    assert.match(capabilities.observability.taskRuntimeState, /lease.*heartbeat.*retry/);
    assert.match(capabilities.observability.controlRoundTripLatency, /heartbeat/);
    assert.match(capabilities.observability.controlBandwidth, /probe/);
    assert.equal(capabilities.features.workerReadinessDiagnostics, true);
    assert.equal(capabilities.features.cliSubmitFlow, true);
    assert.equal(capabilities.features.cliBatchSubmitFlow, true);
    assert.equal(capabilities.features.mcpRunTaskFlow, true);
    assert.equal(capabilities.features.mcpRunBatchFlow, true);
    assert.equal(capabilities.features.distributedTaskPlanning, true);
    assert.equal(capabilities.features.ipv6ControlUrls, true);
    assert.equal(capabilities.features.networkActionHints, true);
    assert.equal(capabilities.features.trustedProxyHeaders, true);
    assert.equal(capabilities.features.authenticatedTrustedProxyHeaders, true);
    assert.equal(capabilities.features.bundledCaddyHttpsDeployment, true);
    assert.equal(capabilities.features.loopbackOnlyNativeControlDefault, true);
    assert.deepEqual(capabilities.features.autoCapabilityRouting, ['gpu', 'docs', 'ppt']);
    assert.equal(capabilities.networking.ipv6LiteralUrls, true);
    assert.equal(capabilities.networking.ipv6LiteralFormat, 'http://[2001:db8::10]:8765');
    assert.equal(capabilities.networking.trustProxyEnv, 'NADO_TRUST_PROXY');
    assert.equal(capabilities.networking.trustProxySecretEnv, 'NADO_TRUST_PROXY_SECRET');
    assert.deepEqual(capabilities.networking.trustedProxyHeaders, ['X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Forwarded-For']);
    assert.equal(capabilities.networking.trustedProxyAuthenticationHeader, 'X-Nado-Proxy-Secret');
    assert.equal(capabilities.networking.trustedProxyAuthenticationRequired, true);
    assert.equal(capabilities.networking.publicHttpsDeployment.edgeOverlay, 'docker-compose.azure-https.yml');
    assert.equal(capabilities.networking.publicHttpsDeployment.nativeControlHostDefault, '127.0.0.1');
    assert.deepEqual(capabilities.networking.publicHttpsDeployment.publicPorts, [80, 443]);
    assert.equal(capabilities.networking.diagnosticsNextActionField, 'network.nextAction');
    assert.equal(capabilities.routingPolicy.explainability.mcpTool, 'nado_explain_schedule');
    assert.equal(capabilities.routingPolicy.agentReadiness.agentTasksRequireConfiguredCommand, true);
    assert.equal(capabilities.routingPolicy.agentReadiness.successfulRecentSelfTestBonus, 25);
    assert.equal(capabilities.routingPolicy.agentReadiness.preferRealTerminalAgent, true);
    assert.equal(capabilities.routingPolicy.agentReadiness.realTerminalAgentBonus, 20);
    assert.equal(capabilities.routingPolicy.agentReadiness.demoEchoAgentPenalty, 20);
    assert.equal(capabilities.routingPolicy.resourcePreference.preserveGpuCapacityPenalty, 30);
    assert.equal(capabilities.routingPolicy.resourcePreference.preferProbeDetectedGpuWhenGpuRequired, true);
    assert.equal(capabilities.routingPolicy.resourcePreference.gpuProbeDetectedBonus, 15);
    assert.equal(capabilities.routingPolicy.resourcePreference.gpuAdvertisedOnlyPenalty, 5);
    assert.ok(capabilities.routingPolicy.automaticInference.some(
      (policy) => policy.capability === 'gpu' && policy.sources.includes('command'),
    ));
    assert.ok(capabilities.routingPolicy.automaticInference.some(
      (policy) => policy.capability === 'docs' && !policy.sources.includes('command'),
    ));
    assert.equal(capabilities.endpoints.workers.bundle, 'POST /api/workers/bundle');
    assert.equal(capabilities.endpoints.workers.bootstrapBundle, 'POST /api/workers/bootstrap-bundle');
    assert.equal(capabilities.endpoints.workers.enroll, 'POST /api/workers/enroll');
    assert.equal(capabilities.endpoints.workers.forget, 'POST /api/workers/{workerId}/forget');
    assert.equal(capabilities.endpoints.workers.enrollmentTokens, 'GET|POST /api/worker-enrollment-tokens');
    assert.equal(capabilities.endpoints.workers.enrollmentTokenPrune, 'POST /api/worker-enrollment-tokens/prune');
    assert.match(capabilities.endpoints.workers.tokenRotationPrepare, /rotation\/prepare/);
    assert.match(capabilities.endpoints.workers.tokenRotationConfirm, /rotation\/confirm/);
    assert.match(capabilities.endpoints.tasks.artifactDownload, /download/);
    assert.equal(
      capabilities.endpoints.tasks.shortDisconnectObservation,
      'POST /api/tasks/{taskId}/acceptance-observations/short-disconnect',
    );
    assert.equal(capabilities.endpoints.tasks.artifactUploadList, 'GET /api/tasks/{taskId}/artifact-uploads');
    assert.match(capabilities.endpoints.tasks.artifactsJson, /artifacts\/content/);
    assert.match(capabilities.endpoints.tasks.artifactsZip, /artifacts\/download/);
    assert.equal(capabilities.features.taskHistoryPruning, true);
    assert.equal(capabilities.features.systemHistoryPruning, true);
    assert.equal(capabilities.features.workerEnrollmentTokenPruning, true);
    assert.equal(capabilities.features.workerTokenRotation, true);
    assert.equal(capabilities.features.workerTokenRotationCrashRecovery, true);
    assert.equal(capabilities.features.workerTokenRotationControlTriggered, true);
    assert.equal(capabilities.features.acceptanceEvidenceRecording, true);
    assert.equal(capabilities.features.verifiedRestoreReceipts, true);
    assert.equal(capabilities.features.workerAuthenticationEvidence, true);
    assert.equal(capabilities.features.workerObservedTransportAcceptance, true);
    assert.equal(capabilities.features.shortDisconnectObservationReceipts, true);
    assert.equal(capabilities.features.shortDisconnectReceiptValidation, true);
    assert.deepEqual(capabilities.features.automatedAcceptanceExercises, [
      'remoteCancellation',
      'agentCollaboration',
    ]);
    assert.deepEqual(capabilities.features.supervisedAcceptanceExercises, [
      'shortDisconnect',
      'longDisconnectRecovery',
      'vmRestartRecovery',
      'largeArtifactResume',
      'largeInputResume',
      'backupRestore',
    ]);
    assert.ok(capabilities.features.workerManagement.includes('rotate_token'));
    assert.ok(capabilities.features.workerManagement.includes('forget'));
    assert.equal(capabilities.endpoints.tasks.prune, 'POST /api/tasks/prune');
    assert.equal(capabilities.endpoints.tasks.systemPrune, 'POST /api/system-history/prune');
    assert.equal(capabilities.endpoints.sessions.pruneEmptyPreview, 'GET /api/sessions/prune-empty');
    assert.equal(capabilities.endpoints.sessions.pruneEmpty, 'POST /api/sessions/prune-empty');
    assert.equal(capabilities.endpoints.verify, 'POST /api/verify');
    assert.equal(capabilities.endpoints.acceptanceTemplate, 'GET /api/acceptance/template');
    assert.equal(capabilities.endpoints.acceptanceRunbook, 'GET /api/acceptance/runbook');
    assert.equal(capabilities.endpoints.acceptanceEvidenceRecord, 'POST /api/acceptance/evidence/record');
    assert.equal(capabilities.endpoints.acceptanceReport, 'POST /api/acceptance/report');
    assert.equal(capabilities.endpoints.demoHealth, 'POST /api/demo/health');
    assert.equal(capabilities.endpoints.network, 'GET /api/network');
    assert.equal(capabilities.endpoints.dispatch.plan, 'POST /api/dispatch/plan');
    assert.equal(capabilities.endpoints.planner.plan, 'POST /api/planner/plan');
    assert.equal(capabilities.endpoints.planner.run, 'POST /api/planner/run');
    assert.ok(capabilities.cli.examples.some(
      (example) => example.includes('--require-complete') && example.includes('--deployment-evidence'),
    ));
    assert.equal(capabilities.workers.length, 0);
    const network = await client.networkInfo();
    assert.equal(network.requestUrl, controlUrl);
    assert.equal(network.requestIsLoopback, true);
    assert.ok(Array.isArray(network.candidates));
    const acceptanceTemplate = await client.acceptanceTemplate();
    assert.equal(acceptanceTemplate.version, 1);
    assert.equal(acceptanceTemplate.scenarios.physicalSeparation.status, 'pending');
    assert.equal(acceptanceTemplate.scenarios.agentCollaboration.status, 'pending');
    const acceptanceRunbook = await client.acceptanceRunbook({
      workerId: 'home-worker',
      deploymentMode: 'public_https',
      requireGpu: true,
    });
    assert.equal(acceptanceRunbook.runbookVersion, 2);
    assert.ok(acceptanceRunbook.steps.some((item) => item.key === 'credential_revocation'));
    assert.ok(acceptanceRunbook.steps.some((item) => item.key === 'strict_report'));
    assert.match(acceptanceRunbook.script, /acceptance evidence init/);
    const acceptanceEvidence = await client.recordAcceptanceEvidence(undefined, {
      scenario: 'physicalSeparation',
      status: 'passed',
      note: 'Observed the VM and home Worker on separately administered physical networks',
      references: ['operator/network-topology.txt'],
    });
    assert.equal(acceptanceEvidence.scenarios.physicalSeparation.status, 'passed');
    assert.equal(acceptanceEvidence.scenarios.agentCollaboration.status, 'pending');
    assert.ok(acceptanceEvidence.updatedAt);
    const invalidAcceptanceEvidence = await fetch(`${controlUrl}/api/acceptance/evidence/record`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        record: { scenario: 'physicalSeparation', status: 'passed' },
      }),
    });
    assert.equal(invalidAcceptanceEvidence.status, 400);
    const missingWorkerReport = await client.acceptanceReport({
      workerId: 'missing-home-worker',
      requireAgent: false,
    });
    assert.equal(missingWorkerReport.overall, 'failed');
    assert.equal(missingWorkerReport.requirements.workerId, 'missing-home-worker');
    assert.equal(missingWorkerReport.automatedChecks.find((item) => item.key === 'targetWorkerOnline').status, 'failed');
    assert.equal(missingWorkerReport.manualChecks.find((item) => item.key === 'physicalSeparation').status, 'pending');
    const strictMissingDeploymentReport = await client.acceptanceReport({
      workerId: 'missing-home-worker',
      requireAgent: false,
      requireDeploymentEvidence: true,
      deploymentEvidence: null,
    });
    assert.equal(strictMissingDeploymentReport.requirements.requireDeploymentEvidence, true);
    assert.equal(
      strictMissingDeploymentReport.automatedChecks.find((item) => item.key === 'deploymentBoundaryReceipt').status,
      'failed',
    );
    const missingWorkerId = await fetch(`${controlUrl}/api/acceptance/report`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(missingWorkerId.status, 400);
    const invalidEvidenceReport = await fetch(`${controlUrl}/api/acceptance/report`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workerId: 'missing-home-worker',
        manualEvidence: { scenarios: { typoScenario: { status: 'pending' } } },
      }),
    });
    assert.equal(invalidEvidenceReport.status, 400);
    const context = await client.context();
    assert.match(context, /Nado Agent Control Context/);
    assert.match(context, /No workers registered yet/);
    assert.match(context, /## MCP Tools/);
    assert.match(context, /## Routing Policy/);
    assert.match(context, /http:\/\/\[2001:db8::10\]:8765/);
    assert.match(context, /gpu: inferred from title, prompt, description, command/);
    assert.match(context, /agent readiness diagnostics/);
    assert.match(context, /actual authentication mode/);
    assert.match(context, /one-click GPU\/docs\/PPT route checks/);
    assert.match(context, /retryPolicy\.failureKinds/);
    assert.match(context, /real Stop Task cancellation/);
    assert.match(context, /--deployment-evidence \.\/deployment-check\.json/);
    assert.match(context, /Check Routes/);
    assert.match(context, /`nado_capabilities`/);
    assert.match(context, /`nado_demo_health`/);
    assert.match(context, /`nado_run_task`/);
    assert.match(context, /`nado_plan_distributed_task`/);
    assert.match(context, /planner run/);
    const mcpConfig = await client.mcpConfig({ name: 'nado-test' });
    assert.equal(mcpConfig.mcpServers['nado-test'].env.NADO_TOKEN, token);
    assert.ok(mcpConfig.mcpServers['nado-test'].args.includes(controlUrl));
    const mcpCommand = await client.mcpConfig({ name: 'nado-test', format: 'command' });
    assert.match(mcpCommand, /NADO_TOKEN/);
    assert.match(mcpCommand, /nado-test|mcp/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('task history pruning removes only old standalone terminal tasks', async () => {
  const root = await makeTempDir();
  const token = 'dashboard-prune-token';
  const { server, port, store } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    const oldStandalone = await store.createTask({
      title: 'old standalone',
      command: 'echo old',
      status: 'succeeded',
    });
    oldStandalone.completedAt = '2026-01-01T00:00:00.000Z';
    oldStandalone.updatedAt = oldStandalone.completedAt;
    const middleStandalone = await store.createTask({
      title: 'middle standalone',
      command: 'echo middle',
      status: 'failed',
    });
    middleStandalone.completedAt = '2026-01-02T00:00:00.000Z';
    middleStandalone.updatedAt = middleStandalone.completedAt;
    const newestStandalone = await store.createTask({
      title: 'newest standalone',
      command: 'echo newest',
      status: 'succeeded',
    });
    newestStandalone.completedAt = '2026-01-03T00:00:00.000Z';
    newestStandalone.updatedAt = newestStandalone.completedAt;
    const batchTask = await store.createTask({
      title: 'batch terminal kept',
      command: 'echo batch',
      status: 'succeeded',
      batchId: 'batch_kept',
    });
    const session = await store.createSession({ title: 'kept session' });
    const sessionTask = await store.createTask({
      title: 'session terminal kept',
      command: 'echo session',
      status: 'succeeded',
      sessionId: session.id,
    });
    const artifactDir = path.join(root, 'control', 'artifacts', oldStandalone.id);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, 'old.txt'), 'old');
    await store.save();

    const preview = await client.previewTaskPrune({ keep: 1 });
    assert.equal(preview.prunableCount, 2);
    assert.deepEqual(preview.tasks.map((task) => task.id), [middleStandalone.id, oldStandalone.id]);

    const pruned = await client.pruneTaskHistory({ keep: 1 });
    assert.equal(pruned.prunedCount, 2);
    assert.equal(pruned.keep, 1);
    assert.equal(await fs.access(artifactDir).then(() => true, () => false), false);
    const { tasks } = await client.listTasks();
    assert.ok(tasks.some((task) => task.id === newestStandalone.id));
    assert.ok(tasks.some((task) => task.id === batchTask.id));
    assert.ok(tasks.some((task) => task.id === sessionTask.id));
    assert.equal(tasks.some((task) => task.id === oldStandalone.id), false);
    assert.equal(tasks.some((task) => task.id === middleStandalone.id), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('demo health API reports route checks without creating tasks', async () => {
  const root = await makeTempDir();
  const token = 'dashboard-demo-health-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    await client.registerWorker({
      id: 'docs-worker',
      capabilities: ['code', 'docs', 'ppt'],
      agentCommandConfigured: true,
      maxConcurrency: 2,
    });
    await client.registerWorker({
      id: 'gpu-worker',
      capabilities: ['code', 'gpu'],
      agentCommandConfigured: true,
      maxConcurrency: 1,
    });

    const result = await client.demoHealth({ skipVerify: true, noPrune: true });
    assert.equal(result.ok, true);
    assert.equal(result.dashboardUrl, `${controlUrl}/dashboard`);
    assert.equal(result.status.workers.active, 2);
    assert.equal(result.verify, null);
    assert.equal(result.prune, null);
    assert.equal((await client.listTasks()).tasks.length, 0);

    const byCapability = Object.fromEntries(result.routeChecks.map((check) => [check.capability, check]));
    assert.equal(byCapability.gpu.workerId, 'gpu-worker');
    assert.deepEqual(byCapability.gpu.effectiveRequiredCapabilities, ['gpu']);
    assert.equal(byCapability.gpu.resourceDiagnostics.gpu.advertised, true);
    assert.equal(byCapability.gpu.resourceDiagnostics.gpu.source, 'advertised');
    assert.ok(byCapability.gpu.warnings.some((warning) => /no NVIDIA\/AMD SMI probe/.test(warning)));
    assert.ok(byCapability.gpu.warnings.some((warning) => /agent command|agent|self-test/.test(warning)));
    assert.equal(byCapability.ppt.workerId, 'docs-worker');
    assert.deepEqual(byCapability.ppt.effectiveRequiredCapabilities, ['ppt']);
    assert.equal(byCapability.docs.workerId, 'docs-worker');
    assert.deepEqual(byCapability.docs.effectiveRequiredCapabilities, ['docs']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('system history pruning removes completed diagnostic tasks and batches only', async () => {
  const root = await makeTempDir();
  const token = 'dashboard-system-prune-token';
  const { server, port, store } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    const systemStandalone = await store.createTask({
      title: 'nado verify raw artifact probe',
      command: 'echo system',
      status: 'succeeded',
    });
    systemStandalone.completedAt = '2026-01-04T00:00:00.000Z';
    systemStandalone.updatedAt = systemStandalone.completedAt;
    const routeCheck = await store.createTask({
      title: 'nado route check GPU inference',
      command: 'echo route',
      status: 'succeeded',
    });
    routeCheck.completedAt = '2026-01-04T00:01:00.000Z';
    routeCheck.updatedAt = routeCheck.completedAt;
    const userStandalone = await store.createTask({
      title: 'user report task',
      command: 'echo user',
      status: 'succeeded',
    });
    userStandalone.completedAt = '2026-01-05T00:00:00.000Z';
    userStandalone.updatedAt = userStandalone.completedAt;
    const systemBatch = await store.createBatch({
      title: 'nado verify batch zip probe',
      tasks: [
        { key: 'alpha', title: 'nado verify alpha', command: 'echo alpha' },
        { key: 'beta', title: 'nado verify beta', command: 'echo beta' },
      ],
    });
    for (const task of systemBatch.tasks) {
      task.status = 'succeeded';
      task.completedAt = '2026-01-06T00:00:00.000Z';
      task.updatedAt = task.completedAt;
    }
    const userBatch = await store.createBatch({
      title: 'user batch',
      tasks: [
        { key: 'doc', title: 'write user docs', command: 'echo docs' },
      ],
    });
    for (const task of userBatch.tasks) {
      task.status = 'succeeded';
      task.completedAt = '2026-01-07T00:00:00.000Z';
      task.updatedAt = task.completedAt;
    }
    const artifactDir = path.join(root, 'control', 'artifacts', systemStandalone.id);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, 'system.txt'), 'system');
    const routeArtifactDir = path.join(root, 'control', 'artifacts', routeCheck.id);
    await fs.mkdir(routeArtifactDir, { recursive: true });
    await fs.writeFile(path.join(routeArtifactDir, 'route.txt'), 'route');
    await store.save();

    const preview = await client.previewSystemHistoryPrune();
    assert.equal(preview.prunableBatchCount, 1);
    assert.equal(preview.prunableTaskCount, 4);
    assert.equal(preview.batches[0].id, systemBatch.batch.id);

    const pruned = await client.pruneSystemHistory();
    assert.equal(pruned.prunedBatchCount, 1);
    assert.equal(pruned.prunedTaskCount, 4);
    assert.equal(await fs.access(artifactDir).then(() => true, () => false), false);
    assert.equal(await fs.access(routeArtifactDir).then(() => true, () => false), false);
    const { tasks } = await client.listTasks();
    const { batches } = await client.listBatches();
    assert.equal(tasks.some((task) => task.id === systemStandalone.id), false);
    assert.equal(tasks.some((task) => task.id === routeCheck.id), false);
    assert.equal(tasks.some((task) => task.batchId === systemBatch.batch.id), false);
    assert.equal(batches.some((batch) => batch.id === systemBatch.batch.id), false);
    assert.ok(tasks.some((task) => task.id === userStandalone.id));
    assert.ok(tasks.some((task) => task.batchId === userBatch.batch.id));
    assert.ok(batches.some((batch) => batch.id === userBatch.batch.id));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('control dashboard can bootstrap the token when explicitly enabled', async () => {
  const root = await makeTempDir();
  const token = 'dashboard-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
    dashboardAutoToken: true,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /const bootstrapToken = "dashboard-token";/);
    assert.match(html, /localStorage\.removeItem\('nadoToken'\)/);
    assert.match(html, /sessionStorage\.removeItem\('nadoToken'\)/);
    assert.match(html, /tokenInput\.value = bootstrapToken \|\| ''/);
    assert.doesNotMatch(html, /(?:localStorage|sessionStorage)\.setItem\('nadoToken'/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('public control URL is advertised through control APIs and bundles', async () => {
  const root = await makeTempDir();
  const token = 'dashboard-public-token';
  const publicControlUrl = 'http://public-control.example:9876';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    publicControlUrl,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    const capabilities = await client.capabilities();
    assert.equal(capabilities.controlUrl, publicControlUrl);
    assert.equal(capabilities.surfaces.dashboard, `${publicControlUrl}/dashboard`);

    const context = await client.context();
    assert.match(context, new RegExp(publicControlUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const mcpConfig = await client.mcpConfig({ name: 'nado-public' });
    assert.ok(mcpConfig.mcpServers['nado-public'].args.includes(publicControlUrl));

    const network = await client.networkInfo();
    assert.equal(network.publicControlUrl, publicControlUrl);
    assert.equal(network.candidates[0].url, publicControlUrl);
    assert.equal(network.candidates[0].source, 'NADO_PUBLIC_CONTROL_URL');

    const bundle = await client.downloadWorkerBootstrapBundle({
      issueEnrollmentToken: true,
      tokenLabel: 'public url bundle',
    });
    assert.ok(bundle.bytes.includes(Buffer.from(publicControlUrl)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trusted proxy headers can advertise external HTTPS control URLs', async () => {
  const root = await makeTempDir();
  const token = 'dashboard-forwarded-token';
  const proxySecret = 'dashboard-forwarded-proxy-secret';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    trustProxy: true,
    trustProxySecret: proxySecret,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Bearer ${token}`,
    'x-forwarded-host': 'control.example.com',
    'x-forwarded-proto': 'https',
    'x-nado-proxy-secret': proxySecret,
  };

  try {
    const spoofed = await (await fetch(`${controlUrl}/api/network`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-forwarded-host': 'spoofed.example.com',
        'x-forwarded-proto': 'https',
      },
    })).json();
    assert.equal(spoofed.requestUrl, controlUrl);
    assert.equal(spoofed.trustProxyConfigured, true);
    assert.equal(spoofed.proxyAuthenticationConfigured, true);
    assert.equal(spoofed.proxyAuthenticated, false);

    const wrongSecret = await (await fetch(`${controlUrl}/api/network`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-forwarded-host': 'wrong-secret.example.com',
        'x-forwarded-proto': 'https',
        'x-nado-proxy-secret': 'wrong-proxy-secret',
      },
    })).json();
    assert.equal(wrongSecret.requestUrl, controlUrl);
    assert.equal(wrongSecret.proxyAuthenticated, false);

    const spoofedWorker = await (await fetch(`${controlUrl}/api/workers/register`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.99',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ id: 'spoof-attempt', capabilities: ['code'] }),
    })).json();
    assert.equal(spoofedWorker.worker.connection.addressSource, 'socket');
    assert.equal(spoofedWorker.worker.connection.protocol, 'http');
    assert.equal(spoofedWorker.worker.connection.trustedProxy, false);
    assert.equal(spoofedWorker.worker.connection.proxyAuthenticated, false);

    const capabilities = await (await fetch(`${controlUrl}/api/capabilities`, { headers })).json();
    assert.equal(capabilities.controlUrl, 'https://control.example.com');
    assert.equal(capabilities.surfaces.dashboard, 'https://control.example.com/dashboard');
    assert.equal(capabilities.networking.trustedProxy.currentRequestAuthenticated, true);
    assert.equal(capabilities.networking.trustedProxy.secretConfigured, true);
    assert.equal(JSON.stringify(capabilities).includes(proxySecret), false);

    const network = await (await fetch(`${controlUrl}/api/network`, { headers })).json();
    assert.equal(network.trustProxy, true);
    assert.equal(network.proxyAuthenticated, true);
    assert.equal(JSON.stringify(network).includes(proxySecret), false);
    assert.equal(network.requestUrl, 'https://control.example.com');
    assert.equal(network.requestProtocol, 'https');
    assert.equal(network.preferredRemoteControlUrl, 'https://control.example.com');
    assert.equal(network.nextAction.code, 'generate_worker_bundle');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trusted proxy mode fails fast without a shared secret', async () => {
  const root = await makeTempDir();
  await assert.rejects(
    startControlServer({
      host: '127.0.0.1',
      port: 0,
      token: 'missing-proxy-secret-token',
      trustProxy: true,
      dataDir: path.join(root, 'control'),
    }),
    /NADO_TRUST_PROXY_SECRET/,
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('worker bootstrap bundles prefer a non-loopback control URL candidate', async () => {
  const root = await makeTempDir();
  const token = 'dashboard-candidate-url-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
    networkInterfaces: {
      Ethernet: [{ address: '192.168.56.10', family: 'IPv4', internal: false }],
    },
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const preferredControlUrl = `http://192.168.56.10:${port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    const network = await client.networkInfo();
    assert.equal(network.requestIsLoopback, true);
    assert.equal(network.remoteWorkerReady, true);
    assert.equal(network.preferredRemoteControlUrl, preferredControlUrl);

    const bundle = await client.downloadWorkerBootstrapBundle({
      issueEnrollmentToken: true,
      tokenLabel: 'candidate url bundle',
    });
    const text = bundle.bytes.toString('latin1');
    assert.match(text, new RegExp(preferredControlUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(text, new RegExp(`http://127\\.0\\.0\\.1:${port}`));

    const fixedBundle = await client.downloadWorkerBundle({
      id: 'candidate-url-worker',
      issueToken: true,
      tokenLabel: 'candidate fixed bundle',
    });
    const fixedText = fixedBundle.bytes.toString('latin1');
    assert.match(fixedText, new RegExp(preferredControlUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(fixedText, new RegExp(`http://127\\.0\\.0\\.1:${port}`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
