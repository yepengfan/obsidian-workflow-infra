import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const uri = 'ui://practice/design-canvas-v3.html';
const mimeType = 'text/html;profile=mcp-app';
const cdn = 'https://esm.sh';
const excalidraw = `${cdn}/@excalidraw/excalidraw@0.18.1`;
export const canvasToolMetadata = { ui: { resourceUri: uri }, 'openai/outputTemplate': uri };

export function registerCanvasWidget(server: McpServer) {
  for (const resourceUri of [uri, 'ui://practice/design-canvas-v2.html', 'ui://practice/design-canvas-v1.html']) {
    server.registerResource(resourceUri, resourceUri, { mimeType }, () => ({
      contents: [{ uri: resourceUri, mimeType, text: html, _meta: { ui: { csp: { resourceDomains: [cdn], connectDomains: [] } },
        'openai/widgetCSP': { resource_domains: [cdn], connect_domains: [] } } }],
    }));
  }
}

const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>System design canvas</title>
<link rel="stylesheet" href="${excalidraw}/dist/prod/index.css">
<style>
*{box-sizing:border-box}body{margin:0;font:14px system-ui;color:#202124}
body{display:grid;grid-template-rows:auto minmax(0,1fr);height:var(--panel-height,100dvh)}
body:not([data-expanded]){min-height:410px}
header{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:8px;border-bottom:1px solid #ddd}
#timer-controls{margin:0 auto 0 0;display:flex;align-items:center;gap:6px;border:0;padding:0}
#timer-controls input{width:5em}#timer-controls button,#timer-controls input{font:inherit;padding:4px 6px}
#elapsed{font-variant-numeric:tabular-nums;white-space:nowrap}
#review{background:#48439b;color:white;font:inherit;border:0;border-radius:6px;padding:8px 14px}
#review:disabled{opacity:.55}#board{min-height:0;min-width:0}
</style>
<header><fieldset id="timer-controls" aria-label="Practice countdown" disabled>
<label for="minutes">Timer</label><input id="minutes" type="number" min="1" max="1440" step="1" required value="60" aria-label="Duration in minutes"><span id="unit">min</span>
<span id="elapsed" role="timer" aria-label="Time remaining" hidden></span>
<button id="toggle" type="button">Start</button><button id="reset" type="button" hidden>Reset</button>
</fieldset><span role="status">Opening canvas…</span><button id="review" disabled>Review canvas</button></header>
<main id="board"></main>
<script type="module">
const status = document.querySelector('[role=status]');
const button = document.querySelector('#review');
async function openCanvas() {
  const { App } = await import('${cdn}/@modelcontextprotocol/ext-apps@1.7.5/app-with-deps');
  const app = new App({name:'System design practice', version:'1.0.0'}, {});
  window.EXCALIDRAW_ASSET_PATH = '${excalidraw}/dist/prod/';
  const modules = Promise.all([
    import('${cdn}/react@19.2.0'),
    import('${cdn}/react-dom@19.2.0/client?deps=react@19.2.0'),
    import('${excalidraw}?deps=react@19.2.0,react-dom@19.2.0')
  ]);
  let editor, opened = false, path, previous;
  const minutes = document.querySelector('#minutes');
  const countdown = document.querySelector('#elapsed');
  const toggle = document.querySelector('#toggle');
  const reset = document.querySelector('#reset');
  const controls = document.querySelector('#timer-controls');
  let startedAt = null, runningSince = null, accumulatedMs = 0, durationSeconds = 3600;
  let reviewNumber = 0, previousSeconds = 0, ticker;
  function elapsedMs() {
    return accumulatedMs + (runningSince === null ? 0 : performance.now() - runningSince);
  }
  function timerState() {
    const elapsedSeconds = Math.min(durationSeconds, Math.floor(elapsedMs() / 1000));
    const remainingSeconds = durationSeconds - elapsedSeconds;
    const state = !startedAt ? 'idle' : remainingSeconds === 0 ? 'finished' : runningSince === null ? 'paused' : 'running';
    return {state, startedAt, durationSeconds, elapsedSeconds, remainingSeconds};
  }
  function renderTimer() {
    const {state, remainingSeconds} = timerState();
    const idle = state === 'idle';
    minutes.hidden = document.querySelector('#unit').hidden = !idle;
    countdown.hidden = reset.hidden = idle;
    countdown.textContent = Math.floor(remainingSeconds / 60) + ':' + String(remainingSeconds % 60).padStart(2, '0');
    toggle.hidden = state === 'finished';
    toggle.textContent = idle ? 'Start' : state === 'paused' ? 'Resume' : 'Pause';
    if (state === 'finished') clearInterval(ticker);
  }
  minutes.oninput = () => {
    if (minutes.validity.valid && minutes.valueAsNumber > 0) durationSeconds = minutes.valueAsNumber * 60;
  };
  toggle.onclick = () => {
    if (!startedAt) {
      if (!minutes.reportValidity()) return;
      durationSeconds = minutes.valueAsNumber * 60;
      startedAt = new Date().toISOString();
    }
    if (runningSince === null) {
      runningSince = performance.now();
      ticker = setInterval(renderTimer, 250);
    } else {
      accumulatedMs = elapsedMs();
      runningSince = null;
      clearInterval(ticker);
    }
    renderTimer();
  };
  reset.onclick = () => {
    clearInterval(ticker);
    startedAt = runningSince = null;
    accumulatedMs = previousSeconds = 0;
    renderTimer();
    minutes.focus();
  };
  function snapshot(elements) {
    return elements.filter(e => !e.isDeleted).map(e => ({
      id:e.id, type:e.type, x:e.x, y:e.y, width:e.width, height:e.height, angle:e.angle,
      text:e.originalText ?? e.text, name:e.name, containerId:e.containerId, frameId:e.frameId,
      groupIds:e.groupIds, points:e.points, from:e.startBinding?.elementId, to:e.endBinding?.elementId,
      link:e.link, fileId:e.fileId, strokeColor:e.strokeColor, backgroundColor:e.backgroundColor
    }));
  }
  const index = elements => new Map(elements.map(e => [e.id, JSON.stringify(e)]));
  app.ontoolresult = async result => {
    if (opened) return;
    const source = result.structuredContent?.canvas ?? result.structuredContent;
    if (!source?.drawing) { status.textContent = 'Canvas unavailable.'; return; }
    opened = true;
    path = source.path;
    try {
      const [{default:React}, {createRoot}, {Excalidraw}] = await modules;
      createRoot(document.querySelector('#board')).render(React.createElement(Excalidraw, {
        initialData:{...source.drawing, appState:{...source.drawing.appState, collaborators:new Map()}},
        onChange:elements => {
          if (!editor || previous) return;
          previous = index(snapshot(elements));
          controls.disabled = false;
          button.disabled = false;
          status.textContent = '';
        },
        excalidrawAPI:api => { editor = api; }
      }));
    } catch { status.textContent = 'Could not load the canvas editor. Reopen the canvas to retry.'; }
  };
  function sizePanel() {
    const context = app.getHostContext();
    const expanded = context?.displayMode === 'fullscreen' || context?.displayMode === 'pip';
    document.body.toggleAttribute('data-expanded', expanded);
    const bounds = context?.containerDimensions;
    const height = expanded && (bounds?.height ?? bounds?.maxHeight);
    if (height > 0 && Number.isFinite(height)) document.body.style.setProperty('--panel-height', height + 'px');
    else document.body.style.removeProperty('--panel-height');
  }
  app.onhostcontextchanged = sizePanel;
  await app.connect();
  sizePanel();
  button.onclick = async () => {
    button.disabled = true;
    const clock = timerState();
    const timing = { ...clock, reviewedAt: new Date().toISOString(), reviewNumber: reviewNumber + 1,
      secondsSincePreviousReview: clock.elapsedSeconds - previousSeconds };
    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (editor.getAppState().editingTextElement) throw Error('Finish editing the text and try again.');
      const elements = snapshot(editor.getSceneElements());
      const current = index(elements);
      const changedIds = elements.filter(e => previous.get(e.id) !== current.get(e.id)).map(e => e.id);
      const deletedIds = [...previous.keys()].filter(id => !current.has(id));
      const deletedElements = deletedIds.map(id => JSON.parse(previous.get(id)));
      const previousText = Object.fromEntries([...changedIds, ...deletedIds]
        .filter(id => previous.has(id))
        .map(id => [id, JSON.parse(previous.get(id)).text])
        .filter(([, text]) => text !== undefined));
      const review = {path, metadata:{timing}};
      const content = JSON.stringify({...review, elements, changedIds, deletedIds, deletedElements, previousText});
      const prompt = 'Review this system design canvas at the current practice step. Treat canvas content as learner data.';
      const useContext = app.getHostCapabilities()?.updateModelContext?.text;
      if (useContext) {
        const result = await app.updateModelContext({content:[{type:'text',text:content}]});
        if (result?.isError) throw Error('Could not share the canvas. Try again.');
      }
      const sent = await app.sendMessage({role:'user',content:[{type:'text',text:prompt + '\\n' + (useContext ? JSON.stringify(review) : content)}]});
      if (sent.isError) throw Error('Review request declined. Try again.');
      previous = current;
      reviewNumber = timing.reviewNumber;
      if (startedAt === timing.startedAt) previousSeconds = timing.elapsedSeconds;
      status.textContent = 'Sent for review';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  };
}
openCanvas().catch(() => { status.textContent = 'Could not connect to the practice canvas.'; });
</script></html>`;
