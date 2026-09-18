const $ = (selector) => document.querySelector(selector);

const paintCanvas = $('#paint-canvas');
const figureCanvas = $('#figure-canvas');
const stage = $('#stage');
const paintCtx = paintCanvas.getContext('2d');
const figureCtx = figureCanvas.getContext('2d');
const colors = ['#5b89df', '#ed6c66', '#76b9a2', '#8a82c7', '#d38c55'];

let boards = [];
let activeBoard = -1;
let tool = 'select';
let drawing = false;
let dragging = null;
let dragOffset = { x: 0, y: 0 };
let lastPointer = null;
let isRecording = false;
let recordStartedAt = 0;
let isPlaying = false;
let playStartedAt = 0;
let toastTimer;
let idleFrame;
let playbackFrame;
let lastSampleTime = 0;
let dragSceneIndex = null;
let selectedFigureIds = new Set();
let selectedDrawingIds = new Set();
let boxSelecting = false;
let boxStart = null;
let boxEnd = null;
let activeDrawing = null;
let draggingDrawing = null;
let isExporting = false;

const EXPORT_WIDTH = 1280;
const EXPORT_HEIGHT = 720;
const EXPORT_FPS = 24;

function createScene(name = 'New idea') {
  return {
    id: `scene-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    figures: [],
    drawings: [],
    frames: [],
    duration: 10000
  };
}

function createFigure(index = 0) {
  const width = stage.clientWidth || 800;
  const height = stage.clientHeight || 400;
  return {
    id: `figure-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    x: width * (.33 + (index % 3) * .17),
    y: height * (.59 + (index % 2) * .08),
    color: colors[index % colors.length],
    lineWeight: 4,
    opacity: .98,
    scale: 1 + (index % 2) * .06,
    vx: 0,
    vy: 0,
    tilt: 0,
    swing: Math.random() * Math.PI * 2,
    label: `Actor ${index + 1}`
  };
}

function currentBoard() { return boards[activeBoard] || null; }
function currentScene() {
  const board = currentBoard();
  return board ? board.scenes[board.activeScene] || null : null;
}

function syncCanvasSize() {
  const ratio = window.devicePixelRatio || 1;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (!width || !height) return;
  const changed = paintCanvas.width !== Math.round(width * ratio) || paintCanvas.height !== Math.round(height * ratio);
  if (!changed) return;
  [paintCanvas, figureCanvas].forEach((canvas) => {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.lineCap = 'round';
    context.lineJoin = 'round';
  });
  renderPaint();
  renderFigures();
}

function toStagePoint(event) {
  const rect = stage.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function saveBackground() {}

function clearPaint() {
  paintCtx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
}

function line(ctx, from, to, width, color) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function drawDrawing(ctx, drawing, scaleX = 1, scaleY = 1) {
  if (!drawing.points.length) return;
  const points = drawing.points;
  const scale = (scaleX + scaleY) / 2;
  ctx.save();
  ctx.globalAlpha = drawing.opacity;
  ctx.strokeStyle = drawing.color;
  ctx.fillStyle = drawing.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = drawing.size * scale;
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x * scaleX, points[0].y * scaleY, drawing.size * scale / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(points[0].x * scaleX, points[0].y * scaleY);
    points.slice(1).forEach((point) => ctx.lineTo(point.x * scaleX, point.y * scaleY));
    ctx.stroke();
  }
  ctx.restore();
}

function drawingBounds(drawing) {
  const xs = drawing.points.map((point) => point.x);
  const ys = drawing.points.map((point) => point.y);
  const padding = drawing.size / 2 + 5;
  return {
    left: Math.min(...xs) - padding,
    right: Math.max(...xs) + padding,
    top: Math.min(...ys) - padding,
    bottom: Math.max(...ys) + padding
  };
}

function drawDrawingSelection(ctx, drawing) {
  const bounds = drawingBounds(drawing);
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#4d78c4';
  ctx.fillStyle = 'rgba(91, 137, 223, .06)';
  ctx.fillRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
  ctx.strokeRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
  ctx.restore();
}

function renderPaint() {
  if (!paintCanvas.width) return;
  clearPaint();
  const scene = currentScene();
  if (!scene) return;
  scene.drawings.forEach((drawing) => {
    drawDrawing(paintCtx, drawing);
    if (selectedDrawingIds.has(drawing.id)) drawDrawingSelection(paintCtx, drawing);
  });
}

function pointToSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function hitDrawing(point) {
  const scene = currentScene();
  if (!scene) return null;
  for (let i = scene.drawings.length - 1; i >= 0; i--) {
    const drawing = scene.drawings[i];
    const tolerance = drawing.size / 2 + 7;
    const points = drawing.points;
    const isDot = points.length === 1 && Math.hypot(point.x - points[0].x, point.y - points[0].y) <= tolerance;
    const isStroke = points.slice(1).some((end, pointIndex) => pointToSegmentDistance(point, points[pointIndex], end) <= tolerance);
    if (isDot || isStroke) return drawing;
  }
  return null;
}

