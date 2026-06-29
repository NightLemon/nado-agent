import { fileURLToPath } from 'node:url';

const DEFAULT_CLI_FILE = fileURLToPath(new URL('./cli.js', import.meta.url));

export function buildMcpClientConfig({
  controlUrl,
  token,
  name = 'nado',
  cliFile = DEFAULT_CLI_FILE,
  nodePath = process.execPath,
} = {}) {
  return {
    mcpServers: {
      [name]: {
        command: nodePath,
        args: [
          cliFile,
          'mcp',
          '--control',
          controlUrl,
        ],
        env: {
          NADO_TOKEN: token || '',
        },
      },
    },
  };
}

export function shellQuote(value, platform = process.platform) {
  const text = String(value);
  if (platform === 'win32') {
    return `"${text.replace(/"/g, '\\"')}"`;
  }
  return `'${text.replace(/'/g, "'\"'\"'")}'`;
}

export function formatMcpCommand(config, name = 'nado', platform = process.platform) {
  const server = config.mcpServers[name];
  if (!server) {
    throw new Error(`Unknown MCP server config: ${name}`);
  }
  const token = server.env?.NADO_TOKEN || '';
  const envPrefix = platform === 'win32'
    ? `$env:NADO_TOKEN=${shellQuote(token, platform)}; `
    : `NADO_TOKEN=${shellQuote(token, platform)} `;
  return `${envPrefix}${shellQuote(server.command, platform)} ${server.args.map((arg) => shellQuote(arg, platform)).join(' ')}`;
}
