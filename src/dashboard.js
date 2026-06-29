export function dashboardHtml(options = {}) {
  const bootstrapToken = options.bootstrapToken ? String(options.bootstrapToken) : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nado Control</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #eef2f6;
      --panel: #ffffff;
      --text: #18202a;
      --muted: #697586;
      --line: #d7dee8;
      --line-strong: #c3ccd9;
      --blue: #2457d6;
      --blue-strong: #1c43a8;
      --green: #097a4b;
      --amber: #936000;
      --red: #b42318;
      --ink: #111827;
      --surface: #f8fafc;
      --console: #101828;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        linear-gradient(180deg, #f8fafc 0, #eef2f6 340px, #eef2f6 100%);
      color: var(--text);
      font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 5;
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 10px 18px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.94);
      backdrop-filter: blur(12px);
      box-shadow: 0 1px 0 rgba(15, 23, 42, 0.02);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 760;
      letter-spacing: 0;
      white-space: nowrap;
      color: #111827;
    }
    h2 {
      margin: 0;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
      font-size: 14px;
      font-weight: 760;
      letter-spacing: 0;
    }
    main {
      max-width: 1600px;
      margin: 0 auto;
      padding: 16px 18px 28px;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(210px, 360px) 92px auto auto 1fr;
      gap: 8px;
      align-items: center;
      width: 100%;
    }
    input, select, textarea, button {
      font: inherit;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--text);
    }
    input, select, textarea {
      width: 100%;
      padding: 7px 9px;
      min-height: 36px;
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
    }
    input:focus, select:focus, textarea:focus {
      border-color: rgba(36, 87, 214, 0.65);
      box-shadow: 0 0 0 3px rgba(36, 87, 214, 0.12);
    }
    input::placeholder, textarea::placeholder {
      color: #98a2b3;
    }
    input[type="checkbox"] {
      width: auto;
      padding: 0;
      margin: 0 6px 0 0;
      vertical-align: middle;
    }
    textarea {
      min-height: 84px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    }
    button {
      padding: 7px 11px;
      cursor: pointer;
      min-height: 36px;
      background: #fff;
      color: #344054;
      font-weight: 650;
      transition: transform 80ms ease, border-color 120ms ease, background 120ms ease, color 120ms ease;
    }
    button:hover:not(:disabled) {
      border-color: var(--line-strong);
      background: #f8fafc;
    }
    button:active:not(:disabled) { transform: translateY(1px); }
    button.primary {
      border-color: var(--blue);
      background: var(--blue);
      color: #fff;
      font-weight: 650;
    }
    button.primary:hover:not(:disabled) {
      border-color: var(--blue-strong);
      background: var(--blue-strong);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .status {
      justify-self: end;
      color: var(--muted);
      font-size: 13px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.55fr) minmax(360px, 0.95fr);
      gap: 12px;
      align-items: start;
    }
    .grid > div {
      display: grid;
      gap: 12px;
      min-width: 0;
    }
    .grid.single-column {
      grid-template-columns: 1fr;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    .readiness-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin: -4px 0 12px;
    }
    .readiness-item {
      min-width: 0;
      padding: 9px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .readiness-item strong {
      display: block;
      margin-bottom: 3px;
      color: var(--ink);
      font-size: 12px;
    }
    .readiness-item small {
      display: block;
      color: var(--muted);
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .readiness-item.ok { border-color: #9bd8b8; background: #f6fef9; }
    .readiness-item.warn { border-color: #f1c36d; background: #fffbeb; }
    .readiness-item.bad { border-color: #fda29b; background: #fff5f5; }
    .view-tabs {
      display: flex;
      gap: 6px;
      align-items: center;
      margin: 0 0 12px;
      padding: 4px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #f8fafc;
      overflow-x: auto;
    }
    .view-tabs button {
      min-width: max-content;
      border-color: transparent;
      background: transparent;
      color: var(--muted);
      font-weight: 650;
    }
    .view-tabs button.active {
      border-color: var(--line-strong);
      background: #fff;
      color: var(--ink);
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
    }
    .view-panel-hidden {
      display: none !important;
    }
    .console-section {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(340px, 0.8fr);
      overflow: hidden;
      margin-bottom: 12px;
    }
    .console-section > h2 {
      grid-column: 1 / -1;
    }
    .console-agent-notice {
      grid-column: 1 / -1;
      margin: 14px 14px 0;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfdff;
      color: var(--muted);
      font-size: 13px;
    }
    .console-agent-notice.warn {
      border-color: #f1c36d;
      background: #fff8e6;
      color: #6f4b00;
    }
    .console-agent-notice.ok {
      border-color: #9bd8b8;
      background: #effaf4;
      color: #095c3a;
    }
    .console-section > form {
      margin: 0;
      grid-column: 1;
    }
    .console-form {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px 12px;
      padding: 14px;
      align-items: end;
    }
    .console-form .wide { grid-column: 1 / -1; }
    .console-form textarea {
      min-height: 86px;
      font-size: 13px;
      line-height: 1.55;
      background: #fcfdff;
    }
    .console-examples {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: -4px;
    }
    .console-examples button {
      min-height: 30px;
      padding: 5px 8px;
      font-size: 12px;
    }
    .console-routing-options {
      grid-column: 1 / -1;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfdff;
      overflow: hidden;
    }
    .console-routing-options summary {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      min-height: 34px;
      padding: 8px 10px;
      cursor: pointer;
      color: #344054;
      font-weight: 700;
      list-style-position: inside;
    }
    .console-routing-summary {
      min-width: 0;
      overflow: hidden;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .console-routing-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px 12px;
      padding: 0 10px 10px;
      align-items: end;
    }
    .console-output {
      grid-column: 2;
      align-self: stretch;
      margin: 14px 14px 8px 0;
      min-height: 0;
      max-height: 300px;
      overflow: auto;
      padding: 10px;
      border: 1px solid #263247;
      border-radius: 8px;
      background: var(--console);
      color: #e5edf7;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .console-result-panel {
      grid-column: 2;
      margin: 0 14px 14px 0;
      max-height: 300px;
      overflow: auto;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .console-result-panel .detail-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin: 0 0 10px;
    }
    .console-result-panel .subhead {
      margin-left: 0;
      margin-right: 0;
    }
    .console-result-panel pre,
    .console-result-panel .table-wrap,
    .console-result-panel .empty {
      margin-left: 0;
      margin-right: 0;
    }
    .stat, section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
    }
    .stat {
      padding: 10px 12px;
      min-height: 66px;
    }
    .stat span {
      display: block;
      color: var(--muted);
      font-size: 12px;
    }
    .stat strong {
      display: block;
      margin-top: 3px;
      font-size: 22px;
      letter-spacing: 0;
    }
    section {
      padding: 0;
      margin-bottom: 0;
      min-width: 0;
      overflow: hidden;
    }
    section > :not(h2) {
      margin-left: 14px;
      margin-right: 14px;
    }
    section > h2 + :not(form):not(.console-output) {
      margin-top: 14px;
    }
    section > form {
      margin: 14px;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      margin-bottom: 14px;
    }
    table {
      width: 100%;
      min-width: 720px;
      border-collapse: collapse;
      background: #fff;
    }
    th, td {
      padding: 7px 9px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      text-align: left;
    }
    th {
      position: sticky;
      top: 0;
      background: #f8fafc;
      color: #344054;
      font-size: 12px;
      font-weight: 700;
    }
    tbody tr:hover {
      background: #fbfdff;
    }
    tr:last-child td { border-bottom: 0; }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 8px;
      border-radius: 6px;
      background: #eef2f7;
      color: #344054;
      font-size: 12px;
      font-weight: 650;
      white-space: nowrap;
    }
    .badge.ok { background: #dcfae6; color: var(--green); }
    .badge.warn { background: #fef0c7; color: var(--amber); }
    .badge.bad { background: #fee4e2; color: var(--red); }
    .routing-note {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 180px;
    }
    .routing-note small {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }
    .actions button {
      min-height: 30px;
      padding: 5px 8px;
      font-size: 12px;
    }
    .onboarding-actions {
      padding-top: 14px;
    }
    .onboarding-actions button {
      min-height: 36px;
      font-size: 13px;
    }
    .onboarding-primary {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 10px 12px;
      border: 1px solid #b7cdfa;
      border-radius: 8px;
      background: #f5f8ff;
    }
    .onboarding-primary strong {
      display: block;
      color: var(--ink);
      font-size: 13px;
    }
    .onboarding-primary p {
      margin: 2px 0 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }
    .advanced-panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfdff;
      overflow: hidden;
    }
    .advanced-panel summary {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      cursor: pointer;
      color: #344054;
      font-weight: 700;
    }
    .advanced-panel summary small {
      color: var(--muted);
      font-weight: 600;
    }
    .advanced-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      padding: 0 10px 10px;
    }
    .advanced-grid .wide { grid-column: 1 / -1; }
    .advanced-panel .subhead {
      margin: 2px 0 7px;
    }
    .advanced-panel pre {
      margin: 8px 0 0;
    }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .form-grid .wide { grid-column: 1 / -1; }
    label {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      margin-bottom: 4px;
    }
    .empty {
      padding: 20px;
      color: var(--muted);
      text-align: center;
      border: 1px dashed #d7dee8;
      border-radius: 8px;
      background: #fbfdff;
      margin-bottom: 14px;
    }
    .error {
      color: var(--red);
      font-weight: 650;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(110px, 1fr));
      gap: 8px;
      margin: 14px 14px 12px;
    }
    .detail-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: #fbfdff;
      min-width: 0;
    }
    .detail-item span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 2px;
    }
    pre {
      max-height: 220px;
      overflow: auto;
      margin: 0 14px 14px;
      padding: 10px;
      border: 1px solid #263247;
      border-radius: 8px;
      background: var(--console);
      color: #e5edf7;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .subhead {
      margin: 14px 14px 7px;
      color: var(--ink);
      font-weight: 700;
      font-size: 13px;
    }
    .section-tools {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 10px 14px 0;
    }
    .section-tools .hint {
      color: var(--muted);
      font-size: 12px;
      margin-left: auto;
    }
    .workbench-task-tools,
    .workbench-worker-tools {
      display: none;
      padding: 10px 14px 0;
    }
    main[data-active-view="workbench"] .workbench-task-tools,
    main[data-active-view="workbench"] .workbench-worker-tools {
      display: flex;
    }
    main[data-active-view="workbench"] .section-tools,
    main[data-active-view="workbench"] .attention-tools,
    main[data-active-view="workbench"] #attentionTasks {
      display: none;
    }
    .attention-tools {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin: 14px 14px 7px;
    }
    .attention-tools .subhead {
      margin: 0;
    }
    .inline-control {
      display: inline-flex;
      align-items: center;
      margin: 0;
      min-height: 30px;
    }
    .compact-input {
      width: 72px;
      min-height: 30px;
      padding: 4px 8px;
      font-size: 12px;
    }
    .field-warning {
      min-height: 16px;
      margin-top: 4px;
      color: var(--amber);
      font-size: 12px;
      line-height: 1.35;
    }
    .warn-text {
      color: var(--amber);
      line-height: 1.35;
    }
    .network-hints {
      display: grid;
      gap: 7px;
      margin-top: 8px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfdff;
    }
    .network-summary {
      font-size: 12px;
      line-height: 1.35;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .network-summary.ok {
      color: var(--green);
    }
    .network-summary.warn {
      color: var(--amber);
    }
    .network-hint-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }
    .network-hint-row code {
      min-width: 0;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }
    .network-hint-row small {
      color: var(--muted);
    }
    .network-hint-row.muted-row {
      opacity: 0.78;
    }
    .network-command-list {
      display: grid;
      gap: 6px;
      margin-top: 7px;
    }
    .network-command {
      display: grid;
      gap: 3px;
      min-width: 0;
      padding: 7px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
    }
    .network-command strong,
    .network-command small,
    .network-command code {
      overflow-wrap: anywhere;
    }
    .network-command strong {
      color: var(--ink);
      font-size: 12px;
    }
    .network-command small {
      color: var(--muted);
    }
    .network-command code {
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }
    @media (max-width: 980px) {
      .toolbar { grid-template-columns: 1fr auto; }
      .status { grid-column: 1 / -1; justify-self: start; }
      .grid { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      .readiness-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .detail-grid { grid-template-columns: repeat(2, minmax(110px, 1fr)); }
      .console-section { grid-template-columns: 1fr; }
      .console-section > form,
      .console-output,
      .console-result-panel { grid-column: 1; }
      .console-output {
        margin: 0 14px 14px;
        min-height: 110px;
      }
      .console-result-panel {
        margin: 0 14px 14px;
      }
      .console-form { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 560px) {
      header { align-items: stretch; flex-direction: column; }
      main { padding: 12px; }
      .toolbar { grid-template-columns: 1fr; }
      .stats { grid-template-columns: 1fr; }
      .readiness-strip { grid-template-columns: 1fr; }
      .form-grid { grid-template-columns: 1fr; }
      .advanced-grid { grid-template-columns: 1fr; }
      .onboarding-primary { grid-template-columns: 1fr; }
      .console-form { grid-template-columns: 1fr; }
      .console-routing-grid { grid-template-columns: 1fr; }
      .detail-grid { grid-template-columns: 1fr; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Nado Control</h1>
    <div class="toolbar">
      <input id="token" type="password" autocomplete="current-password" aria-label="NADO_TOKEN" placeholder="NADO_TOKEN">
      <select id="locale" aria-label="Language">
        <option value="zh-CN">中文</option>
        <option value="en">English</option>
      </select>
      <button id="saveToken">Save</button>
      <button id="refresh" class="primary">Refresh</button>
      <div id="status" class="status">Waiting for token</div>
    </div>
  </header>
  <main>
    <div class="stats" id="stats"></div>
    <div id="readinessStrip" class="readiness-strip"></div>
    <nav class="view-tabs" aria-label="Dashboard sections">
      <button type="button" class="active" data-view-tab="workbench">Workbench</button>
      <button type="button" data-view-tab="workers">Workers</button>
      <button type="button" data-view-tab="onboarding">Onboarding</button>
      <button type="button" data-view-tab="tasks">Tasks</button>
      <button type="button" data-view-tab="batches">Batches</button>
      <button type="button" data-view-tab="sessions">Sessions</button>
      <button type="button" data-view-tab="ops">Operations</button>
    </nav>
    <section class="console-section">
      <h2>Control Console</h2>
      <div id="consoleAgentNotice" class="console-agent-notice">Loading agent capability...</div>
      <form id="consoleForm" class="console-form">
        <div class="wide">
          <label for="consolePrompt">Prompt</label>
          <textarea id="consolePrompt" name="prompt" placeholder="Describe the work to dispatch"></textarea>
        </div>
        <div class="wide console-examples" aria-label="Prompt examples">
          <button type="button" data-console-example="gpu">GPU Route</button>
          <button type="button" data-console-example="docs">Docs Task</button>
          <button type="button" data-console-example="ppt">PPT Task</button>
        </div>
        <details id="consoleRoutingOptions" class="console-routing-options">
          <summary><span>Routing Options</span><span id="consoleRoutingSummary" class="console-routing-summary">automatic</span></summary>
          <div class="console-routing-grid">
            <div>
              <label for="consoleTitle">Title</label>
              <input id="consoleTitle" name="title" placeholder="agent task">
            </div>
            <div>
              <label for="consoleWorkerId">Worker</label>
              <input id="consoleWorkerId" name="workerId" placeholder="optional worker id">
            </div>
            <div>
              <label for="consoleCapability">Capability</label>
              <input id="consoleCapability" name="capability" placeholder="code,gpu">
            </div>
            <div>
              <label for="consoleTool">Required tool</label>
              <input id="consoleTool" name="tool" placeholder="codex,claude">
            </div>
            <div>
              <label for="consoleSessionId">Session</label>
              <input id="consoleSessionId" name="sessionId" placeholder="optional session id">
            </div>
            <div>
              <label for="consolePriority">Priority</label>
              <input id="consolePriority" name="priority" type="number" value="0">
            </div>
            <div>
              <label for="consoleLabel">Required label</label>
              <input id="consoleLabel" name="label" placeholder="zone=lab">
            </div>
            <div>
              <label><input id="consoleRequireRoutable" name="requireRoutable" type="checkbox" checked> Require routable worker</label>
            </div>
          </div>
        </details>
        <div class="wide actions">
          <button id="runConsoleTask" class="primary" type="submit">Run</button>
          <button id="previewConsoleDispatch" type="button">Preview Route</button>
          <button id="checkConsoleRoutes" type="button">Check Routes</button>
          <button id="newConsoleSession" type="button">New Session</button>
          <button id="clearConsoleSession" type="button">Clear Session</button>
          <button id="stopConsoleTask" type="button">Stop Task</button>
          <button id="downloadConsoleArtifacts" type="button" disabled>Download Result ZIP</button>
        </div>
      </form>
      <div id="consoleOutput" class="console-output">Waiting for task</div>
      <div id="consoleResultPanel" class="console-result-panel empty">No console result yet</div>
    </section>
    <div class="grid">
      <div>
          <section>
            <h2>Workers</h2>
            <div class="workbench-worker-tools actions">
              <button id="openWorkerOnboarding" type="button">Add Worker</button>
            </div>
            <div id="workers"></div>
          </section>
          <section>
            <h2>Worker Detail</h2>
            <div id="workerDetail" class="empty">Select a worker</div>
          </section>
          <section>
            <h2>Tasks</h2>
            <div class="workbench-task-tools actions">
              <button id="clearWorkbenchCompleted" type="button">Reset Demo</button>
            </div>
            <div class="attention-tools">
              <div class="subhead">Needs Attention</div>
              <button id="cancelRoutingIssues" type="button" disabled>Cancel Issues</button>
            </div>
            <div id="attentionTasks" class="empty">No routing issues</div>
            <div class="section-tools">
              <button type="button" data-task-filter="user">User Tasks</button>
              <button type="button" data-task-filter="all">All History</button>
              <label class="inline-control" for="taskPruneKeep">Keep</label>
              <input id="taskPruneKeep" class="compact-input" type="number" min="0" value="20">
              <button id="pruneTaskHistory" type="button">Clear Completed</button>
              <button id="pruneSystemHistory" type="button">Clear System History</button>
              <span id="taskListHint" class="hint">Showing recent user tasks</span>
            </div>
            <div id="tasks"></div>
        </section>
        <section>
          <h2>Task Detail</h2>
          <div id="taskDetail" class="empty">Select a task</div>
        </section>
      </div>
      <div>
        <section>
          <h2>Worker Onboarding</h2>
          <div class="onboarding-primary">
            <div>
              <strong>Self-Service Worker Bundle</strong>
              <p>Recommended path: the worker generates its ID and keypair, then enrolls with the control server on first start.</p>
            </div>
            <button id="downloadBootstrapBundle" class="primary" type="button">Download Self-Service Bundle</button>
          </div>
          <form id="inviteForm" class="form-grid">
            <div class="wide">
              <label for="inviteControl">Control URL</label>
              <input id="inviteControl" name="controlUrl" placeholder="http://control-host:8765">
              <div id="inviteControlWarning" class="field-warning"></div>
              <div class="actions">
                <button id="refreshNetworkInfo" type="button">Refresh Network URLs</button>
              </div>
              <div id="networkInfo" class="network-hints empty">No network URL scan loaded</div>
            </div>
            <div>
              <label for="inviteCapabilities">Capabilities</label>
              <input id="inviteCapabilities" name="capabilities" placeholder="code,docs,gpu">
            </div>
            <div>
              <label for="inviteLabels">Labels</label>
              <input id="inviteLabels" name="labels" placeholder="zone=lab,role=builder">
            </div>
            <div>
              <label for="inviteConcurrency">Max concurrency</label>
              <input id="inviteConcurrency" name="maxConcurrency" type="number" min="1" value="1">
            </div>
            <div>
              <label for="invitePoll">Poll ms</label>
              <input id="invitePoll" name="pollMs" type="number" min="50" value="2000">
            </div>
            <div>
              <label for="inviteAgentPreset">Agent preset</label>
              <select id="inviteAgentPreset" name="agentPreset">
                <option value="">custom/none</option>
                <option value="codex">codex</option>
                <option value="claude">claude</option>
                <option value="node-copy">node-copy</option>
              </select>
            </div>
            <div class="wide">
              <label for="inviteAgent">Agent command</label>
              <input id="inviteAgent" name="agentCommand" placeholder="optional command template">
            </div>
            <div>
              <label for="inviteLabel">Token label</label>
              <input id="inviteLabel" name="tokenLabel" placeholder="ubuntu laptop">
            </div>
            <div>
              <label for="inviteDataDir">Data dir</label>
              <input id="inviteDataDir" name="dataDir" value=".nado">
            </div>
            <div class="wide">
              <label><input id="inviteCleanup" name="cleanupWorkspaces" type="checkbox"> Cleanup non-session workspaces</label>
            </div>
            <details class="advanced-panel wide">
              <summary><span>Advanced Fixed-ID Invite</span><small>for pre-named hosts only</small></summary>
              <div class="advanced-grid">
                <div>
                  <label for="inviteId">Fixed Worker ID</label>
                  <input id="inviteId" name="id" placeholder="worker-a">
                </div>
                <div>
                  <label for="inviteFormat">Format</label>
                  <select id="inviteFormat" name="format">
                    <option value="bash">bash</option>
                    <option value="powershell">powershell</option>
                  </select>
                </div>
                <div class="wide">
                  <button type="submit">Issue Fixed-ID Invite</button>
                </div>
                <div class="wide">
                  <div class="subhead">Fixed-ID Invite Script</div>
                  <div class="actions">
                    <button id="downloadInvite" type="button">Download Invite</button>
                    <button id="downloadBundle" type="button">Download Bundle</button>
                    <button id="selfTestInvite" type="button">Self-Test Worker</button>
                  </div>
                  <pre id="inviteOutput">No invite generated</pre>
                </div>
              </div>
            </details>
          </form>
        </section>
        <section>
          <h2>Worker Tokens</h2>
          <div class="form-grid">
            <div>
              <label for="workerTokenFilter">Worker</label>
              <input id="workerTokenFilter" placeholder="optional worker id">
            </div>
            <div>
              <label>&nbsp;</label>
              <button id="loadWorkerTokens" type="button">Refresh Tokens</button>
            </div>
          </div>
          <div id="workerTokens" class="empty">No token list loaded</div>
          <div class="subhead">Enrollment Tokens</div>
          <div class="actions">
            <button id="loadWorkerEnrollmentTokens" type="button">Refresh Enrollment Tokens</button>
            <button id="pruneWorkerEnrollmentTokens" type="button">Clear Unused Enrollment Tokens</button>
            <label class="inline-control"><input id="showEnrollmentHistory" type="checkbox"> Show History</label>
          </div>
          <div id="workerEnrollmentTokens" class="empty">No enrollment token list loaded</div>
        </section>
        <section>
          <h2>Demo Health</h2>
          <div class="actions">
            <button id="runDemoHealth" class="primary" type="button">Run Demo Health</button>
            <label><input id="demoHealthSkipVerify" type="checkbox"> Skip heavy verify</label>
            <label><input id="demoHealthKeepHistory" type="checkbox"> Keep diagnostic history</label>
          </div>
          <div id="demoHealthResult" class="empty">No demo health run yet</div>
        </section>
        <section>
          <h2>Doctor</h2>
          <form id="doctorForm" class="form-grid">
            <div>
              <label for="doctorWorker">Worker</label>
              <input id="doctorWorker" name="workerId" placeholder="optional worker id">
            </div>
            <div>
              <label for="doctorCapability">Capability</label>
              <input id="doctorCapability" name="capability" placeholder="code,gpu">
            </div>
            <div>
              <label for="doctorTool">Required tool</label>
              <input id="doctorTool" name="tool" placeholder="node,codex">
            </div>
            <div>
              <label for="doctorLabel">Required label</label>
              <input id="doctorLabel" name="label" placeholder="zone=lab">
            </div>
            <div>
              <label for="doctorTimeout">Timeout ms</label>
              <input id="doctorTimeout" name="timeoutMs" type="number" min="1000" value="15000">
            </div>
            <div class="wide">
              <label><input id="doctorSelfTest" name="selfTest" type="checkbox"> Run self-test task</label>
            </div>
            <div class="wide">
              <label><input id="doctorAgentSelfTest" name="agentSelfTest" type="checkbox"> Run agent self-test task</label>
            </div>
            <div class="wide">
              <label><input id="doctorAllWorkers" name="allWorkers" type="checkbox"> Probe every eligible worker</label>
            </div>
            <div class="wide">
              <button id="runDoctor" class="primary" type="submit">Run Doctor</button>
            </div>
          </form>
          <div id="doctorResult" class="empty">No doctor run yet</div>
        </section>
        <section>
          <h2>Readiness Verify</h2>
          <form id="verifyForm" class="form-grid">
            <div>
              <label for="verifyWorker">Worker</label>
              <input id="verifyWorker" name="workerId" placeholder="optional worker id">
            </div>
            <div>
              <label for="verifyCapability">Capability</label>
              <input id="verifyCapability" name="capability" placeholder="code,gpu">
            </div>
            <div>
              <label for="verifyTool">Required tool</label>
              <input id="verifyTool" name="tool" placeholder="node,codex">
            </div>
            <div>
              <label for="verifyLabel">Required label</label>
              <input id="verifyLabel" name="label" placeholder="zone=lab">
            </div>
            <div>
              <label for="verifyTimeout">Timeout ms</label>
              <input id="verifyTimeout" name="timeoutMs" type="number" min="1000" value="30000">
            </div>
            <div class="wide">
              <label><input id="verifyAllWorkers" name="allWorkers" type="checkbox"> Doctor probes every eligible worker</label>
            </div>
            <div class="wide">
              <label><input id="verifySkipDoctor" name="skipDoctor" type="checkbox"> Skip doctor self-test</label>
            </div>
            <div class="wide">
              <button id="runVerify" class="primary" type="submit">Run Verify</button>
            </div>
          </form>
          <div id="verifyResult" class="empty">No readiness verification run yet</div>
        </section>
        <section>
          <h2>Agent Context</h2>
          <div class="actions">
            <button id="loadAgentContext" type="button">Refresh Context</button>
            <button id="downloadAgentContext" type="button">Download AGENTS.md</button>
          </div>
          <pre id="agentContext">No context loaded</pre>
        </section>
        <section>
          <h2>Gateway Manifest</h2>
          <div class="actions">
            <button id="loadCapabilities" type="button">Refresh Manifest</button>
            <button id="downloadCapabilities" type="button">Download Manifest</button>
          </div>
          <pre id="capabilitiesManifest">No manifest loaded</pre>
        </section>
        <section>
          <h2>MCP Config</h2>
          <div class="form-grid">
            <div>
              <label for="mcpConfigName">Server name</label>
              <input id="mcpConfigName" value="nado">
            </div>
            <div>
              <label for="mcpConfigFormat">Format</label>
              <select id="mcpConfigFormat">
                <option value="json">json</option>
                <option value="command">command</option>
              </select>
            </div>
            <div class="wide actions">
              <button id="loadMcpConfig" type="button">Refresh MCP Config</button>
              <button id="downloadMcpConfig" type="button">Download MCP Config</button>
            </div>
          </div>
          <pre id="mcpConfig">No MCP config loaded</pre>
        </section>
        <section>
          <h2>Offline Recovery</h2>
          <form id="recoveryForm" class="form-grid">
            <div>
              <label for="recoveryWorker">Offline worker</label>
              <input id="recoveryWorker" name="workerId" placeholder="optional worker id">
            </div>
            <div>
              <label for="recoveryTargetWorker">Target worker</label>
              <input id="recoveryTargetWorker" name="targetWorkerId" placeholder="optional target">
            </div>
            <div>
              <label for="recoveryCapability">Capability</label>
              <input id="recoveryCapability" name="capability" placeholder="code,gpu">
            </div>
            <div>
              <label for="recoveryTool">Required tool</label>
              <input id="recoveryTool" name="tool" placeholder="node,codex">
            </div>
            <div>
              <label for="recoveryLabel">Required label</label>
              <input id="recoveryLabel" name="label" placeholder="zone=lab">
            </div>
            <div>
              <label for="recoverySlots">Slots</label>
              <input id="recoverySlots" name="slots" type="number" min="1" placeholder="optional">
            </div>
            <div class="wide">
              <label><input id="recoveryIncludeSessions" name="includeSessions" type="checkbox"> Include session tasks</label>
            </div>
            <div class="wide">
              <label for="recoveryReason">Reason</label>
              <input id="recoveryReason" name="reason" placeholder="dashboard offline recovery">
            </div>
            <div class="wide actions">
              <button id="loadRecoveryCandidates" type="button">Refresh Offline</button>
              <button id="recoverOfflineTasks" class="primary" type="submit">Requeue Offline</button>
            </div>
          </form>
          <div id="recoveryCandidates" class="empty">No offline recovery scan loaded</div>
        </section>
        <section>
          <h2>Submit Task</h2>
          <form id="submitForm" class="form-grid">
            <div class="wide">
              <label for="title">Title</label>
              <input id="title" name="title" placeholder="short task title">
            </div>
            <div>
              <label for="taskType">Type</label>
              <select id="taskType" name="type">
                <option value="shell">shell</option>
                <option value="agent">agent</option>
              </select>
            </div>
            <div>
              <label for="sessionId">Session</label>
              <input id="sessionId" name="sessionId" placeholder="optional session id">
            </div>
            <div class="wide">
              <label for="command">Command</label>
              <textarea id="command" name="command" placeholder="echo hello"></textarea>
            </div>
            <div class="wide">
              <label for="prompt">Prompt</label>
              <textarea id="prompt" name="prompt" placeholder="Use with agent tasks"></textarea>
            </div>
            <div>
              <label for="workerId">Worker</label>
              <input id="workerId" name="workerId" placeholder="optional worker id">
            </div>
            <div>
              <label for="capability">Capability</label>
              <input id="capability" name="capability" placeholder="code,gpu">
            </div>
            <div>
              <label for="label">Required label</label>
              <input id="label" name="label" placeholder="zone=lab">
            </div>
            <div>
              <label for="priority">Priority</label>
              <input id="priority" name="priority" type="number" value="0">
            </div>
            <div>
              <label for="slots">Slots</label>
              <input id="slots" name="slots" type="number" min="1" value="1">
            </div>
            <div>
              <label for="tool">Required tool</label>
              <input id="tool" name="tool" placeholder="node,codex">
            </div>
            <div>
              <label for="timeoutMs">Timeout ms</label>
              <input id="timeoutMs" name="timeoutMs" type="number" min="1000" placeholder="600000">
            </div>
            <div>
              <label for="workspacePolicy">Workspace</label>
              <select id="workspacePolicy" name="workspacePolicy">
                <option value="">worker default</option>
                <option value="keep">keep</option>
                <option value="cleanup">cleanup</option>
              </select>
            </div>
            <div>
              <label for="sandboxProfile">Sandbox</label>
              <select id="sandboxProfile" name="sandboxProfile">
                <option value="">default</option>
                <option value="isolated">isolated env</option>
              </select>
            </div>
            <div class="wide">
              <label for="envText">Env</label>
              <textarea id="envText" name="envText" placeholder="KEY=value"></textarea>
            </div>
            <div>
              <label for="artifactInclude">Artifact include</label>
              <input id="artifactInclude" name="artifactInclude" placeholder="dist/**, report.md">
            </div>
            <div>
              <label for="artifactExclude">Artifact exclude</label>
              <input id="artifactExclude" name="artifactExclude" placeholder="dist/tmp/**">
            </div>
            <div class="wide">
              <label for="inputFiles">Input files</label>
              <input id="inputFiles" name="inputFiles" type="file" multiple>
            </div>
            <div class="wide">
              <label><input id="requireRoutable" name="requireRoutable" type="checkbox"> Require routable worker</label>
            </div>
            <div class="wide">
              <button class="primary" type="submit">Submit</button>
            </div>
          </form>
        </section>
        <section>
          <h2>Distributed Planner</h2>
          <form id="plannerForm" class="form-grid">
            <div class="wide">
              <label for="plannerTitle">Title</label>
              <input id="plannerTitle" name="title" placeholder="large task">
            </div>
            <div>
              <label for="plannerMode">Mode</label>
              <select id="plannerMode" name="mode">
                <option value="auto">auto</option>
                <option value="map_reduce">map_reduce</option>
                <option value="parallel">parallel</option>
                <option value="pipeline">pipeline</option>
                <option value="review">review</option>
              </select>
            </div>
            <div>
              <label for="plannerShards">Shards</label>
              <input id="plannerShards" name="shards" type="number" min="1" max="16" placeholder="auto">
            </div>
            <div>
              <label for="plannerCapability">Capability</label>
              <input id="plannerCapability" name="capability" placeholder="code,docs,gpu">
            </div>
            <div>
              <label for="plannerTool">Required tool</label>
              <input id="plannerTool" name="tool" placeholder="codex,claude">
            </div>
            <div>
              <label for="plannerLabel">Required label</label>
              <input id="plannerLabel" name="label" placeholder="zone=lab">
            </div>
            <div class="wide">
              <label for="plannerPrompt">Large task</label>
              <textarea id="plannerPrompt" name="prompt" placeholder="Describe the task to split across workers"></textarea>
            </div>
            <div class="wide">
              <label for="plannerSubtasks">Optional focus areas</label>
              <textarea id="plannerSubtasks" name="subtasks" placeholder="research: collect facts&#10;implementation: make changes&#10;verify: run tests"></textarea>
            </div>
            <div class="wide">
              <label><input id="plannerRequireRoutable" name="requireRoutable" type="checkbox"> Require routable workers</label>
            </div>
            <div class="wide actions">
              <button id="planDistributedTask" class="primary" type="submit">Plan Distributed Task</button>
              <button id="runDistributedPlan" type="button">Run Distributed Plan</button>
            </div>
          </form>
          <div id="plannerResult" class="empty">No distributed plan loaded</div>
        </section>
        <section>
          <h2>Plan Batch</h2>
          <form id="batchPlanForm" class="form-grid">
            <div class="wide">
              <label for="batchPlanTitle">Title</label>
              <input id="batchPlanTitle" name="title" placeholder="implementation shards">
            </div>
            <div>
              <label for="batchPlanType">Type</label>
              <select id="batchPlanType" name="type">
                <option value="agent">agent</option>
                <option value="shell">shell</option>
              </select>
            </div>
            <div>
              <label for="batchPlanWorkerId">Worker</label>
              <input id="batchPlanWorkerId" name="workerId" placeholder="optional worker id">
            </div>
            <div>
              <label for="batchPlanCapability">Capability</label>
              <input id="batchPlanCapability" name="capability" placeholder="code,gpu">
            </div>
            <div>
              <label for="batchPlanTool">Required tool</label>
              <input id="batchPlanTool" name="tool" placeholder="codex,claude">
            </div>
            <div>
              <label for="batchPlanLabel">Required label</label>
              <input id="batchPlanLabel" name="label" placeholder="zone=lab">
            </div>
            <div>
              <label for="batchPlanPriority">Priority</label>
              <input id="batchPlanPriority" name="priority" type="number" value="0">
            </div>
            <div>
              <label for="batchPlanSlots">Slots</label>
              <input id="batchPlanSlots" name="slots" type="number" min="1" value="1">
            </div>
            <div>
              <label for="batchPlanWorkspacePolicy">Workspace</label>
              <select id="batchPlanWorkspacePolicy" name="workspacePolicy">
                <option value="">worker default</option>
                <option value="keep">keep</option>
                <option value="cleanup">cleanup</option>
              </select>
            </div>
            <div>
              <label for="batchPlanSandboxProfile">Sandbox</label>
              <select id="batchPlanSandboxProfile" name="sandboxProfile">
                <option value="">default</option>
                <option value="isolated">isolated env</option>
              </select>
            </div>
            <div class="wide">
              <label for="batchPlanCommandTemplate">Shell command template</label>
              <input id="batchPlanCommandTemplate" name="commandTemplate" placeholder="echo {key}: {title}">
            </div>
            <div class="wide">
              <label for="batchPlanTasks">Tasks</label>
              <textarea id="batchPlanTasks" name="tasks" placeholder="docs: Draft docs&#10;tests: Add smoke tests"></textarea>
            </div>
            <div class="wide">
              <button class="primary" type="submit">Plan Batch</button>
            </div>
          </form>
        </section>
        <section>
          <h2>Submit Batch JSON</h2>
          <form id="batchForm" class="form-grid">
            <div class="wide">
              <label for="batchJson">Batch JSON</label>
              <textarea id="batchJson" name="batchJson">{
  "title": "dashboard batch",
  "tasks": [
    {
      "key": "one",
      "title": "first shard",
      "type": "shell",
      "command": "echo one"
    },
    {
      "key": "two",
      "title": "second shard",
      "type": "shell",
      "command": "echo two"
    }
  ]
}</textarea>
            </div>
            <div class="wide">
              <label><input id="batchRequireRoutable" name="requireRoutable" type="checkbox"> Require routable workers</label>
            </div>
            <div class="wide">
              <button class="primary" type="submit">Submit Batch</button>
              <button id="planDispatchFromBatch" type="button">Preview Dispatch</button>
            </div>
          </form>
          <div id="dispatchPlan" class="empty">No dispatch preview loaded</div>
        </section>
        <section>
          <h2>Batches</h2>
          <div id="batches"></div>
        </section>
        <section>
          <h2>Batch Detail</h2>
          <div id="batchDetail" class="empty">Select a batch</div>
        </section>
        <section>
          <h2>Create Session</h2>
          <form id="sessionForm" class="form-grid">
            <div class="wide">
              <label for="sessionTitle">Title</label>
              <input id="sessionTitle" name="title" placeholder="multi-step subproject">
            </div>
            <div>
              <label for="sessionWorkerId">Worker</label>
              <input id="sessionWorkerId" name="workerId" placeholder="optional worker id">
            </div>
            <div>
              <label for="sessionCapability">Capability</label>
              <input id="sessionCapability" name="capability" placeholder="code,gpu">
            </div>
            <div>
              <label for="sessionTool">Required tool</label>
              <input id="sessionTool" name="tool" placeholder="codex,claude">
            </div>
            <div>
              <label for="sessionLabel">Required label</label>
              <input id="sessionLabel" name="label" placeholder="zone=lab">
            </div>
            <div class="wide">
              <button class="primary" type="submit">Create Session</button>
            </div>
          </form>
        </section>
        <section>
          <h2>Sessions</h2>
          <div id="sessions"></div>
        </section>
        <section>
          <h2>Session Detail</h2>
          <div id="sessionDetail" class="empty">Select a session</div>
        </section>
      </div>
    </div>
  </main>
  <script>
    const DASHBOARD_UI_VERSION = '2026-06-29-workbench-access-tab-v1';
    const DASHBOARD_VIEWS = ['workbench', 'workers', 'onboarding', 'tasks', 'batches', 'sessions', 'ops'];

    function initialDashboardView() {
      const storedVersion = localStorage.getItem('nadoDashboardUiVersion');
      if (storedVersion !== DASHBOARD_UI_VERSION) {
        localStorage.setItem('nadoDashboardUiVersion', DASHBOARD_UI_VERSION);
        localStorage.setItem('nadoDashboardView', 'workbench');
        return 'workbench';
      }
      const storedView = localStorage.getItem('nadoDashboardView') || 'workbench';
      return DASHBOARD_VIEWS.includes(storedView) ? storedView : 'workbench';
    }

    const state = {
      snapshot: null,
      selectedWorkerId: null,
      selectedWorkerEvents: null,
      selectedTaskId: null,
      selectedBatchId: null,
      selectedBatchMode: 'detail',
      selectedSessionId: null,
      selectedSessionArtifactsId: null,
      selectedSessionArtifacts: null,
      lastInvite: null,
      recoveryCandidates: [],
      eventStream: null,
      consoleEvents: [],
      consoleTaskId: null,
      consoleArtifactTaskId: null,
      consoleArtifactPreview: '',
      networkInfo: null,
      statusHoldUntil: 0,
      inviteControlTouched: false,
      activeView: initialDashboardView(),
      taskFilter: localStorage.getItem('nadoTaskFilter') || 'user',
      showEnrollmentHistory: localStorage.getItem('nadoShowEnrollmentHistory') === 'true',
    };
    const tokenInput = document.getElementById('token');
    const localeInput = document.getElementById('locale');
    const statusEl = document.getElementById('status');
    const bootstrapToken = ${JSON.stringify(bootstrapToken)};
    if (bootstrapToken) {
      localStorage.setItem('nadoToken', bootstrapToken);
    }
    tokenInput.value = localStorage.getItem('nadoToken') || bootstrapToken || '';
    const textSources = new WeakMap();
    const attrSources = new WeakMap();
    const translations = {
      'zh-CN': {
        'Language': '语言',
        'Save': '保存',
        'Refresh': '刷新',
        'Waiting for token': '等待输入令牌',
        'Control URL': '主控端 URL',
        'Remote Workers': '远端工作端',
        'Agent Runtime': 'Agent 运行时',
        'GPU Routing': 'GPU 路由',
        'Auto Routing': '自动路由',
        'Waiting for gateway state': '等待网关状态',
        'Ready for remote workers': '远端工作端连接已就绪',
        'Configure public URL for IPv6/LAN workers': '请为 IPv6/局域网工作端配置公共 URL',
        'Scan network URL from Worker Onboarding': '请在工作端接入里扫描网络 URL',
        'IPv6 literals must use brackets, for example http://[2001:db8::10]:8765': 'IPv6 字面量必须使用方括号，例如 http://[2001:db8::10]:8765',
        'Real terminal agent ready': '真实终端 Agent 就绪',
        'Verified terminal agent ready': '已验证真实终端 Agent',
        'Demo/custom agent only': '仅演示/自定义 Agent',
        'No agent worker online': '没有在线 Agent 工作端',
        'GPU worker has accelerator probe': 'GPU 工作端已探测到加速器',
        'GPU worker advertised only': 'GPU 工作端仅声明能力',
        'No GPU worker online': '没有在线 GPU 工作端',
        'Task text can infer gpu, docs, ppt': '任务文本可自动推断 gpu、docs、ppt',
        'Workbench': '工作台',
        'Operations': '运维',
        'Workers': '工作端',
        'Onboarding': '接入',
        'Forget': '移除记录',
        'Control Console': '主控控制台',
        'Loading agent capability...': '正在加载 Agent 能力...',
        'Demo echo agent is active. It validates scheduling and artifact flow, but it does not analyze prompts. Start a worker with Codex or Claude to run real agent work.': '当前启用的是演示回显 Agent。它可以验证调度和产物流，但不会真正分析提示词。启动带 Codex 或 Claude 的工作端后才能执行真实 Agent 工作。',
        'No active terminal agent worker is ready.': '当前没有可用的终端 Agent 工作端。',
        'Agent workers are online, but no Codex or Claude tool is reported. Agent tasks may use a custom command or demo echo preset.': 'Agent 工作端在线，但没有上报 Codex 或 Claude 工具。Agent 任务可能会走自定义命令或演示回显预设。',
        'Prompt': '提示词',
        'Describe the work to dispatch': '描述要分派的工作',
        'Prompt examples': '提示词模板',
        'GPU Route': 'GPU 路由',
        'Docs Task': '文档任务',
        'PPT Task': 'PPT 任务',
        'agent task': 'agent 任务',
        'Routing Options': '路由选项',
        'automatic': '自动路由',
        'Run': '运行',
        'Preview Route': '预览路由',
        'Check Routes': '检查路由',
        'New Session': '新建会话',
        'Clear Session': '清除会话',
        'Stop Task': '停止任务',
        'Download Result ZIP': '下载结果 ZIP',
        'Waiting for task': '等待任务',
        'No console result yet': '尚无控制台结果',
        'Result': '结果',
        'Preview': '预览',
        'Worker Detail': '工作端详情',
        'Select a worker': '选择一个工作端',
        'Add Worker': '添加工作端',
        'Tasks': '任务',
        'Needs Attention': '需要处理',
        'Next Action': '下一步',
        'No routing issues': '暂无路由问题',
        'Cancel Issues': '取消异常任务',
        'User Tasks': '用户任务',
        'All History': '全部历史',
        'Keep': '保留',
        'Clear Completed': '清理已完成',
        'Reset Demo': '复位 Demo',
        'Reset demo state': '复位 Demo 状态',
        'Clear System History': '清理系统历史',
        'Clear all completed standalone demo tasks': '清理所有已完成的独立 Demo 任务',
        'Clear completed standalone tasks except the latest': '清理独立已完成任务，仅保留最近',
        'Clear completed verify/doctor system history': '清理已完成的 verify/doctor 系统历史',
        'Showing recent user tasks': '显示最近用户任务',
        'Showing all recent history': '显示全部最近历史',
        'Task Detail': '任务详情',
        'Select a task': '选择一个任务',
        'Worker Onboarding': '工作端接入',
        'Self-Service Worker Bundle': '自助工作端接入包',
        'Recommended path: the worker generates its ID and keypair, then enrolls with the control server on first start.': '推荐路径：工作端首次启动时自动生成 ID 和密钥对，然后向主控端注册。',
        'Advanced Fixed-ID Invite': '高级：固定 ID 邀请',
        'for pre-named hosts only': '仅用于预先命名的主机',
        'Fixed Worker ID': '固定工作端 ID',
        'Format': '格式',
        'Remote workers cannot reach a loopback control URL. Use the control host LAN address or bracketed IPv6 address before downloading a bundle for another machine.': '远端工作端无法连接本机回环地址。给另一台机器下载接入包前，请改成主控机的局域网地址或带方括号的 IPv6 地址。',
        'Control URL is not a valid URL': '主控端 URL 不是有效 URL',
        'Refresh Network URLs': '刷新网络 URL',
        'No network URL scan loaded': '尚未扫描网络 URL',
        'Current browser URL is loopback. Pick a reachable LAN or IPv6 URL before sending bundles to another machine.': '当前浏览器 URL 是本机回环地址。发给另一台机器前，请选择可达的局域网或 IPv6 URL。',
        'Browser uses loopback; worker bundles will use the preferred URL below.': '浏览器正在使用本机回环地址；工作端接入包会使用下方首选 URL。',
        'Remote worker URL ready': '远端工作端 URL 已就绪',
        'No usable remote worker URL detected.': '未检测到可用的远端工作端 URL。',
        'Remote workers should use the configured public Control URL.': '远端工作端应使用已配置的公共主控端 URL。',
        'The browser is using loopback; worker bundles should use the detected non-loopback Control URL.': '浏览器正在使用回环地址；工作端接入包应使用检测到的非回环主控端 URL。',
        'Remote workers can use the detected non-loopback Control URL.': '远端工作端可以使用检测到的非回环主控端 URL。',
        'The control server only sees container-internal addresses. Set NADO_PUBLIC_CONTROL_URL to the host LAN or bracketed IPv6 URL before generating remote worker bundles.': '主控端目前只能看到容器内部地址。生成远端工作端接入包前，请将 NADO_PUBLIC_CONTROL_URL 设置为宿主机局域网地址或带方括号的 IPv6 URL。',
        'Set NADO_PUBLIC_CONTROL_URL to a reachable LAN or bracketed IPv6 URL before generating remote worker bundles.': '生成远端工作端接入包前，请将 NADO_PUBLIC_CONTROL_URL 设置为可达的局域网地址或带方括号的 IPv6 URL。',
        'Generate a self-service worker bundle or invite from this Control URL.': '用这个主控端 URL 生成自助接入包或邀请。',
        'Generate a self-service worker bundle or invite using the preferred Control URL.': '使用首选主控端 URL 生成自助接入包或邀请。',
        'Set public Control URL (bash)': '设置公共主控端 URL（bash）',
        'Restart Docker demo on IPv6 (PowerShell)': '用 IPv6 重启 Docker demo（PowerShell）',
        'Start control on IPv6 directly': '直接以 IPv6 启动主控端',
        'Build self-service worker bundle': '生成自助工作端接入包',
        'Build self-service worker bundle (PowerShell)': '生成自助工作端接入包（PowerShell）',
        'Replace the IPv6 example with the host address that workers can reach.': '将示例 IPv6 替换成工作端可以访问的主控机地址。',
        'Use this when the control server runs in Docker and remote IPv6 workers must reach the published host port.': '当主控端跑在 Docker 中，且远端 IPv6 工作端需要访问宿主机发布端口时使用。',
        'Use this for a non-Docker control server on an IPv6 or dual-stack host.': '主控端不跑 Docker，且主机支持 IPv6 或双栈时使用。',
        'Creates a bundle whose worker side connects to the preferred remote Control URL.': '生成一个工作端会连接到首选远端主控 URL 的接入包。',
        'Creates the same worker bundle from a Windows control terminal.': '从 Windows 主控终端生成同样的工作端接入包。',
        'No non-loopback network address was detected on this host.': '未检测到这台主机的非回环网络地址。',
        'This looks like a container-internal Docker bridge address. Remote workers should use the host LAN/IPv6 address or NADO_PUBLIC_CONTROL_URL instead.': '这看起来是容器内部 Docker bridge 地址。远端工作端应使用宿主机局域网/IPv6 地址，或配置 NADO_PUBLIC_CONTROL_URL。',
        'Not for remote workers': '不适合远端工作端',
        'Use URL': '使用 URL',
        'Network URLs refreshed': '网络 URL 已刷新',
        'Capabilities': '能力',
        'Labels': '标签',
        'Max concurrency': '最大并发',
        'Poll ms': '轮询间隔 ms',
        'Agent preset': 'Agent 预设',
        'custom/none': '自定义/无',
        'Agent command': 'Agent 命令',
        'Token label': '令牌标签',
        'Data dir': '数据目录',
        'Cleanup non-session workspaces': '清理非会话工作区',
        'Issue Fixed-ID Invite': '签发固定 ID 邀请',
        'Fixed-ID Invite Script': '固定 ID 邀请脚本',
        'Download Invite': '下载邀请',
        'Download Bundle': '下载工作端包',
        'Download Self-Service Bundle': '下载自助接入包',
        'Self-Test Worker': '自测工作端',
        'No invite generated': '尚未生成邀请',
        'GPU probe': 'GPU 探测',
        'probe': '探测到',
        'advertised': '已声明',
        'none': '无',
        'gpu capability is advertised but no NVIDIA/ROCm probe was reported; verify the worker GPU runtime before scheduling real accelerator workloads': '工作端声明了 GPU 能力，但没有上报 NVIDIA/ROCm 探测结果；调度真实加速任务前请先确认工作端 GPU 运行时。',
        'Agent readiness': 'Agent 就绪',
        'Run Agent Self-Test': '运行 Agent 自测',
        'Run an agent self-test on this worker? This may call the configured Codex or Claude CLI.': '要在这个工作端运行 Agent 自测吗？这可能会调用已配置的 Codex 或 Claude CLI。',
        'real-terminal-agent': '真实终端 Agent',
        'demo-echo': '演示回显',
        'missing-tool': '缺少工具',
        'shell-only': '仅 Shell',
        'custom': '自定义',
        'verified': '已验证',
        'configured': '已配置',
        'demo': '演示',
        'unavailable': '不可用',
        'self-test-failed': '自测失败',
        'ready': '就绪',
        'warning': '警告',
        'no agent command configured; this worker can run shell tasks but not terminal-agent tasks': '未配置 Agent 命令；这个工作端可以跑 Shell 任务，但不能跑终端 Agent 任务。',
        'demo echo agent is configured; it validates scheduling and artifacts but does not perform real LLM reasoning': '当前配置的是演示回显 Agent；它能验证调度和产物流，但不会进行真实 LLM 推理。',
        'agent self-test did not succeed; inspect worker diagnostics before assigning agent tasks': 'Agent 自测未成功；分配 Agent 任务前请先检查工作端诊断。',
        'agent command is configured, but no successful agent self-test has been recorded yet': 'Agent 命令已配置，但还没有记录成功的 Agent 自测。',
        'custom agent command is configured; run an agent self-test before trusting real agent work': '已配置自定义 Agent 命令；信任真实 Agent 工作前请先运行 Agent 自测。',
        'Worker Tokens': '工作端令牌',
        'Enrollment Tokens': '接入注册令牌',
        'Worker': '工作端',
        'Routing': '路由',
        'Route Issue': '路由问题',
        'Ready': '就绪',
        'optional worker id': '可选工作端 ID',
        'Refresh Tokens': '刷新令牌',
        'Refresh Enrollment Tokens': '刷新接入注册令牌',
        'Clear Unused Enrollment Tokens': '清理未使用接入注册令牌',
        'Show History': '显示历史',
        'No token list loaded': '尚未加载令牌列表',
        'No enrollment token list loaded': '尚未加载接入注册令牌列表',
        'Showing active enrollment tokens': '正在显示可用接入注册令牌',
        'Demo Health': 'Demo 健康检查',
        'Run Demo Health': '运行 Demo 健康检查',
        'Skip heavy verify': '跳过完整验证',
        'Keep diagnostic history': '保留诊断历史',
        'No demo health run yet': '尚未运行 Demo 健康检查',
        'Doctor': '诊断',
        'Capability': '能力',
        'Evidence': '证据',
        'Required tool': '必需工具',
        'Required label': '必需标签',
        'Timeout ms': '超时 ms',
        'Run self-test task': '运行自测任务',
        'Probe every eligible worker': '探测所有符合条件的工作端',
        'Run Doctor': '运行诊断',
        'No doctor run yet': '尚未运行诊断',
        'Readiness Verify': '就绪验证',
        'Doctor probes every eligible worker': '诊断探测所有符合条件的工作端',
        'Skip doctor self-test': '跳过诊断自测',
        'Run Verify': '运行验证',
        'No readiness verification run yet': '尚未运行就绪验证',
        'No records': '暂无记录',
        'Agent Context': 'Agent 上下文',
        'Refresh Context': '刷新上下文',
        'Download AGENTS.md': '下载 AGENTS.md',
        'No context loaded': '尚未加载上下文',
        'Gateway Manifest': '网关清单',
        'Refresh Manifest': '刷新清单',
        'Download Manifest': '下载清单',
        'No manifest loaded': '尚未加载清单',
        'MCP Config': 'MCP 配置',
        'Server name': '服务名',
        'Refresh MCP Config': '刷新 MCP 配置',
        'Download MCP Config': '下载 MCP 配置',
        'No MCP config loaded': '尚未加载 MCP 配置',
        'Offline Recovery': '离线恢复',
        'Offline worker': '离线工作端',
        'Target worker': '目标工作端',
        'optional target': '可选目标',
        'Include session tasks': '包含会话任务',
        'Refresh Offline': '刷新离线项',
        'Requeue Offline': '重新排队离线任务',
        'No offline recovery scan loaded': '尚未加载离线恢复扫描',
        'Submit Task': '提交任务',
        'Session': '会话',
        'optional session id': '可选会话 ID',
        'Command': '命令',
        'Workspace': '工作区',
        'worker default': '工作端默认',
        'keep': '保留',
        'cleanup': '清理',
        'Sandbox': '沙盒',
        'default': '默认',
        'isolated env': '隔离环境',
        'Env': '环境变量',
        'Artifact include': '产物包含',
        'Artifact exclude': '产物排除',
        'Input files': '输入文件',
        'Shell command template': 'Shell 命令模板',
        'Require routable workers': '要求可路由工作端',
        'Submit': '提交',
        'Require routable worker': '要求可路由工作端',
        'Distributed Planner': '分布式规划器',
        'Mode': '模式',
        'Shards': '分片',
        'Strategy': '策略',
        'Depends On': '依赖',
        'Assumptions': '假设',
        'Large task': '大任务',
        'Optional focus areas': '可选关注点',
        'Describe the task to split across workers': '描述要拆分到多个工作端的大任务',
        'Plan Distributed Task': '规划分布式任务',
        'Run Distributed Plan': '运行分布式计划',
        'No distributed plan loaded': '尚未加载分布式计划',
        'Distributed planner requires a large task prompt': '分布式规划器需要填写大任务描述',
        'Plan Batch': '规划批次',
        'Batch JSON': '批次 JSON',
        'Submit Batch JSON': '提交批次 JSON',
        'Submit Batch': '提交批次',
        'Preview Dispatch': '预览分配',
        'No dispatch preview loaded': '尚未加载分配预览',
        'Batches': '批次',
        'Batch Detail': '批次详情',
        'Select a batch': '选择一个批次',
        'Create Session': '创建会话',
        'Sessions': '会话',
        'Session Detail': '会话详情',
        'Select a session': '选择一个会话',
        'No records': '暂无记录',
        'ID': 'ID',
        'Gateway': '网关',
        'Admin': '管理',
        'Slots': '槽位',
        'Tools': '工具',
        'Agent': 'Agent',
        'Agent Test': 'Agent 自测',
        'Actions': '操作',
        'Action': '操作',
        'View': '查看',
        'Use': '使用',
        'Auto Route': '自动路由',
        'Use In Forms': '填入表单',
        'Load Events': '加载事件',
        'Metrics': '指标',
        'Worker Events': '工作端事件',
        'Recent Worker Tasks': '最近工作端任务',
        'Status': '状态',
        'Title': '标题',
        'Task': '任务',
        'Label': '标签',
        'Preview': '预览',
        'Created': '创建时间',
        'Last Used': '最近使用',
        'Uses': '使用次数',
        'Expires': '过期时间',
        'Revoked': '已撤销',
        'Revoke': '撤销',
        'Health': '健康',
        'Eligible': '符合条件',
        'State': '状态',
        'Self Tests': '自测',
        'Exit': '退出码',
        'Artifacts': '产物',
        'Problems': '问题',
        'No problems': '没有问题',
        'Verify': '验证',
        'Batch': '批次',
        'Checks': '检查项',
        'Skipped': '已跳过',
        'Check': '检查',
        'Duration': '耗时',
        'Detail': '详情',
        'Dashboard': '控制台',
        'Network': '网络',
        'Public URL': '公开 URL',
        'Route Checks': '路由检查',
        'Inferred': '自动推断',
        'Verification': '验证',
        'Cleanup': '清理',
        'Plan': '计划',
        'Assigned': '已分配',
        'Unassigned': '未分配',
        'Key': '键',
        'Reason': '原因',
        'Candidates': '候选项',
        'Priority': '优先级',
        'At': '时间',
        'Type': '类型',
        'Message': '消息',
        'Path': '路径',
        'Size': '大小',
        'SHA256': 'SHA256',
        'Download': '下载',
        'Scheduler': '调度器',
        'Selected Worker': '选中工作端',
        'Inferred Capabilities': '自动推断能力',
        'Effective Capabilities': '最终必需能力',
        'Inference Explanation': '推断说明',
        'Eligible': '符合条件',
        'Routable': '可路由',
        'Inferred': '自动推断',
        'Effective': '最终能力',
        'Score': '分数',
        'Reasons': '原因',
        'Manage Task': '管理任务',
        'Cancel': '取消',
        'Requeue': '重新排队',
        'Reschedule': '重新调度',
        'Stdout': '标准输出',
        'Stderr': '标准错误',
        'Events': '事件',
        'Load All Events': '加载全部事件',
        'Stream Events': '流式事件',
        'Stop Stream': '停止流',
        'Stored': '已存储',
        'Done': '完成',
        'Report': '报告',
        'Retry Failed': '重试失败项',
        'Completed': '已完成',
        'Counts': '计数',
        'Event Timeline': '事件时间线',
        'Manage Batch': '管理批次',
        'Cancel Remaining': '取消剩余项',
        'Child Tasks': '子任务',
        'Batch Artifacts': '批次产物',
        'List Artifacts': '列出产物',
        'Download ZIP': '下载 ZIP',
        'No batch artifact list loaded': '尚未加载批次产物列表',
        'Output Excerpts': '输出摘要',
        'No output yet': '暂无输出',
        'Next Actions': '下一步操作',
        'No suggested action': '暂无建议操作',
        'add_worker_or_relax_constraints': '补充工作端或放宽约束',
        'fix_target_or_reschedule': '修复目标或重新调度',
        'inspect_requested_worker': '检查指定工作端',
        'wait_or_add_capacity': '等待或增加容量',
        'Add or resume a worker matching the required capabilities/tools/labels, or resubmit with different routing constraints.': '添加或恢复符合能力/工具/标签要求的工作端，或使用不同路由约束重新提交。',
        'Check the explicit target worker state/capabilities, or reschedule the task to allow automatic routing.': '检查显式目标工作端的状态/能力，或重新调度以允许自动路由。',
        'Check worker status and logs; the requested worker has not claimed the queued task yet.': '检查工作端状态和日志；指定工作端尚未领取该排队任务。',
        'Wait for current work to finish, reduce requested slots, or add another matching worker with free capacity.': '等待当前任务完成、降低请求槽位，或添加另一个有空闲容量的匹配工作端。',
        'Source': '来源',
        'Refresh Timeline': '刷新时间线',
        'Latest Session Artifacts': '最新会话产物',
        'No session artifact list loaded': '尚未加载会话产物列表',
        'Session Tasks': '会话任务',
        'Use In Task Form': '填入任务表单',
        'Close Session': '关闭会话',
        'Current Task': '当前任务',
        'Last Seen': '最后在线',
        'Current Tasks': '当前任务',
        'No tool inventory reported': '尚未上报工具清单',
        'Load worker events': '加载工作端事件',
        'Loading worker...': '正在加载工作端...',
        'Loading worker events...': '正在加载工作端事件...',
        'Loading task...': '正在加载任务...',
        'Loading batch...': '正在加载批次...',
        'Loading session...': '正在加载会话...',
        'No scheduler decision recorded': '没有调度决策记录',
        'Source Task': '来源任务',
        'active': '活跃',
        'revoked': '已撤销',
        'stored': '已存储',
        'skipped': '已跳过',
        'eligible': '符合条件',
        'rejected': '已拒绝',
        'ok': '正常',
        'failed': '失败',
        'succeeded': '成功',
        'cancelled': '已取消',
        'offline': '离线',
        'shutdown_requested': '请求关机',
        'running': '运行中',
        'queued': '排队中',
        'blocked': '已阻塞',
        'paused': '已暂停',
        'draining': '排空中',
        'completed_with_errors': '完成但有错误',
        'idle': '空闲',
        'enabled': '启用',
        'open': '打开',
        'available': '可用',
        'assigned': '已分配',
        'unassigned': '未分配',
        'skipped': '已跳过',
        'missing': '缺失',
        'pause': '暂停',
        'resume': '恢复',
        'drain': '排空',
        'shutdown': '关机',
        'cancel current': '取消当前任务',
        'total': '总计',
        'running': '运行中',
        'active': '活跃',
        'loopback': '回环地址',
        'used': '已使用',
        'optional command template': '可选命令模板',
        'ubuntu laptop': 'Ubuntu 笔记本',
        'retry worker id': '重试工作端 ID',
        'optional': '可选',
        'dashboard': '控制台',
      },
    };
    const statusPatterns = [
      [/^Showing recent user tasks \\((.+)\\)$/, '显示最近用户任务（$1）'],
      [/^Showing all recent history \\((.+)\\)$/, '显示全部最近历史（$1）'],
      [/^(.+) total, (.+) running, (.+) needs attention$/, '$1 总计，$2 运行中，$3 需要处理'],
      [/^(.+) total, (.+) running$/, '$1 总计，$2 运行中'],
      [/^(.+) open$/, '$1 打开'],
      [/^Enter NADO_TOKEN to load gateway state$/, '请输入 NADO_TOKEN 以加载网关状态'],
      [/^Enter NADO_TOKEN to load worker tokens$/, '请输入 NADO_TOKEN 以加载工作端令牌'],
      [/^Enter NADO_TOKEN to load worker enrollment tokens$/, '请输入 NADO_TOKEN 以加载工作端接入注册令牌'],
      [/^Connected to real terminal agents: (.+)$/, '已连接真实终端 Agent：$1'],
      [/^Refreshing\\.\\.\\.$/, '正在刷新...'],
      [/^Updated (.+)$/, '已更新 $1'],
      [/^Streaming (.+)\\.\\.\\.$/, '正在流式读取 $1...'],
      [/^Stream completed: (.+) (.+)$/, '流式读取完成：$1 $2'],
      [/^Stopped event stream$/, '已停止事件流'],
      [/^Loaded (\\d+) worker tokens$/, '已加载 $1 个工作端令牌'],
      [/^Revoked worker token (.+)$/, '已撤销工作端令牌 $1'],
      [/^Loaded (\\d+) worker enrollment tokens$/, '已加载 $1 个工作端接入注册令牌'],
      [/^Showing active enrollment tokens \\((\\d+) hidden\\)$/, '正在显示可用接入注册令牌（已隐藏 $1 个历史令牌）'],
      [/^Revoked worker enrollment token (.+)$/, '已撤销工作端接入注册令牌 $1'],
      [/^Pruned (\\d+) unused worker enrollment token\\(s\\)$/, '已清理 $1 个未使用工作端接入注册令牌'],
      [/^No unused worker enrollment tokens to prune$/, '没有可清理的未使用接入注册令牌'],
      [/^Loaded worker events for (.+)$/, '已加载 $1 的工作端事件'],
      [/^Loaded (\\d+) task events$/, '已加载 $1 条任务事件'],
      [/^Pruned (\\d+) completed task\\(s\\), kept latest (.+)$/, '已清理 $1 个已完成任务，保留最近 $2 个'],
      [/^Pruned (\\d+) system task\\(s\\) and (\\d+) system batch\\(es\\)$/, '已清理 $1 个系统任务和 $2 个系统批次'],
      [/^Demo reset cleared (\\d+) task\\(s\\), (\\d+) empty session\\(s\\), (\\d+) system item\\(s\\)$/, 'Demo 复位已清理 $1 个任务、$2 个空会话、$3 个系统项'],
      [/^No completed standalone tasks to prune$/, '没有可清理的独立已完成任务'],
      [/^Demo already clean$/, 'Demo 已经是干净状态'],
      [/^No completed system history to prune$/, '没有可清理的系统历史'],
      [/^cancel task (.+) -> (.+)$/, '已取消任务 $1 -> $2'],
      [/^Cancelled (\\d+) routing issue task\\(s\\)$/, '已取消 $1 个路由异常任务'],
      [/^requeue task (.+) -> (.+)$/, '已重新排队任务 $1 -> $2'],
      [/^reschedule task (.+) -> (.+)$/, '已重新调度任务 $1 -> $2'],
      [/^Loaded agent context$/, '已加载 Agent 上下文'],
      [/^Downloaded AGENTS\\.md$/, '已下载 AGENTS.md'],
      [/^Loaded gateway manifest$/, '已加载网关清单'],
      [/^Downloaded gateway manifest$/, '已下载网关清单'],
      [/^Loaded MCP config$/, '已加载 MCP 配置'],
      [/^Downloaded MCP config$/, '已下载 MCP 配置'],
      [/^Loaded (\\d+) offline recovery candidates$/, '已加载 $1 个离线恢复候选项'],
      [/^Recovered (\\d+) offline tasks(, skipped (\\d+))?$/, '已恢复 $1 个离线任务$2'],
      [/^Previewed dispatch for (\\d+) task\\(s\\)$/, '已预览 $1 个任务的分配'],
      [/^Loaded (\\d+) batch artifacts$/, '已加载 $1 个批次产物'],
      [/^Downloaded batch artifacts ZIP$/, '已下载批次产物 ZIP'],
      [/^Downloaded task artifacts ZIP$/, '已下载任务产物 ZIP'],
      [/^Loaded (\\d+) session artifacts$/, '已加载 $1 个会话产物'],
      [/^Downloaded session artifacts ZIP$/, '已下载会话产物 ZIP'],
      [/^Downloaded (.+)$/, '已下载 $1'],
      [/^Submitted (.+)$/, '已提交 $1'],
      [/^Console prompt is required$/, '主控控制台需要提示词'],
      [/^Console submitted (.+)$/, '主控控制台已提交 $1'],
      [/^Console completed (.+): (.+)$/, '主控控制台完成 $1：$2'],
      [/^Previewed console route: (.+)$/, '已预览主控控制台路由：$1'],
      [/^Console route blocked: (.+)$/, '主控控制台路由被阻止：$1'],
      [/^Console route check ok$/, '主控控制台路由检查正常'],
      [/^Console route check found (\\d+) problem\\(s\\)$/, '主控控制台路由检查发现 $1 个问题'],
      [/^Console stream stopped$/, '主控控制台日志流已停止'],
      [/^Console task (.+) already (.+)$/, '主控控制台任务 $1 已经是 $2'],
      [/^Console stop requested (.+)$/, '已请求停止主控控制台任务 $1'],
      [/^Routing blocked; dispatch plan shown for (\\d+) unassigned task\\(s\\)$/, '路由被阻止；已显示 $1 个未分配任务的分配计划'],
      [/^Console session (.+) ready$/, '主控控制台会话 $1 已就绪'],
      [/^Console empty session (.+) closed$/, '已关闭空的主控控制台会话 $1'],
      [/^Console empty session (.+) removed$/, '已移除空的主控控制台会话 $1'],
      [/^Console session cleared$/, '主控控制台会话已清除'],
      [/^No console task artifacts available$/, '当前控制台任务没有可下载产物'],
      [/^Submitted batch (.+)$/, '已提交批次 $1'],
      [/^Created session (.+)$/, '已创建会话 $1'],
      [/^Closed session (.+)$/, '已关闭会话 $1'],
      [/^Using worker (.+) in forms$/, '已将工作端 $1 填入表单'],
      [/^Using session (.+) for task submission$/, '已将会话 $1 用于任务提交'],
      [/^Downloaded invite for (.+)$/, '已下载 $1 的邀请脚本'],
      [/^Downloaded worker bundle for (.+)$/, '已下载 $1 的工作端包'],
      [/^Downloaded self-service worker bundle$/, '已下载自助工作端接入包'],
      [/^Downloaded self-service worker bundle with loopback control URL$/, '已下载自助工作端接入包，但主控 URL 是本机回环地址'],
      [/^Running self-test for (.+)\\.\\.\\.$/, '正在为 $1 运行自测...'],
      [/^Running agent self-test for (.+)\\.\\.\\.$/, '正在为 $1 运行 Agent 自测...'],
      [/^Agent self-test (.+) for (.+)$/, '$2 的 Agent 自测结果：$1'],
      [/^No agent self-test result for (.+)$/, '$1 没有返回 Agent 自测结果'],
      [/^Issued invite for (.+)$/, '已为 $1 签发邀请'],
      [/^Worker invite requires a worker ID$/, '工作端邀请需要 Worker ID'],
      [/^Shell tasks require a command$/, 'Shell 任务需要命令'],
      [/^Agent tasks require a prompt$/, 'Agent 任务需要提示词'],
      [/^Batch plan requires at least one task line$/, '批次规划至少需要一行任务'],
      [/^Planned (\\d+) batch task\\(s\\)$/, '已规划 $1 个批次任务'],
      [/^No invite generated yet$/, '尚未生成邀请'],
      [/^No agent context available$/, '没有可用的 Agent 上下文'],
      [/^No gateway manifest available$/, '没有可用的网关清单'],
      [/^No MCP config available$/, '没有可用的 MCP 配置'],
      [/^doctor=ok$/, '诊断正常'],
      [/^doctor found (\\d+) problem\\(s\\)$/, '诊断发现 $1 个问题'],
      [/^verify=ok$/, '验证正常'],
      [/^verify found (\\d+) problem\\(s\\)$/, '验证发现 $1 个问题'],
      [/^demoHealth=ok$/, 'Demo 健康检查正常'],
      [/^demoHealth found (\\d+) problem\\(s\\)$/, 'Demo 健康检查发现 $1 个问题'],
    ];
    state.locale = localStorage.getItem('nadoLocale') || 'zh-CN';
    localeInput.value = state.locale;

    function refreshStatusText(text) {
      const value = String(text || '');
      return value === 'Refreshing...' || value.startsWith('Updated ');
    }

    function setStatus(text, isError = false) {
      if (refreshStatusText(text) && Date.now() < state.statusHoldUntil) {
        return;
      }
      if (!refreshStatusText(text)) {
        state.statusHoldUntil = Date.now() + 4_000;
      }
      statusEl.dataset.i18nStatus = String(text ?? '');
      statusEl.textContent = localizeText(text);
      statusEl.className = isError ? 'status error' : 'status';
    }

    function activeDictionary() {
      return translations[state.locale] || {};
    }

    function localizeText(value) {
      const text = String(value ?? '');
      if (state.locale === 'en') {
        return text;
      }
      const dictionary = activeDictionary();
      const leading = text.match(/^\\s*/)?.[0] || '';
      const trailing = text.match(/\\s*$/)?.[0] || '';
      const core = text.trim();
      if (!core) {
        return text;
      }
      if (dictionary[core]) {
        return leading + dictionary[core] + trailing;
      }
      for (const [pattern, replacement] of statusPatterns) {
        if (pattern.test(core)) {
          return leading + core.replace(pattern, replacement) + trailing;
        }
      }
      return text;
    }

    function translateTextNode(node) {
      const original = textSources.get(node) ?? node.nodeValue;
      if (!textSources.has(node)) {
        textSources.set(node, original);
      }
      node.nodeValue = localizeText(original);
    }

    function translateElement(element) {
      for (const attr of ['placeholder', 'aria-label', 'title']) {
        if (!element.hasAttribute?.(attr)) {
          continue;
        }
        let originals = attrSources.get(element);
        if (!originals) {
          originals = {};
          attrSources.set(element, originals);
        }
        if (originals[attr] === undefined) {
          originals[attr] = element.getAttribute(attr);
        }
        element.setAttribute(attr, localizeText(originals[attr]));
      }
    }

    function applyLocale(root = document.body) {
      document.documentElement.lang = state.locale;
      document.title = state.locale === 'zh-CN' ? 'Nado 主控台' : 'Nado Control';
      if (localeInput.value !== state.locale) {
        localeInput.value = state.locale;
      }
      if (statusEl.dataset.i18nStatus) {
        statusEl.textContent = localizeText(statusEl.dataset.i18nStatus);
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || ['SCRIPT', 'STYLE'].includes(parent.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      const nodes = [];
      while (walker.nextNode()) {
        nodes.push(walker.currentNode);
      }
      nodes.forEach(translateTextNode);
      const elements = root.nodeType === Node.ELEMENT_NODE ? [root, ...root.querySelectorAll('*')] : [...document.querySelectorAll('*')];
      elements.forEach(translateElement);
    }

    const i18nObserver = new MutationObserver((mutations) => {
      if (state.locale === 'en') {
        return;
      }
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            translateTextNode(node);
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            applyLocale(node);
          }
        });
      }
    });
    i18nObserver.observe(document.body, { childList: true, subtree: true });

    function headers() {
      return {
        accept: 'application/json',
        authorization: 'Bearer ' + tokenInput.value.trim(),
      };
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: {
          ...headers(),
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const error = new Error(data?.error || response.statusText);
        if (data?.dispatchPlan) {
          error.dispatchPlan = data.dispatchPlan;
        }
        if (data?.nextActions) {
          error.nextActions = data.nextActions;
        }
        throw error;
      }
      return data;
    }

    async function binaryApi(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: {
          accept: 'application/octet-stream',
          authorization: 'Bearer ' + tokenInput.value.trim(),
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || response.statusText);
      }
      return {
        blob: await response.blob(),
        fileName: fileNameFromDisposition(response.headers.get('content-disposition')),
        artifactPath: decodeURIComponent(response.headers.get('x-nado-artifact-path') || ''),
      };
    }

    function fileNameFromDisposition(value) {
      const text = String(value || '');
      const encoded = text.match(/filename\\*=UTF-8''([^;]+)/i);
      if (encoded) {
        try {
          return decodeURIComponent(encoded[1]);
        } catch {
          return encoded[1];
        }
      }
      const quoted = text.match(/filename="([^"]+)"/i);
      return quoted ? quoted[1] : null;
    }

    function stopEventStream() {
      if (state.eventStream) {
        state.eventStream.abort();
        state.eventStream = null;
      }
    }

    function decodeSseBlock(block) {
      const text = String(block || '').trim();
      if (!text || text.startsWith(':')) {
        return null;
      }
      const item = { event: 'message', id: null, data: '' };
      const data = [];
      for (const line of text.split(/\\r?\\n/)) {
        if (line.startsWith(':')) {
          continue;
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') {
          item.event = value || 'message';
        } else if (field === 'id') {
          item.id = value;
        } else if (field === 'data') {
          data.push(value);
        }
      }
      if (data.length) {
        const body = data.join('\\n');
        try {
          item.data = JSON.parse(body);
        } catch {
          item.data = body;
        }
      }
      return item;
    }

    async function streamSse(path, onEvent, label) {
      stopEventStream();
      const controller = new AbortController();
      state.eventStream = controller;
      setStatus('Streaming ' + label + '...');
      try {
        const response = await fetch(path, {
          headers: {
            accept: 'text/event-stream',
            authorization: 'Bearer ' + tokenInput.value.trim(),
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error('Stream failed with ' + response.status);
        }
        if (!response.body) {
          throw new Error('Streaming is not supported by this browser');
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          const parts = buffer.split(/\\r?\\n\\r?\\n/);
          buffer = parts.pop() || '';
          for (const part of parts) {
            const item = decodeSseBlock(part);
            if (!item) {
              continue;
            }
            if (item.event === 'event') {
              onEvent(item.data);
            } else if (item.event === 'done') {
              setStatus('Stream completed: ' + label + ' ' + item.data.status);
            } else if (item.event === 'error') {
              throw new Error(item.data.error || 'Stream error');
            }
          }
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          setStatus(error.message, true);
        }
      } finally {
        if (state.eventStream === controller) {
          state.eventStream = null;
        }
      }
    }

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[char]));
    }

    function badge(value) {
      const text = String(value || '-');
      const cls = ['succeeded', 'idle', 'enabled', 'open', 'Ready', 'assigned', 'verified', 'ready'].includes(text) ? 'ok'
        : ['failed', 'cancelled', 'offline', 'shutdown_requested', 'self-test-failed', 'unavailable'].includes(text) ? 'bad'
        : ['running', 'queued', 'blocked', 'paused', 'draining', 'completed_with_errors', 'Route Issue', 'unassigned', 'skipped', 'warning', 'configured', 'demo'].includes(text) ? 'warn'
        : '';
      return '<span class="badge ' + cls + '">' + esc(localizeText(text)) + '</span>';
    }

    function localizeSchedulerReason(value) {
      const text = String(value || '');
      if (state.locale === 'en' || !text) {
        return text;
      }
      const exact = {
        'explicit worker requested': '已指定工作端',
        'explicit worker requested; target not eligible': '已指定工作端，但目标当前不符合条件',
        'explicit worker cleared': '已清除指定工作端',
        'session worker affinity': '沿用会话绑定工作端',
        'no eligible worker': '没有符合条件的工作端',
        'blocked by dependencies': '被依赖任务阻塞',
        'missing required labels': '缺少必需标签',
        'idle': '空闲',
        'gpu match': 'GPU 匹配',
        'gpu probe detected': '探测到 GPU',
        'gpu advertised without probe': 'GPU 仅声明，未探测',
        'preserve gpu capacity': '保留 GPU 容量',
        'agent command configured': '已配置 Agent 命令',
        'real terminal agent': '真实终端 Agent',
        'demo echo agent': '演示回显 Agent',
        'custom agent command': '自定义 Agent 命令',
        'no agent command configured': '未配置 Agent 命令',
        'agent self-test not recorded': '未记录 Agent 自测',
        'agent self-test succeeded recently': 'Agent 自测近期成功',
        'agent self-test succeeded but stale': 'Agent 自测成功但已过期',
        'agent self-test status unknown': 'Agent 自测状态未知',
      };
      if (exact[text]) {
        return exact[text];
      }
      const patterns = [
        [/^scheduled by score (.+)$/, '按评分调度：$1'],
        [/^worker adminState=(.+)$/, '工作端管理状态：$1'],
        [/^missing required capabilities:? (.+)$/, '缺少必需能力：$1'],
        [/^missing required tools:? (.+)$/, '缺少必需工具：$1'],
        [/^agent preset tool missing: (.+)$/, 'Agent 预设缺少工具：$1'],
        [/^capacity full (.+); needs (.+)$/, '容量已满：$1，需要 $2'],
        [/^task slots (.+) exceed worker capacity (.+)$/, '任务槽位 $1 超过工作端容量 $2'],
        [/^running=(.+)$/, '运行中=$1'],
        [/^reserved=(.+)$/, '已预留=$1'],
        [/^slots=(.+)$/, '可用槽位=$1'],
        [/^needs=(.+)$/, '需要槽位=$1'],
        [/^inferred capability: (.+)$/, '自动推断能力：$1'],
        [/^labels=(.+)$/, '标签匹配=$1'],
        [/^agent self-test (.+)$/, 'Agent 自测：$1'],
        [/^(.+) available$/, '$1 可用'],
      ];
      for (const [pattern, replacement] of patterns) {
        if (pattern.test(text)) {
          return text.replace(pattern, replacement);
        }
      }
      return localizeText(text);
    }

    function localizeInferenceReason(value) {
      const text = String(value || '');
      if (state.locale === 'en' || !text) {
        return text;
      }
      const exact = {
        'CUDA keyword': 'CUDA 关键词',
        'cuDNN keyword': 'cuDNN 关键词',
        'NVIDIA GPU probe': 'NVIDIA GPU 探测',
        'VRAM keyword': 'VRAM/显存关键词',
        'ROCm keyword': 'ROCm 关键词',
        'TensorRT keyword': 'TensorRT 关键词',
        'Stable Diffusion workload': 'Stable Diffusion 工作负载',
        'ComfyUI workload': 'ComfyUI 工作负载',
        'Diffusers workload': 'Diffusers 工作负载',
        'ML framework with accelerator wording': '机器学习框架与加速器词汇同时出现',
        'Accelerator wording with ML framework': '加速器词汇与机器学习框架同时出现',
        'Chinese VRAM keyword': '中文显存关键词',
        'GPU execution verb': 'GPU 执行动词',
        'GPU keyword with execution verb': 'GPU 关键词与执行动作同时出现',
        'Chinese GPU execution wording': '中文 GPU 执行表述',
        'Chinese GPU keyword with execution wording': '中文 GPU 关键词与执行动作同时出现',
        'Chinese model workload with GPU wording': '中文模型工作负载与 GPU 表述同时出现',
        'Chinese GPU wording with model workload': '中文 GPU 表述与模型工作负载同时出现',
        'PPT keyword': 'PPT 关键词',
        'PowerPoint keyword': 'PowerPoint 关键词',
        'Slide deck keyword': '幻灯片/Deck 关键词',
        'Presentation deck keyword': '演示稿 Deck 关键词',
        'Slides creation wording': '幻灯片创建表述',
        'Slides artifact wording': '幻灯片产物表述',
        'Chinese PPT keyword': '中文 PPT 关键词',
        'Chinese slide keyword': '中文幻灯片关键词',
        'Chinese presentation document keyword': '中文演示文稿关键词',
        'Chinese deck creation wording': '中文演示稿创建表述',
        'Chinese deck artifact wording': '中文演示稿产物表述',
        'Documentation keyword': 'Documentation 关键词',
        'Docs keyword': 'Docs 关键词',
        'README keyword': 'README 关键词',
        'User guide keyword': '用户指南关键词',
        'Manual keyword': '手册关键词',
        'Word document artifact': 'Word/Docx 产物',
        'Documentation writing wording': '文档编写表述',
        'Documentation artifact wording': '文档产物表述',
        'Chinese docs keyword': '中文文档关键词',
        'Chinese manual keyword': '中文手册关键词',
        'Chinese documentation writing wording': '中文文档编写表述',
        'Chinese documentation artifact wording': '中文文档产物表述',
      };
      return exact[text] || localizeText(text);
    }

    function localizeReasonList(reasons = []) {
      return (reasons || []).map(localizeSchedulerReason).join(', ') || '-';
    }

    function localizeEventMessage(value) {
      const text = String(value || '').replace(/\\s+$/g, '');
      if (state.locale === 'en' || !text) {
        return text;
      }
      const exact = {
        'Task queued': '任务已排队',
        'Task succeeded': '任务成功',
        'Task failed': '任务失败',
        'Task cancelled': '任务已取消',
      };
      if (exact[text]) {
        return exact[text];
      }
      const patterns = [
        [/^Claimed by (.+)$/, '已由 $1 领取'],
        [/^Worker (.+) started task$/, '工作端 $1 已开始任务'],
        [/^Task (.+) scheduled: (.+)$/, (_, taskId, reason) => '任务 ' + taskId + ' 已调度：' + localizeSchedulerReason(reason)],
      ];
      for (const [pattern, replacement] of patterns) {
        if (pattern.test(text)) {
          return typeof replacement === 'function'
            ? text.replace(pattern, replacement)
            : text.replace(pattern, replacement);
        }
      }
      return localizeSchedulerReason(text);
    }

    function list(value) {
      return Array.isArray(value) && value.length ? value.map(esc).join(', ') : '-';
    }

    function labels(value) {
      const entries = Object.entries(value || {});
      return entries.length ? entries.map(([key, val]) => esc(key + '=' + val)).join(', ') : '-';
    }

    function terminalTaskStatus(status) {
      return ['succeeded', 'failed', 'cancelled'].includes(status);
    }

    function taskActionButtons(task, compact = false) {
      const buttons = ['<button data-task-view="' + esc(task.id) + '">View</button>'];
      if (compact) {
        return '<div class="actions">' + buttons.join('') + '</div>';
      }
      if (!terminalTaskStatus(task.status)) {
        buttons.push('<button data-task-manage="' + esc(task.id) + '" data-task-action="cancel">Cancel</button>');
      }
      if (task.status === 'queued') {
        if (taskNeedsAttention(task)) {
          buttons.push('<button data-task-manage="' + esc(task.id) + '" data-task-action="reschedule" data-task-auto-route="true">Auto Route</button>');
        } else {
          buttons.push('<button data-task-manage="' + esc(task.id) + '" data-task-action="reschedule">Reschedule</button>');
        }
      }
      if (['failed', 'cancelled'].includes(task.status)) {
        buttons.push('<button data-task-manage="' + esc(task.id) + '" data-task-action="requeue">Requeue</button>');
      }
      return '<div class="actions">' + buttons.join('') + '</div>';
    }

    function taskNeedsAttention(task) {
      if (!task || task.status !== 'queued' || !task.scheduler) {
        return false;
      }
      if (task.scheduler.workerId) {
        return false;
      }
      return ['no eligible worker', 'explicit worker requested; target not eligible'].includes(task.scheduler.reason);
    }

    function taskRoutingSummary(task) {
      if (!task?.scheduler) {
        return '-';
      }
      const candidateReasons = (task.scheduler.candidates || [])
        .flatMap((candidate) => candidate.reasons || [])
        .filter(Boolean);
      const uniqueReasons = Array.from(new Set(candidateReasons)).slice(0, 2);
      const pieces = [
        localizeSchedulerReason(task.scheduler.reason),
        ...uniqueReasons.map(localizeSchedulerReason),
      ].filter(Boolean);
      return pieces.join(' · ') || '-';
    }

    function nextActionForTask(task) {
      if (task?.nextAction) {
        return task.nextAction;
      }
      if (!task || task.status !== 'queued') {
        return null;
      }
      const reason = task.scheduler?.reason || '';
      if (reason === 'no eligible worker') {
        return {
          code: 'add_worker_or_relax_constraints',
          message: 'Add or resume a worker matching the required capabilities/tools/labels, or resubmit with different routing constraints.',
        };
      }
      if (reason === 'explicit worker requested; target not eligible') {
        return {
          code: 'fix_target_or_reschedule',
          message: 'Check the explicit target worker state/capabilities, or reschedule the task to allow automatic routing.',
        };
      }
      if (task.requestedWorkerId) {
        return {
          code: 'inspect_requested_worker',
          message: 'Check worker status and logs; the requested worker has not claimed the queued task yet.',
        };
      }
      return null;
    }

    function nextActionLabel(action) {
      return action?.code ? localizeText(action.code) : '-';
    }

    function renderNextAction(task) {
      const action = nextActionForTask(task);
      if (!action) {
        return '-';
      }
      return '<div class="routing-note">' + badge(nextActionLabel(action))
        + '<small>' + esc(localizeText(action.message || '')) + '</small></div>';
    }

    function renderRoutingCell(task) {
      if (!task?.scheduler) {
        return '-';
      }
      if (taskNeedsAttention(task)) {
        const action = nextActionForTask(task);
        return '<div class="routing-note">' + badge('Route Issue')
          + '<small>' + esc(taskRoutingSummary(task)) + (action ? '<br>' + esc(localizeText('Next Action')) + ': ' + esc(nextActionLabel(action)) : '') + '</small></div>';
      }
      const inferred = task.scheduler?.inferredCapabilities || [];
      if (inferred.length) {
        return '<div class="routing-note">' + badge('Ready')
          + '<small>' + esc(localizeSchedulerReason('inferred capability: ' + inferred.join(','))) + '</small></div>';
      }
      const reason = task.scheduler?.reason || (task.requestedWorkerId ? 'explicit worker requested' : '');
      if (task.status !== 'queued') {
        return '<small>' + esc(localizeSchedulerReason(reason) || '-') + '</small>';
      }
      return '<div class="routing-note">' + badge('Ready')
        + '<small>' + esc(localizeSchedulerReason(reason) || '-') + '</small></div>';
    }

    function taskWorkerDisplay(task) {
      const workerId = task.assignedWorkerId || task.requestedWorkerId || task.scheduler?.workerId || '-';
      if (!taskNeedsAttention(task)) {
        return esc(workerId);
      }
      return esc(workerId) + '<br>' + badge('Route Issue');
    }

    function taskStatsText({ userCount, runningCount, attentionCount, hiddenSystemTasks }) {
      if (state.locale === 'zh-CN') {
        return userCount + ' 个用户任务，' + runningCount + ' 个运行中，' + attentionCount + ' 个需处理'
          + (hiddenSystemTasks ? '，已隐藏 ' + hiddenSystemTasks + ' 个系统任务' : '');
      }
      return userCount + ' user, ' + runningCount + ' running, ' + attentionCount + ' needs attention'
        + (hiddenSystemTasks ? ', ' + hiddenSystemTasks + ' hidden system' : '');
    }

    function batchStatsText(total, running) {
      return state.locale === 'zh-CN'
        ? total + ' 个批次，' + running + ' 个运行中'
        : total + ' total, ' + running + ' running';
    }

    function sessionStatsText(open) {
      return state.locale === 'zh-CN'
        ? open + ' 个打开'
        : open + ' open';
    }

    function table(columns, rows) {
      if (!rows.length) {
        return '<div class="empty">No records</div>';
      }
      return '<div class="table-wrap"><table><thead><tr>'
        + columns.map((column) => '<th>' + esc(localizeText(column.label)) + '</th>').join('')
        + '</tr></thead><tbody>'
        + rows.map((row) => '<tr>' + columns.map((column) => '<td>' + column.value(row) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table></div>';
    }

    function workbenchMode() {
      return (state.activeView || 'workbench') === 'workbench';
    }

    function renderStats(snapshot) {
      const visibleTasks = userTasks(snapshot.tasks.items || []);
      const hiddenSystemTasks = Math.max(0, (snapshot.tasks.items || []).length - visibleTasks.length);
      const counts = visibleTasks.reduce((acc, task) => {
        acc[task.status] = (acc[task.status] || 0) + 1;
        return acc;
      }, {});
      const batches = snapshot.batches.counts || {};
      const attentionCount = snapshot.tasks.attention?.total ?? (snapshot.tasks.items || []).filter(taskNeedsAttention).length;
      document.getElementById('stats').innerHTML = [
        ['Workers', snapshot.workers.active + ' / ' + snapshot.workers.total],
        ['Tasks', taskStatsText({
          userCount: visibleTasks.length,
          runningCount: counts.running || 0,
          attentionCount,
          hiddenSystemTasks,
        })],
        ['Batches', batchStatsText(snapshot.batches.total, batches.running || 0)],
        ['Sessions', sessionStatsText(snapshot.sessions.open)],
      ].map(([label, value]) => '<div class="stat"><span>' + label + '</span><strong>' + esc(value) + '</strong></div>').join('');
    }

    function availableTools(worker) {
      return Object.entries(worker.inventory?.tools || {})
        .filter(([, tool]) => tool.available)
        .map(([name]) => name);
    }

    function gpuDiagnostic(worker) {
      if (worker.resources?.gpu) {
        return worker.resources.gpu;
      }
      const tools = worker.inventory?.tools || {};
      const probes = [
        { name: 'nvidia-smi', tool: 'nvidiaSmi', available: !!tools.nvidiaSmi?.available, version: tools.nvidiaSmi?.version || null },
        { name: 'rocm-smi', tool: 'rocmSmi', available: !!tools.rocmSmi?.available, version: tools.rocmSmi?.version || null },
      ];
      const advertised = (worker.capabilities || []).includes('gpu');
      const detected = probes.some((probe) => probe.available);
      return {
        advertised,
        detected,
        source: detected ? 'probe' : (advertised ? 'advertised' : 'none'),
        probes,
        warning: advertised && !detected
          ? 'gpu capability is advertised but no NVIDIA/ROCm probe was reported; verify the worker GPU runtime before scheduling real accelerator workloads'
          : '',
      };
    }

    function renderGpuDiagnostic(worker) {
      const gpu = gpuDiagnostic(worker);
      const availableProbe = (gpu.probes || []).find((probe) => probe.available);
      const text = availableProbe ? availableProbe.name : localizeText(gpu.source || 'none');
      return esc(text) + (gpu.warning ? '<br><small class="warn-text">' + esc(localizeText(gpu.warning)) + '</small>' : '');
    }

    function agentReadiness(worker) {
      if (worker.readiness?.agent) {
        return worker.readiness.agent;
      }
      const tools = worker.inventory?.tools || {};
      const configured = !!worker.agentCommandConfigured;
      const preset = worker.agentPreset || null;
      const selfTest = worker.diagnostics?.agentSelfTest || null;
      const selfTestStatus = String(selfTest?.status || '').toLowerCase();
      const selfTestFailed = selfTestStatus && selfTestStatus !== 'succeeded';
      const expectedTool = preset === 'codex' || preset === 'claude' ? preset : null;
      const expectedToolAvailable = expectedTool ? !!tools[expectedTool]?.available : !!(tools.codex?.available || tools.claude?.available);
      if (!configured) {
        return { status: 'unavailable', mode: 'shell-only', warning: 'no agent command configured; this worker can run shell tasks but not terminal-agent tasks' };
      }
      if (preset === 'node-copy') {
        return {
          status: selfTestFailed ? 'self-test-failed' : 'demo',
          mode: 'demo-echo',
          warning: selfTestFailed ? 'agent self-test did not succeed; inspect worker diagnostics before assigning agent tasks' : 'demo echo agent is configured; it validates scheduling and artifacts but does not perform real LLM reasoning',
        };
      }
      if (expectedTool && !expectedToolAvailable) {
        return { status: 'warning', mode: 'missing-tool', warning: preset + ' preset is configured but the ' + preset + ' CLI was not reported in worker inventory' };
      }
      if (selfTestFailed) {
        return { status: 'self-test-failed', mode: expectedTool ? 'real-terminal-agent' : 'custom', warning: 'agent self-test did not succeed; inspect worker diagnostics before assigning agent tasks' };
      }
      if (expectedTool && expectedToolAvailable) {
        return { status: selfTestStatus === 'succeeded' ? 'verified' : 'ready', mode: 'real-terminal-agent', warning: selfTestStatus === 'succeeded' ? '' : 'agent command is configured, but no successful agent self-test has been recorded yet' };
      }
      return { status: selfTestStatus === 'succeeded' ? 'verified' : 'configured', mode: 'custom', warning: selfTestStatus === 'succeeded' ? '' : 'custom agent command is configured; run an agent self-test before trusting real agent work' };
    }

    function renderAgentReadiness(worker) {
      const readiness = agentReadiness(worker);
      return badge(readiness.status || '-')
        + '<br><small>' + esc(localizeText(readiness.mode || '-')) + '</small>'
        + (readiness.warning ? '<br><small class="warn-text">' + esc(localizeText(readiness.warning)) + '</small>' : '');
    }

    function onlineWorkers(workers = []) {
      return workers.filter((worker) => worker.gatewayState !== 'offline');
    }

    function readinessCard(title, message, tone = '') {
      return '<div class="readiness-item ' + esc(tone) + '">'
        + '<strong>' + esc(localizeText(title)) + '</strong>'
        + '<small>' + message + '</small>'
        + '</div>';
    }

    function renderControlReadiness(snapshot = state.snapshot) {
      const target = document.getElementById('readinessStrip');
      if (!target) {
        return;
      }
      if (!snapshot) {
        target.innerHTML = readinessCard('Control URL', esc(localizeText('Waiting for gateway state')), 'warn');
        return;
      }
      const workers = onlineWorkers(snapshot.workers?.items || []);
      const network = state.networkInfo;
      const preferredUrl = network?.preferredRemoteControlUrl || preferredControlUrlCandidate(network)?.url || '';
      const networkTone = network?.remoteWorkerReady ? 'ok' : (network ? 'warn' : '');
      const networkMessage = network
        ? (network.remoteWorkerReady
          ? esc(localizeText('Ready for remote workers')) + '<br><span class="mono">' + esc(preferredUrl) + '</span>'
          : esc(localizeText('Configure public URL for IPv6/LAN workers')) + '<br>' + esc(localizeText('IPv6 literals must use brackets, for example http://[2001:db8::10]:8765')))
        : esc(localizeText('Scan network URL from Worker Onboarding'));

      const agentWorkers = workers.filter((worker) => agentReadiness(worker).readyForAgentTasks !== false && worker.agentCommandConfigured);
      const realAgentWorkers = agentWorkers.filter((worker) => agentReadiness(worker).realTerminalAgent);
      const verifiedAgentWorkers = realAgentWorkers.filter((worker) => agentReadiness(worker).status === 'verified');
      const agentTone = verifiedAgentWorkers.length ? 'ok' : (realAgentWorkers.length || agentWorkers.length ? 'warn' : 'bad');
      const agentMessage = verifiedAgentWorkers.length
        ? esc(localizeText('Verified terminal agent ready')) + ': <span class="mono">' + esc(verifiedAgentWorkers.map((worker) => worker.id).join(', ')) + '</span>'
        : (realAgentWorkers.length
          ? esc(localizeText('Real terminal agent ready')) + ': <span class="mono">' + esc(realAgentWorkers.map((worker) => worker.id).join(', ')) + '</span>'
        : (agentWorkers.length
          ? esc(localizeText('Demo/custom agent only')) + ': <span class="mono">' + esc(agentWorkers.map((worker) => worker.id).join(', ')) + '</span>'
          : esc(localizeText('No agent worker online'))));

      const gpuWorkers = workers.filter((worker) => (worker.capabilities || []).includes('gpu'));
      const probedGpuWorkers = gpuWorkers.filter((worker) => gpuDiagnostic(worker).detected);
      const advertisedOnlyGpuWorkers = gpuWorkers.filter((worker) => gpuDiagnostic(worker).advertised && !gpuDiagnostic(worker).detected);
      const gpuTone = probedGpuWorkers.length ? 'ok' : (gpuWorkers.length ? 'warn' : 'bad');
      const gpuMessage = probedGpuWorkers.length
        ? esc(localizeText('GPU worker has accelerator probe')) + ': <span class="mono">' + esc(probedGpuWorkers.map((worker) => worker.id).join(', ')) + '</span>'
        : (advertisedOnlyGpuWorkers.length
          ? esc(localizeText('GPU worker advertised only')) + ': <span class="mono">' + esc(advertisedOnlyGpuWorkers.map((worker) => worker.id).join(', ')) + '</span>'
          : esc(localizeText('No GPU worker online')));

      target.innerHTML = [
        readinessCard('Remote Workers', networkMessage, networkTone),
        readinessCard('Agent Runtime', agentMessage, agentTone),
        readinessCard('GPU Routing', gpuMessage, gpuTone),
        readinessCard('Auto Routing', esc(localizeText('Task text can infer gpu, docs, ppt')), 'ok'),
      ].join('');
    }

    function renderConsoleAgentNotice(workers) {
      const target = document.getElementById('consoleAgentNotice');
      if (!target) {
        return;
      }
      const activeWorkers = (workers || []).filter((worker) => worker.adminState !== 'disabled');
      const realAgentWorkers = activeWorkers.filter((worker) => {
        const tools = availableTools(worker);
        return worker.agentCommandConfigured
          && (
            (worker.agentPreset === 'codex' && tools.includes('codex'))
            || (worker.agentPreset === 'claude' && tools.includes('claude'))
          );
      });
      const echoWorkers = activeWorkers.filter((worker) => worker.agentPreset === 'node-copy');
      if (realAgentWorkers.length) {
        target.className = 'console-agent-notice ok';
        target.textContent = localizeText('Connected to real terminal agents: ' + realAgentWorkers.map((worker) => worker.id).join(', '));
        return;
      }
      if (echoWorkers.length) {
        target.className = 'console-agent-notice warn';
        target.textContent = localizeText('Demo echo agent is active. It validates scheduling and artifact flow, but it does not analyze prompts. Start a worker with Codex or Claude to run real agent work.');
        return;
      }
      if (activeWorkers.some((worker) => worker.agentCommandConfigured)) {
        target.className = 'console-agent-notice warn';
        target.textContent = localizeText('Agent workers are online, but no Codex or Claude tool is reported. Agent tasks may use a custom command or demo echo preset.');
        return;
      }
      target.className = 'console-agent-notice warn';
      target.textContent = localizeText('No active terminal agent worker is ready.');
    }

    function renderAgentSelfTest(worker) {
      const current = worker.diagnostics?.agentSelfTest ? badge(worker.diagnostics.agentSelfTest.status) : '-';
      if (!worker.agentCommandConfigured) {
        return current;
      }
      return current
        + '<div class="actions"><button data-worker-agent-self-test="' + esc(worker.id) + '">Run Agent Self-Test</button></div>';
    }

    function canForgetWorker(worker) {
      return ['offline', 'shutdown_requested', 'drained'].includes(worker.gatewayState)
        && !(worker.runningTasks || worker.reservedTasks || (worker.currentTaskIds || []).length);
    }

    function renderWorkers(workers) {
      const compact = workbenchMode();
      const columns = compact ? [
        { label: 'ID', value: (worker) => '<span class="mono">' + esc(worker.id) + '</span>' },
        { label: 'Gateway', value: (worker) => badge(worker.gatewayState) },
        { label: 'Slots', value: (worker) => esc((worker.runningSlots || 0) + '/' + (worker.maxConcurrency || 1)) },
        { label: 'Capabilities', value: (worker) => list(worker.capabilities) },
        { label: 'Agent', value: renderAgentReadiness },
        { label: 'Agent Test', value: renderAgentSelfTest },
        { label: 'Actions', value: (worker) => '<div class="actions">'
          + '<button data-worker-use="' + esc(worker.id) + '">Use</button>'
          + '<button data-worker-view="' + esc(worker.id) + '">View</button>'
          + '</div>' },
      ] : [
        { label: 'ID', value: (worker) => '<span class="mono">' + esc(worker.id) + '</span>' },
        { label: 'Gateway', value: (worker) => badge(worker.gatewayState) },
        { label: 'Admin', value: (worker) => badge(worker.adminState) },
        { label: 'Slots', value: (worker) => esc((worker.runningSlots || 0) + '/' + (worker.maxConcurrency || 1)) },
        { label: 'Capabilities', value: (worker) => list(worker.capabilities) },
        { label: 'Labels', value: (worker) => labels(worker.labels) },
        { label: 'Tools', value: (worker) => list(Object.entries(worker.inventory?.tools || {}).filter(([, tool]) => tool.available).map(([name]) => name)) },
        { label: 'Agent', value: renderAgentReadiness },
        { label: 'Agent Test', value: renderAgentSelfTest },
        { label: 'Actions', value: (worker) => '<div class="actions">'
          + '<button data-worker-view="' + esc(worker.id) + '">View</button>'
          + '<button data-worker-use="' + esc(worker.id) + '">Use</button>'
          + ['pause', 'resume', 'drain', 'shutdown', 'cancel_current'].map((action) => '<button data-worker="' + esc(worker.id) + '" data-action="' + action + '">' + action.replace('_', ' ') + '</button>').join('')
          + (canForgetWorker(worker) ? '<button data-worker-forget="' + esc(worker.id) + '">Forget</button>' : '')
          + '</div>' },
      ];
      document.getElementById('workers').innerHTML = table(columns, compact ? workers.slice(0, 6) : workers);
    }

    function workerTasks(workerId) {
      return (state.snapshot?.tasks?.items || []).filter((task) => task.assignedWorkerId === workerId || task.requestedWorkerId === workerId);
    }

    function renderWorkerDetail(worker) {
      const detail = document.getElementById('workerDetail');
      const tools = Object.entries(worker.inventory?.tools || {})
        .map(([name, tool]) => name + '=' + (tool.available ? (tool.version || 'available') : 'missing'))
        .join('\\n') || 'No tool inventory reported';
      const tasks = workerTasks(worker.id).slice(0, 10);
      const agentSelfTest = worker.diagnostics?.agentSelfTest || null;
      const workerEvents = state.selectedWorkerEvents?.workerId === worker.id
        ? renderEventRows(state.selectedWorkerEvents.events || [])
        : '<div class="empty">Load worker events</div>';
      detail.innerHTML = ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>ID</span><div class="mono">' + esc(worker.id) + '</div></div>'
        + '<div class="detail-item"><span>Gateway</span>' + badge(worker.gatewayState) + '</div>'
        + '<div class="detail-item"><span>Admin</span>' + badge(worker.adminState) + '</div>'
        + '<div class="detail-item"><span>Slots</span><div>' + esc((worker.runningSlots || 0) + '/' + (worker.maxConcurrency || 1) + ' used') + '</div></div>'
        + '</div>'
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>Capabilities</span><div>' + list(worker.capabilities || []) + '</div></div>'
        + '<div class="detail-item"><span>Labels</span><div>' + labels(worker.labels || {}) + '</div></div>'
        + '<div class="detail-item"><span>GPU probe</span><div>' + renderGpuDiagnostic(worker) + '</div></div>'
        + '<div class="detail-item"><span>Agent readiness</span><div>' + renderAgentReadiness(worker) + '</div></div>'
        + '<div class="detail-item"><span>Current Tasks</span><div>' + list(worker.currentTaskIds || (worker.currentTaskId ? [worker.currentTaskId] : [])) + '</div></div>'
        + '<div class="detail-item"><span>Last Seen</span><div>' + esc(worker.lastSeenAt || '-') + '</div></div>'
        + '<div class="detail-item"><span>Agent Test</span><div>' + (agentSelfTest ? badge(agentSelfTest.status) + '<br><small>' + esc(agentSelfTest.at || '-') + '</small>' : '-') + '</div></div>'
        + '</div>'
        + '<div class="actions">'
        + '<button data-worker-use="' + esc(worker.id) + '">Use In Forms</button>'
        + '<button data-worker-events="' + esc(worker.id) + '">Load Events</button>'
        + (worker.agentCommandConfigured ? '<button data-worker-agent-self-test="' + esc(worker.id) + '">Run Agent Self-Test</button>' : '')
        + ['pause', 'resume', 'drain', 'shutdown', 'cancel_current'].map((action) => '<button data-worker="' + esc(worker.id) + '" data-action="' + action + '">' + action.replace('_', ' ') + '</button>').join('')
        + (canForgetWorker(worker) ? '<button data-worker-forget="' + esc(worker.id) + '">Forget</button>' : '')
        + '</div>'
        + '<div class="subhead">Metrics</div><pre>' + esc(JSON.stringify(worker.metrics || {}, null, 2)) + '</pre>'
        + '<div class="subhead">Tools</div><pre>' + esc(tools) + '</pre>'
        + '<div class="subhead">Worker Events</div><div id="workerEvents">' + workerEvents + '</div>'
        + '<div class="subhead">Recent Worker Tasks</div>' + table([
          { label: 'ID', value: (task) => '<span class="mono">' + esc(task.id) + '</span>' },
          { label: 'Status', value: (task) => badge(task.status) },
          { label: 'Title', value: (task) => esc(task.title || task.id) },
          { label: 'Actions', value: (task) => '<button data-task-view="' + esc(task.id) + '">Task</button>' },
        ], tasks);
      bindWorkerButtons(detail);
      bindTaskDetailButtons(detail);
    }

    async function loadWorkerDetail(workerId) {
      if (state.selectedWorkerId !== workerId) {
        state.selectedWorkerEvents = null;
      }
      state.selectedWorkerId = workerId;
      document.getElementById('workerDetail').innerHTML = '<div class="empty">Loading worker...</div>';
      const { worker } = await api('/api/workers/' + encodeURIComponent(workerId));
      renderWorkerDetail(worker);
    }

    async function loadWorkerEvents(workerId) {
      const target = document.getElementById('workerEvents');
      if (target) {
        target.innerHTML = '<div class="empty">Loading worker events...</div>';
      }
      const result = await api('/api/workers/' + encodeURIComponent(workerId) + '/events?tail=50');
      state.selectedWorkerEvents = result;
      const nextTarget = document.getElementById('workerEvents');
      if (nextTarget) {
        nextTarget.innerHTML = renderEventRows(result.events || []);
      }
      setStatus('Loaded worker events for ' + workerId);
    }

    function renderWorkerTokens(workerTokens) {
      document.getElementById('workerTokens').innerHTML = table([
        { label: 'ID', value: (token) => '<span class="mono">' + esc(token.id) + '</span>' },
        { label: 'Worker', value: (token) => esc(token.workerId) },
        { label: 'Label', value: (token) => esc(token.label || '-') },
        { label: 'Preview', value: (token) => esc(token.tokenPreview || '-') },
        { label: 'Created', value: (token) => esc(token.createdAt || '-') },
        { label: 'Last Used', value: (token) => esc(token.lastUsedAt || '-') },
        { label: 'Revoked', value: (token) => token.revokedAt ? badge('revoked') : badge('active') },
        { label: 'Actions', value: (token) => token.revokedAt
          ? '-'
          : '<button data-worker-token-revoke="' + esc(token.id) + '">Revoke</button>' },
      ], workerTokens || []);
      bindWorkerTokenButtons();
    }

    async function loadWorkerTokens({ silent = false } = {}) {
      if (!tokenInput.value.trim()) {
        if (!silent) {
          setStatus('Enter NADO_TOKEN to load worker tokens', true);
        }
        return;
      }
      const workerId = document.getElementById('workerTokenFilter').value.trim();
      const suffix = workerId ? '?workerId=' + encodeURIComponent(workerId) : '';
      const { workerTokens } = await api('/api/worker-tokens' + suffix);
      renderWorkerTokens(workerTokens);
      if (!silent) {
        setStatus('Loaded ' + workerTokens.length + ' worker tokens');
      }
    }

    function bindWorkerTokenButtons(root = document) {
      root.querySelectorAll('[data-worker-token-revoke]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            const result = await api('/api/worker-tokens/' + encodeURIComponent(button.dataset.workerTokenRevoke) + '/revoke', {
              method: 'POST',
              body: JSON.stringify({}),
            });
            setStatus('Revoked worker token ' + result.workerToken.id);
            await loadWorkerTokens({ silent: true });
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
    }

    function enrollmentTokenStatus(token) {
      if (token.revokedAt) {
        return 'revoked';
      }
      if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
        return 'expired';
      }
      if (token.maxUses && Number(token.useCount || 0) >= Number(token.maxUses)) {
        return 'used';
      }
      return 'active';
    }

    function renderWorkerEnrollmentTokens(enrollmentTokens) {
      const rows = enrollmentTokens || [];
      const visible = state.showEnrollmentHistory
        ? rows
        : rows.filter((token) => enrollmentTokenStatus(token) === 'active');
      const hiddenCount = rows.length - visible.length;
      const hint = !state.showEnrollmentHistory && hiddenCount
        ? '<div class="network-summary">' + esc(localizeText('Showing active enrollment tokens (' + hiddenCount + ' hidden)')) + '</div>'
        : '';
      document.getElementById('workerEnrollmentTokens').innerHTML = hint + table([
        { label: 'ID', value: (token) => '<span class="mono">' + esc(token.id) + '</span>' },
        { label: 'Label', value: (token) => esc(token.label || '-') },
        { label: 'Preview', value: (token) => esc(token.tokenPreview || '-') },
        { label: 'Status', value: (token) => badge(enrollmentTokenStatus(token)) },
        { label: 'Uses', value: (token) => esc((token.useCount || 0) + '/' + (token.maxUses || '∞')) },
        { label: 'Created', value: (token) => esc(token.createdAt || '-') },
        { label: 'Last Used', value: (token) => esc(token.lastUsedAt || '-') },
        { label: 'Expires', value: (token) => esc(token.expiresAt || '-') },
        { label: 'Actions', value: (token) => enrollmentTokenStatus(token) === 'active'
          ? '<button data-worker-enrollment-token-revoke="' + esc(token.id) + '">Revoke</button>'
          : '-' },
      ], visible);
      bindWorkerEnrollmentTokenButtons();
    }

    async function loadWorkerEnrollmentTokens({ silent = false } = {}) {
      if (!tokenInput.value.trim()) {
        if (!silent) {
          setStatus('Enter NADO_TOKEN to load worker enrollment tokens', true);
        }
        return;
      }
      const { enrollmentTokens } = await api('/api/worker-enrollment-tokens');
      renderWorkerEnrollmentTokens(enrollmentTokens);
      if (!silent) {
        const hiddenCount = state.showEnrollmentHistory
          ? 0
          : (enrollmentTokens || []).filter((token) => enrollmentTokenStatus(token) !== 'active').length;
        setStatus(hiddenCount
          ? 'Showing active enrollment tokens (' + hiddenCount + ' hidden)'
          : 'Loaded ' + enrollmentTokens.length + ' worker enrollment tokens');
      }
    }

    async function pruneWorkerEnrollmentTokens() {
      const preview = await api('/api/worker-enrollment-tokens/prune');
      if (!preview.prunableCount) {
        setStatus('No unused worker enrollment tokens to prune');
        return;
      }
      const ok = window.confirm('Revoke ' + preview.prunableCount + ' unused worker enrollment token(s)? Used enrollment tokens will be preserved.');
      if (!ok) {
        return;
      }
      const result = await api('/api/worker-enrollment-tokens/prune', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setStatus('Pruned ' + result.prunedCount + ' unused worker enrollment token(s)');
      await loadWorkerEnrollmentTokens({ silent: true });
    }

    function bindWorkerEnrollmentTokenButtons(root = document) {
      root.querySelectorAll('[data-worker-enrollment-token-revoke]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            const result = await api('/api/worker-enrollment-tokens/' + encodeURIComponent(button.dataset.workerEnrollmentTokenRevoke) + '/revoke', {
              method: 'POST',
              body: JSON.stringify({}),
            });
            setStatus('Revoked worker enrollment token ' + result.enrollmentToken.id);
            await loadWorkerEnrollmentTokens({ silent: true });
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
    }

    function doctorOptions() {
      const form = document.getElementById('doctorForm');
      const data = new FormData(form);
      const options = {
        selfTest: Boolean(data.get('selfTest')),
        agentSelfTest: Boolean(data.get('agentSelfTest')),
        allWorkers: Boolean(data.get('allWorkers')),
        timeoutMs: Number(data.get('timeoutMs') || 15000),
      };
      if (data.get('workerId')) {
        options.workerId = data.get('workerId');
      }
      if (data.get('capability')) {
        options.requiredCapabilities = parseCsv(data.get('capability'));
      }
      if (data.get('tool')) {
        options.requiredTools = parseCsv(data.get('tool'));
      }
      if (data.get('label')) {
        options.requiredLabels = parseLabel(data.get('label'));
      }
      return options;
    }

    function renderDoctor(result) {
      const workerRows = result.workers?.items || [];
      const selfTests = result.selfTests || [];
      const agentSelfTests = result.agentSelfTests || [];
      document.getElementById('doctorResult').innerHTML = ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>Doctor</span>' + badge(result.ok ? 'ok' : 'failed') + '</div>'
        + '<div class="detail-item"><span>Health</span>' + badge(result.health?.ok ? 'ok' : 'failed') + '</div>'
        + '<div class="detail-item"><span>Workers</span><div>' + esc((result.workers?.active || 0) + '/' + (result.workers?.total || 0) + ' active') + '</div></div>'
        + '<div class="detail-item"><span>Eligible</span><div>' + list(result.workers?.eligibleForSelfTest || []) + '</div></div>'
        + '</div>'
        + '<div class="subhead">Workers</div>' + table([
          { label: 'ID', value: (worker) => '<span class="mono">' + esc(worker.id) + '</span>' },
          { label: 'State', value: (worker) => badge(worker.gatewayState) },
          { label: 'Admin', value: (worker) => badge(worker.adminState) },
          { label: 'Capabilities', value: (worker) => list(worker.capabilities || []) },
          { label: 'Tools', value: (worker) => esc(Object.entries(worker.inventory?.tools || {}).filter(([, tool]) => tool.available).map(([name]) => name).join(', ') || '-') },
        ], workerRows)
        + '<div class="subhead">Self Tests</div>' + table([
          { label: 'Task', value: (test) => '<span class="mono">' + esc(test.taskId || '-') + '</span>' },
          { label: 'Status', value: (test) => badge(test.status) },
          { label: 'Worker', value: (test) => esc(test.workerId || '-') },
          { label: 'Exit', value: (test) => esc(test.exitCode ?? '-') },
          { label: 'Artifacts', value: (test) => esc((test.artifacts || []).map((artifact) => artifact.path).join(', ') || '-') },
          { label: 'Actions', value: (test) => test.taskId ? '<button data-task-view="' + esc(test.taskId) + '">Task</button>' : '-' },
        ], selfTests)
        + '<div class="subhead">Agent Self Tests</div>' + table([
          { label: 'Task', value: (test) => '<span class="mono">' + esc(test.taskId || '-') + '</span>' },
          { label: 'Status', value: (test) => badge(test.status) },
          { label: 'Worker', value: (test) => esc(test.workerId || '-') },
          { label: 'Exit', value: (test) => esc(test.exitCode ?? '-') },
          { label: 'Artifacts', value: (test) => esc((test.artifacts || []).map((artifact) => artifact.path).join(', ') || '-') },
          { label: 'Error', value: (test) => esc(test.error || '-') },
          { label: 'Actions', value: (test) => test.taskId ? '<button data-task-view="' + esc(test.taskId) + '">Task</button>' : '-' },
        ], agentSelfTests)
        + '<div class="subhead">Problems</div><pre>' + esc((result.problems || []).join('\\n') || 'No problems') + '</pre>';
      bindTaskDetailButtons(document.getElementById('doctorResult'));
    }

    async function runDashboardDoctor() {
      const result = await api('/api/doctor', {
        method: 'POST',
        body: JSON.stringify(doctorOptions()),
      });
      renderDoctor(result);
      setStatus(result.ok ? 'doctor=ok' : 'doctor found ' + result.problems.length + ' problem(s)', !result.ok);
    }

    function verifyOptions() {
      const form = document.getElementById('verifyForm');
      const data = new FormData(form);
      const options = {
        allWorkers: Boolean(data.get('allWorkers')),
        skipDoctor: Boolean(data.get('skipDoctor')),
        timeoutMs: Number(data.get('timeoutMs') || 30000),
      };
      if (data.get('workerId')) {
        options.workerId = data.get('workerId');
      }
      if (data.get('capability')) {
        options.requiredCapabilities = parseCsv(data.get('capability'));
      }
      if (data.get('tool')) {
        options.requiredTools = parseCsv(data.get('tool'));
      }
      if (data.get('label')) {
        options.requiredLabels = parseLabel(data.get('label'));
      }
      return options;
    }

    function renderVerify(result) {
      const checks = result.checks || [];
      const summary = result.summary || {};
      document.getElementById('verifyResult').innerHTML = ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>Verify</span>' + badge(result.ok ? 'ok' : 'failed') + '</div>'
        + '<div class="detail-item"><span>Workers</span><div>' + esc((summary.workers?.active || 0) + '/' + (summary.workers?.total || 0) + ' active') + '</div></div>'
        + '<div class="detail-item"><span>Task</span><div><span class="mono">' + esc(summary.taskId || '-') + '</span></div></div>'
        + '<div class="detail-item"><span>Batch</span><div><span class="mono">' + esc(summary.batchId || '-') + '</span></div></div>'
        + '</div>'
        + '<div class="subhead">Checks</div>' + table([
          { label: 'Check', value: (check) => esc(check.name) },
          { label: 'Status', value: (check) => badge(check.ok ? 'ok' : 'failed') },
          { label: 'Duration', value: (check) => esc((check.durationMs ?? '-') + 'ms') },
          { label: 'Detail', value: (check) => '<span class="mono">' + esc(check.error || JSON.stringify(check.detail || {})) + '</span>' },
        ], checks)
        + '<div class="subhead">Artifacts</div><pre>' + esc(JSON.stringify(summary.artifacts || {}, null, 2)) + '</pre>'
        + '<div class="subhead">Problems</div><pre>' + esc((result.problems || []).join('\\n') || 'No problems') + '</pre>'
        + '<div class="actions">'
        + (summary.taskId ? '<button data-task-view="' + esc(summary.taskId) + '">Task</button>' : '')
        + (summary.batchId ? '<button data-batch-view="' + esc(summary.batchId) + '">Batch</button>' : '')
        + '</div>';
      bindTaskDetailButtons(document.getElementById('verifyResult'));
      bindBatchNavigationButtons(document.getElementById('verifyResult'));
    }

    async function runDashboardVerify() {
      const result = await api('/api/verify', {
        method: 'POST',
        body: JSON.stringify(verifyOptions()),
      });
      renderVerify(result);
      setStatus(result.ok ? 'verify=ok' : 'verify found ' + result.problems.length + ' problem(s)', !result.ok);
    }

    function renderDemoHealth(result) {
      const status = result.status || {};
      const network = result.network || {};
      const routeChecks = result.routeChecks || [];
      const verify = result.verify || null;
      const prune = result.prune || null;
      document.getElementById('demoHealthResult').innerHTML = ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>' + esc(localizeText('Health')) + '</span>' + badge(result.ok ? 'ok' : 'failed') + '</div>'
        + '<div class="detail-item"><span>' + esc(localizeText('Dashboard')) + '</span><div><span class="mono">' + esc(result.dashboardUrl || '-') + '</span></div></div>'
        + '<div class="detail-item"><span>' + esc(localizeText('Workers')) + '</span><div>' + esc((status.workers?.active || 0) + '/' + (status.workers?.total || 0) + ' ' + localizeText('active')) + '</div></div>'
        + '<div class="detail-item"><span>' + esc(localizeText('Tasks')) + '</span><div>' + esc((status.tasks?.total || 0) + ' ' + localizeText('total') + ', ' + (status.tasks?.attention?.total || 0) + ' ' + localizeText('Needs Attention')) + '</div></div>'
        + '<div class="detail-item"><span>' + esc(localizeText('Network')) + '</span><div>' + esc((network.requestUrl || '-') + (network.requestIsLoopback ? ' (' + localizeText('loopback') + ')' : '')) + '</div></div>'
        + '<div class="detail-item"><span>' + esc(localizeText('Public URL')) + '</span><div><span class="mono">' + esc(network.publicControlUrl || '-') + '</span></div></div>'
        + '</div>'
        + '<div class="subhead">' + esc(localizeText('Workers')) + '</div>' + table([
          { label: 'Worker', value: (worker) => '<span class="mono">' + esc(worker.id) + '</span>' },
          { label: 'Status', value: (worker) => badge(worker.gatewayState || '-') },
          { label: 'Slots', value: (worker) => esc((worker.runningSlots ?? worker.runningTasks ?? 0) + '/' + (worker.maxConcurrency || 1)) },
          { label: 'Capabilities', value: (worker) => esc((worker.capabilities || []).join(',') || '-') },
          { label: 'GPU probe', value: renderGpuDiagnostic },
        ], status.workers?.items || [])
        + '<div class="subhead">' + esc(localizeText('Route Checks')) + '</div>' + table([
          { label: 'Capability', value: (check) => badge(check.capability || '-') },
          { label: 'Status', value: (check) => badge(check.status || '-') },
          { label: 'Worker', value: (check) => '<span class="mono">' + esc(check.workerId || '-') + '</span>' },
          { label: 'Inferred', value: (check) => esc((check.inferredCapabilities || []).join(',') || '-') },
          { label: 'Reason', value: (check) => esc(localizeSchedulerReason(check.reason || '-')) + ((check.warnings || []).length ? '<br><small class="warn-text">' + esc((check.warnings || []).map(localizeText).join('\\n')) + '</small>' : '') },
        ], routeChecks)
        + '<div class="subhead">' + esc(localizeText('Verification')) + '</div><pre>' + esc(verify ? JSON.stringify({
          ok: verify.ok,
          checks: (verify.checks || []).map((check) => ({ name: check.name, ok: check.ok, durationMs: check.durationMs })),
          problems: verify.problems || [],
        }, null, 2) : localizeText('Skipped')) + '</pre>'
        + '<div class="subhead">' + esc(localizeText('Cleanup')) + '</div><pre>' + esc(prune ? JSON.stringify({
          prunedTaskCount: prune.prunedTaskCount || 0,
          prunedBatchCount: prune.prunedBatchCount || 0,
        }, null, 2) : localizeText('Skipped')) + '</pre>'
        + '<div class="subhead">' + esc(localizeText('Problems')) + '</div><pre>' + esc((result.problems || []).join('\\n') || localizeText('No problems')) + '</pre>';
    }

    async function runDashboardDemoHealth() {
      const result = await api('/api/demo/health', {
        method: 'POST',
        body: JSON.stringify({
          skipVerify: document.getElementById('demoHealthSkipVerify').checked,
          noPrune: document.getElementById('demoHealthKeepHistory').checked,
          timeoutMs: 60000,
        }),
      });
      renderDemoHealth(result);
      setStatus(result.ok ? 'demoHealth=ok' : 'demoHealth found ' + result.problems.length + ' problem(s)', !result.ok);
    }

    function renderConsoleRouteCheck(result) {
      const target = document.getElementById('consoleOutput');
      const network = result.network || {};
      const status = result.status || {};
      const routeChecks = result.routeChecks || [];
      const routeLine = (check) => {
        const inferred = (check.inferredCapabilities || []).join(',') || '-';
        const effective = (check.effectiveRequiredCapabilities || []).join(',') || '-';
        const worker = check.workerId || '-';
        const reason = localizeSchedulerReason(check.reason || check.status || '-');
        return ' - ' + check.capability + ': ' + check.status + ' worker=' + worker + ' inferred=' + inferred + ' effective=' + effective + ' reason=' + reason;
      };
      const warningLines = routeChecks.flatMap((check) => (
        (check.warnings || []).map((warning) => ' - ' + check.capability + ': ' + localizeText(warning))
      ));
      const lines = [
        state.locale === 'zh-CN' ? '路由自检' : 'route check',
        'ok=' + Boolean(result.ok),
        'workers=' + ((status.workers?.active || 0) + '/' + (status.workers?.total || 0)),
        'network=' + (network.requestUrl || '-') + (network.requestIsLoopback ? ' loopback' : ''),
        'remoteWorkerReady=' + Boolean(network.remoteWorkerReady),
      ];
      if (network.nextAction?.message) {
        lines.push('networkAction=' + localizeText(network.nextAction.message));
      }
      lines.push(state.locale === 'zh-CN' ? '能力路由:' : 'capability routes:');
      routeChecks.forEach((check) => lines.push(routeLine(check)));
      if (warningLines.length) {
        lines.push(state.locale === 'zh-CN' ? '警告:' : 'warnings:');
        lines.push(...warningLines);
      }
      if ((result.problems || []).length) {
        lines.push(state.locale === 'zh-CN' ? '问题:' : 'problems:');
        lines.push(...result.problems.map((problem) => ' - ' + problem));
      }
      target.textContent = lines.join('\\n');
      target.scrollTop = target.scrollHeight;
      clearConsoleResultState();
    }

    async function runConsoleRouteCheck() {
      const result = await api('/api/demo/health', {
        method: 'POST',
        body: JSON.stringify({
          skipVerify: true,
          noPrune: true,
          timeoutMs: 60000,
        }),
      });
      renderConsoleRouteCheck(result);
      setStatus(result.ok ? 'Console route check ok' : 'Console route check found ' + result.problems.length + ' problem(s)', !result.ok);
      await refresh();
      return result;
    }

    function renderDispatchPlan(plan) {
      document.getElementById('dispatchPlan').innerHTML = ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>Plan</span><div>' + esc(plan.title || '-') + '</div></div>'
        + '<div class="detail-item"><span>Tasks</span><div>' + esc(plan.totalTasks || 0) + '</div></div>'
        + '<div class="detail-item"><span>Assigned</span><div>' + esc(plan.counts?.assigned || 0) + '</div></div>'
        + '<div class="detail-item"><span>Unassigned</span><div>' + esc(plan.counts?.unassigned || 0) + '</div></div>'
        + '</div>'
        + table([
          { label: 'Key', value: (item) => '<span class="mono">' + esc(item.key) + '</span>' },
          { label: 'Worker', value: (item) => '<span class="mono">' + esc(item.scheduler?.workerId || '-') + '</span>' },
          { label: 'Reason', value: (item) => esc(localizeSchedulerReason(item.scheduler?.reason || '-') || '-') },
          { label: 'Routable', value: (item) => badge(item.routability?.routable ? 'yes' : 'no') },
          { label: 'Inferred', value: (item) => esc((item.inferredCapabilities || []).join(',') || '-') },
          { label: 'Effective', value: (item) => esc((item.effectiveRequiredCapabilities || item.requiredCapabilities || []).join(',') || '-') },
          { label: 'Next Action', value: (item) => item.nextAction ? '<div class="routing-note"><small>' + esc(nextActionLabel(item.nextAction)) + '</small></div>' : '-' },
          { label: 'Slots', value: (item) => esc(item.slots || 1) },
          { label: 'Candidates', value: (item) => esc((item.scheduler?.candidates || []).map((candidate) => candidate.workerId + ':' + (candidate.eligible ? candidate.score : 'no')).join(', ') || '-') },
          { label: 'Title', value: (item) => esc(item.title || '-') },
        ], plan.items || []);
    }

    function renderPlannerResult(result) {
      const planner = result.planner || {};
      const target = document.getElementById('plannerResult');
      target.innerHTML = ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>Mode</span><div>' + esc(planner.mode || '-') + '</div></div>'
        + '<div class="detail-item"><span>Tasks</span><div>' + esc(planner.taskCount || 0) + '</div></div>'
        + '<div class="detail-item"><span>Shards</span><div>' + esc(planner.shardCount || 0) + '</div></div>'
        + '<div class="detail-item"><span>Strategy</span><div>' + esc(planner.strategy || '-') + '</div></div>'
        + '</div>'
        + table([
          { label: 'Key', value: (item) => '<span class="mono">' + esc(item.key) + '</span>' },
          { label: 'Depends On', value: (item) => esc((item.dependsOn || []).join(',') || '-') },
          { label: 'Title', value: (item) => esc(item.title || '-') },
        ], planner.topology || [])
        + '<div class="subhead">' + esc(localizeText('Assumptions')) + '</div>'
        + '<pre>' + esc((planner.assumptions || []).join('\\n')) + '</pre>';
      if (result.dispatchPlan) {
        renderDispatchPlan(result.dispatchPlan);
      }
    }

    function showDispatchPlanError(error) {
      if (!error?.dispatchPlan) {
        return false;
      }
      renderDispatchPlan(error.dispatchPlan);
      state.activeView = 'batches';
      localStorage.setItem('nadoDashboardView', state.activeView);
      applyView();
      const unassigned = error.dispatchPlan.counts?.unassigned || 0;
      setStatus('Routing blocked; dispatch plan shown for ' + unassigned + ' unassigned task(s)', true);
      return true;
    }

    async function previewDispatchFromBatchJson() {
      const body = JSON.parse(document.getElementById('batchJson').value);
      const result = await api('/api/dispatch/plan', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      renderDispatchPlan(result.plan);
      setStatus('Previewed dispatch for ' + result.plan.totalTasks + ' task(s)');
      return result.plan;
    }

    async function loadAgentContext({ silent = false } = {}) {
      if (!tokenInput.value.trim()) {
        return '';
      }
      const response = await fetch('/api/context', { headers: headers() });
      const text = await response.text();
      if (!response.ok) {
        let message = response.statusText;
        try {
          message = JSON.parse(text).error || message;
        } catch {
          message = text || message;
        }
        throw new Error(message);
      }
      document.getElementById('agentContext').textContent = text;
      if (!silent) {
        setStatus('Loaded agent context');
      }
      return text;
    }

    async function downloadAgentContext() {
      const text = await loadAgentContext({ silent: true });
      if (!text) {
        throw new Error('No agent context available');
      }
      downloadBlob('AGENTS.md', new Blob([text], { type: 'text/markdown' }));
      setStatus('Downloaded AGENTS.md');
    }

    async function loadCapabilities({ silent = false } = {}) {
      if (!tokenInput.value.trim()) {
        return null;
      }
      const manifest = await api('/api/capabilities');
      document.getElementById('capabilitiesManifest').textContent = JSON.stringify(manifest, null, 2);
      if (!silent) {
        setStatus('Loaded gateway manifest');
      }
      return manifest;
    }

    async function downloadCapabilities() {
      const manifest = await loadCapabilities({ silent: true });
      if (!manifest) {
        throw new Error('No gateway manifest available');
      }
      downloadBlob('nado-capabilities.json', new Blob([JSON.stringify(manifest, null, 2) + '\\n'], { type: 'application/json' }));
      setStatus('Downloaded gateway manifest');
    }

    function mcpConfigPath() {
      const params = new URLSearchParams();
      const name = document.getElementById('mcpConfigName').value.trim();
      const format = document.getElementById('mcpConfigFormat').value || 'json';
      if (name) {
        params.set('name', name);
      }
      if (format) {
        params.set('format', format);
      }
      const text = params.toString();
      return '/api/mcp-config' + (text ? '?' + text : '');
    }

    async function loadMcpConfig({ silent = false } = {}) {
      if (!tokenInput.value.trim()) {
        return '';
      }
      const response = await fetch(mcpConfigPath(), { headers: headers() });
      const text = await response.text();
      if (!response.ok) {
        let message = response.statusText;
        try {
          message = JSON.parse(text).error || message;
        } catch {
          message = text || message;
        }
        throw new Error(message);
      }
      const format = document.getElementById('mcpConfigFormat').value || 'json';
      const display = format === 'json' ? JSON.stringify(JSON.parse(text), null, 2) : text;
      document.getElementById('mcpConfig').textContent = display;
      if (!silent) {
        setStatus('Loaded MCP config');
      }
      return display;
    }

    async function downloadMcpConfig() {
      const text = await loadMcpConfig({ silent: true });
      if (!text) {
        throw new Error('No MCP config available');
      }
      const format = document.getElementById('mcpConfigFormat').value || 'json';
      const fileName = format === 'json' ? 'nado-mcp.json' : 'nado-mcp-command.txt';
      downloadBlob(fileName, new Blob([text], { type: format === 'json' ? 'application/json' : 'text/plain' }));
      setStatus('Downloaded MCP config');
    }

    function recoveryOptions(action) {
      const form = document.getElementById('recoveryForm');
      const data = new FormData(form);
      const options = { action };
      if (data.get('workerId')) {
        options.workerId = data.get('workerId');
      }
      if (data.get('targetWorkerId')) {
        options.targetWorkerId = data.get('targetWorkerId');
      }
      if (data.get('capability')) {
        options.requiredCapabilities = parseCsv(data.get('capability'));
      }
      if (data.get('tool')) {
        options.requiredTools = parseCsv(data.get('tool'));
      }
      if (data.get('label')) {
        options.requiredLabels = parseLabel(data.get('label'));
      }
      if (data.get('slots')) {
        options.slots = Number(data.get('slots'));
      }
      if (data.get('includeSessions')) {
        options.includeSessions = true;
      }
      options.reason = data.get('reason') || 'dashboard offline recovery';
      return options;
    }

    function renderRecoveryCandidates(candidates) {
      state.recoveryCandidates = candidates || [];
      document.getElementById('recoveryCandidates').innerHTML = table([
        { label: 'Task', value: (item) => '<span class="mono">' + esc(item.task?.id || '-') + '</span>' },
        { label: 'Status', value: (item) => badge(item.task?.status || '-') },
        { label: 'Worker', value: (item) => esc(item.worker?.id || item.task?.assignedWorkerId || '-') },
        { label: 'Gateway', value: (item) => badge(item.worker?.gatewayState || 'offline') },
        { label: 'Offline', value: (item) => item.offlineMs == null ? '-' : esc(Math.round(item.offlineMs / 1000) + 's') },
        { label: 'Session', value: (item) => esc(item.task?.sessionId || '-') },
        { label: 'Title', value: (item) => esc(item.task?.title || item.task?.id || '-') },
        { label: 'Actions', value: (item) => item.task?.id ? '<button data-task-view="' + esc(item.task.id) + '">Task</button>' : '-' },
      ], state.recoveryCandidates);
      bindTaskDetailButtons(document.getElementById('recoveryCandidates'));
    }

    async function loadRecoveryCandidates({ silent = false } = {}) {
      if (!tokenInput.value.trim()) {
        return;
      }
      const workerId = document.getElementById('recoveryWorker').value.trim();
      const suffix = workerId ? '?workerId=' + encodeURIComponent(workerId) : '';
      const { candidates } = await api('/api/recovery/offline-tasks' + suffix);
      renderRecoveryCandidates(candidates);
      if (!silent) {
        setStatus('Loaded ' + candidates.length + ' offline recovery candidates');
      }
    }

    async function recoverOfflineTasks() {
      const result = await api('/api/recovery/offline-tasks', {
        method: 'POST',
        body: JSON.stringify(recoveryOptions('requeue')),
      });
      renderRecoveryCandidates(result.candidates || []);
      const skipped = result.skipped?.length || 0;
      setStatus('Recovered ' + result.recovered.length + ' offline tasks' + (skipped ? ', skipped ' + skipped : ''));
      await refresh();
    }

    function isSystemTask(task) {
      const title = String(task.title || '').toLowerCase();
      return title.startsWith('nado verify')
        || title.startsWith('nado doctor')
        || title.startsWith('docker agent echo')
        || title.startsWith('docker gpu route')
        || title.startsWith('claude smoke')
        || title.startsWith('claude file smoke');
    }

    function taskTime(task) {
      return Date.parse(task.createdAt || task.updatedAt || '') || 0;
    }

    function userTasks(tasks) {
      return (tasks || []).filter((task) => !isSystemTask(task));
    }

    function filteredTasks(tasks) {
      const newestFirst = [...(tasks || [])].sort((a, b) => taskTime(b) - taskTime(a));
      return state.taskFilter === 'all'
        ? newestFirst
        : newestFirst.filter((task) => !isSystemTask(task));
    }

    function updateTaskFilterControls(total, shown) {
      document.querySelectorAll('[data-task-filter]').forEach((button) => {
        button.classList.toggle('active', button.dataset.taskFilter === state.taskFilter);
      });
      const hint = document.getElementById('taskListHint');
      if (hint) {
        const label = state.taskFilter === 'all' ? 'Showing all recent history' : 'Showing recent user tasks';
        hint.dataset.i18nStatus = label + ' (' + shown + '/' + total + ')';
        hint.textContent = localizeText(label) + ' (' + shown + '/' + total + ')';
      }
    }

    async function pruneTaskHistory(options = {}) {
      const keepInput = document.getElementById('taskPruneKeep');
      const keep = Math.max(0, Number(options.keep ?? keepInput?.value ?? 20));
      const preview = await api('/api/tasks/prune?keep=' + encodeURIComponent(String(keep)));
      if (!preview.prunableCount) {
        setStatus('No completed standalone tasks to prune');
        return;
      }
      const message = options.confirmText
        ? localizeText(options.confirmText) + '? (' + preview.prunableCount + ')'
        : localizeText('Clear completed standalone tasks except the latest') + ' '
          + keep + '? (' + preview.prunableCount + ')';
      if (!window.confirm(message)) {
        return;
      }
      const result = await api('/api/tasks/prune', {
        method: 'POST',
        body: JSON.stringify({ keep }),
      });
      setStatus('Pruned ' + result.prunedCount + ' completed task(s), kept latest ' + result.keep);
      await refresh();
    }

    async function pruneSystemHistory() {
      const preview = await api('/api/system-history/prune');
      const count = Number(preview.prunableTaskCount || 0) + Number(preview.prunableBatchCount || 0);
      if (!count) {
        setStatus('No completed system history to prune');
        return;
      }
      const message = localizeText('Clear completed verify/doctor system history') + '? ('
        + preview.prunableTaskCount + ' tasks, ' + preview.prunableBatchCount + ' batches)';
      if (!window.confirm(message)) {
        return;
      }
      const result = await api('/api/system-history/prune', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setStatus('Pruned ' + result.prunedTaskCount + ' system task(s) and ' + result.prunedBatchCount + ' system batch(es)');
      await refresh();
    }

    async function resetWorkbenchDemo() {
      const [taskPreview, sessionPreview, systemPreview] = await Promise.all([
        api('/api/tasks/prune?keep=0'),
        api('/api/sessions/prune-empty'),
        api('/api/system-history/prune'),
      ]);
      const taskCount = Number(taskPreview.prunableCount || 0);
      const sessionCount = Number(sessionPreview.prunableCount || 0);
      const systemCount = Number(systemPreview.prunableTaskCount || 0) + Number(systemPreview.prunableBatchCount || 0);
      const total = taskCount + sessionCount + systemCount;
      if (!total) {
        setStatus('Demo already clean');
        return;
      }
      const message = localizeText('Reset demo state') + '? ('
        + taskCount + ' tasks, '
        + sessionCount + ' empty sessions, '
        + systemCount + ' system items)';
      if (!window.confirm(message)) {
        return;
      }
      const [taskResult, sessionResult, systemResult] = await Promise.all([
        taskCount ? api('/api/tasks/prune', { method: 'POST', body: JSON.stringify({ keep: 0 }) }) : Promise.resolve({ prunedCount: 0 }),
        sessionCount ? api('/api/sessions/prune-empty', { method: 'POST', body: JSON.stringify({}) }) : Promise.resolve({ prunedCount: 0 }),
        systemCount ? api('/api/system-history/prune', { method: 'POST', body: JSON.stringify({}) }) : Promise.resolve({ prunedTaskCount: 0, prunedBatchCount: 0 }),
      ]);
      const clearedSystem = Number(systemResult.prunedTaskCount || 0) + Number(systemResult.prunedBatchCount || 0);
      setStatus('Demo reset cleared ' + (taskResult.prunedCount || 0) + ' task(s), '
        + (sessionResult.prunedCount || 0) + ' empty session(s), '
        + clearedSystem + ' system item(s)');
      await refresh();
    }

    function renderTasks(tasks) {
      const filtered = filteredTasks(tasks);
      const compact = workbenchMode();
      const rows = filtered.slice(0, compact ? 6 : (state.taskFilter === 'all' ? 30 : 12));
      updateTaskFilterControls((tasks || []).length, filtered.length);
      const columns = compact ? [
        { label: 'Status', value: (task) => badge(task.status) },
        { label: 'Worker', value: (task) => taskWorkerDisplay(task) },
        { label: 'Routing', value: (task) => renderRoutingCell(task) },
        { label: 'Title', value: (task) => esc(task.title) },
        { label: 'Actions', value: (task) => taskActionButtons(task, true) },
      ] : [
        { label: 'ID', value: (task) => '<span class="mono">' + esc(task.id) + '</span>' },
        { label: 'Status', value: (task) => badge(task.status) },
        { label: 'Worker', value: (task) => taskWorkerDisplay(task) },
        { label: 'Routing', value: (task) => renderRoutingCell(task) },
        { label: 'Priority', value: (task) => esc(task.priority || 0) },
        { label: 'Slots', value: (task) => esc(task.slots || 1) },
        { label: 'Title', value: (task) => esc(task.title) },
        { label: 'Actions', value: (task) => taskActionButtons(task, false) },
      ];
      document.getElementById('tasks').innerHTML = table(columns, rows);
    }

    function renderAttentionTasks(tasks) {
      const rows = filteredTasks(tasks).filter(taskNeedsAttention).slice(0, 8);
      const target = document.getElementById('attentionTasks');
      const cancelButton = document.getElementById('cancelRoutingIssues');
      if (!target) {
        return;
      }
      if (cancelButton) {
        cancelButton.disabled = rows.length === 0;
        cancelButton.textContent = localizeText('Cancel Issues') + (rows.length ? ' (' + rows.length + ')' : '');
      }
      target.className = rows.length ? '' : 'empty';
      target.innerHTML = rows.length ? table([
        { label: 'Status', value: (task) => badge(task.status) },
        { label: 'Worker', value: (task) => taskWorkerDisplay(task) },
        { label: 'Routing', value: (task) => renderRoutingCell(task) },
        { label: 'Next Action', value: (task) => renderNextAction(task) },
        { label: 'Title', value: (task) => esc(task.title) },
        { label: 'Actions', value: (task) => taskActionButtons(task) },
      ], rows) : 'No routing issues';
    }

    function renderEventRows(events) {
      return table([
        { label: 'At', value: (event) => esc(event.at || '-') },
        { label: 'Type', value: (event) => badge(event.type) },
        { label: 'Worker', value: (event) => esc(event.workerId || '-') },
        { label: 'Message', value: (event) => esc(localizeEventMessage(event.message).slice(0, 160)) },
      ], (events || []).slice(-20).reverse());
    }

    function renderTaskEvents(result) {
      const target = document.getElementById('taskEvents');
      if (!target) {
        return;
      }
      target.innerHTML = renderEventRows(result.events || []);
    }

    async function loadTaskEvents(taskId) {
      const result = await api('/api/tasks/' + encodeURIComponent(taskId) + '/events');
      renderTaskEvents(result);
      setStatus('Loaded ' + result.events.length + ' task events');
    }

    function startTaskEventStream(taskId) {
      const events = [];
      streamSse('/api/tasks/' + encodeURIComponent(taskId) + '/events/stream', (event) => {
        events.push(event);
        renderTaskEvents({ events });
      }, 'task ' + taskId);
    }

    function consoleEventLine(event) {
      const at = String(event.at || '').replace('T', ' ').replace('Z', '');
      const worker = event.workerId ? ' [' + event.workerId + ']' : '';
      return [at, (event.type || 'event') + worker, localizeEventMessage(event.message)]
        .filter(Boolean)
        .join('  ');
    }

    function renderConsoleOutput(taskId, events = [], task = null, artifactPreview = '') {
      const target = document.getElementById('consoleOutput');
      const downloadButton = document.getElementById('downloadConsoleArtifacts');
      const lines = [];
      let downloadableArtifacts = [];
      if (taskId) {
        lines.push('task=' + taskId);
      }
      for (const event of events.slice(-80)) {
        lines.push(consoleEventLine(event));
      }
      if (task) {
        lines.push('status=' + task.status + ' worker=' + (task.assignedWorkerId || task.requestedWorkerId || '-') + ' exit=' + (task.exitCode ?? '-'));
        if (task.scheduler) {
          lines.push('route=' + (task.scheduler.workerId || '-') + ' reason=' + (localizeSchedulerReason(task.scheduler.reason) || '-'));
          const inferred = task.scheduler.inferredCapabilities || [];
          const effective = task.scheduler.effectiveRequiredCapabilities || [];
          if (inferred.length || effective.length) {
            lines.push('capabilities inferred=' + (inferred.join(',') || '-') + ' effective=' + (effective.join(',') || '-'));
          }
        }
        const stdout = String(task.stdout || '').trimEnd();
        const stderr = String(task.stderr || '').trimEnd();
        if (stdout) {
          lines.push('stdout:');
          lines.push(stdout.slice(-2000));
        }
        if (stderr) {
          lines.push('stderr:');
          lines.push(stderr.slice(-2000));
        }
        if (task.error) {
          lines.push('error: ' + task.error);
        }
        downloadableArtifacts = Array.isArray(task.artifacts) ? task.artifacts.filter((artifact) => !artifact.skipped) : [];
        if (downloadableArtifacts.length) {
          lines.push('artifacts:');
          downloadableArtifacts.forEach((artifact) => {
            lines.push(' - ' + artifact.path + ' (' + (artifact.size || 0) + ' bytes)');
          });
        }
        if (artifactPreview) {
          lines.push('artifact preview:');
          lines.push(artifactPreview);
        }
      }
      if (downloadButton) {
        state.consoleArtifactTaskId = task?.id && downloadableArtifacts.length ? task.id : null;
        downloadButton.disabled = !state.consoleArtifactTaskId;
      }
      target.textContent = lines.join('\\n') || 'Waiting for task';
      target.scrollTop = target.scrollHeight;
    }

    function bindConsoleResultButtons(panel) {
      panel.querySelectorAll('[data-console-artifact-task][data-console-artifact-id]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            await downloadArtifact(button.dataset.consoleArtifactTask, button.dataset.consoleArtifactId);
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
      panel.querySelectorAll('[data-console-artifacts-download]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            await downloadTaskArtifacts(button.dataset.consoleArtifactsDownload);
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
    }

    function renderConsoleResultPanel(task = null, artifacts = [], artifactPreview = '') {
      const panel = document.getElementById('consoleResultPanel');
      if (!panel) {
        return;
      }
      if (!task) {
        panel.className = 'console-result-panel empty';
        panel.textContent = localizeText('No console result yet');
        return;
      }
      const storedArtifacts = (artifacts || []).filter((artifact) => !artifact.skipped);
      panel.className = 'console-result-panel';
      panel.innerHTML = ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>' + esc(localizeText('Status')) + '</span>' + badge(task.status) + '</div>'
        + '<div class="detail-item"><span>' + esc(localizeText('Worker')) + '</span><div>' + esc(task.assignedWorkerId || task.requestedWorkerId || '-') + '</div></div>'
        + '<div class="detail-item"><span>' + esc(localizeText('Task')) + '</span><div class="mono">' + esc(task.id || '-') + '</div></div>'
        + '<div class="detail-item"><span>' + esc(localizeText('Exit')) + '</span><div>' + esc(task.exitCode ?? '-') + '</div></div>'
        + '</div>'
        + '<div class="subhead">' + esc(localizeText('Scheduler')) + '</div>' + renderScheduler(task)
        + '<div class="subhead">' + esc(localizeText('Artifacts')) + '</div>'
        + (storedArtifacts.length
          ? '<div class="actions"><button data-console-artifacts-download="' + esc(task.id) + '">' + esc(localizeText('Download ZIP')) + '</button></div>'
            + table([
              { label: 'Path', value: (artifact) => esc(artifact.path) },
              { label: 'Size', value: (artifact) => esc(artifact.size || 0) },
              { label: 'Actions', value: (artifact) => '<button data-console-artifact-task="' + esc(task.id) + '" data-console-artifact-id="' + esc(artifact.id) + '">' + esc(localizeText('Download')) + '</button>' },
            ], storedArtifacts.slice(0, 8))
          : '<div class="empty">' + esc(localizeText('No records')) + '</div>')
        + (artifactPreview ? '<div class="subhead">' + esc(localizeText('Preview')) + '</div><pre>' + esc(artifactPreview) + '</pre>' : '');
      bindConsoleResultButtons(panel);
    }

    function clearConsoleResultState() {
      state.consoleArtifactTaskId = null;
      state.consoleArtifactPreview = '';
      const downloadButton = document.getElementById('downloadConsoleArtifacts');
      if (downloadButton) {
        downloadButton.disabled = true;
      }
      renderConsoleResultPanel(null);
    }

    function consoleTaskSpecFromForm(form) {
      const prompt = String(form.get('prompt') || '').trim();
      const title = String(form.get('title') || prompt.slice(0, 80) || 'agent task').trim();
      return {
        key: 'console',
        title,
        type: 'agent',
        prompt,
        workerId: form.get('workerId') || undefined,
        sessionId: form.get('sessionId') || undefined,
        capabilities: parseCsv(form.get('capability')),
        tools: parseCsv(form.get('tool')),
        labels: parseLabel(form.get('label')),
      };
    }

    function updateConsoleRoutingSummary() {
      const target = document.getElementById('consoleRoutingSummary');
      if (!target) {
        return;
      }
      const labelText = (label) => {
        if (state.locale !== 'zh-CN') {
          return label;
        }
        return {
          worker: '工作端',
          cap: '能力',
          tool: '工具',
          session: '会话',
          label: '标签',
        }[label] || label;
      };
      const values = [
        ['worker', document.getElementById('consoleWorkerId')?.value],
        ['cap', document.getElementById('consoleCapability')?.value],
        ['tool', document.getElementById('consoleTool')?.value],
        ['session', document.getElementById('consoleSessionId')?.value],
        ['label', document.getElementById('consoleLabel')?.value],
      ]
        .map(([label, value]) => [label, String(value || '').trim()])
        .filter(([, value]) => value);
      const text = values.length
        ? values.map(([label, value]) => labelText(label) + '=' + value).join(' · ')
        : 'automatic';
      target.dataset.i18nStatus = text;
      target.textContent = localizeText(text);
      target.title = text;
    }

    const consoleExamples = {
      gpu: {
        title: 'Run CUDA inference smoke task',
        prompt: '运行一个 CUDA / PyTorch GPU 推理检查，把结论写入 gpu-report.md。',
      },
      docs: {
        title: 'Draft project documentation',
        prompt: '编写一份项目使用文档，输出 README-demo.md，包含启动、分发任务、下载产物三个小节。',
      },
      ppt: {
        title: 'Design a product PPT outline',
        prompt: '生成一个产品演示 PPT 大纲，输出 slides-outline.md，包含 6 页幻灯片标题和要点。',
      },
    };

    function applyConsoleExample(kind) {
      const example = consoleExamples[kind];
      if (!example) {
        return;
      }
      document.getElementById('consoleTitle').value = example.title;
      document.getElementById('consolePrompt').value = example.prompt;
      document.getElementById('consoleWorkerId').value = '';
      document.getElementById('consoleCapability').value = '';
      document.getElementById('consoleTool').value = '';
      document.getElementById('consoleSessionId').value = '';
      document.getElementById('consoleLabel').value = '';
      clearConsoleResultState();
      updateConsoleRoutingSummary();
      setStatus('Loaded example: ' + example.title);
    }

    function renderConsoleDispatchPlan(plan) {
      const target = document.getElementById('consoleOutput');
      const item = (plan.items || [])[0] || {};
      const scheduler = item.scheduler || {};
      const pair = (label, value) => state.locale === 'zh-CN'
        ? label + '：' + (value || '-')
        : label + '=' + (value || '-');
      const candidateLine = (candidate) => {
        const worker = candidate.workerId || '-';
        const stateText = candidate.eligible
          ? (state.locale === 'zh-CN' ? '分数=' + candidate.score : 'score=' + candidate.score)
          : (state.locale === 'zh-CN' ? '已拒绝' : 'rejected');
        return ' - ' + worker + ' ' + stateText + ' ' + localizeReasonList(candidate.reasons || []);
      };
      const lines = [
        state.locale === 'zh-CN' ? '路由预览' : 'route preview',
        pair(state.locale === 'zh-CN' ? '任务' : 'task', item.title || '-'),
        pair(state.locale === 'zh-CN' ? '选中工作端' : 'selectedWorker', scheduler.workerId || '-'),
        pair(state.locale === 'zh-CN' ? '原因' : 'reason', localizeSchedulerReason(scheduler.reason) || '-'),
        pair(state.locale === 'zh-CN' ? '最终必需能力' : 'requiredCapabilities', (item.effectiveRequiredCapabilities || item.requiredCapabilities || []).join(',') || '-'),
      ];
      if ((scheduler.inferenceReasons || []).length) {
        lines.push(state.locale === 'zh-CN' ? '推断说明:' : 'inference:');
        scheduler.inferenceReasons.forEach((reason) => {
          lines.push(' - ' + reason.capability + ': ' + localizeInferenceReason(reason.reason) + ' (' + reason.evidence + ')');
        });
      }
      if ((scheduler.warnings || []).length) {
        lines.push(state.locale === 'zh-CN' ? '调度警告:' : 'warnings:');
        scheduler.warnings.forEach((warning) => {
          lines.push(' - ' + localizeText(warning.message || warning.code || '-'));
        });
      }
      lines.push(state.locale === 'zh-CN' ? '候选工作端:' : 'candidates:');
      (scheduler.candidates || []).forEach((candidate) => {
        lines.push(candidateLine(candidate));
      });
      target.textContent = lines.join('\\n');
      target.scrollTop = target.scrollHeight;
      clearConsoleResultState();
    }

    async function previewConsoleDispatch(form) {
      const task = consoleTaskSpecFromForm(form);
      if (!task.prompt) {
        setStatus('Console prompt is required', true);
        return null;
      }
      const result = await api('/api/dispatch/plan', {
        method: 'POST',
        body: JSON.stringify({
          title: task.title || 'console route preview',
          tasks: [task],
        }),
      });
      renderConsoleDispatchPlan(result.plan);
      const workerId = result.plan.items?.[0]?.scheduler?.workerId || 'unassigned';
      setStatus('Previewed console route: ' + workerId, workerId === 'unassigned');
      return result.plan;
    }

    function consolePlanBlocker(plan) {
      const item = (plan?.items || [])[0] || null;
      if (!item || item.routability?.routable) {
        return null;
      }
      return {
        item,
        reason: item.routability?.reason || item.scheduler?.reason || 'no routable worker',
        nextAction: item.nextAction || null,
      };
    }

    async function loadConsoleArtifactPreview(taskId) {
      const result = await api('/api/tasks/' + encodeURIComponent(taskId) + '/artifacts/content');
      return renderArtifactPreviewText(result.artifacts || []);
    }

    function renderArtifactPreviewText(artifacts = []) {
      return (artifacts || [])
        .filter(previewableArtifact)
        .slice(0, 3)
        .map((artifact) => {
          const text = base64ToText(artifact.contentBase64).trimEnd();
          return '--- ' + artifact.path + ' ---\\n' + text.slice(0, 4000);
        })
        .join('\\n');
    }

    async function runConsoleTask(form) {
      const prompt = String(form.get('prompt') || '').trim();
      if (!prompt) {
        setStatus('Console prompt is required', true);
        return;
      }
      const plan = await previewConsoleDispatch(form);
      const blocker = Boolean(form.get('requireRoutable')) ? consolePlanBlocker(plan) : null;
      if (blocker) {
        const actionText = blocker.nextAction?.message ? ': ' + blocker.nextAction.message : '';
        setStatus('Console route blocked: ' + blocker.reason + actionText, true);
        return;
      }
      const body = {
        title: form.get('title') || prompt.slice(0, 80) || 'agent task',
        type: 'agent',
        prompt,
        workerId: form.get('workerId') || undefined,
        sessionId: form.get('sessionId') || undefined,
        requiredCapabilities: parseCsv(form.get('capability')),
        requiredTools: parseCsv(form.get('tool')),
        requiredLabels: parseLabel(form.get('label')),
        priority: form.get('priority') ? Number(form.get('priority')) : undefined,
        requireRoutable: Boolean(form.get('requireRoutable')),
      };
      const result = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const taskId = result.task.id;
      state.selectedTaskId = taskId;
      state.consoleTaskId = taskId;
      state.consoleEvents = [];
      state.consoleArtifactPreview = '';
      renderConsoleOutput(taskId, state.consoleEvents, result.task);
      renderConsoleResultPanel(result.task, result.task.artifacts || []);
      setStatus('Console submitted ' + taskId);
      await refresh();
      await loadTaskDetail(taskId);
      await streamSse('/api/tasks/' + encodeURIComponent(taskId) + '/events/stream', (event) => {
        state.consoleEvents.push(event);
        renderConsoleOutput(taskId, state.consoleEvents);
        renderTaskEvents({ events: state.consoleEvents });
      }, 'console task ' + taskId);
      const { task } = await api('/api/tasks/' + encodeURIComponent(taskId));
      state.consoleArtifactPreview = '';
      if ((task.artifacts || []).some((artifact) => previewableArtifact({ ...artifact, contentBase64: 'present' }))) {
        try {
          state.consoleArtifactPreview = await loadConsoleArtifactPreview(taskId);
        } catch (error) {
          state.consoleArtifactPreview = 'artifact preview failed: ' + error.message;
        }
      }
      renderConsoleOutput(taskId, state.consoleEvents, task, state.consoleArtifactPreview);
      renderConsoleResultPanel(task, task.artifacts || [], state.consoleArtifactPreview);
      if (state.consoleTaskId === taskId && terminalTaskStatus(task.status)) {
        state.consoleTaskId = null;
      }
      await loadTaskDetail(taskId);
      await refresh();
      setStatus('Console completed ' + taskId + ': ' + task.status, task.status !== 'succeeded');
    }

    async function submitConsoleForm(formElement = document.getElementById('consoleForm')) {
      const runButton = document.getElementById('runConsoleTask');
      try {
        runButton.disabled = true;
        await runConsoleTask(new FormData(formElement));
      } finally {
        runButton.disabled = false;
      }
    }

    async function stopConsoleTask() {
      const taskId = state.consoleTaskId;
      if (!taskId) {
        stopEventStream();
        setStatus('Console stream stopped');
        return;
      }
      let task = null;
      try {
        ({ task } = await api('/api/tasks/' + encodeURIComponent(taskId)));
      } catch {
        stopEventStream();
        state.consoleTaskId = null;
        setStatus('Console stream stopped');
        return;
      }
      if (terminalTaskStatus(task.status)) {
        stopEventStream();
        state.consoleTaskId = null;
        renderConsoleOutput(taskId, state.consoleEvents, task, state.consoleArtifactPreview);
        renderConsoleResultPanel(task, task.artifacts || [], state.consoleArtifactPreview);
        setStatus('Console task ' + taskId + ' already ' + task.status);
        return;
      }
      const result = await api('/api/tasks/' + encodeURIComponent(taskId) + '/manage', {
        method: 'POST',
        body: JSON.stringify({
          action: 'cancel',
          reason: 'Cancelled from Control Console',
        }),
      });
      stopEventStream();
      state.consoleTaskId = null;
      state.selectedTaskId = taskId;
      renderConsoleOutput(taskId, state.consoleEvents, result.task);
      renderConsoleResultPanel(result.task, result.task.artifacts || []);
      setStatus('Console stop requested ' + taskId);
      await refresh();
      await loadTaskDetail(taskId);
    }

    async function createConsoleSession() {
      const form = new FormData(document.getElementById('consoleForm'));
      const title = String(form.get('title') || form.get('prompt') || 'console session').trim();
      const body = {
        title: title.slice(0, 80) || 'console session',
        workerId: form.get('workerId') || undefined,
        requiredCapabilities: parseCsv(form.get('capability')),
        requiredTools: parseCsv(form.get('tool')),
        requiredLabels: parseLabel(form.get('label')),
      };
      const result = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const sessionId = result.session.id;
      state.selectedSessionId = sessionId;
      document.getElementById('consoleSessionId').value = sessionId;
      document.getElementById('sessionId').value = sessionId;
      updateConsoleRoutingSummary();
      setStatus('Console session ' + sessionId + ' ready');
      await refresh();
      return result.session;
    }

    function emptyConsoleSession(session = {}) {
      return session.status === 'open'
        && !(session.taskIds || []).length
        && !session.currentTaskId
        && !session.workspace;
    }

    async function clearConsoleSession() {
      const sessionId = document.getElementById('consoleSessionId').value || '';
      document.getElementById('consoleSessionId').value = '';
      document.getElementById('sessionId').value = '';
      updateConsoleRoutingSummary();
      if (!sessionId) {
        setStatus('Console session cleared');
        return;
      }
      try {
        const { session } = await api('/api/sessions/' + encodeURIComponent(sessionId));
        if (emptyConsoleSession(session)) {
          await api('/api/sessions/prune-empty', {
            method: 'POST',
            body: JSON.stringify({ sessionId }),
          });
          if (state.selectedSessionId === sessionId) {
            state.selectedSessionId = null;
          }
          setStatus('Console empty session ' + sessionId + ' removed');
          await refresh();
          return;
        }
      } catch (error) {
        setStatus(error.message, true);
        return;
      }
      setStatus('Console session cleared');
    }

    function renderArtifactRows(taskId, artifacts) {
      return table([
        { label: 'Path', value: (artifact) => esc(artifact.path) },
        { label: 'Size', value: (artifact) => esc(artifact.size || 0) },
        { label: 'SHA256', value: (artifact) => esc((artifact.sha256 || '').slice(0, 12) || '-') },
        { label: 'Status', value: (artifact) => artifact.skipped ? badge('skipped') : badge('stored') },
        { label: 'Actions', value: (artifact) => artifact.skipped
          ? '-'
        : '<button data-artifact-task="' + esc(taskId) + '" data-artifact-id="' + esc(artifact.id) + '">Download</button>' },
      ], artifacts || []);
    }

    function renderScheduler(task) {
      const scheduler = task?.scheduler;
      if (!scheduler) {
        return '<div class="empty">No scheduler decision recorded</div>';
      }
      const inferred = scheduler.inferredCapabilities || [];
      const effective = scheduler.effectiveRequiredCapabilities || [];
      const inferenceReasons = scheduler.inferenceReasons || [];
      const action = nextActionForTask(task);
      const actionHtml = action
        ? '<div class="subhead">Next Action</div><div class="detail-grid">'
          + '<div class="detail-item"><span>Action</span><div>' + esc(nextActionLabel(action)) + '</div></div>'
          + '<div class="detail-item wide"><span>Message</span><div>' + esc(localizeText(action.message || '')) + '</div></div>'
          + '</div>'
        : '';
      const inferenceHtml = inferenceReasons.length
        ? '<div class="subhead">Inference Explanation</div>' + table([
          { label: 'Capability', value: (item) => esc(item.capability || '-') },
          { label: 'Reason', value: (item) => esc(item.reason || '-') },
          { label: 'Evidence', value: (item) => '<span class="mono">' + esc(item.evidence || '-') + '</span>' },
        ], inferenceReasons)
        : '';
      const warningsHtml = (scheduler.warnings || []).length
        ? '<div class="subhead">Warnings</div>' + table([
          { label: 'Worker', value: (item) => '<span class="mono">' + esc(item.workerId || '-') + '</span>' },
          { label: 'Severity', value: (item) => badge(item.severity || '-') },
          { label: 'Message', value: (item) => esc(localizeText(item.message || item.code || '-')) },
        ], scheduler.warnings || [])
        : '';
      return ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>Selected Worker</span><div>' + esc(scheduler.workerId || '-') + '</div></div>'
        + '<div class="detail-item"><span>Reason</span><div>' + esc(localizeSchedulerReason(scheduler.reason) || '-') + '</div></div>'
        + '<div class="detail-item"><span>Inferred Capabilities</span><div>' + list(inferred) + '</div></div>'
        + '<div class="detail-item"><span>Effective Capabilities</span><div>' + list(effective) + '</div></div>'
        + '</div>'
        + actionHtml
        + inferenceHtml
        + warningsHtml
        + table([
          { label: 'Worker', value: (candidate) => '<span class="mono">' + esc(candidate.workerId || '-') + '</span>' },
          { label: 'Eligible', value: (candidate) => badge(candidate.eligible ? 'eligible' : 'rejected') },
          { label: 'Score', value: (candidate) => esc(candidate.score ?? '-') },
          { label: 'Reasons', value: (candidate) => esc(localizeReasonList(candidate.reasons || [])) },
        ], scheduler.candidates || []);
    }

    function renderTaskDetail(task, artifacts, artifactPreview = '') {
      document.getElementById('taskDetail').innerHTML = ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>ID</span><div class="mono">' + esc(task.id) + '</div></div>'
        + '<div class="detail-item"><span>Status</span>' + badge(task.status) + '</div>'
        + '<div class="detail-item"><span>Worker</span><div>' + esc(task.assignedWorkerId || task.requestedWorkerId || '-') + '</div></div>'
        + '<div class="detail-item"><span>Exit</span><div>' + esc(task.exitCode ?? '-') + '</div></div>'
        + '</div>'
        + '<div class="subhead">Scheduler</div>' + renderScheduler(task)
        + '<div class="subhead">Manage Task</div>'
        + '<form id="taskManageForm" class="form-grid" data-task-id="' + esc(task.id) + '">'
        + '<div><label for="taskManageWorker">Worker</label><input id="taskManageWorker" name="workerId" placeholder="optional worker id"></div>'
        + '<div><label for="taskManageCapability">Capability</label><input id="taskManageCapability" name="capability" placeholder="code,gpu"></div>'
        + '<div><label for="taskManageTool">Required tool</label><input id="taskManageTool" name="tool" placeholder="node,codex"></div>'
        + '<div><label for="taskManageLabel">Required label</label><input id="taskManageLabel" name="label" placeholder="zone=lab"></div>'
        + '<div><label for="taskManageSlots">Slots</label><input id="taskManageSlots" name="slots" type="number" min="1" placeholder="' + esc(task.slots || 1) + '"></div>'
        + '<div><label for="taskManageReason">Reason</label><input id="taskManageReason" name="reason" placeholder="dashboard"></div>'
        + '<div class="wide actions">'
        + '<button type="button" data-task-manage="' + esc(task.id) + '" data-task-action="cancel"' + (terminalTaskStatus(task.status) ? ' disabled' : '') + '>Cancel</button>'
        + '<button type="button" data-task-manage="' + esc(task.id) + '" data-task-action="requeue"' + (!['failed', 'cancelled'].includes(task.status) ? ' disabled' : '') + '>Requeue</button>'
        + '<button type="button" data-task-manage="' + esc(task.id) + '" data-task-action="reschedule"' + (task.status !== 'queued' ? ' disabled' : '') + '>Reschedule</button>'
        + '</div>'
        + '</form>'
        + '<div class="subhead">Stdout</div><pre>' + esc(task.stdout || '') + '</pre>'
        + '<div class="subhead">Stderr</div><pre>' + esc(task.stderr || '') + '</pre>'
        + '<div class="subhead">Artifacts</div>'
        + '<div class="actions"><button data-task-artifacts-download="' + esc(task.id) + '"' + ((artifacts || []).some((artifact) => !artifact.skipped) ? '' : ' disabled') + '>Download ZIP</button></div>'
        + renderArtifactRows(task.id, artifacts)
        + (artifactPreview ? '<div class="subhead">Artifact Preview</div><pre>' + esc(artifactPreview) + '</pre>' : '')
        + '<div class="subhead">Events</div><div class="actions">'
        + '<button data-task-events="' + esc(task.id) + '">Load All Events</button>'
        + '<button data-task-stream="' + esc(task.id) + '">Stream Events</button>'
        + '<button data-stop-stream>Stop Stream</button>'
        + '</div><div id="taskEvents">' + renderEventRows(task.events || []) + '</div>';

      bindTaskManageButtons(document.getElementById('taskDetail'));
      document.querySelectorAll('[data-task-events]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            await loadTaskEvents(button.dataset.taskEvents);
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
      document.querySelectorAll('[data-task-stream]').forEach((button) => {
        button.addEventListener('click', () => {
          startTaskEventStream(button.dataset.taskStream);
        });
      });
      document.querySelectorAll('[data-stop-stream]').forEach((button) => {
        button.addEventListener('click', () => {
          stopEventStream();
          setStatus('Stopped event stream');
        });
      });
      document.querySelectorAll('[data-artifact-task][data-artifact-id]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            await downloadArtifact(button.dataset.artifactTask, button.dataset.artifactId);
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
      document.querySelectorAll('[data-task-artifacts-download]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            await downloadTaskArtifacts(button.dataset.taskArtifactsDownload);
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
    }

    async function loadTaskDetail(taskId) {
      state.selectedTaskId = taskId;
      document.getElementById('taskDetail').innerHTML = '<div class="empty">Loading task...</div>';
      const [{ task }, { artifacts }] = await Promise.all([
        api('/api/tasks/' + encodeURIComponent(taskId)),
        api('/api/tasks/' + encodeURIComponent(taskId) + '/artifacts'),
      ]);
      let artifactPreview = '';
      if ((artifacts || []).some((artifact) => previewableArtifact({ ...artifact, contentBase64: 'present' }))) {
        const content = await api('/api/tasks/' + encodeURIComponent(taskId) + '/artifacts/content');
        artifactPreview = renderArtifactPreviewText(content.artifacts || []);
      }
      renderTaskDetail(task, artifacts, artifactPreview);
    }

    function base64Bytes(value) {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    }

    function downloadBlob(fileName, blob) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    }

    async function downloadArtifact(taskId, artifactId) {
      const result = await binaryApi('/api/tasks/' + encodeURIComponent(taskId) + '/artifacts/' + encodeURIComponent(artifactId) + '/download');
      downloadBlob(result.fileName || (result.artifactPath || artifactId).split('/').pop(), result.blob);
      setStatus('Downloaded ' + (result.artifactPath || artifactId));
    }

    async function downloadTaskArtifacts(taskId) {
      const result = await binaryApi('/api/tasks/' + encodeURIComponent(taskId) + '/artifacts/download');
      downloadBlob(result.fileName || taskId + '-artifacts.zip', result.blob);
      setStatus('Downloaded task artifacts ZIP');
    }

    function crc32(bytes) {
      const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, index) => {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
          value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        return value >>> 0;
      }));
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      }
      return (crc ^ 0xffffffff) >>> 0;
    }

    function dosTimestamp(date = new Date()) {
      const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
      const day = Math.max(1, date.getDate());
      const month = date.getMonth() + 1;
      const year = Math.max(1980, date.getFullYear()) - 1980;
      return { time, date: (year << 9) | (month << 5) | day };
    }

    function zipBlob(files) {
      const encoder = new TextEncoder();
      const chunks = [];
      const central = [];
      let offset = 0;
      const stamp = dosTimestamp();
      for (const file of files) {
        const name = encoder.encode(file.name);
        const data = file.bytes;
        const crc = crc32(data);
        const local = new Uint8Array(30 + name.length);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, 0x0800, true);
        localView.setUint16(8, 0, true);
        localView.setUint16(10, stamp.time, true);
        localView.setUint16(12, stamp.date, true);
        localView.setUint32(14, crc, true);
        localView.setUint32(18, data.length, true);
        localView.setUint32(22, data.length, true);
        localView.setUint16(26, name.length, true);
        local.set(name, 30);
        chunks.push(local, data);

        const entry = new Uint8Array(46 + name.length);
        const entryView = new DataView(entry.buffer);
        entryView.setUint32(0, 0x02014b50, true);
        entryView.setUint16(4, 20, true);
        entryView.setUint16(6, 20, true);
        entryView.setUint16(8, 0x0800, true);
        entryView.setUint16(10, 0, true);
        entryView.setUint16(12, stamp.time, true);
        entryView.setUint16(14, stamp.date, true);
        entryView.setUint32(16, crc, true);
        entryView.setUint32(20, data.length, true);
        entryView.setUint32(24, data.length, true);
        entryView.setUint16(28, name.length, true);
        entryView.setUint32(42, offset, true);
        entry.set(name, 46);
        central.push(entry);
        offset += local.length + data.length;
      }
      const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
      const end = new Uint8Array(22);
      const endView = new DataView(end.buffer);
      endView.setUint32(0, 0x06054b50, true);
      endView.setUint16(8, files.length, true);
      endView.setUint16(10, files.length, true);
      endView.setUint32(12, centralSize, true);
      endView.setUint32(16, offset, true);
      return new Blob([...chunks, ...central, end], { type: 'application/zip' });
    }

    function safeZipPath(...parts) {
      return parts.flatMap((part) => String(part || '').split(/[\\/]+/))
        .map((part) => part.trim().replace(/[\\x00-\\x1f:*?"<>|]/g, '_'))
        .filter((part) => part && part !== '.' && part !== '..')
        .join('/') || 'artifact';
    }

    function batchArtifactRows(result) {
      return (result.tasks || []).flatMap((task) => (task.artifacts || []).map((artifact) => ({
        taskId: task.taskId,
        batchKey: task.batchKey,
        title: task.title,
        status: task.status,
        artifact,
      })));
    }

    function renderBatchArtifacts(result) {
      const target = document.getElementById('batchArtifacts');
      if (!target) {
        return;
      }
      target.innerHTML = table([
        { label: 'Key', value: (row) => esc(row.batchKey || '-') },
        { label: 'Task', value: (row) => '<span class="mono">' + esc(row.taskId) + '</span>' },
        { label: 'Status', value: (row) => badge(row.status) },
        { label: 'Path', value: (row) => esc(row.artifact.path) },
        { label: 'Size', value: (row) => esc(row.artifact.size || 0) },
        { label: 'Stored', value: (row) => row.artifact.skipped ? badge('skipped') : badge('stored') },
      ], batchArtifactRows(result));
    }

    async function loadBatchArtifacts(batchId) {
      const result = await api('/api/batches/' + encodeURIComponent(batchId) + '/artifacts');
      renderBatchArtifacts(result);
      setStatus('Loaded ' + result.totalArtifacts + ' batch artifacts');
    }

    async function downloadBatchArtifacts(batchId) {
      const result = await binaryApi('/api/batches/' + encodeURIComponent(batchId) + '/artifacts/download');
      downloadBlob(result.fileName || batchId + '-artifacts.zip', result.blob);
      setStatus('Downloaded batch artifacts ZIP');
    }

    function renderSessionArtifacts(result) {
      const target = document.getElementById('sessionArtifacts');
      if (!target) {
        return;
      }
      target.innerHTML = ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>Source Task</span><div class="mono">' + esc(result.sourceTaskId || '-') + '</div></div>'
        + '<div class="detail-item"><span>Artifacts</span><div>' + esc(result.totalArtifacts || 0) + '</div></div>'
        + '</div>'
        + table([
          { label: 'Path', value: (artifact) => esc(artifact.path) },
          { label: 'Size', value: (artifact) => esc(artifact.size || 0) },
          { label: 'SHA256', value: (artifact) => esc((artifact.sha256 || '').slice(0, 12) || '-') },
          { label: 'Status', value: (artifact) => artifact.skipped ? badge('skipped') : badge('stored') },
        ], result.artifacts || []);
    }

    async function loadSessionArtifacts(sessionId) {
      const result = await api('/api/sessions/' + encodeURIComponent(sessionId) + '/artifacts');
      state.selectedSessionArtifactsId = sessionId;
      state.selectedSessionArtifacts = result;
      renderSessionArtifacts(result);
      setStatus('Loaded ' + result.totalArtifacts + ' session artifacts');
    }

    async function downloadSessionArtifacts(sessionId) {
      const result = await binaryApi('/api/sessions/' + encodeURIComponent(sessionId) + '/artifacts/download');
      downloadBlob(result.fileName || sessionId + '-artifacts.zip', result.blob);
      setStatus('Downloaded session artifacts ZIP');
    }

    function renderBatches(batches) {
      document.getElementById('batches').innerHTML = table([
        { label: 'ID', value: (batch) => '<span class="mono">' + esc(batch.id) + '</span>' },
        { label: 'Status', value: (batch) => badge(batch.status) },
        { label: 'Done', value: (batch) => esc((batch.completedTasks || 0) + '/' + (batch.totalTasks || 0)) },
        { label: 'Title', value: (batch) => esc(batch.title) },
        { label: 'Actions', value: (batch) => '<div class="actions">'
          + '<button data-batch-view="' + esc(batch.id) + '">View</button>'
          + '<button data-batch-report="' + esc(batch.id) + '">Report</button>'
          + '<button data-batch-events="' + esc(batch.id) + '">Events</button>'
          + '<button data-batch-manage="' + esc(batch.id) + '" data-batch-action="retry_failed">Retry Failed</button>'
          + '<button data-batch-manage="' + esc(batch.id) + '" data-batch-action="cancel">Cancel</button>'
          + '</div>' },
      ], batches.slice(0, 12));
    }

    function bindTaskDetailButtons(root = document) {
      root.querySelectorAll('[data-task-view]').forEach((button) => {
        button.addEventListener('click', () => {
          state.activeView = 'tasks';
          localStorage.setItem('nadoDashboardView', state.activeView);
          applyView();
          rerenderViewTables();
          loadTaskDetail(button.dataset.taskView).catch((error) => setStatus(error.message, true));
        });
      });
    }

    function taskManageOptions(root) {
      if (root.dataset?.taskAutoRoute === 'true') {
        return { reason: 'dashboard auto route' };
      }
      const form = root.closest?.('#taskManageForm');
      if (!form) {
        return { reason: 'dashboard' };
      }
      const data = new FormData(form);
      const options = {
        reason: data.get('reason') || 'dashboard',
      };
      if (data.get('workerId')) {
        options.workerId = data.get('workerId');
      }
      if (data.get('capability')) {
        options.requiredCapabilities = parseCsv(data.get('capability'));
      }
      if (data.get('tool')) {
        options.requiredTools = parseCsv(data.get('tool'));
      }
      if (data.get('label')) {
        options.requiredLabels = parseLabel(data.get('label'));
      }
      if (data.get('slots')) {
        options.slots = Number(data.get('slots'));
      }
      return options;
    }

    async function manageTask(taskId, action, options = {}) {
      const result = await api('/api/tasks/' + encodeURIComponent(taskId) + '/manage', {
        method: 'POST',
        body: JSON.stringify({ ...options, action }),
      });
      state.selectedTaskId = result.task.id;
      setStatus(action + ' task ' + result.task.id + ' -> ' + result.task.status);
      await refresh();
    }

    async function cancelRoutingIssues() {
      const tasks = filteredTasks(state.snapshot?.tasks?.items || []).filter(taskNeedsAttention);
      if (!tasks.length) {
        setStatus('No routing issues');
        return;
      }
      const message = localizeText('Cancel Issues') + '? (' + tasks.length + ')';
      if (!window.confirm(message)) {
        return;
      }
      const button = document.getElementById('cancelRoutingIssues');
      if (button) {
        button.disabled = true;
      }
      try {
        for (const task of tasks) {
          await api('/api/tasks/' + encodeURIComponent(task.id) + '/manage', {
            method: 'POST',
            body: JSON.stringify({
              action: 'cancel',
              reason: 'Cancelled from Dashboard Needs Attention',
            }),
          });
        }
        if (state.selectedTaskId && tasks.some((task) => task.id === state.selectedTaskId)) {
          state.selectedTaskId = null;
        }
        setStatus('Cancelled ' + tasks.length + ' routing issue task(s)');
        await refresh();
      } finally {
        if (button) {
          button.disabled = false;
        }
      }
    }

    function bindTaskManageButtons(root = document) {
      root.querySelectorAll('[data-task-manage][data-task-action]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            await manageTask(button.dataset.taskManage, button.dataset.taskAction, taskManageOptions(button));
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
    }

    function batchManageOptions(root) {
      const form = root.closest?.('#batchManageForm');
      if (!form) {
        return { reason: 'dashboard' };
      }
      const data = new FormData(form);
      const options = {
        reason: data.get('reason') || 'dashboard',
      };
      if (data.get('workerId')) {
        options.workerId = data.get('workerId');
      }
      if (data.get('capability')) {
        options.requiredCapabilities = parseCsv(data.get('capability'));
      }
      if (data.get('tool')) {
        options.requiredTools = parseCsv(data.get('tool'));
      }
      if (data.get('label')) {
        options.requiredLabels = parseLabel(data.get('label'));
      }
      if (data.get('slots')) {
        options.slots = Number(data.get('slots'));
      }
      return options;
    }

    async function manageBatch(batchId, action, options = {}) {
      const result = await api('/api/batches/' + encodeURIComponent(batchId) + '/manage', {
        method: 'POST',
        body: JSON.stringify({ ...options, action }),
      });
      state.selectedBatchId = result.batch.id;
      state.selectedBatchMode = 'detail';
      setStatus(action + ' batch ' + result.batch.id + ' -> ' + result.batch.status);
      await refresh();
    }

    function bindBatchManageButtons(root = document) {
      root.querySelectorAll('[data-batch-manage][data-batch-action]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            await manageBatch(button.dataset.batchManage, button.dataset.batchAction, batchManageOptions(button));
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
    }

    function bindBatchArtifactButtons(root = document) {
      root.querySelectorAll('[data-batch-artifacts]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            await loadBatchArtifacts(button.dataset.batchArtifacts);
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
      root.querySelectorAll('[data-batch-download]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            await downloadBatchArtifacts(button.dataset.batchDownload);
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
    }

    function renderBatchTasks(tasks) {
      return table([
        { label: 'Key', value: (task) => esc(task.batchKey || '-') },
        { label: 'ID', value: (task) => '<span class="mono">' + esc(task.id) + '</span>' },
        { label: 'Status', value: (task) => badge(task.status) },
        { label: 'Worker', value: (task) => esc(task.assignedWorkerId || task.requestedWorkerId || '-') },
        { label: 'Title', value: (task) => esc(task.title) },
        { label: 'Actions', value: (task) => '<button data-task-view="' + esc(task.id) + '">Task</button>' },
      ], tasks || []);
    }

    function renderBatchDetail(batch, tasks) {
      const counts = batch.counts || {};
      const detail = document.getElementById('batchDetail');
      detail.innerHTML = ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>ID</span><div class="mono">' + esc(batch.id) + '</div></div>'
        + '<div class="detail-item"><span>Status</span>' + badge(batch.status) + '</div>'
        + '<div class="detail-item"><span>Completed</span><div>' + esc((batch.completedTasks || 0) + '/' + (batch.totalTasks || 0)) + '</div></div>'
        + '<div class="detail-item"><span>Counts</span><div>' + esc('queued:' + (counts.queued || 0) + ' running:' + (counts.running || 0) + ' succeeded:' + (counts.succeeded || 0) + ' failed:' + (counts.failed || 0)) + '</div></div>'
        + '</div>'
        + '<div class="actions">'
        + '<button data-batch-report="' + esc(batch.id) + '">Report</button>'
        + '<button data-batch-events="' + esc(batch.id) + '">Event Timeline</button>'
        + '</div>'
        + '<div class="subhead">Manage Batch</div>'
        + '<form id="batchManageForm" class="form-grid" data-batch-id="' + esc(batch.id) + '">'
        + '<div><label for="batchManageWorker">Worker</label><input id="batchManageWorker" name="workerId" placeholder="retry worker id"></div>'
        + '<div><label for="batchManageCapability">Capability</label><input id="batchManageCapability" name="capability" placeholder="code,gpu"></div>'
        + '<div><label for="batchManageTool">Required tool</label><input id="batchManageTool" name="tool" placeholder="node,codex"></div>'
        + '<div><label for="batchManageLabel">Required label</label><input id="batchManageLabel" name="label" placeholder="zone=lab"></div>'
        + '<div><label for="batchManageSlots">Slots</label><input id="batchManageSlots" name="slots" type="number" min="1" placeholder="optional"></div>'
        + '<div><label for="batchManageReason">Reason</label><input id="batchManageReason" name="reason" placeholder="dashboard"></div>'
        + '<div class="wide actions">'
        + '<button type="button" data-batch-manage="' + esc(batch.id) + '" data-batch-action="retry_failed">Retry Failed</button>'
        + '<button type="button" data-batch-manage="' + esc(batch.id) + '" data-batch-action="cancel">Cancel Remaining</button>'
        + '</div>'
        + '</form>'
        + '<div class="subhead">Child Tasks</div>' + renderBatchTasks(tasks || [])
        + '<div class="subhead">Batch Artifacts</div><div class="actions">'
        + '<button data-batch-artifacts="' + esc(batch.id) + '">List Artifacts</button>'
        + '<button data-batch-download="' + esc(batch.id) + '">Download ZIP</button>'
        + '</div><div id="batchArtifacts" class="empty">No batch artifact list loaded</div>';
      bindTaskDetailButtons(detail);
      bindTaskManageButtons(detail);
      bindBatchManageButtons(detail);
      bindBatchArtifactButtons(detail);
      bindBatchNavigationButtons(detail);
    }

    function renderBatchReport(report) {
      const counts = report.batch.counts || {};
      const outputTasks = (report.tasks || []).filter((task) => task.stdoutTail || task.stderrTail || task.error);
      const output = outputTasks.map((task) => {
        const label = task.label || task.batchKey || task.taskId;
        return [
          '## ' + label,
          task.stdoutTail ? 'stdout:\\n' + task.stdoutTail.trimEnd() : '',
          task.stderrTail ? 'stderr:\\n' + task.stderrTail.trimEnd() : '',
          task.error ? 'error: ' + task.error : '',
        ].filter(Boolean).join('\\n');
      }).join('\\n\\n');
      const detail = document.getElementById('batchDetail');
      detail.innerHTML = ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>ID</span><div class="mono">' + esc(report.batch.id) + '</div></div>'
        + '<div class="detail-item"><span>Status</span>' + badge(report.batch.status) + '</div>'
        + '<div class="detail-item"><span>Completed</span><div>' + esc((report.batch.completedTasks || 0) + '/' + (report.batch.totalTasks || 0)) + '</div></div>'
        + '<div class="detail-item"><span>Artifacts</span><div>' + esc(report.batch.artifactTotal || 0) + '</div></div>'
        + '</div>'
        + '<div class="actions">'
        + '<button data-batch-view="' + esc(report.batch.id) + '">Detail</button>'
        + '<button data-batch-events="' + esc(report.batch.id) + '">Event Timeline</button>'
        + '</div>'
        + '<div class="subhead">Counts</div><pre>' + esc('queued:' + (counts.queued || 0) + ' blocked:' + (counts.blocked || 0) + ' running:' + (counts.running || 0) + ' succeeded:' + (counts.succeeded || 0) + ' failed:' + (counts.failed || 0) + ' cancelled:' + (counts.cancelled || 0)) + '</pre>'
        + '<div class="subhead">Tasks</div>' + table([
          { label: 'Label', value: (task) => esc(task.label || task.batchKey || task.taskId) },
          { label: 'Status', value: (task) => badge(task.status) },
          { label: 'Worker', value: (task) => esc(task.workerId || '-') },
          { label: 'Artifacts', value: (task) => esc((task.artifacts || []).map((artifact) => artifact.path).join(', ') || '-') },
          { label: 'Actions', value: (task) => '<button data-task-view="' + esc(task.taskId) + '">Task</button>' },
        ], report.tasks || [])
        + '<div class="subhead">Output Excerpts</div><pre>' + esc(output || 'No output yet') + '</pre>'
        + '<div class="subhead">Batch Artifacts</div><div class="actions">'
        + '<button data-batch-artifacts="' + esc(report.batch.id) + '">List Artifacts</button>'
        + '<button data-batch-download="' + esc(report.batch.id) + '">Download ZIP</button>'
        + '</div><div id="batchArtifacts" class="empty">No batch artifact list loaded</div>'
        + '<div class="subhead">Manage Batch</div><div class="actions">'
        + '<button data-batch-manage="' + esc(report.batch.id) + '" data-batch-action="retry_failed">Retry Failed</button>'
        + '<button data-batch-manage="' + esc(report.batch.id) + '" data-batch-action="cancel">Cancel Remaining</button>'
        + '</div>'
        + '<div class="subhead">Next Actions</div><pre>' + esc((report.nextActions || []).join('\\n') || 'No suggested action') + '</pre>';
      bindTaskDetailButtons(detail);
      bindTaskManageButtons(detail);
      bindBatchManageButtons(detail);
      bindBatchArtifactButtons(detail);
      bindBatchNavigationButtons(detail);
    }

    function renderBatchEventTable(events) {
      return table([
        { label: 'At', value: (event) => esc(event.at || '-') },
        { label: 'Source', value: (event) => badge(event.source || '-') },
        { label: 'Task', value: (event) => '<span class="mono">' + esc(event.task || event.taskId || '-') + '</span>' },
        { label: 'Type', value: (event) => badge(event.type) },
        { label: 'Worker', value: (event) => esc(event.workerId || '-') },
        { label: 'Message', value: (event) => esc(String(event.message || '').replace(/\\s+/g, ' ').slice(0, 160)) },
      ], events || []);
    }

    function startBatchEventStream(batchId) {
      const events = [];
      streamSse('/api/batches/' + encodeURIComponent(batchId) + '/events/stream', (event) => {
        events.push(event);
        const target = document.getElementById('batchEventTimeline');
        if (target) {
          target.innerHTML = renderBatchEventTable(events);
        }
      }, 'batch ' + batchId);
    }

    function renderBatchEvents(result) {
      const detail = document.getElementById('batchDetail');
      detail.innerHTML = ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>ID</span><div class="mono">' + esc(result.batch.id) + '</div></div>'
        + '<div class="detail-item"><span>Status</span>' + badge(result.batch.status) + '</div>'
        + '<div class="detail-item"><span>Events</span><div>' + esc((result.events || []).length) + '</div></div>'
        + '<div class="detail-item"><span>Updated</span><div>' + esc(result.batch.updatedAt || result.batch.createdAt || '-') + '</div></div>'
        + '</div>'
        + '<div class="actions">'
        + '<button data-batch-view="' + esc(result.batch.id) + '">Detail</button>'
        + '<button data-batch-report="' + esc(result.batch.id) + '">Report</button>'
        + '<button data-batch-events="' + esc(result.batch.id) + '">Refresh Timeline</button>'
        + '<button data-batch-stream="' + esc(result.batch.id) + '">Stream Timeline</button>'
        + '<button data-stop-stream>Stop Stream</button>'
        + '</div>'
        + '<div class="subhead">Event Timeline</div>'
        + '<div id="batchEventTimeline">' + renderBatchEventTable(result.events || []) + '</div>';
      bindBatchNavigationButtons(detail);
      detail.querySelectorAll('[data-batch-stream]').forEach((button) => {
        button.addEventListener('click', () => {
          startBatchEventStream(button.dataset.batchStream);
        });
      });
      detail.querySelectorAll('[data-stop-stream]').forEach((button) => {
        button.addEventListener('click', () => {
          stopEventStream();
          setStatus('Stopped event stream');
        });
      });
    }

    async function loadBatchDetail(batchId, mode = 'detail') {
      state.selectedBatchId = batchId;
      state.selectedBatchMode = mode;
      document.getElementById('batchDetail').innerHTML = '<div class="empty">Loading batch...</div>';
      if (mode === 'report') {
        const report = await api('/api/batches/' + encodeURIComponent(batchId) + '/report?stdoutChars=600&stderrChars=600');
        renderBatchReport(report);
        return;
      }
      if (mode === 'events') {
        const result = await api('/api/batches/' + encodeURIComponent(batchId) + '/events');
        renderBatchEvents(result);
        return;
      }
      const { batch, tasks } = await api('/api/batches/' + encodeURIComponent(batchId));
      renderBatchDetail(batch, tasks);
    }

    function renderSessions(sessions) {
      document.getElementById('sessions').innerHTML = table([
        { label: 'ID', value: (session) => '<span class="mono">' + esc(session.id) + '</span>' },
        { label: 'Status', value: (session) => badge(session.status) },
        { label: 'Worker', value: (session) => esc(session.assignedWorkerId || session.requestedWorkerId || '-') },
        { label: 'Title', value: (session) => esc(session.title) },
        { label: 'Actions', value: (session) => '<div class="actions">'
          + '<button data-session-view="' + esc(session.id) + '">View</button>'
          + '<button data-session-use="' + esc(session.id) + '">Use</button>'
          + (session.status === 'open' ? '<button data-session-close="' + esc(session.id) + '">Close</button>' : '')
          + '</div>' },
      ], sessions.slice(0, 12));
    }

    function renderSessionTasks(session) {
      const byId = new Map((state.snapshot?.tasks?.items || []).map((task) => [task.id, task]));
      const tasks = (session.taskIds || []).map((id) => byId.get(id) || { id, status: 'unknown', title: id });
      return table([
        { label: 'ID', value: (task) => '<span class="mono">' + esc(task.id) + '</span>' },
        { label: 'Status', value: (task) => badge(task.status) },
        { label: 'Worker', value: (task) => esc(task.assignedWorkerId || task.requestedWorkerId || '-') },
        { label: 'Title', value: (task) => esc(task.title) },
        { label: 'Actions', value: (task) => '<button data-task-view="' + esc(task.id) + '">Task</button>' },
      ], tasks);
    }

    function renderSessionDetail(session) {
      const detail = document.getElementById('sessionDetail');
      detail.innerHTML = ''
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>ID</span><div class="mono">' + esc(session.id) + '</div></div>'
        + '<div class="detail-item"><span>Status</span>' + badge(session.status) + '</div>'
        + '<div class="detail-item"><span>Worker</span><div>' + esc(session.assignedWorkerId || session.requestedWorkerId || '-') + '</div></div>'
        + '<div class="detail-item"><span>Current Task</span><div class="mono">' + esc(session.currentTaskId || '-') + '</div></div>'
        + '</div>'
        + '<div class="detail-grid">'
        + '<div class="detail-item"><span>Capabilities</span><div>' + list(session.requiredCapabilities || []) + '</div></div>'
        + '<div class="detail-item"><span>Tools</span><div>' + list(session.requiredTools || []) + '</div></div>'
        + '<div class="detail-item"><span>Labels</span><div>' + labels(session.requiredLabels || {}) + '</div></div>'
        + '<div class="detail-item"><span>Workspace</span><div class="mono">' + esc(session.workspace || '-') + '</div></div>'
        + '</div>'
        + '<div class="actions">'
        + '<button data-session-use="' + esc(session.id) + '">Use In Task Form</button>'
        + (session.status === 'open' ? '<button data-session-close="' + esc(session.id) + '">Close Session</button>' : '')
        + '</div>'
        + '<div class="subhead">Latest Session Artifacts</div><div class="actions">'
        + '<button data-session-artifacts="' + esc(session.id) + '">List Artifacts</button>'
        + '<button data-session-download="' + esc(session.id) + '">Download ZIP</button>'
        + '</div><div id="sessionArtifacts" class="empty">No session artifact list loaded</div>'
        + '<div class="subhead">Session Tasks</div>' + renderSessionTasks(session);
      if (state.selectedSessionArtifactsId === session.id && state.selectedSessionArtifacts) {
        renderSessionArtifacts(state.selectedSessionArtifacts);
      }
      bindTaskDetailButtons(detail);
      bindSessionButtons(detail);
      bindSessionArtifactButtons(detail);
    }

    async function loadSessionDetail(sessionId) {
      if (state.selectedSessionId !== sessionId) {
        state.selectedSessionArtifactsId = null;
        state.selectedSessionArtifacts = null;
      }
      state.selectedSessionId = sessionId;
      document.getElementById('sessionDetail').innerHTML = '<div class="empty">Loading session...</div>';
      const { session } = await api('/api/sessions/' + encodeURIComponent(sessionId));
      renderSessionDetail(session);
    }

    function bindSessionButtons(root = document) {
      root.querySelectorAll('[data-session-view]').forEach((button) => {
        button.addEventListener('click', () => {
          loadSessionDetail(button.dataset.sessionView).catch((error) => setStatus(error.message, true));
        });
      });
      root.querySelectorAll('[data-session-use]').forEach((button) => {
        button.addEventListener('click', () => {
          document.getElementById('consoleSessionId').value = button.dataset.sessionUse;
          document.getElementById('sessionId').value = button.dataset.sessionUse;
          state.activeView = 'workbench';
          localStorage.setItem('nadoDashboardView', state.activeView);
          applyView();
          setStatus('Using session ' + button.dataset.sessionUse + ' for task submission');
        });
      });
      root.querySelectorAll('[data-session-close]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            const { session } = await api('/api/sessions/' + encodeURIComponent(button.dataset.sessionClose) + '/close', {
              method: 'POST',
              body: JSON.stringify({}),
            });
            state.selectedSessionId = session.id;
            setStatus('Closed session ' + session.id);
            await refresh();
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
    }

    function bindSessionArtifactButtons(root = document) {
      root.querySelectorAll('[data-session-artifacts]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            await loadSessionArtifacts(button.dataset.sessionArtifacts);
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
      root.querySelectorAll('[data-session-download]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            await downloadSessionArtifacts(button.dataset.sessionDownload);
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
    }

    function useWorker(workerId) {
      document.getElementById('consoleWorkerId').value = workerId;
      const routingOptions = document.getElementById('consoleRoutingOptions');
      if (routingOptions) {
        routingOptions.open = true;
      }
      document.getElementById('workerId').value = workerId;
      document.getElementById('batchPlanWorkerId').value = workerId;
      document.getElementById('sessionWorkerId').value = workerId;
      document.getElementById('recoveryTargetWorker').value = workerId;
      document.getElementById('workerTokenFilter').value = workerId;
      updateConsoleRoutingSummary();
      setStatus('Using worker ' + workerId + ' in forms');
    }

    async function runWorkerAgentSelfTest(workerId) {
      const ok = window.confirm(localizeText('Run an agent self-test on this worker? This may call the configured Codex or Claude CLI.'));
      if (!ok) {
        return;
      }
      setStatus('Running agent self-test for ' + workerId + '...');
      const result = await api('/api/doctor', {
        method: 'POST',
        body: JSON.stringify({
          workerId,
          agentSelfTest: true,
          timeoutMs: 60000,
        }),
      });
      renderDoctor(result);
      await refresh();
      const test = result.agentSelfTest || (result.agentSelfTests || []).find((item) => item.workerId === workerId);
      setStatus(test
        ? 'Agent self-test ' + test.status + ' for ' + workerId
        : 'No agent self-test result for ' + workerId, !result.ok);
    }

    function bindWorkerButtons(root = document) {
      root.querySelectorAll('[data-worker-view]').forEach((button) => {
        button.addEventListener('click', () => {
          state.activeView = 'workers';
          localStorage.setItem('nadoDashboardView', state.activeView);
          applyView();
          rerenderViewTables();
          loadWorkerDetail(button.dataset.workerView).catch((error) => setStatus(error.message, true));
        });
      });
      root.querySelectorAll('[data-worker-use]').forEach((button) => {
        button.addEventListener('click', () => {
          useWorker(button.dataset.workerUse);
        });
      });
      root.querySelectorAll('[data-worker-events]').forEach((button) => {
        button.addEventListener('click', () => {
          loadWorkerEvents(button.dataset.workerEvents).catch((error) => setStatus(error.message, true));
        });
      });
      root.querySelectorAll('[data-worker-agent-self-test]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            await runWorkerAgentSelfTest(button.dataset.workerAgentSelfTest);
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
      root.querySelectorAll('[data-worker-forget]').forEach((button) => {
        button.addEventListener('click', async () => {
          const workerId = button.dataset.workerForget;
          const ok = window.confirm('Forget retired worker ' + workerId + '? This removes it from the gateway list and revokes its worker tokens.');
          if (!ok) {
            return;
          }
          try {
            button.disabled = true;
            const result = await api('/api/workers/' + encodeURIComponent(workerId) + '/forget', {
              method: 'POST',
              body: JSON.stringify({ reason: 'dashboard forget retired worker' }),
            });
            if (state.selectedWorkerId === workerId) {
              state.selectedWorkerId = null;
              document.getElementById('workerDetail').innerHTML = '<div class="empty">Select a worker</div>';
            }
            setStatus('Forgot worker ' + result.worker.id);
            await refresh();
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
      root.querySelectorAll('[data-worker][data-action]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            button.disabled = true;
            await api('/api/workers/' + encodeURIComponent(button.dataset.worker) + '/manage', {
              method: 'POST',
              body: JSON.stringify({ action: button.dataset.action, reason: 'dashboard' }),
            });
            state.selectedWorkerId = button.dataset.worker;
            await refresh();
          } catch (error) {
            setStatus(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
      });
    }

    function bindBatchNavigationButtons(root = document) {
      root.querySelectorAll('[data-batch-view]').forEach((button) => {
        button.addEventListener('click', () => {
          loadBatchDetail(button.dataset.batchView, 'detail').catch((error) => setStatus(error.message, true));
        });
      });
      root.querySelectorAll('[data-batch-report]').forEach((button) => {
        button.addEventListener('click', () => {
          loadBatchDetail(button.dataset.batchReport, 'report').catch((error) => setStatus(error.message, true));
        });
      });
      root.querySelectorAll('[data-batch-events]').forEach((button) => {
        button.addEventListener('click', () => {
          loadBatchDetail(button.dataset.batchEvents, 'events').catch((error) => setStatus(error.message, true));
        });
      });
    }

    function panelViews(panel) {
      const has = (selector) => Boolean(panel.querySelector(selector));
      if (panel.classList.contains('console-section')) return ['workbench'];
      if (has('#workerDetail')) return ['workers'];
      if (has('#workers')) return ['workbench', 'workers'];
      if (has('#taskDetail')) return ['tasks'];
      if (has('#tasks')) return ['workbench', 'tasks'];
      if (has('#inviteForm') || has('#workerTokens')) return ['onboarding'];
      if (has('#submitForm')) return ['tasks'];
      if (has('#plannerForm') || has('#batchPlanForm') || has('#batchForm') || has('#batches') || has('#batchDetail')) return ['batches'];
      if (has('#sessionForm') || has('#sessions') || has('#sessionDetail')) return ['sessions'];
      if (has('#doctorForm') || has('#verifyForm') || has('#agentContext') || has('#capabilitiesManifest') || has('#mcpConfig') || has('#recoveryForm')) return ['ops'];
      return ['ops'];
    }

    function applyView() {
      const activeView = state.activeView || 'workbench';
      const main = document.querySelector('main');
      if (main) {
        main.dataset.activeView = activeView;
      }
      document.querySelectorAll('[data-view-tab]').forEach((button) => {
        button.classList.toggle('active', button.dataset.viewTab === activeView);
      });
      document.querySelectorAll('main > section, .grid section').forEach((panel) => {
        const visible = panelViews(panel).includes(activeView);
        panel.classList.toggle('view-panel-hidden', !visible);
      });
      document.querySelectorAll('.grid > div').forEach((column) => {
        const visiblePanel = [...column.querySelectorAll('section')]
          .some((panel) => !panel.classList.contains('view-panel-hidden'));
        column.classList.toggle('view-panel-hidden', !visiblePanel);
      });
      const grid = document.querySelector('.grid');
      if (grid) {
        grid.classList.toggle('single-column', ['workbench', 'onboarding', 'batches', 'sessions', 'ops'].includes(activeView));
      }
    }

    function rerenderViewTables() {
      if (!state.snapshot) {
        return;
      }
      renderWorkers(state.snapshot.workers.items || []);
      renderAttentionTasks(state.snapshot.tasks.items || []);
      renderTasks(state.snapshot.tasks.items || []);
      bindWorkerButtons(document.getElementById('workers'));
      bindTaskDetailButtons(document.getElementById('attentionTasks'));
      bindTaskDetailButtons(document.getElementById('tasks'));
      bindTaskManageButtons(document.getElementById('attentionTasks'));
      bindTaskManageButtons(document.getElementById('tasks'));
      applyLocale(document.querySelector('main') || document.body);
    }

    function openWorkerOnboarding() {
      state.activeView = 'onboarding';
      localStorage.setItem('nadoDashboardView', state.activeView);
      applyView();
      rerenderViewTables();
      const button = document.getElementById('downloadBootstrapBundle');
      button?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      button?.focus();
      setStatus('Worker onboarding ready');
    }

    function render(snapshot) {
      renderStats(snapshot);
      renderControlReadiness(snapshot);
      renderConsoleAgentNotice(snapshot.workers.items || []);
      renderWorkers(snapshot.workers.items || []);
      renderAttentionTasks(snapshot.tasks.items || []);
      renderTasks(snapshot.tasks.items || []);
      renderBatches(snapshot.batches.items || []);
      renderSessions(snapshot.sessions.items || []);
      bindWorkerButtons();
      bindTaskDetailButtons();
      bindTaskManageButtons();
      bindBatchManageButtons();
      bindSessionButtons();
      bindBatchNavigationButtons();
      applyView();
    }

    function parseCsv(value) {
      return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
    }

    function parseListText(value) {
      return String(value || '').split(/[,\\n]/).map((item) => item.trim()).filter(Boolean);
    }

    function parseLabel(value) {
      const text = String(value || '').trim();
      if (!text) return {};
      const [key, ...rest] = text.split('=');
      return key ? { [key]: rest.join('=') || 'true' } : {};
    }

    function parseEnvText(value) {
      const env = {};
      for (const line of String(value || '').split(/\\n/)) {
        const text = line.trim();
        if (!text || text.startsWith('#')) {
          continue;
        }
        const [key, ...rest] = text.split('=');
        if (key) {
          env[key.trim()] = rest.join('=');
        }
      }
      return env;
    }

    function parsePlanTasks(value) {
      return String(value || '').split(/\\n/).map((item) => item.trim()).filter(Boolean);
    }

    function plannerFormBody() {
      const form = new FormData(document.getElementById('plannerForm'));
      const body = {
        title: form.get('title') || undefined,
        prompt: form.get('prompt') || '',
        mode: form.get('mode') || 'auto',
        shards: form.get('shards') ? Number(form.get('shards')) : undefined,
        subtasks: parsePlanTasks(form.get('subtasks')),
        capabilities: parseCsv(form.get('capability')),
        tools: parseCsv(form.get('tool')),
        labels: parseLabel(form.get('label')),
        requireRoutable: Boolean(form.get('requireRoutable')),
      };
      if (!body.subtasks.length) {
        delete body.subtasks;
      }
      return body;
    }

    function bytesToBase64(bytes) {
      let binary = '';
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }
      return btoa(binary);
    }

    function base64ToText(base64) {
      const binary = atob(base64 || '');
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new TextDecoder().decode(bytes);
    }

    function previewableArtifact(artifact) {
      if (!artifact?.contentBase64 || artifact.skipped) {
        return false;
      }
      if (Number(artifact.size || 0) > 80_000) {
        return false;
      }
      return /\.(txt|md|markdown|json|csv|tsv|log|ya?ml|xml|html|css|js|ts|py|sh|ps1)$/i.test(artifact.path || '');
    }

    async function readInputFiles(fileList) {
      const files = Array.from(fileList || []);
      const inputFiles = [];
      for (const file of files) {
        inputFiles.push({
          path: file.webkitRelativePath || file.name,
          contentBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
        });
      }
      return inputFiles;
    }

    function artifactPolicyFromForm(form) {
      const include = parseListText(form.get('artifactInclude'));
      const exclude = parseListText(form.get('artifactExclude'));
      if (!include.length && !exclude.length) {
        return undefined;
      }
      return { include, exclude };
    }

    function keepWorkspaceFromPolicy(policy) {
      if (policy === 'keep') {
        return true;
      }
      if (policy === 'cleanup') {
        return false;
      }
      return undefined;
    }

    function quoteBash(value) {
      return "'" + String(value).replaceAll("'", "'\\\"'\\\"'") + "'";
    }

    function quotePowerShell(value) {
      return "'" + String(value).replaceAll("'", "''") + "'";
    }

    function buildWorkerStartOptions(options, quote) {
      const values = [
        ['--id', options.id],
        ['--data-dir', options.dataDir || '.nado'],
      ];
      for (const capability of options.capabilities || []) {
        values.push(['--capability', capability]);
      }
      for (const label of options.labels || []) {
        values.push(['--label', label]);
      }
      if (options.agentPreset) {
        values.push(['--agent', options.agentPreset]);
      }
      if (options.agentCommand) {
        values.push(['--agent-command', options.agentCommand]);
      }
      if (options.maxConcurrency) {
        values.push(['--max-concurrency', options.maxConcurrency]);
      }
      if (options.cleanupWorkspaces) {
        values.push(['--cleanup-workspaces', null]);
      }
      if (options.pollMs) {
        values.push(['--poll-ms', options.pollMs]);
      }
      return values.flatMap(([key, value]) => value === null ? [key] : [key, quote(value)]).join(' ');
    }

    function buildWorkerPreflightCommand(options, quote) {
      const cli = options.format === 'powershell' ? '.\\\\src\\\\cli.js' : './src/cli.js';
      const control = options.format === 'powershell' ? '$env:NADO_CONTROL' : '"$NADO_CONTROL"';
      return 'node ' + cli + ' worker preflight --control ' + control + ' --id ' + quote(options.id) + ' --data-dir ' + quote(options.dataDir || '.nado');
    }

    function buildWorkerInvite(options) {
      if (options.format === 'powershell') {
        return [
          '# Run from the nado-agent repository root on the worker host.',
          '$env:NADO_TOKEN=' + quotePowerShell(options.token),
          '$env:NADO_CONTROL=' + quotePowerShell(options.controlUrl),
          buildWorkerPreflightCommand(options, quotePowerShell),
          'node .\\\\src\\\\cli.js worker start ' + buildWorkerStartOptions(options, quotePowerShell),
        ].join('\\n');
      }
      return [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '',
        '# Run from the nado-agent repository root on the worker host.',
        'export NADO_TOKEN=' + quoteBash(options.token),
        'export NADO_CONTROL=' + quoteBash(options.controlUrl),
        buildWorkerPreflightCommand(options, quoteBash),
        'node ./src/cli.js worker start ' + buildWorkerStartOptions(options, quoteBash),
      ].join('\\n');
    }

    function generatedWorkerId() {
      const bytes = new Uint8Array(4);
      crypto.getRandomValues(bytes);
      return 'worker-' + Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    function loopbackControlUrlReason(value) {
      try {
        const parsed = new URL(value || window.location.origin);
        const host = parsed.hostname.replace(/^\\[|\\]$/g, '').toLowerCase();
        if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.startsWith('127.')) {
          return 'Remote workers cannot reach a loopback control URL. Use the control host LAN address or bracketed IPv6 address before downloading a bundle for another machine.';
        }
        return '';
      } catch {
        return 'Control URL is not a valid URL';
      }
    }

    function updateInviteControlWarning() {
      const target = document.getElementById('inviteControlWarning');
      if (!target) {
        return '';
      }
      const reason = loopbackControlUrlReason(document.getElementById('inviteControl').value);
      target.dataset.i18nStatus = reason;
      target.textContent = reason ? localizeText(reason) : '';
      return reason;
    }

    function preferredControlUrlCandidate(info) {
      return (info?.candidates || []).find((candidate) => candidate.usable !== false) || null;
    }

    function shouldAutoFillInviteControl(currentValue) {
      const value = String(currentValue || '').trim();
      if (!value) {
        return true;
      }
      const warning = loopbackControlUrlReason(value);
      if (state.inviteControlTouched && value !== window.location.origin && !warning) {
        return false;
      }
      return value === window.location.origin || Boolean(warning);
    }

    function maybeAutoFillInviteControl(info) {
      const candidate = preferredControlUrlCandidate(info);
      const input = document.getElementById('inviteControl');
      if (!candidate || !input || !shouldAutoFillInviteControl(input.value)) {
        return false;
      }
      input.value = candidate.url;
      updateInviteControlWarning();
      return true;
    }

    function renderNetworkActionCommands(commands = []) {
      if (!commands.length) {
        return '';
      }
      return '<div class="network-command-list">'
        + commands.map((command) => ''
          + '<div class="network-command">'
          + '<strong>' + esc(localizeText(command.label || command.shell || 'Command')) + '</strong>'
          + (command.description ? '<small>' + esc(localizeText(command.description)) + '</small>' : '')
          + '<code>' + esc(command.command || '') + '</code>'
          + '</div>').join('')
        + '</div>';
    }

    function renderNetworkInfo(info) {
      const target = document.getElementById('networkInfo');
      if (!target) {
        return;
      }
      if (!info) {
        target.className = 'network-hints empty';
        target.textContent = 'No network URL scan loaded';
        return;
      }
      const candidates = info.candidates || [];
      const preferredUrl = info.preferredRemoteControlUrl || (preferredControlUrlCandidate(info)?.url || '');
      const readiness = info.remoteWorkerReady
        ? '<div class="network-summary ok">' + esc(localizeText('Remote worker URL ready')) + ': <code>' + esc(preferredUrl) + '</code></div>'
        : '<div class="network-summary warn">' + esc(localizeText('No usable remote worker URL detected.')) + '</div>';
      const warning = info.requestIsLoopback
        ? '<div class="field-warning">' + esc(localizeText(info.remoteWorkerReady
          ? 'Browser uses loopback; worker bundles will use the preferred URL below.'
          : 'Current browser URL is loopback. Pick a reachable LAN or IPv6 URL before sending bundles to another machine.')) + '</div>'
        : '';
      const nextAction = info.nextAction
        ? '<div class="field-warning"><strong>' + esc(localizeText('Next Action')) + '</strong>: '
          + esc(localizeText(info.nextAction.message || info.nextAction.code || ''))
          + (info.nextAction.cli ? '<br><code>' + esc(info.nextAction.cli) + '</code>' : '')
          + renderNetworkActionCommands(info.nextAction.commands || [])
          + '</div>'
        : '';
      const rows = candidates.map((candidate) => ''
        + '<div class="network-hint-row' + (candidate.usable === false ? ' muted-row' : '') + '">'
        + '<div><code>' + esc(candidate.url) + '</code><br><small>' + esc(candidate.family + ' · ' + candidate.interface + (candidate.source === 'NADO_PUBLIC_CONTROL_URL' ? ' · configured' : '')) + '</small>'
        + (candidate.warning ? '<div class="field-warning">' + esc(localizeText(candidate.warning)) + '</div>' : '')
        + '</div>'
        + (candidate.usable === false
          ? '<button type="button" disabled>' + esc(localizeText('Not for remote workers')) + '</button>'
          : '<button type="button" data-use-control-url="' + esc(candidate.url) + '">' + esc(localizeText('Use URL')) + '</button>')
        + '</div>').join('');
      target.className = 'network-hints';
      target.innerHTML = readiness + warning + nextAction + (rows || '<div class="empty">' + esc(localizeText('No non-loopback network address was detected on this host.')) + '</div>');
      target.querySelectorAll('[data-use-control-url]').forEach((button) => {
        button.addEventListener('click', () => {
          document.getElementById('inviteControl').value = button.dataset.useControlUrl;
          state.inviteControlTouched = true;
          updateInviteControlWarning();
        });
      });
    }

    async function loadNetworkInfo({ silent = false } = {}) {
      if (!tokenInput.value.trim()) {
        renderNetworkInfo(null);
        return null;
      }
      const info = await api('/api/network');
      state.networkInfo = info;
      maybeAutoFillInviteControl(info);
      renderNetworkInfo(info);
      renderControlReadiness();
      if (!silent) {
        setStatus('Network URLs refreshed');
      }
      return info;
    }

    function inviteFormOptions() {
      const form = new FormData(document.getElementById('inviteForm'));
      const formControlUrl = form.get('controlUrl') || window.location.origin;
      const preferredControlUrl = state.networkInfo?.preferredRemoteControlUrl || '';
      return {
        workerId: String(form.get('id') || '').trim(),
        controlUrl: preferredControlUrl && loopbackControlUrlReason(formControlUrl)
          ? preferredControlUrl
          : formControlUrl,
        format: form.get('format') || 'bash',
        capabilities: parseCsv(form.get('capabilities')),
        labels: parseCsv(form.get('labels')),
        agentPreset: form.get('agentPreset') || '',
        agentCommand: form.get('agentCommand') || '',
        maxConcurrency: Number(form.get('maxConcurrency') || 1),
        cleanupWorkspaces: Boolean(form.get('cleanupWorkspaces')),
        pollMs: Number(form.get('pollMs') || 2000),
        dataDir: form.get('dataDir') || '.nado',
        tokenLabel: form.get('tokenLabel') || '',
      };
    }

    function downloadInviteScript() {
      if (!state.lastInvite) {
        throw new Error('No invite generated yet');
      }
      const text = document.getElementById('inviteOutput').textContent || '';
      const extension = state.lastInvite.format === 'powershell' ? 'ps1' : 'sh';
      const name = safeZipPath('nado-worker-' + state.lastInvite.workerId + '.' + extension);
      downloadBlob(name, new Blob([text + '\\n'], { type: 'text/plain' }));
      setStatus('Downloaded invite for ' + state.lastInvite.workerId);
    }

    async function downloadWorkerBundle() {
      if (!state.lastInvite) {
        throw new Error('No invite generated yet');
      }
      const invite = state.lastInvite;
      const result = await binaryApi('/api/workers/bundle', {
        method: 'POST',
        body: JSON.stringify({
          id: invite.workerId,
          workerToken: invite.token,
          controlUrl: invite.controlUrl,
          capabilities: invite.capabilities || [],
          labels: invite.labels || [],
          agentPreset: invite.agentPreset || '',
          agentCommand: invite.agentCommand || '',
          maxConcurrency: invite.maxConcurrency || 1,
          cleanupWorkspaces: Boolean(invite.cleanupWorkspaces),
          pollMs: invite.pollMs || 2000,
          dataDir: invite.dataDir || '.nado',
        }),
      });
      const name = result.fileName || safeZipPath('nado-worker-' + invite.workerId + '.zip');
      downloadBlob(name, result.blob);
      setStatus('Downloaded worker bundle for ' + invite.workerId);
    }

    async function downloadBootstrapBundle() {
      const options = inviteFormOptions();
      const controlUrlWarning = updateInviteControlWarning();
      const result = await binaryApi('/api/workers/bootstrap-bundle', {
        method: 'POST',
        body: JSON.stringify({
          issueEnrollmentToken: true,
          tokenLabel: options.tokenLabel || 'dashboard self-service',
          controlUrl: options.controlUrl,
          capabilities: options.capabilities,
          labels: options.labels,
          agentPreset: options.agentPreset,
          agentCommand: options.agentCommand,
          maxConcurrency: options.maxConcurrency,
          cleanupWorkspaces: options.cleanupWorkspaces,
          pollMs: options.pollMs,
          dataDir: options.dataDir,
        }),
      });
      downloadBlob(result.fileName || 'nado-worker-bootstrap.zip', result.blob);
      setStatus(controlUrlWarning
        ? 'Downloaded self-service worker bundle with loopback control URL'
        : 'Downloaded self-service worker bundle');
      await loadWorkerEnrollmentTokens({ silent: true });
    }

    async function selfTestInviteWorker() {
      if (!state.lastInvite) {
        throw new Error('No invite generated yet');
      }
      document.getElementById('doctorWorker').value = state.lastInvite.workerId;
      document.getElementById('doctorCapability').value = '';
      document.getElementById('doctorTool').value = '';
      document.getElementById('doctorLabel').value = '';
      document.getElementById('doctorSelfTest').checked = true;
      document.getElementById('doctorAllWorkers').checked = false;
      setStatus('Running self-test for ' + state.lastInvite.workerId + '...');
      await runDashboardDoctor();
    }

    async function refresh() {
      if (!tokenInput.value.trim()) {
        setStatus('Enter NADO_TOKEN to load gateway state', true);
        return;
      }
      setStatus('Refreshing...');
      const snapshot = await api('/api/status');
      state.snapshot = snapshot;
      render(snapshot);
      await loadWorkerTokens({ silent: true });
      await loadWorkerEnrollmentTokens({ silent: true });
      await loadAgentContext({ silent: true });
      await loadMcpConfig({ silent: true });
      await loadRecoveryCandidates({ silent: true });
      if (state.selectedWorkerId) {
        await loadWorkerDetail(state.selectedWorkerId);
      }
      if (state.selectedTaskId) {
        await loadTaskDetail(state.selectedTaskId);
      }
      if (state.selectedBatchId) {
        await loadBatchDetail(state.selectedBatchId, state.selectedBatchMode || 'detail');
      }
      if (state.selectedSessionId) {
        await loadSessionDetail(state.selectedSessionId);
      }
      setStatus('Updated ' + new Date().toLocaleTimeString());
    }

    statusEl.dataset.i18nStatus = statusEl.textContent;
    applyLocale();
    localeInput.addEventListener('change', () => {
      state.locale = localeInput.value || 'en';
      localStorage.setItem('nadoLocale', state.locale);
      applyLocale();
      updateConsoleRoutingSummary();
    });
    document.querySelectorAll('[data-view-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeView = button.dataset.viewTab || 'workbench';
        localStorage.setItem('nadoDashboardView', state.activeView);
        applyView();
        rerenderViewTables();
      });
    });
    document.querySelectorAll('[data-task-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        state.taskFilter = button.dataset.taskFilter || 'user';
        localStorage.setItem('nadoTaskFilter', state.taskFilter);
        if (state.snapshot) {
          renderAttentionTasks(state.snapshot.tasks.items || []);
          renderTasks(state.snapshot.tasks.items || []);
          bindTaskDetailButtons();
          bindTaskManageButtons();
          applyLocale(document.getElementById('tasks')?.closest('section') || document.body);
        }
      });
    });
    document.getElementById('pruneTaskHistory').addEventListener('click', () => {
      pruneTaskHistory().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('clearWorkbenchCompleted').addEventListener('click', () => {
      resetWorkbenchDemo().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('openWorkerOnboarding').addEventListener('click', openWorkerOnboarding);
    document.getElementById('pruneSystemHistory').addEventListener('click', () => {
      pruneSystemHistory().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('cancelRoutingIssues').addEventListener('click', () => {
      cancelRoutingIssues().catch((error) => setStatus(error.message, true));
    });
    document.querySelectorAll('[data-console-example]').forEach((button) => {
      button.addEventListener('click', () => {
        applyConsoleExample(button.dataset.consoleExample);
      });
    });
    ['consoleWorkerId', 'consoleCapability', 'consoleTool', 'consoleSessionId', 'consoleLabel'].forEach((id) => {
      document.getElementById(id).addEventListener('input', updateConsoleRoutingSummary);
      document.getElementById(id).addEventListener('change', updateConsoleRoutingSummary);
    });
    updateConsoleRoutingSummary();
    applyView();
    if (!document.getElementById('inviteId').value.trim()) {
      document.getElementById('inviteId').value = generatedWorkerId();
    }
    document.getElementById('saveToken').addEventListener('click', () => {
      localStorage.setItem('nadoToken', tokenInput.value.trim());
      refresh().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('refresh').addEventListener('click', () => {
      refresh().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('loadWorkerTokens').addEventListener('click', () => {
      loadWorkerTokens().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('loadWorkerEnrollmentTokens').addEventListener('click', () => {
      loadWorkerEnrollmentTokens().catch((error) => setStatus(error.message, true));
    });
    const showEnrollmentHistoryInput = document.getElementById('showEnrollmentHistory');
    showEnrollmentHistoryInput.checked = state.showEnrollmentHistory;
    showEnrollmentHistoryInput.addEventListener('change', () => {
      state.showEnrollmentHistory = showEnrollmentHistoryInput.checked;
      localStorage.setItem('nadoShowEnrollmentHistory', String(state.showEnrollmentHistory));
      loadWorkerEnrollmentTokens({ silent: true }).catch((error) => setStatus(error.message, true));
    });
    document.getElementById('pruneWorkerEnrollmentTokens').addEventListener('click', () => {
      pruneWorkerEnrollmentTokens().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('downloadInvite').addEventListener('click', async () => {
      try {
        document.getElementById('downloadInvite').disabled = true;
        downloadInviteScript();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('downloadInvite').disabled = false;
      }
    });
    document.getElementById('downloadBundle').addEventListener('click', async () => {
      try {
        document.getElementById('downloadBundle').disabled = true;
        await downloadWorkerBundle();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('downloadBundle').disabled = false;
      }
    });
    document.getElementById('downloadBootstrapBundle').addEventListener('click', async () => {
      try {
        document.getElementById('downloadBootstrapBundle').disabled = true;
        await downloadBootstrapBundle();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('downloadBootstrapBundle').disabled = false;
      }
    });
    document.getElementById('selfTestInvite').addEventListener('click', async () => {
      try {
        document.getElementById('selfTestInvite').disabled = true;
        await selfTestInviteWorker();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('selfTestInvite').disabled = false;
      }
    });
    document.getElementById('doctorForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        document.getElementById('runDoctor').disabled = true;
        await runDashboardDoctor();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('runDoctor').disabled = false;
      }
    });
    document.getElementById('verifyForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        document.getElementById('runVerify').disabled = true;
        await runDashboardVerify();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('runVerify').disabled = false;
      }
    });
    document.getElementById('runDemoHealth').addEventListener('click', async () => {
      try {
        document.getElementById('runDemoHealth').disabled = true;
        await runDashboardDemoHealth();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('runDemoHealth').disabled = false;
      }
    });
    document.getElementById('loadAgentContext').addEventListener('click', () => {
      loadAgentContext().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('downloadAgentContext').addEventListener('click', async () => {
      try {
        document.getElementById('downloadAgentContext').disabled = true;
        await downloadAgentContext();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('downloadAgentContext').disabled = false;
      }
    });
    document.getElementById('loadCapabilities').addEventListener('click', () => {
      loadCapabilities().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('downloadCapabilities').addEventListener('click', async () => {
      try {
        document.getElementById('downloadCapabilities').disabled = true;
        await downloadCapabilities();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('downloadCapabilities').disabled = false;
      }
    });
    document.getElementById('loadMcpConfig').addEventListener('click', () => {
      loadMcpConfig().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('downloadMcpConfig').addEventListener('click', async () => {
      try {
        document.getElementById('downloadMcpConfig').disabled = true;
        await downloadMcpConfig();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('downloadMcpConfig').disabled = false;
      }
    });
    document.getElementById('loadRecoveryCandidates').addEventListener('click', () => {
      loadRecoveryCandidates().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('recoveryForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        document.getElementById('recoverOfflineTasks').disabled = true;
        await recoverOfflineTasks();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('recoverOfflineTasks').disabled = false;
      }
    });
    document.getElementById('consoleForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await submitConsoleForm(event.currentTarget);
      } catch (error) {
        setStatus(error.message, true);
      }
    });
    document.getElementById('consolePrompt').addEventListener('keydown', (event) => {
      if (event.isComposing || event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) {
        return;
      }
      event.preventDefault();
      const runButton = document.getElementById('runConsoleTask');
      if (runButton.disabled) {
        return;
      }
      document.getElementById('consoleForm').requestSubmit();
    });
    document.getElementById('stopConsoleTask').addEventListener('click', async () => {
      try {
        document.getElementById('stopConsoleTask').disabled = true;
        await stopConsoleTask();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('stopConsoleTask').disabled = false;
      }
    });
    document.getElementById('previewConsoleDispatch').addEventListener('click', async () => {
      try {
        document.getElementById('previewConsoleDispatch').disabled = true;
        await previewConsoleDispatch(new FormData(document.getElementById('consoleForm')));
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('previewConsoleDispatch').disabled = false;
      }
    });
    document.getElementById('checkConsoleRoutes').addEventListener('click', async () => {
      try {
        document.getElementById('checkConsoleRoutes').disabled = true;
        await runConsoleRouteCheck();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('checkConsoleRoutes').disabled = false;
      }
    });
    document.getElementById('newConsoleSession').addEventListener('click', async () => {
      try {
        document.getElementById('newConsoleSession').disabled = true;
        await createConsoleSession();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('newConsoleSession').disabled = false;
      }
    });
    document.getElementById('clearConsoleSession').addEventListener('click', () => {
      clearConsoleSession().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('downloadConsoleArtifacts').addEventListener('click', async () => {
      if (!state.consoleArtifactTaskId) {
        setStatus('No console task artifacts available', true);
        return;
      }
      try {
        document.getElementById('downloadConsoleArtifacts').disabled = true;
        await downloadTaskArtifacts(state.consoleArtifactTaskId);
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        document.getElementById('downloadConsoleArtifacts').disabled = !state.consoleArtifactTaskId;
      }
    });
    document.getElementById('submitForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const taskType = form.get('type') || 'shell';
      const command = String(form.get('command') || '').trim();
      const prompt = String(form.get('prompt') || '').trim();
      const body = {
        title: form.get('title') || command || prompt || 'dashboard task',
        type: taskType,
        command: command || undefined,
        prompt: prompt || undefined,
        workerId: form.get('workerId') || undefined,
        sessionId: form.get('sessionId') || undefined,
        requiredCapabilities: parseCsv(form.get('capability')),
        requiredTools: parseCsv(form.get('tool')),
        requiredLabels: parseLabel(form.get('label')),
        priority: Number(form.get('priority') || 0),
        slots: Number(form.get('slots') || 1),
        timeoutMs: form.get('timeoutMs') ? Number(form.get('timeoutMs')) : undefined,
        keepWorkspace: keepWorkspaceFromPolicy(form.get('workspacePolicy')),
        sandboxProfile: form.get('sandboxProfile') || undefined,
        env: parseEnvText(form.get('envText')),
        artifactPolicy: artifactPolicyFromForm(form),
        requireRoutable: Boolean(form.get('requireRoutable')),
        inputFiles: await readInputFiles(document.getElementById('inputFiles').files),
      };
      if (taskType === 'shell' && !body.command) {
        setStatus('Shell tasks require a command', true);
        return;
      }
      if (taskType === 'agent' && !body.prompt && !body.command) {
        setStatus('Agent tasks require a prompt', true);
        return;
      }
      try {
        const result = await api('/api/tasks', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        event.currentTarget.reset();
        document.getElementById('taskType').value = 'shell';
        document.getElementById('priority').value = '0';
        document.getElementById('slots').value = '1';
        document.getElementById('workspacePolicy').value = '';
        document.getElementById('sandboxProfile').value = '';
        state.selectedTaskId = result.task.id;
        setStatus('Submitted ' + result.task.id);
        await refresh();
      } catch (error) {
        if (!showDispatchPlanError(error)) {
          setStatus(error.message, true);
        }
      }
    });
    document.getElementById('batchPlanForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const tasks = parsePlanTasks(form.get('tasks'));
      if (!tasks.length) {
        setStatus('Batch plan requires at least one task line', true);
        return;
      }
      const body = {
        title: form.get('title') || 'dashboard planned batch',
        type: form.get('type') || 'agent',
        tasks,
        workerId: form.get('workerId') || undefined,
        capabilities: parseCsv(form.get('capability')),
        tools: parseCsv(form.get('tool')),
        labels: parseLabel(form.get('label')),
        priority: Number(form.get('priority') || 0),
        slots: Number(form.get('slots') || 1),
        keepWorkspace: keepWorkspaceFromPolicy(form.get('workspacePolicy')),
        sandboxProfile: form.get('sandboxProfile') || undefined,
        commandTemplate: form.get('commandTemplate') || undefined,
      };
      try {
        const result = await api('/api/batches/plan', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        document.getElementById('batchJson').value = JSON.stringify(result.batch, null, 2);
        setStatus('Planned ' + result.batch.tasks.length + ' batch task(s)');
      } catch (error) {
        if (!showDispatchPlanError(error)) {
          setStatus(error.message, true);
        }
      }
    });
    document.getElementById('plannerForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = plannerFormBody();
      if (!body.prompt.trim()) {
        setStatus('Distributed planner requires a large task prompt', true);
        return;
      }
      try {
        const result = await api('/api/planner/plan', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        renderPlannerResult(result);
        document.getElementById('batchJson').value = JSON.stringify(result.batch, null, 2);
        setStatus('Planned distributed batch with ' + result.planner.taskCount + ' task(s)');
      } catch (error) {
        if (!showDispatchPlanError(error)) {
          setStatus(error.message, true);
        }
      }
    });
    document.getElementById('runDistributedPlan').addEventListener('click', async () => {
      const body = plannerFormBody();
      if (!body.prompt.trim()) {
        setStatus('Distributed planner requires a large task prompt', true);
        return;
      }
      try {
        const result = await api('/api/planner/run', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        renderPlannerResult(result);
        state.selectedBatchId = result.batch.id;
        state.selectedBatchMode = 'detail';
        setStatus('Submitted distributed batch ' + result.batch.id);
        await refresh();
      } catch (error) {
        if (!showDispatchPlanError(error)) {
          setStatus(error.message, true);
        }
      }
    });
    document.getElementById('batchForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const jsonText = document.getElementById('batchJson').value;
      try {
        const body = JSON.parse(jsonText);
        if (new FormData(event.currentTarget).get('requireRoutable')) {
          body.requireRoutable = true;
        }
        const result = await api('/api/batches', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        state.selectedBatchId = result.batch.id;
        state.selectedBatchMode = 'detail';
        setStatus('Submitted batch ' + result.batch.id);
        await refresh();
      } catch (error) {
        if (!showDispatchPlanError(error)) {
          setStatus(error.message, true);
        }
      }
    });
    document.getElementById('planDispatchFromBatch').addEventListener('click', () => {
      previewDispatchFromBatchJson().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('sessionForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const body = {
        title: form.get('title') || 'dashboard session',
        workerId: form.get('workerId') || undefined,
        requiredCapabilities: parseCsv(form.get('capability')),
        requiredTools: parseCsv(form.get('tool')),
        requiredLabels: parseLabel(form.get('label')),
      };
      try {
        const result = await api('/api/sessions', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        state.selectedSessionId = result.session.id;
        document.getElementById('sessionId').value = result.session.id;
        event.currentTarget.reset();
        setStatus('Created session ' + result.session.id);
        await refresh();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
    document.getElementById('inviteControl').value = window.location.origin;
    updateInviteControlWarning();
    document.getElementById('inviteControl').addEventListener('input', () => {
      state.inviteControlTouched = true;
      updateInviteControlWarning();
    });
    document.getElementById('refreshNetworkInfo').addEventListener('click', () => {
      loadNetworkInfo().catch((error) => setStatus(error.message, true));
    });
    document.getElementById('inviteForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const options = inviteFormOptions();
      const workerId = options.workerId;
      if (!workerId) {
        setStatus('Worker invite requires a worker ID', true);
        return;
      }
      try {
        const issued = await api('/api/worker-tokens', {
          method: 'POST',
          body: JSON.stringify({
            workerId,
            label: options.tokenLabel || '',
          }),
        });
        const inviteOptions = {
          id: workerId,
          token: issued.token,
          controlUrl: options.controlUrl,
          format: options.format,
          capabilities: options.capabilities,
          labels: options.labels,
          agentPreset: options.agentPreset,
          agentCommand: options.agentCommand,
          maxConcurrency: options.maxConcurrency,
          cleanupWorkspaces: options.cleanupWorkspaces,
          pollMs: options.pollMs,
          dataDir: options.dataDir,
        };
        const invite = buildWorkerInvite(inviteOptions);
        state.lastInvite = {
          workerId,
          token: issued.token,
          tokenId: issued.workerToken.id,
          ...inviteOptions,
        };
        document.getElementById('inviteOutput').textContent = '# Issued worker token ' + issued.workerToken.id + ' for ' + issued.workerToken.workerId + '\\n' + invite;
        document.getElementById('doctorWorker').value = workerId;
        document.getElementById('doctorSelfTest').checked = true;
        document.getElementById('doctorAllWorkers').checked = false;
        setStatus('Issued invite for ' + workerId);
        await loadWorkerTokens({ silent: true });
      } catch (error) {
        setStatus(error.message, true);
      }
    });

    if (tokenInput.value.trim()) {
      refresh().catch((error) => setStatus(error.message, true));
      loadNetworkInfo({ silent: true }).catch(() => {});
    }
    setInterval(() => {
      if (tokenInput.value.trim()) {
        refresh().catch((error) => setStatus(error.message, true));
      }
    }, 5000);
  </script>
</body>
</html>`;
}