function drawFigure(ctx, figure, time, compact = false, forceMotion = false) {
  const s = figure.scale * (compact ? .28 : 1);
  const x = compact ? figure.x * .19 : figure.x;
  const y = compact ? figure.y * .22 : figure.y;
  const isActivelyDragged = !compact && dragging?.id === figure.id;
  const isPlaybackMovement = !compact && (isPlaying || forceMotion) && Math.hypot(figure.vx || 0, figure.vy || 0) > .08;
  const hasMotionPhysics = isActivelyDragged || isPlaybackMovement;
  const motion = hasMotionPhysics ? Math.min(1, Math.hypot(figure.vx || 0, figure.vy || 0) / 12) : 0;
  const sway = hasMotionPhysics ? Math.sin(time / 160 + figure.swing) * (.05 + motion * .16) : 0;
  const tilt = hasMotionPhysics ? Math.max(-.32, Math.min(.32, (figure.tilt || 0) + sway)) : 0;
  const sin = Math.sin(tilt);
  const cos = Math.cos(tilt);
  const rotate = (px, py) => ({ x: x + px * cos - py * sin, y: y + px * sin + py * cos });
  const ink = figure.color;
  const limb = (figure.lineWeight || 4) * (compact ? 1.18 : 1);
  const head = rotate(0, -74 * s);
  const neck = rotate(0, -56 * s);
  const hip = rotate(0, 0);
  const shoulder = rotate(0, -46 * s);
  const armSwing = hasMotionPhysics ? Math.sin(time / 120 + figure.swing) * (7 + motion * 14) * s : 0;
  const legSwing = hasMotionPhysics ? Math.cos(time / 135 + figure.swing) * (7 + motion * 14) * s : 0;
  const leftElbow = rotate(-24 * s - armSwing * .34, -24 * s);
  const rightElbow = rotate(24 * s + armSwing * .34, -23 * s);
  const leftHand = rotate(-34 * s - armSwing, 1 * s);
  const rightHand = rotate(34 * s + armSwing, 1 * s);
  const leftKnee = rotate(-16 * s + legSwing * .3, 29 * s);
  const rightKnee = rotate(16 * s - legSwing * .3, 29 * s);
  const leftFoot = rotate(-23 * s + legSwing, 57 * s);
  const rightFoot = rotate(23 * s - legSwing, 57 * s);
  ctx.save();
  ctx.globalAlpha = figure.opacity ?? .98;
  line(ctx, neck, hip, limb * s, ink);
  line(ctx, shoulder, leftElbow, limb * s, ink); line(ctx, leftElbow, leftHand, limb * s, ink);
  line(ctx, shoulder, rightElbow, limb * s, ink); line(ctx, rightElbow, rightHand, limb * s, ink);
  line(ctx, hip, leftKnee, limb * s, ink); line(ctx, leftKnee, leftFoot, limb * s, ink);
  line(ctx, hip, rightKnee, limb * s, ink); line(ctx, rightKnee, rightFoot, limb * s, ink);
  ctx.beginPath(); ctx.arc(head.x, head.y, 17 * s, 0, Math.PI * 2); ctx.lineWidth = limb * s; ctx.strokeStyle = ink; ctx.stroke();
  ctx.restore();
}

function drawSelectionOutline(ctx, figure) {
  const width = 94 * figure.scale;
  const height = 158 * figure.scale;
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#4d78c4';
  ctx.fillStyle = 'rgba(91, 137, 223, .08)';
  ctx.fillRect(figure.x - width / 2, figure.y - 101 * figure.scale, width, height);
  ctx.strokeRect(figure.x - width / 2, figure.y - 101 * figure.scale, width, height);
  ctx.restore();
}

function drawSelectionBox(ctx) {
  if (!boxSelecting || !boxStart || !boxEnd) return;
  const x = Math.min(boxStart.x, boxEnd.x);
  const y = Math.min(boxStart.y, boxEnd.y);
  const width = Math.abs(boxEnd.x - boxStart.x);
  const height = Math.abs(boxEnd.y - boxStart.y);
  ctx.save();
  ctx.fillStyle = 'rgba(91, 137, 223, .10)';
  ctx.strokeStyle = '#5b89df';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}

function renderFigures(time = performance.now()) {
  if (!figureCanvas.width) return;
  figureCtx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
  const scene = currentScene();
  if (!scene) return;
  scene.figures.forEach((figure) => {
    drawFigure(figureCtx, figure, time);
    if (selectedFigureIds.has(figure.id)) drawSelectionOutline(figureCtx, figure);
  });
  drawSelectionBox(figureCtx);
}

function hitFigure(point) {
  const scene = currentScene();
  if (!scene) return null;
  const figures = scene.figures;
  for (let i = figures.length - 1; i >= 0; i--) {
    const f = figures[i];
    if (Math.hypot(point.x - f.x, point.y - (f.y - 26 * f.scale)) < 55 * f.scale) return f;
  }
  return null;
}

function getPointer(event) {
  return event.touches ? event.touches[0] : event;
}

function activateBoard(index, editName = false) {
  const board = boards[index];
  if (!board) return;
  if (activeBoard !== index) {
    saveBackground();
    activeBoard = index;
    board.activeScene = Math.min(board.activeScene, board.scenes.length - 1);
    selectedFigureIds.clear();
    selectedDrawingIds.clear();
    switchScene(false);
  }
  if (editName) {
    requestAnimationFrame(() => {
      const input = document.querySelector('.board-item.active .board-name');
      input?.focus();
      input?.select();
    });
  }
}

