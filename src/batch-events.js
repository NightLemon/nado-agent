export function batchEventRows(batch, tasks) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const rows = [];
  for (const [index, event] of (batch.events || []).entries()) {
    const task = event.taskId ? taskById.get(event.taskId) : null;
    rows.push({
      at: event.at,
      source: 'batch',
      task: task ? task.batchKey || task.id : event.taskId || '-',
      taskId: event.taskId || null,
      type: event.type,
      workerId: event.workerId || '-',
      message: event.message || '',
      order: index,
    });
  }
  for (const task of tasks) {
    for (const [index, event] of (task.events || []).entries()) {
      rows.push({
        at: event.at,
        source: 'task',
        task: task.batchKey || task.id,
        taskId: task.id,
        type: event.type,
        workerId: event.workerId || task.assignedWorkerId || task.requestedWorkerId || '-',
        message: event.message || '',
        order: index,
      });
    }
  }
  return rows.sort((a, b) => (
    String(a.at || '').localeCompare(String(b.at || ''))
    || a.source.localeCompare(b.source)
    || String(a.task || '').localeCompare(String(b.task || ''))
    || a.order - b.order
  ));
}
