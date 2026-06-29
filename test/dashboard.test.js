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
    const html = await response.text();
    assert.match(html, /Nado Control/);
    assert.match(html, /aria-label="NADO_TOKEN"/);
    assert.doesNotMatch(html, /dashboard-token/);
    assert.match(html, /id="locale"/);
    assert.match(html, /zh-CN/);
    assert.match(html, /工作端接入/);
    assert.match(html, /readinessStrip/);
    assert.match(html, /renderControlReadiness/);
    assert.match(html, /Remote Workers/);
    assert.match(html, /Verified terminal agent ready/);
    assert.match(html, /IPv6 literals must use brackets/);
    assert.match(html, /GPU worker advertised only/);
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
    assert.match(html, /workbench-access-tab-v1/);
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
    assert.match(html, /Doctor/);
    assert.match(html, /Readiness Verify/);
    assert.match(html, /Agent Context/);
    assert.match(html, /Gateway Manifest/);
    assert.match(html, /MCP Config/);
    assert.match(html, /Offline Recovery/);
    assert.match(html, /Submit Task/);
    assert.match(html, /Distributed Planner/);
    assert.match(html, /plannerForm/);
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
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
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
    const status = await client.status();
    assert.equal(status.workers.total, 0);
    const capabilities = await client.capabilities();
    assert.equal(capabilities.name, 'nado-agent');
    assert.equal(capabilities.auth.type, 'bearer');
    assert.ok(capabilities.mcp.tools.includes('nado_capabilities'));
    assert.ok(capabilities.mcp.tools.includes('nado_demo_health'));
    assert.equal(capabilities.features.workerPreflight, true);
    assert.equal(capabilities.features.workerEvents, true);
    assert.equal(capabilities.features.workerBundles, true);
    assert.equal(capabilities.features.workerSelfServiceEnrollment, true);
    assert.equal(capabilities.features.signedWorkerRequests, true);
    assert.equal(capabilities.features.batches, true);
    assert.equal(capabilities.features.eventStreams, true);
    assert.equal(capabilities.features.groupedArtifactZipDownload, true);
    assert.equal(capabilities.features.doctorAgentSelfTest, true);
    assert.equal(capabilities.features.readinessVerification, true);
    assert.equal(capabilities.features.demoHealth, true);
    assert.equal(capabilities.features.dispatchPlanning, true);
    assert.equal(capabilities.features.requireRoutableSubmit, true);
    assert.equal(capabilities.features.routingActionHints, true);
    assert.equal(capabilities.features.workerResourceDiagnostics, true);
    assert.equal(capabilities.features.workerReadinessDiagnostics, true);
    assert.equal(capabilities.features.cliSubmitFlow, true);
    assert.equal(capabilities.features.cliBatchSubmitFlow, true);
    assert.equal(capabilities.features.mcpRunTaskFlow, true);
    assert.equal(capabilities.features.mcpRunBatchFlow, true);
    assert.equal(capabilities.features.distributedTaskPlanning, true);
    assert.equal(capabilities.features.ipv6ControlUrls, true);
    assert.equal(capabilities.features.networkActionHints, true);
    assert.equal(capabilities.features.trustedProxyHeaders, true);
    assert.deepEqual(capabilities.features.autoCapabilityRouting, ['gpu', 'docs', 'ppt']);
    assert.equal(capabilities.networking.ipv6LiteralUrls, true);
    assert.equal(capabilities.networking.ipv6LiteralFormat, 'http://[2001:db8::10]:8765');
    assert.equal(capabilities.networking.trustProxyEnv, 'NADO_TRUST_PROXY');
    assert.deepEqual(capabilities.networking.trustedProxyHeaders, ['X-Forwarded-Host', 'X-Forwarded-Proto']);
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
    assert.match(capabilities.endpoints.tasks.artifactDownload, /download/);
    assert.match(capabilities.endpoints.tasks.artifactsJson, /artifacts\/content/);
    assert.match(capabilities.endpoints.tasks.artifactsZip, /artifacts\/download/);
    assert.equal(capabilities.features.taskHistoryPruning, true);
    assert.equal(capabilities.features.systemHistoryPruning, true);
    assert.equal(capabilities.features.workerEnrollmentTokenPruning, true);
    assert.ok(capabilities.features.workerManagement.includes('forget'));
    assert.equal(capabilities.endpoints.tasks.prune, 'POST /api/tasks/prune');
    assert.equal(capabilities.endpoints.tasks.systemPrune, 'POST /api/system-history/prune');
    assert.equal(capabilities.endpoints.sessions.pruneEmptyPreview, 'GET /api/sessions/prune-empty');
    assert.equal(capabilities.endpoints.sessions.pruneEmpty, 'POST /api/sessions/prune-empty');
    assert.equal(capabilities.endpoints.verify, 'POST /api/verify');
    assert.equal(capabilities.endpoints.demoHealth, 'POST /api/demo/health');
    assert.equal(capabilities.endpoints.network, 'GET /api/network');
    assert.equal(capabilities.endpoints.dispatch.plan, 'POST /api/dispatch/plan');
    assert.equal(capabilities.endpoints.planner.plan, 'POST /api/planner/plan');
    assert.equal(capabilities.endpoints.planner.run, 'POST /api/planner/run');
    assert.equal(capabilities.workers.length, 0);
    const network = await client.networkInfo();
    assert.equal(network.requestUrl, controlUrl);
    assert.equal(network.requestIsLoopback, true);
    assert.ok(Array.isArray(network.candidates));
    const context = await client.context();
    assert.match(context, /Nado Agent Control Context/);
    assert.match(context, /No workers registered yet/);
    assert.match(context, /## MCP Tools/);
    assert.match(context, /## Routing Policy/);
    assert.match(context, /http:\/\/\[2001:db8::10\]:8765/);
    assert.match(context, /gpu: inferred from title, prompt, description, command/);
    assert.match(context, /agent readiness diagnostics/);
    assert.match(context, /one-click GPU\/docs\/PPT route checks/);
    assert.match(context, /real Stop Task cancellation/);
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
    assert.ok(byCapability.gpu.warnings.some((warning) => /no NVIDIA\/ROCm probe/.test(warning)));
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
    assert.match(html, /localStorage\.setItem\('nadoToken', bootstrapToken\)/);
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
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    trustProxy: true,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Bearer ${token}`,
    'x-forwarded-host': 'control.example.com',
    'x-forwarded-proto': 'https',
  };

  try {
    const capabilities = await (await fetch(`${controlUrl}/api/capabilities`, { headers })).json();
    assert.equal(capabilities.controlUrl, 'https://control.example.com');
    assert.equal(capabilities.surfaces.dashboard, 'https://control.example.com/dashboard');

    const network = await (await fetch(`${controlUrl}/api/network`, { headers })).json();
    assert.equal(network.trustProxy, true);
    assert.equal(network.requestUrl, 'https://control.example.com');
    assert.equal(network.requestProtocol, 'https');
    assert.equal(network.preferredRemoteControlUrl, 'https://control.example.com');
    assert.equal(network.nextAction.code, 'generate_worker_bundle');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
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