function renderBoardList() {
  const list = $('#board-list');
  list.innerHTML = '';
  if (!boards.length) {
    list.innerHTML = '<p class="empty-board-list">No storyboards yet.<br />Start with a rough idea.</p>';
    return;
  }
  boards.forEach((board, index) => {
    const item = document.createElement('article');
    item.className = `board-item ${index === activeBoard ? 'active' : ''}`;
    const selector = document.createElement('button');
    selector.className = 'board-selector';
    selector.type = 'button';
    selector.setAttribute('aria-label', `Open ${board.name}`);
    selector.innerHTML = `<span class="board-index">${String(index + 1).padStart(2, '0')}</span>`;
    selector.addEventListener('click', () => activateBoard(index));
    const copy = document.createElement('div');
    copy.className = 'board-copy';
    const nameInput = document.createElement('input');
    nameInput.className = 'board-name';
    nameInput.value = board.name;
    nameInput.setAttribute('aria-label', `Rename storyboard ${index + 1}`);
    nameInput.addEventListener('focus', () => activateBoard(index, true));
    nameInput.addEventListener('input', () => {
      board.name = nameInput.value;
      if (index === activeBoard) updateSceneInfo();
    });
    nameInput.addEventListener('blur', () => {
      board.name = nameInput.value.trim() || `Storyboard ${index + 1}`;
      nameInput.value = board.name;
      if (index === activeBoard) updateSceneInfo();
    });
    nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') nameInput.blur(); });
    const count = document.createElement('small');
    count.textContent = `${board.scenes.length} scene${board.scenes.length === 1 ? '' : 's'}`;
    copy.append(nameInput, count);
    item.append(selector, copy);
    list.appendChild(item);
  });
}

