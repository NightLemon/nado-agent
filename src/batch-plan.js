import { safeName } from './utils.js';

function normalizeList(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [String(value)];
}

function parseTaskLine(value, index) {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon > 0) {
    const key = safeName(text.slice(0, colon).trim()).replace(/^[-_.]+|[-_.]+$/g, '');
    const title = text.slice(colon + 1).trim();
    return {
      key: key || `task_${index + 1}`,
      title: title || key || `Task ${index + 1}`,
      prompt: title || key || text,
    };
  }
  return {
    key: safeName(`task_${index + 1}`),
    title: text,
    prompt: text,
  };
}

function renderTemplate(template, task) {
  return String(template)
    .replaceAll('{key}', task.key)
    .replaceAll('{title}', task.title)
    .replaceAll('{prompt}', task.prompt);
}

export function buildBatchPlan(input = {}) {
  const lines = normalizeList(input.tasks || input.task || input.lines)
    .map((line, index) => parseTaskLine(line, index))
    .filter(Boolean);
  if (!lines.length) {
    throw new Error('Batch plan requires at least one task line');
  }

  const type = input.type || 'agent';
  const defaults = {
    ...(input.defaults || {}),
  };
  if (input.workerId) {
    defaults.workerId = input.workerId;
  }
  if (input.capabilities?.length) {
    defaults.capabilities = input.capabilities;
  }
  if (input.tools?.length) {
    defaults.tools = input.tools;
  }
  if (input.labels && Object.keys(input.labels).length) {
    defaults.labels = input.labels;
  }
  if (input.slots !== undefined) {
    defaults.slots = Number(input.slots);
  }
  if (input.priority !== undefined) {
    defaults.priority = Number(input.priority);
  }
  if (input.keepWorkspace !== undefined) {
    defaults.keepWorkspace = Boolean(input.keepWorkspace);
  }
  if (input.sandboxProfile) {
    defaults.sandboxProfile = input.sandboxProfile;
  }

  const commandTemplate = input.commandTemplate || null;
  const tasks = lines.map((task) => {
    const planned = {
      key: task.key,
      title: task.title,
      type,
    };
    if (type === 'shell') {
      planned.command = commandTemplate
        ? renderTemplate(commandTemplate, task)
        : `echo ${JSON.stringify(`TODO ${task.key}: ${task.title}`)}`;
    } else {
      planned.prompt = task.prompt;
    }
    return planned;
  });

  return {
    title: input.title || 'planned batch',
    defaults,
    tasks,
  };
}
