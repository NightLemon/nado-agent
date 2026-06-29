const TASK_STATUSES = ['queued', 'blocked', 'running', 'succeeded', 'failed', 'cancelled'];

function normalizeArtifactGroups(groups) {
  if (!groups) {
    return new Map();
  }
  if (groups instanceof Map) {
    return groups;
  }
  return new Map(Object.entries(groups));
}

function tailText(value, maxChars) {
  const text = String(value || '');
  if (!text || maxChars <= 0) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `...[last ${maxChars} chars]\n${text.slice(text.length - maxChars)}`;
}

function oneLine(value, maxChars = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

function taskLabel(task) {
  return task.batchKey || task.id;
}

function latestEvent(task) {
  const events = task.events || [];
  return events.length ? events[events.length - 1] : null;
}

export function buildBatchReport(batch, tasks, options = {}) {
  const artifactGroups = normalizeArtifactGroups(options.artifactGroups);
  const stdoutChars = Number(options.stdoutChars ?? 1_200);
  const stderrChars = Number(options.stderrChars ?? 1_200);
  const counts = {};
  for (const status of TASK_STATUSES) {
    counts[status] = batch.counts?.[status] || 0;
  }

  const taskReports = tasks.map((task) => {
    const artifacts = artifactGroups.get(task.id) || task.artifacts || [];
    const storedArtifacts = artifacts.filter((artifact) => !artifact.skipped);
    const skippedArtifacts = artifacts.filter((artifact) => artifact.skipped);
    const lastEvent = latestEvent(task);
    return {
      taskId: task.id,
      batchKey: task.batchKey || null,
      label: taskLabel(task),
      title: task.title,
      status: task.status,
      workerId: task.assignedWorkerId || task.requestedWorkerId || null,
      requestedWorkerId: task.requestedWorkerId || null,
      assignedWorkerId: task.assignedWorkerId || null,
      requiredCapabilities: task.requiredCapabilities || [],
      requiredLabels: task.requiredLabels || {},
      priority: task.priority || 0,
      dependencyKeys: task.dependencyKeys || [],
      dependsOnTaskIds: task.dependsOnTaskIds || [],
      blockedReason: task.blockedReason || null,
      exitCode: task.exitCode ?? null,
      error: task.error || null,
      stdoutTail: tailText(task.stdout, stdoutChars),
      stderrTail: tailText(task.stderr, stderrChars),
      artifactCount: storedArtifacts.length,
      skippedArtifactCount: skippedArtifacts.length,
      artifacts: storedArtifacts.map((artifact) => ({
        id: artifact.id,
        path: artifact.path,
        size: artifact.size,
        sha256: artifact.sha256 || null,
      })),
      skippedArtifacts: skippedArtifacts.map((artifact) => ({
        id: artifact.id,
        path: artifact.path,
        reason: artifact.reason || null,
      })),
      latestEvent: lastEvent ? {
        at: lastEvent.at,
        type: lastEvent.type,
        workerId: lastEvent.workerId || task.assignedWorkerId || task.requestedWorkerId || null,
        message: lastEvent.message || '',
      } : null,
    };
  });

  const problemTasks = taskReports.filter((task) => ['failed', 'cancelled'].includes(task.status));
  const blockedTasks = taskReports.filter((task) => task.status === 'blocked');
  const runningTasks = taskReports.filter((task) => task.status === 'running');
  const queuedTasks = taskReports.filter((task) => task.status === 'queued');
  const artifactTotal = taskReports.reduce((sum, task) => sum + task.artifactCount, 0);

  return {
    batch: {
      id: batch.id,
      title: batch.title,
      status: batch.status,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      totalTasks: batch.totalTasks,
      completedTasks: batch.completedTasks,
      counts,
      artifactTotal,
    },
    tasks: taskReports,
    problemTasks,
    blockedTasks,
    runningTasks,
    queuedTasks,
    nextActions: suggestNextActions(batch, { problemTasks, blockedTasks, runningTasks, queuedTasks }),
  };
}

function suggestNextActions(batch, groups) {
  const actions = [];
  if (batch.status === 'completed_with_errors' && groups.problemTasks.length) {
    actions.push('Review failed/cancelled task stderr and run batch manage --action retry_failed after fixing routing or command issues.');
  }
  if (groups.blockedTasks.length) {
    actions.push('Resolve failed dependency parents first; blocked child tasks will unblock automatically after dependencies succeed.');
  }
  if (groups.runningTasks.length || groups.queuedTasks.length) {
    actions.push('Use batch events --watch for live progress and batch wait to block until the batch is terminal.');
  }
  if (batch.status === 'succeeded') {
    actions.push('Download or inspect artifacts; all child tasks reached succeeded.');
  }
  return actions;
}

export function formatBatchReport(report) {
  const lines = [];
  const counts = report.batch.counts;
  lines.push(`batch=${report.batch.id}`);
  lines.push(`title=${report.batch.title}`);
  lines.push(`status=${report.batch.status}`);
  lines.push(`completed=${report.batch.completedTasks}/${report.batch.totalTasks}`);
  lines.push(`counts=queued:${counts.queued} blocked:${counts.blocked} running:${counts.running} succeeded:${counts.succeeded} failed:${counts.failed} cancelled:${counts.cancelled}`);
  lines.push(`artifacts=${report.batch.artifactTotal}`);

  if (report.problemTasks.length) {
    lines.push('');
    lines.push('Problems:');
    for (const task of report.problemTasks) {
      lines.push(`- ${task.label} status=${task.status} worker=${task.workerId || '-'} exit=${task.exitCode ?? '-'} error=${oneLine(task.error) || '-'}`);
    }
  }

  if (report.blockedTasks.length) {
    lines.push('');
    lines.push('Blocked:');
    for (const task of report.blockedTasks) {
      lines.push(`- ${task.label} dependsOn=${task.dependencyKeys.join(',') || '-'} reason=${oneLine(task.blockedReason) || '-'}`);
    }
  }

  lines.push('');
  lines.push('Tasks:');
  for (const task of report.tasks) {
    const artifacts = task.artifacts.map((artifact) => artifact.path).join(',') || '-';
    lines.push(`- ${task.label} status=${task.status} worker=${task.workerId || '-'} artifacts=${artifacts} title=${task.title}`);
  }

  const outputTasks = report.tasks.filter((task) => task.stdoutTail || task.stderrTail || task.error);
  if (outputTasks.length) {
    lines.push('');
    lines.push('Output excerpts:');
    for (const task of outputTasks) {
      lines.push(`## ${task.label}`);
      if (task.stdoutTail) {
        lines.push('stdout:');
        lines.push(task.stdoutTail.trimEnd());
      }
      if (task.stderrTail) {
        lines.push('stderr:');
        lines.push(task.stderrTail.trimEnd());
      }
      if (task.error) {
        lines.push(`error: ${task.error}`);
      }
    }
  }

  if (report.nextActions.length) {
    lines.push('');
    lines.push('Next actions:');
    for (const action of report.nextActions) {
      lines.push(`- ${action}`);
    }
  }

  return lines.join('\n');
}
