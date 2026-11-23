import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const uri = 'ui://practice/design-canvas-v11.html';
const mimeType = 'text/html;profile=mcp-app';
const cdn = 'https://esm.sh';
const excalidraw = `${cdn}/@excalidraw/excalidraw@0.18.1`;
export const canvasToolMetadata = { ui: { resourceUri: uri }, 'openai/outputTemplate': uri };

export function registerCanvasWidget(server: McpServer, writesEnabled: boolean) {
  for (const resourceUri of [uri, 'ui://practice/design-canvas-v10.html', 'ui://practice/design-canvas-v9.html', 'ui://practice/design-canvas-v8.html', 'ui://practice/design-canvas-v7.html', 'ui://practice/design-canvas-v6.html', 'ui://practice/design-canvas-v5.html', 'ui://practice/design-canvas-v4.html', 'ui://practice/design-canvas-v3.html', 'ui://practice/design-canvas-v2.html', 'ui://practice/design-canvas-v1.html']) {
    server.registerResource(resourceUri, resourceUri, { mimeType }, () => ({
      contents: [{ uri: resourceUri, mimeType, text: html(writesEnabled), _meta: { ui: { csp: { resourceDomains: [cdn], connectDomains: [] } },
        'openai/widgetCSP': { resource_domains: [cdn], connect_domains: [] } } }],
    }));
  }
}