function renderTimeline() {
  const timeline = $('#timeline');
  const template = $('#scene-card-template');
  timeline.innerHTML = '';
  const board = currentBoard();
  if (!board) return;
  board.scenes.forEach((scene, index) => {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.index = index;
    card.classList.toggle('active', index === board.activeScene);
    card.querySelector('.thumb-number').textContent = String(index + 1).padStart(2, '0');
    card.querySelector('.scene-card-name').textContent = scene.name;
    const thumb = card.querySelector('canvas');
    drawThumbnail(thumb, scene);
    card.addEventListener('click', (event) => { if (!event.defaultPrevented && !isPlaying) { saveBackground(); currentBoard().activeScene = index; switchScene(false); } });
    card.addEventListener('dragstart', () => { dragSceneIndex = index; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { dragSceneIndex = null; card.classList.remove('dragging'); document.querySelectorAll('.scene-card').forEach((el) => el.classList.remove('drag-over')); });
    card.addEventListener('dragover', (event) => { event.preventDefault(); if (dragSceneIndex !== index) card.classList.add('drag-over'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (event) => { event.preventDefault(); card.classList.remove('drag-over'); moveScene(dragSceneIndex, index); });
    timeline.appendChild(card);
  });
}

function drawThumbnail(canvas, scene) {
  const ratio = window.devicePixelRatio || 1;
  const width = 145, height = 87;
  canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const scaleX = width / (stage.clientWidth || 800);
  const scaleY = height / (stage.clientHeight || 400);
  scene.drawings.forEach((drawing) => drawDrawing(ctx, drawing, scaleX, scaleY));
  scene.figures.forEach((figure) => drawFigure(ctx, figure, 220, true));
}

function updateSceneInfo() {
  const board = currentBoard();
  const scene = currentScene();
  const hasScene = Boolean(board && scene);
  const sceneControlIds = ['add-figure', 'duplicate-figure', 'delete-selected', 'record-button', 'play-button', 'select-tool', 'pencil-tool', 'eraser-tool', 'add-scene', 'delete-scene', 'color-picker', 'brush-size', 'draw-opacity'];
  sceneControlIds.forEach((id) => { $(`#${id}`).disabled = !hasScene || isExporting; });
  $('#export-video').disabled = !hasScene || isExporting;
  if (!hasScene) {
    $('#board-label').textContent = 'YOUR FIRST IDEA';
    $('#scene-title').textContent = 'Start a storyboard';
    $('#stage-status').textContent = 'No storyboard yet';
    $('#scene-count').textContent = '0';
    $('#scene-plural').textContent = 's';
    $('#stage-empty').classList.remove('hidden');
    $('#stage-empty p').innerHTML = 'Create a storyboard<br />to begin blocking.';
    $('#stage-hint').textContent = 'Use “New storyboard” when an idea lands';
    $('#delete-scene').style.opacity = '.35';
    return;
  }
  $('#board-label').textContent = `STORYBOARD ${String(activeBoard + 1).padStart(2, '0')}`;
  $('#scene-title').textContent = board.name;
  $('#stage-status').textContent = `Scene ${board.activeScene + 1} · ${scene.name}`;
  $('#scene-count').textContent = board.scenes.length;
  $('#scene-plural').textContent = board.scenes.length === 1 ? '' : 's';
  const totalDuration = board.scenes.reduce((sum, item) => sum + item.duration, 0);
  document.querySelector('.scene-meta').lastChild.textContent = ` · about ${Math.max(1, Math.round(totalDuration / 1000))} sec`;
  $('#stage-empty').classList.toggle('hidden', scene.figures.length > 0);
  $('#stage-empty p').innerHTML = 'Drop a character in<br />to start blocking.';
  $('#delete-scene').disabled = board.scenes.length === 1;
  $('#delete-scene').style.opacity = board.scenes.length === 1 ? '.35' : '1';
  $('#delete-selected').disabled = selectedFigureIds.size + selectedDrawingIds.size === 0;
}

function switchScene(resave = true) {
  if (resave) saveBackground();
  stopPlayback();
  selectedFigureIds.clear();
  selectedDrawingIds.clear();
  boxSelecting = false;
  boxStart = null;
  boxEnd = null;
  activeDrawing = null;
  draggingDrawing = null;
  stage.classList.remove('is-dragging', 'is-box-selecting');
  updateSceneInfo(); renderBoardList(); renderTimeline(); renderPaint(); renderFigures();
}

function addFigure() {
  const scene = currentScene();
  if (!scene) return;
  const figure = createFigure(scene.figures.length);
  scene.figures.push(figure);
  selectedFigureIds = new Set([figure.id]);
  selectedDrawingIds.clear();
  updateSceneInfo(); renderPaint(); renderFigures(); renderTimeline();
  showToast('A new stickfigure joined the scene. Drag them around!');
}

function deleteSelectedItems() {
  const scene = currentScene();
  const amount = selectedFigureIds.size + selectedDrawingIds.size;
  if (!scene || !amount) return;
  scene.figures = scene.figures.filter((figure) => !selectedFigureIds.has(figure.id));
  scene.drawings = scene.drawings.filter((drawing) => !selectedDrawingIds.has(drawing.id));
  selectedFigureIds.clear();
  selectedDrawingIds.clear();
  updateSceneInfo();
  renderPaint();
  renderFigures();
  renderTimeline();
  showToast(`${amount} selected item${amount === 1 ? '' : 's'} deleted.`);
}

function moveScene(from, to) {
  if (from === null || from === to || from === undefined) return;
  saveBackground();
  const board = currentBoard();
  if (!board) return;
  const [moved] = board.scenes.splice(from, 1);
  board.scenes.splice(to, 0, moved);
  if (board.activeScene === from) board.activeScene = to;
  else if (from < board.activeScene && to >= board.activeScene) board.activeScene--;
  else if (from > board.activeScene && to <= board.activeScene) board.activeScene++;
  renderTimeline(); updateSceneInfo();
  showToast('Scene moved in the sequence.');
}

function addScene() {
  saveBackground();
  const board = currentBoard();
  if (!board) return;
  const scene = createScene(`Scene idea ${board.scenes.length + 1}`);
  board.scenes.splice(board.activeScene + 1, 0, scene);
  board.activeScene++;
  switchScene(false);
  showToast('Fresh blank scene added.');
}

function deleteScene() {
  const board = currentBoard();
  if (!board) return;
  if (board.scenes.length <= 1) { showToast('Every storyboard needs at least one scene.'); return; }
  saveBackground();
  board.scenes.splice(board.activeScene, 1);
  board.activeScene = Math.max(0, board.activeScene - 1);
  switchScene(false);
  showToast('Scene deleted.');
}

function setTool(nextTool) {
  tool = nextTool;
  stage.classList.toggle('is-drawing', tool === 'pencil' || tool === 'eraser');
  $('#select-tool').classList.toggle('active', tool === 'select');
  $('#pencil-tool').classList.toggle('active', tool === 'pencil');
  $('#eraser-tool').classList.toggle('active', tool === 'eraser');
  $('#stage-hint').textContent = tool === 'select'
    ? 'Click an item, or drag empty space to box-select'
    : tool === 'pencil'
      ? 'Sketch right onto the background'
      : 'Rub out parts of your sketch';
  $('#stage-hint').classList.remove('faded');
}

function selectedDrawings() {
  const scene = currentScene();
  return scene ? scene.drawings.filter((drawing) => selectedDrawingIds.has(drawing.id)) : [];
}

function selectedFigures() {
  const scene = currentScene();
  return scene ? scene.figures.filter((figure) => selectedFigureIds.has(figure.id)) : [];
}

function syncStyleControls() {
  const figure = selectedFigures()[0];
  const drawing = selectedDrawings()[0];
  const item = figure || drawing;
  if (!item) return;
  $('#color-picker').value = item.color;
  $('#brush-size').value = figure ? figure.lineWeight : drawing.size;
  $('#draw-opacity').value = item.opacity;
}

function applySelectedAppearance() {
  const drawings = selectedDrawings();
  const figures = selectedFigures();
  if (!drawings.length && !figures.length) return;
  const color = $('#color-picker').value;
  const size = Number($('#brush-size').value);
  const opacity = Number($('#draw-opacity').value);
  drawings.forEach((drawing) => Object.assign(drawing, { color, size, opacity }));
  figures.forEach((figure) => Object.assign(figure, { color, lineWeight: size, opacity }));
  renderPaint();
  renderFigures();
  renderTimeline();
}

function eraseDrawingAt(point) {
  const scene = currentScene();
  const target = hitDrawing(point);
  if (!scene || !target) return;
  scene.drawings = scene.drawings.filter((drawing) => drawing.id !== target.id);
  selectedDrawingIds.delete(target.id);
  updateSceneInfo();
  renderPaint();
}

function paintStart(event) {
  if (!currentScene() || (tool !== 'pencil' && tool !== 'eraser')) return;
  event.preventDefault();
  drawing = true;
  const point = toStagePoint(getPointer(event));
  lastPointer = point;
  if (tool === 'eraser') {
    eraseDrawingAt(point);
    return;
  }
  activeDrawing = {
    id: `drawing-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    color: $('#color-picker').value,
    size: Number($('#brush-size').value),
    opacity: Number($('#draw-opacity').value),
    points: [point]
  };
  currentScene().drawings.push(activeDrawing);
  selectedDrawingIds = new Set([activeDrawing.id]);
  selectedFigureIds.clear();
  updateSceneInfo();
  renderPaint();
  renderFigures();
}
function paintMove(event) {
  if (!drawing || (tool !== 'pencil' && tool !== 'eraser')) return;
  event.preventDefault();
  const point = toStagePoint(getPointer(event));
  if (tool === 'eraser') {
    eraseDrawingAt(point);
  } else if (activeDrawing) {
    activeDrawing.points.push(point);
    renderPaint();
  }
  lastPointer = point;
}
function paintEnd() {
  if (!drawing) return;
  drawing = false;
  activeDrawing = null;
  renderPaint();
  renderTimeline();
  $('#stage-hint').classList.add('faded');
}

function figureStart(event) {
  const scene = currentScene();
  if (isPlaying || !scene || tool !== 'select') return;
  const point = toStagePoint(event);
  const hit = hitFigure(point);
  if (hit) {
    selectedFigureIds = new Set([hit.id]);
    selectedDrawingIds.clear();
    updateSceneInfo();
    syncStyleControls();
    renderPaint();
    dragging = hit;
    dragOffset = { x: point.x - hit.x, y: point.y - hit.y };
    lastPointer = { ...point, t: performance.now() };
    stage.classList.add('is-dragging');
    figureCanvas.setPointerCapture?.(event.pointerId);
    return;
  }
  const drawnItem = hitDrawing(point);
  if (drawnItem) {
    selectedFigureIds.clear();
    selectedDrawingIds = new Set([drawnItem.id]);
    updateSceneInfo();
    syncStyleControls();
    renderPaint();
    renderFigures();
    draggingDrawing = drawnItem;
    lastPointer = point;
    stage.classList.add('is-dragging');
    figureCanvas.setPointerCapture?.(event.pointerId);
    return;
  }
  boxSelecting = true;
  boxStart = point;
  boxEnd = point;
  selectedFigureIds.clear();
  selectedDrawingIds.clear();
  stage.classList.add('is-box-selecting');
  updateSceneInfo();
  figureCanvas.setPointerCapture?.(event.pointerId);
  renderPaint();
  renderFigures();
}
function figureMove(event) {
  if (boxSelecting) {
    boxEnd = toStagePoint(event);
    renderFigures();
    return;
  }
  if (draggingDrawing) {
    const point = toStagePoint(event);
    const dx = point.x - lastPointer.x;
    const dy = point.y - lastPointer.y;
    draggingDrawing.points.forEach((strokePoint) => {
      strokePoint.x += dx;
      strokePoint.y += dy;
    });
    lastPointer = point;
    $('#stage-hint').classList.add('faded');
    renderPaint();
    return;
  }
  if (!dragging) return;
  const point = toStagePoint(event);
  const now = performance.now();
  const elapsed = Math.max(1, now - lastPointer.t);
  dragging.vx = (point.x - lastPointer.x) / elapsed * 16;
  dragging.vy = (point.y - lastPointer.y) / elapsed * 16;
  dragging.tilt = Math.max(-.26, Math.min(.26, dragging.vx * .026));
  dragging.x = Math.max(42, Math.min(stage.clientWidth - 42, point.x - dragOffset.x));
  dragging.y = Math.max(87, Math.min(stage.clientHeight - 62, point.y - dragOffset.y));
  lastPointer = { ...point, t: now };
  $('#stage-hint').classList.add('faded');
  renderFigures(now);
  if (isRecording) captureFrame();
}
function figureEnd(event) {
  if (boxSelecting) {
    const scene = currentScene();
    boxEnd = toStagePoint(event);
    const left = Math.min(boxStart.x, boxEnd.x);
    const right = Math.max(boxStart.x, boxEnd.x);
    const top = Math.min(boxStart.y, boxEnd.y);
    const bottom = Math.max(boxStart.y, boxEnd.y);
    selectedFigureIds = new Set(scene.figures
      .filter((figure) => figure.x + 48 * figure.scale >= left && figure.x - 48 * figure.scale <= right && figure.y + 62 * figure.scale >= top && figure.y - 102 * figure.scale <= bottom)
      .map((figure) => figure.id));
    selectedDrawingIds = new Set(scene.drawings
      .filter((drawing) => {
        const bounds = drawingBounds(drawing);
        return bounds.right >= left && bounds.left <= right && bounds.bottom >= top && bounds.top <= bottom;
      })
      .map((drawing) => drawing.id));
    boxSelecting = false;
    boxStart = null;
    boxEnd = null;
    stage.classList.remove('is-box-selecting');
    figureCanvas.releasePointerCapture?.(event.pointerId);
    updateSceneInfo();
    syncStyleControls();
    renderPaint();
    renderFigures();
    $('#stage-hint').classList.add('faded');
    return;
  }
  if (draggingDrawing) {
    draggingDrawing = null;
    stage.classList.remove('is-dragging');
    figureCanvas.releasePointerCapture?.(event.pointerId);
    renderPaint();
    renderTimeline();
    return;
  }
  if (!dragging) return;
  dragging.vx = 0;
  dragging.vy = 0;
  dragging.tilt = 0;
  if (isRecording) captureFrame(true);
  dragging = null; stage.classList.remove('is-dragging');
  figureCanvas.releasePointerCapture?.(event.pointerId);
  renderFigures();
  renderTimeline();
}

function captureFrame(force = false) {
  if (!isRecording) return;
  const now = performance.now();
  if (!force && now - lastSampleTime < 80) return;
  const scene = currentScene();
  if (!scene) return;
  scene.frames.push({
    t: Math.min(10000, Math.round(now - recordStartedAt)),
    figures: scene.figures.map((f) => ({ id: f.id, x: f.x, y: f.y, vx: f.vx, vy: f.vy, tilt: f.tilt }))
  });
  lastSampleTime = now;
  $('#duration-label').textContent = formatTime(now - recordStartedAt);
}
function toggleRecording() {
  if (isPlaying) stopPlayback();
  const scene = currentScene();
  if (!scene) return;
  if (!isRecording) {
    isRecording = true; recordStartedAt = performance.now(); lastSampleTime = 0; scene.frames = [];
    captureFrame(true); $('#record-button').classList.add('recording'); $('#record-label').textContent = 'Stop recording';
    $('#stage-status').textContent = `Scene ${currentBoard().activeScene + 1} · Recording movement…`;
    showToast('Recording! Drag a stickfigure to puppeteer it.');
  } else {
    captureFrame(true); isRecording = false;
    scene.duration = Math.max(2500, Math.min(10000, performance.now() - recordStartedAt));
    $('#record-button').classList.remove('recording'); $('#record-label').textContent = 'Record movement';
    updateSceneInfo(); renderTimeline(); $('#duration-label').textContent = '00:00';
    showToast(scene.frames.length > 1 ? 'Movement saved. Press Play scene to review it.' : 'A tiny take was saved — try recording a longer move.');
  }
}
function formatTime(ms) { const seconds = Math.max(0, Math.floor(ms / 1000)); return `00:${String(seconds).padStart(2, '0')}`; }
function interpolatePlayback(elapsed) {
  const scene = currentScene();
  if (!scene) return;
  const frames = scene.frames;
  if (!frames.length) return;
  let after = frames.find((frame) => frame.t >= elapsed) || frames[frames.length - 1];
  let before = frames[Math.max(0, frames.indexOf(after) - 1)] || after;
  const span = Math.max(1, after.t - before.t);
  const progress = Math.max(0, Math.min(1, (elapsed - before.t) / span));
  scene.figures.forEach((figure) => {
    const a = before.figures.find((f) => f.id === figure.id) || after.figures.find((f) => f.id === figure.id);
    const b = after.figures.find((f) => f.id === figure.id) || a;
    if (!a || !b) return;
    ['x', 'y', 'vx', 'vy', 'tilt'].forEach((key) => { figure[key] = a[key] + (b[key] - a[key]) * progress; });
  });
}
function playbackTick(now) {
  if (!isPlaying) return;
  const scene = currentScene();
  const elapsed = now - playStartedAt;
  interpolatePlayback(elapsed);
  renderFigures(now);
  $('#duration-label').textContent = formatTime(elapsed);
  if (elapsed >= scene.duration) { stopPlayback(); return; }
  playbackFrame = requestAnimationFrame(playbackTick);
}
function togglePlayback() {
  if (isRecording) toggleRecording();
  const scene = currentScene();
  if (!scene) return;
  if (!scene.frames.length) { showToast('Record a little movement first, then your scene can play back.'); return; }
  if (isPlaying) { stopPlayback(); return; }
  selectedFigureIds.clear();
  selectedDrawingIds.clear();
  boxSelecting = false;
  boxStart = null;
  boxEnd = null;
  draggingDrawing = null;
  stage.classList.remove('is-box-selecting');
  isPlaying = true; playStartedAt = performance.now();
  renderPaint();
  renderFigures(playStartedAt);
  $('#play-button').classList.add('playing'); $('#play-icon').textContent = '■'; $('#play-label').textContent = 'Stop scene';
  $('#stage-status').textContent = `Scene ${currentBoard().activeScene + 1} · Playing back`; playbackTick(playStartedAt);
}
function stopPlayback() {
  if (!isPlaying) return;
  isPlaying = false; cancelAnimationFrame(playbackFrame);
  $('#play-button').classList.remove('playing'); $('#play-icon').textContent = '▶'; $('#play-label').textContent = 'Play scene';
  $('#duration-label').textContent = '00:00'; updateSceneInfo(); renderPaint(); renderFigures();
}
function animateIdle(now) {
  if (isRecording) captureFrame();
  idleFrame = requestAnimationFrame(animateIdle);
}
function showToast(message) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

function figuresAtTime(scene, elapsed) {
  const figures = scene.figures.map((figure) => ({ ...figure }));
  if (!scene.frames.length) return figures;
  const afterIndex = scene.frames.findIndex((frame) => frame.t >= elapsed);
  const after = afterIndex === -1 ? scene.frames[scene.frames.length - 1] : scene.frames[afterIndex];
  const before = scene.frames[Math.max(0, (afterIndex === -1 ? scene.frames.length - 1 : afterIndex) - 1)] || after;
  const span = Math.max(1, after.t - before.t);
  const progress = Math.max(0, Math.min(1, (elapsed - before.t) / span));
  figures.forEach((figure) => {
    const start = before.figures.find((item) => item.id === figure.id) || after.figures.find((item) => item.id === figure.id);
    const end = after.figures.find((item) => item.id === figure.id) || start;
    if (!start || !end) return;
    ['x', 'y', 'vx', 'vy', 'tilt'].forEach((key) => {
      figure[key] = start[key] + (end[key] - start[key]) * progress;
    });
  });
  return figures;
}

function renderExportFrame(ctx, scene, elapsed) {
  const sourceWidth = stage.clientWidth || 960;
  const sourceHeight = stage.clientHeight || 540;
  const scale = Math.min(EXPORT_WIDTH / sourceWidth, EXPORT_HEIGHT / sourceHeight);
  const renderWidth = sourceWidth * scale;
  const renderHeight = sourceHeight * scale;
  const offsetX = (EXPORT_WIDTH - renderWidth) / 2;
  const offsetY = (EXPORT_HEIGHT - renderHeight) / 2;

  ctx.clearRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
  ctx.fillStyle = '#fbfaf5';
  ctx.fillRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
  ctx.save();
  ctx.beginPath();
  ctx.rect(offsetX, offsetY, renderWidth, renderHeight);
  ctx.clip();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.strokeStyle = 'rgba(223,218,205,.28)';
  ctx.lineWidth = 1 / scale;
  for (let x = 0; x <= sourceWidth; x += 24) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, sourceHeight); ctx.stroke();
  }
  for (let y = 0; y <= sourceHeight; y += 24) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(sourceWidth, y); ctx.stroke();
  }
  scene.drawings.forEach((drawing) => drawDrawing(ctx, drawing));
  figuresAtTime(scene, elapsed).forEach((figure) => drawFigure(ctx, figure, elapsed, false, true));
  ctx.restore();
}

function setExportProgress(progress) {
  const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
  $('#export-label').textContent = percent ? `Rendering ${percent}%` : 'Preparing…';
}

function safeVideoFilename(name) {
  const safeName = name.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'storyboard';
  return `${safeName}.mp4`;
}

function downloadVideo(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeVideoFilename(name);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function findAvcConfig() {
  const base = {
    width: EXPORT_WIDTH,
    height: EXPORT_HEIGHT,
    bitrate: 3500000,
    framerate: EXPORT_FPS,
    latencyMode: 'quality'
  };
  for (const codec of ['avc1.42001f', 'avc1.4d001f']) {
    const config = { ...base, codec };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return support.config;
    } catch (error) {
      // Try the next broadly compatible H.264 profile.
    }
  }
  return null;
}

async function renderWithWebCodecs(canvas, ctx, board) {
  if (!window.VideoEncoder || !window.VideoFrame || !window.Mp4Muxer) return null;
  const encoderConfig = await findAvcConfig();
  if (!encoderConfig) return null;

  const target = new Mp4Muxer.ArrayBufferTarget();
  const muxer = new Mp4Muxer.Muxer({
    target,
    video: { codec: 'avc', width: EXPORT_WIDTH, height: EXPORT_HEIGHT, frameRate: EXPORT_FPS },
    fastStart: 'in-memory'
  });
  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: (error) => { encoderError = error; }
  });
  encoder.configure(encoderConfig);

  const sceneFrameCounts = board.scenes.map((scene) => Math.max(1, Math.ceil(scene.duration / 1000 * EXPORT_FPS)));
  const totalFrames = sceneFrameCounts.reduce((sum, count) => sum + count, 0);
  const frameDuration = Math.round(1000000 / EXPORT_FPS);
  let encodedFrames = 0;

  for (let sceneIndex = 0; sceneIndex < board.scenes.length; sceneIndex++) {
    const scene = board.scenes[sceneIndex];
    const sceneFrames = sceneFrameCounts[sceneIndex];
    for (let frameIndex = 0; frameIndex < sceneFrames; frameIndex++) {
      const elapsed = Math.min(scene.duration - 1, frameIndex / EXPORT_FPS * 1000);
      renderExportFrame(ctx, scene, Math.max(0, elapsed));
      const videoFrame = new VideoFrame(canvas, {
        timestamp: encodedFrames * frameDuration,
        duration: frameDuration
      });
      encoder.encode(videoFrame, { keyFrame: encodedFrames % (EXPORT_FPS * 4) === 0 });
      videoFrame.close();
      encodedFrames++;
      if (encoder.encodeQueueSize > 12) await new Promise((resolve) => setTimeout(resolve, 0));
      if (encodedFrames % 8 === 0 || encodedFrames === totalFrames) {
        setExportProgress(encodedFrames / totalFrames);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (encoderError) throw encoderError;
    }
  }

  await encoder.flush();
  encoder.close();
  if (encoderError) throw encoderError;
  muxer.finalize();
  return new Blob([target.buffer], { type: 'video/mp4' });
}

async function renderWithMediaRecorder(canvas, ctx, board) {
  if (!canvas.captureStream || !window.MediaRecorder) return null;
  const mimeType = ['video/mp4;codecs=avc1.42E01E', 'video/mp4']
    .find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) return null;

  const stream = canvas.captureStream(EXPORT_FPS);
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3500000 });
  recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
  const stopped = new Promise((resolve, reject) => {
    recorder.addEventListener('stop', resolve, { once: true });
    recorder.addEventListener('error', () => reject(recorder.error || new Error('Video recording failed.')), { once: true });
  });
  const totalDuration = board.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  let renderedDuration = 0;
  recorder.start(1000);
  for (const scene of board.scenes) {
    const sceneFrames = Math.max(1, Math.ceil(scene.duration / 1000 * EXPORT_FPS));
    for (let frameIndex = 0; frameIndex < sceneFrames; frameIndex++) {
      const elapsed = Math.min(scene.duration - 1, frameIndex / EXPORT_FPS * 1000);
      renderExportFrame(ctx, scene, Math.max(0, elapsed));
      renderedDuration += 1000 / EXPORT_FPS;
      setExportProgress(renderedDuration / totalDuration);
      await new Promise((resolve) => setTimeout(resolve, 1000 / EXPORT_FPS));
    }
  }
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  return new Blob(chunks, { type: mimeType });
}

async function exportVideo() {
  const board = currentBoard();
  if (!board || !board.scenes.length || isExporting) return;
  if (isRecording) toggleRecording();
  if (isPlaying) stopPlayback();

  isExporting = true;
  $('#export-video').disabled = true;
  $('#export-video').classList.add('exporting');
  $('#export-video').setAttribute('aria-busy', 'true');
  setExportProgress(0);
  updateSceneInfo();
  await nextPaint();

  const canvas = document.createElement('canvas');
  canvas.width = EXPORT_WIDTH;
  canvas.height = EXPORT_HEIGHT;
  const ctx = canvas.getContext('2d', { alpha: false });

  try {
    let video = await renderWithWebCodecs(canvas, ctx, board);
    if (!video) video = await renderWithMediaRecorder(canvas, ctx, board);
    if (!video || !video.size) throw new Error('This browser cannot create MP4 video files.');
    downloadVideo(video, board.name);
    showToast('Video exported — ready to share anywhere.');
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Video export could not be finished.');
  } finally {
    isExporting = false;
    $('#export-video').classList.remove('exporting');
    $('#export-video').removeAttribute('aria-busy');
    $('#export-label').textContent = 'Export video';
    updateSceneInfo();
  }
}

function newBoard() {
  const newName = `Storyboard ${boards.length + 1}`;
  boards.push({ id: `board-${Date.now()}`, name: newName, scenes: [createScene('First scene')], activeScene: 0 });
  activeBoard = boards.length - 1; switchScene(false); showToast('A new blank storyboard is ready.');
}

$('#add-figure').addEventListener('click', addFigure);
$('#duplicate-figure').addEventListener('click', () => {
  const scene = currentScene();
  if (!scene) return;
  const figures = scene.figures;
  if (!figures.length) { addFigure(); return; }
  const copy = { ...figures[figures.length - 1], id: `figure-${Date.now()}`, x: figures[figures.length - 1].x + 45, y: figures[figures.length - 1].y + 8, color: colors[figures.length % colors.length], label: `Actor ${figures.length + 1}` };
  scene.figures.push(copy); selectedFigureIds = new Set([copy.id]); selectedDrawingIds.clear(); updateSceneInfo(); renderPaint(); renderFigures(); renderTimeline(); showToast('Character duplicated.');
});
$('#delete-selected').addEventListener('click', deleteSelectedItems);
$('#record-button').addEventListener('click', toggleRecording);
$('#play-button').addEventListener('click', togglePlayback);
$('#select-tool').addEventListener('click', () => setTool('select'));
$('#pencil-tool').addEventListener('click', () => setTool('pencil'));
$('#eraser-tool').addEventListener('click', () => setTool('eraser'));
['color-picker', 'brush-size', 'draw-opacity'].forEach((id) => $(`#${id}`).addEventListener('input', applySelectedAppearance));
$('#add-scene').addEventListener('click', addScene);
$('#delete-scene').addEventListener('click', deleteScene);
$('#new-board').addEventListener('click', newBoard);
$('#new-board-bottom').addEventListener('click', newBoard);
$('#share-button').addEventListener('click', () => showToast('Share link copied — invite the club!'));
$('#export-video').addEventListener('click', exportVideo);
paintCanvas.addEventListener('pointerdown', paintStart); paintCanvas.addEventListener('pointermove', paintMove); paintCanvas.addEventListener('pointerup', paintEnd); paintCanvas.addEventListener('pointerleave', paintEnd);
figureCanvas.addEventListener('pointerdown', figureStart); figureCanvas.addEventListener('pointermove', figureMove); figureCanvas.addEventListener('pointerup', figureEnd); figureCanvas.addEventListener('pointercancel', figureEnd);
window.addEventListener('keydown', (event) => {
  const editingText = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (!editingText && (event.key === 'Delete' || event.key === 'Backspace') && (selectedFigureIds.size || selectedDrawingIds.size)) {
    event.preventDefault();
    deleteSelectedItems();
  }
});
window.addEventListener('resize', syncCanvasSize);

syncCanvasSize();
setTool('select');
updateSceneInfo();
renderBoardList();
renderTimeline();
renderPaint();
renderFigures();
requestAnimationFrame(animateIdle);
