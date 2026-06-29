export function selectedWorkerIdForTask(task = {}) {
  return task.scheduler?.workerId || task.assignedWorkerId || null;
}

export function targetWorkerIdForTask(task = {}) {
  return task.requestedWorkerId || null;
}

export function routeStatusForTask(task = {}) {
  const selectedWorkerId = selectedWorkerIdForTask(task);
  const targetWorkerId = targetWorkerIdForTask(task);
  if (selectedWorkerId) {
    return 'selected';
  }
  if (targetWorkerId && task.scheduler?.reason === 'explicit worker requested; target not eligible') {
    return 'target_not_eligible';
  }
  if (targetWorkerId) {
    return 'waiting_for_target';
  }
  return 'unassigned';
}

export function targetEligibleForTask(task = {}) {
  const targetWorkerId = targetWorkerIdForTask(task);
  if (!targetWorkerId) {
    return selectedWorkerIdForTask(task) ? true : null;
  }
  return selectedWorkerIdForTask(task) === targetWorkerId;
}

export function routingActionHint(task = {}) {
  if (task.status !== 'queued') {
    return null;
  }
  const taskId = task.id || '<task-id>';
  const reason = task.scheduler?.reason || '';
  const candidateReasons = (task.scheduler?.candidates || [])
    .flatMap((candidate) => candidate.reasons || [])
    .filter(Boolean);
  if (reason === 'no eligible worker') {
    if (candidateReasons.some((item) => String(item).includes('capacity full'))) {
      return {
        code: 'wait_or_add_capacity',
        message: 'Wait for current work to finish, reduce requested slots, or add another matching worker with free capacity.',
        cli: `nado status --control <control-url> then nado dispatch plan --control <control-url> --task "<key>: <task>"`,
        mcp: ['nado_status', 'nado_plan_dispatch', 'nado_list_workers'],
      };
    }
    return {
      code: 'add_worker_or_relax_constraints',
      message: 'Add or resume a worker matching the required capabilities/tools/labels, or resubmit with different routing constraints.',
      cli: `nado dispatch plan --control <control-url> --task "<key>: <task>" then resubmit, or add a matching worker`,
      mcp: ['nado_list_workers', 'nado_plan_dispatch', 'nado_create_worker_bootstrap_bundle'],
    };
  }
  if (reason === 'explicit worker requested; target not eligible') {
    return {
      code: 'fix_target_or_reschedule',
      message: 'Check the explicit target worker state/capabilities, or reschedule the task to allow automatic routing.',
      cli: `nado task manage ${taskId} --action reschedule --control <control-url>`,
      mcp: ['nado_list_workers', 'nado_explain_schedule', 'nado_manage_task'],
    };
  }
  if (task.requestedWorkerId) {
    return {
      code: 'inspect_requested_worker',
      message: 'Check worker status and logs; the requested worker has not claimed the queued task yet.',
      cli: `nado worker logs --control <control-url> --id ${task.requestedWorkerId} --tail 50`,
      mcp: ['nado_list_workers', 'nado_list_worker_events'],
    };
  }
  return null;
}
