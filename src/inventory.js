import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function optionalNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeLinuxTemperatureC(value) {
  const parsed = optionalNumber(value);
  if (parsed === null) {
    return null;
  }
  const celsius = Math.abs(parsed) >= 1_000 ? parsed / 1_000 : parsed;
  return celsius >= -40 && celsius <= 200 ? Math.round(celsius * 10) / 10 : null;
}

export function parseWindowsThermalOutput(output = '') {
  return String(output || '').trim().split(/\r?\n/).filter(Boolean).map((line, index) => {
    const separator = line.lastIndexOf(',');
    const name = separator >= 0 ? line.slice(0, separator).trim() : `ACPI thermal zone ${index}`;
    const raw = optionalNumber(separator >= 0 ? line.slice(separator + 1) : line);
    const temperatureC = raw === null ? null : Math.round(((raw / 10) - 273.15) * 10) / 10;
    return {
      name: name || `ACPI thermal zone ${index}`,
      source: 'windows-acpi',
      temperatureC,
    };
  }).filter((item) => item.temperatureC !== null && item.temperatureC >= -40 && item.temperatureC <= 200);
}

export function parseWindowsHardwareMonitorOutput(output = '') {
  let payload;
  try {
    payload = JSON.parse(String(output || '').trim());
  } catch {
    return [];
  }
  const sensors = Array.isArray(payload) ? payload : payload?.sensors;
  if (!Array.isArray(sensors)) {
    return [];
  }
  const seen = new Set();
  const temperatures = [];
  for (const [index, sensor] of sensors.slice(0, 1_024).entries()) {
    if (!sensor || typeof sensor !== 'object') {
      continue;
    }
    const temperature = optionalNumber(sensor.temperatureC ?? sensor.value);
    if (temperature === null || temperature < -40 || temperature > 200) {
      continue;
    }
    const temperatureC = Math.round(temperature * 10) / 10;
    const name = String(sensor.name || '').trim() || `Windows temperature sensor ${index}`;
    const source = String(sensor.source || '').trim() || 'windows-hardware-monitor';
    const identifier = String(sensor.identifier || '').trim().toLowerCase();
    const key = identifier || `${name.toLowerCase()}\0${temperatureC}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    temperatures.push({ name, source, temperatureC });
    if (temperatures.length >= 256) {
      break;
    }
  }
  return temperatures;
}

function sysfsDirectory(entry) {
  return entry.isDirectory() || entry.isSymbolicLink();
}

async function probeLinuxThermalZones(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const zones = await Promise.all(entries
      .filter((entry) => sysfsDirectory(entry) && entry.name.startsWith('thermal_zone'))
      .map(async (entry) => {
        const directory = `${root}/${entry.name}`;
        try {
          const [type, temperature] = await Promise.all([
            fs.readFile(`${directory}/type`, 'utf8').catch(() => entry.name),
            fs.readFile(`${directory}/temp`, 'utf8'),
          ]);
          return {
            name: String(type).trim() || entry.name,
            source: 'linux-sysfs',
            temperatureC: normalizeLinuxTemperatureC(temperature),
          };
        } catch {
          return null;
        }
      }));
    return zones.filter((item) => item && item.temperatureC !== null);
  } catch {
    return [];
  }
}

async function probeLinuxHwmonTemperatures(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const devices = entries
      .filter((entry) => sysfsDirectory(entry) && entry.name.startsWith('hwmon'))
      .slice(0, 64);
    const temperatures = await Promise.all(devices.map(async (entry) => {
      const directory = `${root}/${entry.name}`;
      try {
        const [chipNameRaw, files] = await Promise.all([
          fs.readFile(`${directory}/name`, 'utf8').catch(() => entry.name),
          fs.readdir(directory, { withFileTypes: true }),
        ]);
        const chipName = String(chipNameRaw).trim() || entry.name;
        const inputs = files
          .filter((file) => file.isFile() && /^temp\d+_input$/.test(file.name))
          .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
          .slice(0, 64);
        return Promise.all(inputs.map(async (input) => {
          const sensor = input.name.slice(0, -'_input'.length);
          try {
            const [temperature, labelRaw] = await Promise.all([
              fs.readFile(`${directory}/${input.name}`, 'utf8'),
              fs.readFile(`${directory}/${sensor}_label`, 'utf8').catch(() => sensor),
            ]);
            const label = String(labelRaw).trim() || sensor;
            return {
              name: label.toLowerCase().startsWith(chipName.toLowerCase())
                ? label
                : `${chipName}: ${label}`,
              source: 'linux-hwmon',
              temperatureC: normalizeLinuxTemperatureC(temperature),
            };
          } catch {
            return null;
          }
        }));
      } catch {
        return [];
      }
    }));
    return temperatures.flat().filter((item) => item && item.temperatureC !== null).slice(0, 256);
  } catch {
    return [];
  }
}

function dedupeTemperatures(items) {
  const unique = new Map();
  for (const item of items) {
    const key = `${String(item.name || '').trim().toLowerCase()}\0${item.temperatureC}`;
    if (!unique.has(key)) {
      unique.set(key, item);
    }
  }
  return [...unique.values()];
}

export async function probeLinuxTemperatures(options = {}) {
  const thermalRoot = options.thermalRoot || '/sys/class/thermal';
  const hwmonRoot = options.hwmonRoot || '/sys/class/hwmon';
  const [hwmon, thermalZones] = await Promise.all([
    probeLinuxHwmonTemperatures(hwmonRoot),
    probeLinuxThermalZones(thermalRoot),
  ]);
  return dedupeTemperatures([...hwmon, ...thermalZones]);
}

const WINDOWS_TEMPERATURE_COMMAND = `
$ErrorActionPreference = "SilentlyContinue"
$sensors = @()
$providers = @(
  [pscustomobject]@{ Namespace = "root/LibreHardwareMonitor"; Source = "windows-libre-hardware-monitor" },
  [pscustomobject]@{ Namespace = "root/OpenHardwareMonitor"; Source = "windows-open-hardware-monitor" }
)
foreach ($provider in $providers) {
  $items = @(Get-CimInstance -Namespace $provider.Namespace -ClassName Sensor -ErrorAction SilentlyContinue | Where-Object { $_.SensorType -eq "Temperature" })
  foreach ($item in $items) {
    $parent = [string]$item.Parent
    $sensorName = [string]$item.Name
    $displayName = if ($parent) { "$($parent): $($sensorName)" } else { $sensorName }
    $sensors += [pscustomobject]@{
      name = $displayName
      source = $provider.Source
      identifier = [string]$item.Identifier
      temperatureC = [double]$item.Value
    }
  }
}
$acpiItems = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue)
foreach ($item in $acpiItems) {
  $sensors += [pscustomobject]@{
    name = [string]$item.InstanceName
    source = "windows-acpi"
    identifier = [string]$item.InstanceName
    temperatureC = [math]::Round((([double]$item.CurrentTemperature / 10) - 273.15), 1)
  }
}
[pscustomobject]@{ sensors = @($sensors) } | ConvertTo-Json -Compress -Depth 4
`.trim();

export async function probeWindowsTemperatures(options = {}) {
  const execute = options.execFileAsync || execFileAsync;
  try {
    const { stdout } = await execute('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_TEMPERATURE_COMMAND,
    ], {
      timeout: options.timeoutMs || 3_000,
      windowsHide: true,
    });
    return parseWindowsHardwareMonitorOutput(stdout);
  } catch {
    return [];
  }
}

export function parseMacOsCpuTemperatureOutput(output = '') {
  const lines = String(output || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .slice(0, 64);
  for (const line of lines) {
    const match = line.match(/^\s*(?:(?:cpu(?:\s+(?:package|proximity|temperature))?|temperature)\s*[:=]\s*)?(-?\d+(?:\.\d+)?)\s*(?:°\s*)?c(?:elsius)?\s*$/i);
    if (!match) {
      continue;
    }
    const temperature = optionalNumber(match[1]);
    if (temperature === null || temperature < -40 || temperature > 200) {
      continue;
    }
    return [{
      name: 'CPU temperature',
      source: 'macos-osx-cpu-temp',
      temperatureC: Math.round(temperature * 10) / 10,
    }];
  }
  return [];
}

export async function probeMacOsTemperatures(options = {}) {
  const execute = options.execFileAsync || execFileAsync;
  try {
    const { stdout } = await execute(options.command || 'osx-cpu-temp', options.args || [], {
      timeout: options.timeoutMs ?? 3_000,
      maxBuffer: 64 * 1_024,
      windowsHide: true,
    });
    return parseMacOsCpuTemperatureOutput(stdout);
  } catch {
    return [];
  }
}

export async function probeHostTemperatures(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'linux') {
    return probeLinuxTemperatures(options);
  }
  if (platform === 'win32') {
    return probeWindowsTemperatures(options);
  }
  if (platform === 'darwin') {
    return probeMacOsTemperatures(options);
  }
  return [];
}

export function parseNvidiaGpuCsv(output = '') {
  return String(output || '').trim().split(/\r?\n/).filter(Boolean).map((line, fallbackIndex) => {
    const [index, name, memoryTotalMiB, memoryFreeMiB, temperatureC, utilizationPercent] = line
      .split(',')
      .map((value) => value.trim());
    const total = optionalNumber(memoryTotalMiB);
    const free = optionalNumber(memoryFreeMiB);
    return {
      index: optionalNumber(index) ?? fallbackIndex,
      vendor: 'nvidia',
      name: name || `NVIDIA GPU ${fallbackIndex}`,
      memoryTotalBytes: total === null ? 0 : Math.round(total * MIB),
      memoryFreeBytes: free === null ? null : Math.round(free * MIB),
      temperatureC: optionalNumber(temperatureC),
      utilizationPercent: optionalNumber(utilizationPercent),
    };
  });
}

function rocmNumber(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/-?[0-9]+(?:\.[0-9]+)?/);
  return match ? optionalNumber(match[0]) : null;
}

function rocmBytes(value, key = '') {
  const parsed = rocmNumber(value);
  if (parsed === null) {
    return null;
  }
  const text = `${key} ${value}`.toLowerCase();
  if (/\bgib\b/.test(text)) return Math.round(parsed * GIB);
  if (/\bmib\b/.test(text)) return Math.round(parsed * MIB);
  if (/\bkib\b/.test(text)) return Math.round(parsed * 1024);
  if (/\bgb\b/.test(text)) return Math.round(parsed * 1_000 ** 3);
  if (/\bmb\b/.test(text)) return Math.round(parsed * 1_000 ** 2);
  if (/\bkb\b/.test(text)) return Math.round(parsed * 1_000);
  return Math.round(parsed);
}

function rocmField(entries, predicate, preferred = () => false) {
  const matches = entries.filter(([key]) => predicate(key.toLowerCase()));
  return matches.find(([key]) => preferred(key.toLowerCase())) || matches[0] || null;
}

export function parseRocmSmiJson(output = '') {
  const text = String(output || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) {
    return [];
  }
  let payload;
  try {
    payload = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  return Object.entries(payload).flatMap(([card, raw], fallbackIndex) => {
    const values = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const entries = Object.entries(values);
    const deviceFields = entries.some(([key]) => /card series|card model|device name|product name|vram|temperature|gpu use|gpu utilization/i.test(key));
    if (!deviceFields) {
      return [];
    }
    const nameField = rocmField(entries, (key) => (
      key.includes('card series')
      || key.includes('card model')
      || key.includes('device name')
      || key.includes('product name')
    ), (key) => key.includes('card series') || key.includes('device name'));
    const totalField = rocmField(entries, (key) => (
      key.includes('vram') && key.includes('total') && key.includes('memory') && !key.includes('used')
    ));
    const usedField = rocmField(entries, (key) => (
      key.includes('vram') && key.includes('used') && key.includes('memory')
    ));
    const temperatureField = rocmField(entries, (key) => key.includes('temperature'), (key) => key.includes('edge'));
    const utilizationField = rocmField(entries, (key) => key.includes('gpu use') || key.includes('gpu utilization'));
    const memoryTotalBytes = totalField ? rocmBytes(totalField[1], totalField[0]) : 0;
    const memoryUsedBytes = usedField ? rocmBytes(usedField[1], usedField[0]) : null;
    const indexMatch = String(card).match(/\d+/);
    return [{
      index: indexMatch ? Number(indexMatch[0]) : fallbackIndex,
      vendor: 'amd',
      name: String(nameField?.[1] || '').trim() || `AMD GPU ${fallbackIndex}`,
      memoryTotalBytes: memoryTotalBytes || 0,
      memoryFreeBytes: memoryTotalBytes && memoryUsedBytes !== null
        ? Math.max(0, memoryTotalBytes - memoryUsedBytes)
        : null,
      temperatureC: temperatureField ? rocmNumber(temperatureField[1]) : null,
      utilizationPercent: utilizationField ? rocmNumber(utilizationField[1]) : null,
    }];
  });
}

function parseJsonPayload(output = '') {
  const text = String(output || '').trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    // Some AMD SMI releases print diagnostics before the JSON document.
  }
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '[' || text[index] === '{') {
      starts.push(index);
    }
  }
  for (const start of starts) {
    const close = text[start] === '[' ? ']' : '}';
    const end = text.lastIndexOf(close);
    if (end <= start) {
      continue;
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Continue past a diagnostic bracket and try the next candidate.
    }
  }
  return null;
}

function normalizedFieldName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function objectField(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const wanted = normalizedFieldName(name);
  const key = Object.keys(value).find((item) => normalizedFieldName(item) === wanted);
  return key === undefined ? undefined : value[key];
}

function pathField(value, path) {
  let current = value;
  for (const part of path) {
    current = objectField(current, part);
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function firstPath(rows, paths) {
  for (const row of rows) {
    for (const path of paths) {
      const value = pathField(row, path);
      if (value !== undefined && value !== null && value !== 'N/A') {
        return value;
      }
    }
  }
  return undefined;
}

function amdScalar(value) {
  const wrapped = objectField(value, 'value');
  return wrapped === undefined ? value : wrapped;
}

function amdNumber(value) {
  return rocmNumber(amdScalar(value));
}

function amdBytes(value, key = '') {
  const unit = objectField(value, 'unit');
  return rocmBytes(amdScalar(value), `${key} ${unit || ''}`);
}

function amdGpuRows(output) {
  const payload = parseJsonPayload(output);
  const candidates = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (objectField(payload, 'gpu') !== undefined ? [payload] : Object.values(payload))
      : [];
  return candidates.filter((row) => (
    row
    && typeof row === 'object'
    && !Array.isArray(row)
    && objectField(row, 'gpu') !== undefined
  ));
}

export function parseAmdSmiJson(staticOutput = '', metricOutput = '') {
  const staticRows = amdGpuRows(staticOutput);
  const metricRows = amdGpuRows(metricOutput);
  const rowsByIndex = new Map();
  for (const [source, rows] of [['static', staticRows], ['metric', metricRows]]) {
    rows.forEach((row, fallbackIndex) => {
      const index = amdNumber(objectField(row, 'gpu')) ?? fallbackIndex;
      const current = rowsByIndex.get(index) || {};
      current[source] = row;
      rowsByIndex.set(index, current);
    });
  }
  return [...rowsByIndex.entries()].sort(([left], [right]) => left - right).map(([index, rows]) => {
    const sources = [rows.metric, rows.static].filter(Boolean);
    const nameValue = firstPath([rows.static, rows.metric].filter(Boolean), [
      ['asic', 'market_name'],
      ['asic', 'market name'],
      ['asic', 'product_name'],
      ['asic', 'name'],
      ['market_name'],
      ['product_name'],
      ['name'],
    ]);
    const totalValue = firstPath(sources, [
      ['mem_usage', 'total_vram'],
      ['memory', 'total_vram'],
      ['vram', 'size'],
      ['vram_total'],
      ['memory_total'],
    ]);
    const usedValue = firstPath(sources, [
      ['mem_usage', 'used_vram'],
      ['memory', 'used_vram'],
      ['vram_used'],
      ['memory_used'],
    ]);
    const freeValue = firstPath(sources, [
      ['mem_usage', 'free_vram'],
      ['memory', 'free_vram'],
      ['vram_free'],
      ['memory_free'],
    ]);
    const temperatureValue = firstPath(sources, [
      ['temperature', 'edge'],
      ['temperature', 'hotspot'],
      ['temperature', 'junction'],
      ['edge_temperature'],
      ['hotspot_temperature'],
      ['temperature_hotspot'],
    ]);
    const utilizationValue = firstPath(sources, [
      ['usage', 'gfx_activity'],
      ['usage', 'average_gfx_activity'],
      ['usage', 'gfx'],
      ['gfx_activity'],
      ['average_gfx_activity'],
      ['gfx'],
    ]);
    const memoryTotalBytes = totalValue === undefined ? 0 : (amdBytes(totalValue, 'vram total') || 0);
    const memoryUsedBytes = usedValue === undefined ? null : amdBytes(usedValue, 'vram used');
    const explicitFreeBytes = freeValue === undefined ? null : amdBytes(freeValue, 'vram free');
    return {
      index,
      vendor: 'amd',
      name: String(amdScalar(nameValue) || '').trim() || `AMD GPU ${index}`,
      memoryTotalBytes,
      memoryFreeBytes: explicitFreeBytes !== null
        ? explicitFreeBytes
        : memoryTotalBytes && memoryUsedBytes !== null
          ? Math.max(0, memoryTotalBytes - memoryUsedBytes)
          : null,
      temperatureC: temperatureValue === undefined ? null : amdNumber(temperatureValue),
      utilizationPercent: utilizationValue === undefined ? null : amdNumber(utilizationValue),
    };
  });
}

async function probeNvidiaGpus() {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=index,name,memory.total,memory.free,temperature.gpu,utilization.gpu',
      '--format=csv,noheader,nounits',
    ], {
      timeout: 2_000,
      windowsHide: true,
    });
    return parseNvidiaGpuCsv(stdout);
  } catch {
    return [];
  }
}

async function probeRocmGpus() {
  try {
    const { stdout } = await execFileAsync('rocm-smi', [
      '--showproductname',
      '--showmeminfo', 'vram',
      '--showtemp',
      '--showuse',
      '--json',
    ], {
      timeout: 2_000,
      windowsHide: true,
    });
    return parseRocmSmiJson(stdout);
  } catch {
    return [];
  }
}

async function probeAmdSmiGpus() {
  let staticOutput = '';
  let metricOutput = '';
  try {
    ({ stdout: staticOutput } = await execFileAsync('amd-smi', [
      'static',
      '--asic',
      '--vram',
      '--json',
    ], {
      timeout: 2_000,
      windowsHide: true,
    }));
  } catch {
    // Metric output can still provide a usable device on partial installations.
  }
  try {
    ({ stdout: metricOutput } = await execFileAsync('amd-smi', [
      'metric',
      '--mem-usage',
      '--usage',
      '--temperature',
      '--json',
    ], {
      timeout: 2_000,
      windowsHide: true,
    }));
  } catch {
    // Static output can still provide model and total VRAM.
  }
  return parseAmdSmiJson(staticOutput, metricOutput);
}

async function probeCommand(name, args = ['--version']) {
  try {
    const { stdout, stderr } = await execFileAsync(name, args, {
      timeout: 2_000,
      windowsHide: true,
    });
    return {
      available: true,
      version: `${stdout || stderr}`.trim().split(/\r?\n/)[0] || 'available',
    };
  } catch (error) {
    return {
      available: false,
      error: error.code || error.message,
    };
  }
}

export function inferCapabilitiesFromInventory(extraCapabilities = [], tools = {}) {
  const inferredCapabilities = new Set(extraCapabilities);
  inferredCapabilities.add('shell');
  if (tools.git?.available) {
    inferredCapabilities.add('git');
  }
  if (tools.codex?.available || tools.claude?.available) {
    inferredCapabilities.add('agent');
    inferredCapabilities.add('code');
  }
  if (tools.gh?.available) {
    inferredCapabilities.add('github');
  }
  if (tools.nvidiaSmi?.available || tools.amdSmi?.available || tools.rocmSmi?.available) {
    inferredCapabilities.add('gpu');
  }
  return Array.from(inferredCapabilities).sort();
}

export async function collectInventory(extraCapabilities = []) {
  const tools = {
    node: {
      available: true,
      version: process.version,
    },
    git: await probeCommand('git'),
    gh: await probeCommand('gh'),
    codex: await probeCommand('codex', ['--version']),
    claude: await probeCommand('claude', ['--version']),
    nvidiaSmi: await probeCommand('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']),
    amdSmi: await probeCommand('amd-smi', ['version']),
    rocmSmi: await probeCommand('rocm-smi', ['--showproductname']),
  };

  const [nvidiaGpus, amdSmiGpus, rocmGpus, temperatures] = await Promise.all([
    probeNvidiaGpus(),
    probeAmdSmiGpus(),
    probeRocmGpus(),
    probeHostTemperatures(),
  ]);
  const amdGpus = amdSmiGpus.length ? amdSmiGpus : rocmGpus;

  return {
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      totalmem: os.totalmem(),
    },
    tools,
    resources: {
      gpus: [...nvidiaGpus, ...amdGpus],
      temperatures,
    },
    inferredCapabilities: inferCapabilitiesFromInventory(extraCapabilities, tools),
    collectedAt: new Date().toISOString(),
  };
}
