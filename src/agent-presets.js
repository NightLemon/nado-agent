export const AGENT_PRESETS = {
  codex: {
    name: 'codex',
    description: 'OpenAI Codex CLI, reading the generated prompt file as the exec prompt on bash-like worker shells.',
    command: 'codex exec --skip-git-repo-check --sandbox workspace-write -- "$(cat {promptFile})"',
  },
  claude: {
    name: 'claude',
    description: 'Claude Code CLI print mode, reading the generated prompt file on bash-like worker shells.',
    command: 'claude -p --permission-mode acceptEdits --allowedTools=default "$(cat {promptFile})" < /dev/null',
  },
  'node-copy': {
    name: 'node-copy',
    description: 'Local test adapter that copies the generated prompt file to agent-output.md.',
    command: 'node -e "const fs=require(\'fs\'); const p=process.argv[1]; fs.writeFileSync(\'agent-output.md\', fs.readFileSync(p,\'utf8\'))" {promptFile}',
  },
};

export function listAgentPresets() {
  return Object.values(AGENT_PRESETS);
}

export function resolveAgentPreset(name) {
  if (!name) {
    return null;
  }
  const normalized = String(name).trim().toLowerCase();
  const preset = AGENT_PRESETS[normalized];
  if (!preset) {
    throw new Error(`Unknown agent preset: ${name}. Available presets: ${Object.keys(AGENT_PRESETS).join(', ')}`);
  }
  return preset;
}

export function resolveAgentCommand({ agentCommand, agentPreset } = {}) {
  if (agentCommand) {
    return {
      agentCommand,
      agentPreset: agentPreset || null,
    };
  }
  const preset = resolveAgentPreset(agentPreset);
  if (!preset) {
    return {
      agentCommand: null,
      agentPreset: null,
    };
  }
  return {
    agentCommand: preset.command,
    agentPreset: preset.name,
  };
}
