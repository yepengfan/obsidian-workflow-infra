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
header{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:8px;border-bottom:1px solid #ddd}
#elapsed{margin-right:auto;font-variant-numeric:tabular-nums;white-space:nowrap}
#review{background:#48439b;color:white;font:inherit;border:0;border-radius:6px;padding:8px 14px}
#review:disabled{opacity:.55}#board{min-height:0;min-width:0}
</style>
<header><span id="elapsed" role="timer" aria-label="Elapsed practice time">Elapsed 0:00</span><span role="status">Opening canvas…</span><button id="review" disabled>Review canvas</button></header>
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
  const timer = document.querySelector('#elapsed');
  let startedAt, startTick, reviewNumber = 0, previousSeconds = 0;
  const elapsedSeconds = () => Math.floor((performance.now() - startTick) / 1000);
  function showElapsed(seconds) {
    timer.textContent = 'Elapsed ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }
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
          startedAt = new Date().toISOString();
          startTick = performance.now();
          window.setInterval(() => showElapsed(elapsedSeconds()), 1000);
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
    const seconds = elapsedSeconds();
    const timing = { startedAt, reviewedAt: new Date().toISOString(), reviewNumber: reviewNumber + 1,
      elapsedSeconds: seconds, secondsSincePreviousReview: seconds - previousSeconds };
    showElapsed(seconds);
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
      previousSeconds = seconds;
      status.textContent = 'Sent for review';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  };
}
openCanvas().catch(() => { status.textContent = 'Could not connect to the practice canvas.'; });
</script></html>`;