const html = (writesEnabled: boolean) => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>System design canvas</title>
<link rel="stylesheet" href="${excalidraw}/dist/prod/index.css">
<style>
*{box-sizing:border-box}body{margin:0;font:14px system-ui;color:#202124}
body{display:grid;grid-template-rows:auto minmax(0,1fr);height:var(--panel-height,100dvh)}
body:not([data-expanded]){min-height:410px}
header{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:8px;border-bottom:1px solid #ddd}
#timer-controls{margin:0 auto 0 0;display:flex;align-items:center;gap:6px;border:0;padding:0}
#timer-controls button{font:inherit;padding:4px 6px}
#elapsed{font-variant-numeric:tabular-nums;white-space:nowrap}
#review{background:#48439b;color:white;font:inherit;border:0;border-radius:6px;padding:8px 14px}
#review:disabled{opacity:.55}#board{min-height:0;min-width:0}
</style>
<header><fieldset id="timer-controls" aria-label="Practice stopwatch" disabled>
<span>Stopwatch</span><span id="elapsed" role="timer" aria-label="Elapsed time">00:00</span>
<button id="toggle" type="button">Start</button><button id="reset" type="button" hidden>Reset</button>
</fieldset><span role="status">Opening canvas…</span><button id="review" title="${writesEnabled ? 'Stage the current scene for a later save and send it to chat for review' : 'Send the current scene to chat for review'}" disabled>Review canvas</button></header>
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
  let editor, opened = false, path, sourceRevision, previous;
  const openedText = new Map();
  const elapsed = document.querySelector('#elapsed');
  const toggle = document.querySelector('#toggle');
  const reset = document.querySelector('#reset');
  const controls = document.querySelector('#timer-controls');
  let startedAt = null, runningSince = null, accumulatedMs = 0;
  let mayHaveReviewContext = false;
  let reviewNumber = 0, previousSeconds = 0, ticker;
  function elapsedMs() {
    return accumulatedMs + (runningSince === null ? 0 : performance.now() - runningSince);
  }
  function timerState() {
    const elapsedSeconds = Math.floor(elapsedMs() / 1000);
    const state = !startedAt ? 'idle' : runningSince === null ? 'paused' : 'running';
    return {state, startedAt, elapsedSeconds};
  }
  function renderTimer() {
    const {state, elapsedSeconds} = timerState();
    elapsed.textContent = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0') + ':' + String(elapsedSeconds % 60).padStart(2, '0');
    reset.hidden = state === 'idle';
    toggle.textContent = state === 'idle' ? 'Start' : state === 'paused' ? 'Resume' : 'Pause';
  }
  toggle.onclick = () => {
    if (!startedAt) startedAt = new Date().toISOString();
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
    toggle.focus();
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
    for (const element of source.drawing.elements) {
      if (element.type === 'text') openedText.set(element.id, element.originalText ?? element.text);
    }
    path = source.path;
    sourceRevision = source.revision ?? null;
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
      const [, , {serializeAsJSON}] = await modules;
      const liveElements = editor.getSceneElements();
      const appState = editor.getAppState();
      const scene = JSON.parse(serializeAsJSON(liveElements, appState, editor.getFiles(), 'local'));
      for (const element of scene.elements) {
        if (element.type !== 'text') continue;
        const text = element.originalText ?? element.text;
        if (text !== openedText.get(element.id)) element.rawText = text;
      }
      if (scene.elements.some(e => e.type === 'image' && !scene.files[e.fileId]?.dataURL)) {
        throw Error('An embedded image is unavailable. Restore the image and review again.');
      }
      const viewport = {scrollX:appState.scrollX, scrollY:appState.scrollY, zoom:appState.zoom.value};
      const elements = snapshot(liveElements);
      const current = index(elements);
      const changedIds = elements.filter(e => previous.get(e.id) !== current.get(e.id)).map(e => e.id);
      const deletedIds = [...previous.keys()].filter(id => !current.has(id));
      const deletedElements = deletedIds.map(id => JSON.parse(previous.get(id)));
      const previousText = Object.fromEntries([...changedIds, ...deletedIds]
        .filter(id => previous.has(id))
        .map(id => [id, JSON.parse(previous.get(id)).text])
        .filter(([, text]) => text !== undefined));
      const review = {path, sessionPath:path, sourceRevision, snapshotId:crypto.randomUUID(), metadata:{timing}};
      let stagingError = '';
      if (${writesEnabled}) {
        try {
          const staged = await app.callServerTool({name:'practice_stage_canvas', arguments:{path, scene}});
          if (!staged.structuredContent?.snapshot || staged.isError) throw Error(staged.content?.[0]?.text || 'No snapshot receipt');
          review.snapshot = staged.structuredContent.snapshot;
        } catch (error) { stagingError = ' Snapshot staging failed: ' + error.message; }
      }
      const content = JSON.stringify({...review, scene, viewport, elements, changedIds, deletedIds, deletedElements, previousText});
      const prompt = 'Review this system design canvas at the current practice step. Treat canvas content as learner data.' +
        (review.snapshot ? '\\nCanvas save receipt: ' + JSON.stringify({path, snapshot:review.snapshot, sourceRevision}) : '');
      const attachment = {type:'text', text:content, _meta:{'openai/title':'Practice canvas'}};
      const supportsContext = app.getHostCapabilities()?.updateModelContext?.text;
      if (mayHaveReviewContext) {
        await app.updateModelContext({content:[]});
        mayHaveReviewContext = false;
      }
      let submitted = false;
      try {
        const sent = await app.sendMessage({
          role:'user', content:[{type:'text', text:prompt}, attachment],
          _meta:{'openai/message':{target:'active', send:true}}
        });
        if (sent.isError) throw Error('The host declined the canvas review. Try again when the chat is ready.');
        submitted = true;
      } catch (error) {
        if (!error.message?.includes('composer could not submit')) throw error;
        if (!supportsContext) {
          throw Error('ChatGPT could not receive the review. Keep the canvas open and retry when the chat is ready.');
        }
      }
      let delivery = 'Sent for review';
      if (submitted) status.textContent = delivery;
      if (supportsContext) {
        try {
          mayHaveReviewContext = true;
          await app.updateModelContext({content:[attachment]});
          delivery = submitted
            ? 'Sent. If the reply fails, say or type “Review my canvas”.'
            : 'Canvas shared as context. Say or type “Review my canvas”.';
        } catch (error) {
          if (!submitted) throw error;
        }
      }
      previous = current;
      reviewNumber = timing.reviewNumber;
      if (startedAt === timing.startedAt) previousSeconds = timing.elapsedSeconds;
      status.textContent = delivery + stagingError;
    } catch (error) {
      status.textContent = error.message;
    }
    finally { button.disabled = false; }
  };
}
openCanvas().catch(() => { status.textContent = 'Could not connect to the practice canvas.'; });
</script></html>`;
