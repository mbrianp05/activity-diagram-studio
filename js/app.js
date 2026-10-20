/**
 * Activity Diagram Studio
 * Editor de diagramas de actividades UML: nodos de acción, gateways de
 * decisión, controles de paralelo (fork/join), carriles, validación y
 * simulación del flujo de control.
 */
import {
  createDiagram, createNode, createEdge, sampleDiagram, serialize, deserialize,
  nodeById, edgeById, outEdges, inEdges, NODE_TYPES,
  bounds, laneIndexAt, addNode, addEdge, removeNode, removeEdge, dotMax,
  removeLaneAt, copyGroup, pasteGroup, groupBounds, freeSpot,
} from './model.js';
import { nodeSides } from './routing.js';
import { planAlign, planDistribute } from './align.js';
import { Renderer, LANE_HEADER } from './render.js';
import { Interaction } from './interact.js';
import { validate, summary } from './validate.js';
import { createSim, start as simStart, step as simStep, simView, cloneSim, evaluate } from './simulate.js';
import { download, exportSvg, exportPng } from './io.js';

const STORAGE_KEY = 'activity-diagram-studio/v1';
// La vista (zoom y paneo) se guarda aparte: `serialize()` la excluye a propósito
// para que los archivos exportados no arrastren la cámara del editor.
const VIEW_KEY = 'activity-diagram-studio/view';

/** Herramientas que no son tipos de nodo (para los rótulos de la barra). */
const EXTRA_TOOLS = { connect: 'Conectar', route: 'Recorrido', delete: 'Eliminar' };
/** Rótulos de las bolitas de conexión. */
const SIDE_LABEL = { left: 'Izquierda', right: 'Derecha', top: 'Arriba', bottom: 'Abajo' };

/**
 * Botones de alinear/repartir del inspector: iconos y texto explicativo. Sólo
 * quedan la alineación horizontal y la vertical; los bordes (izquierda/derecha/
 * arriba/abajo) eran un resultado equivocado de iteraciones anteriores.
 */
const ALIGN_BUTTONS = [
  ['centerX', 'Alinear horizontalmente', '<path d="M12 3v18" /><rect x="4" y="6" width="16" height="5" /><rect x="7" y="13" width="10" height="5" />'],
  ['centerY', 'Alinear verticalmente', '<path d="M3 12h18" /><rect x="6" y="4" width="5" height="16" /><rect x="13" y="7" width="5" height="10" />'],
];
const DIST_BUTTONS = [
  ['x', 'Repartir en horizontal (3 nodos o más)', '<path d="M4 3v18" /><path d="M20 3v18" /><rect x="8" y="7" width="3" height="10" /><rect x="13" y="7" width="3" height="10" />'],
  ['y', 'Repartir en vertical (3 nodos o más)', '<path d="M3 4h18" /><path d="M3 20h18" /><rect x="7" y="8" width="10" height="3" /><rect x="7" y="13" width="10" height="3" />'],
];

/** Fila de botones de alineación (`attr` es `data-align` o `data-dist`). */
function alignRow(attr, defs) {
  return `<div class="align-row">${defs.map(([k, title, body]) => `
    <button class="btn icon" ${attr}="${k}" title="${title}" aria-label="${title}"><svg viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${body}</svg></button>`).join('')}</div>`;
}

class App {
  constructor() {
    this.svg = document.getElementById('canvas');
    this.diagram = loadInitial();
    const savedView = loadSavedView();
    if (savedView) this.diagram.view = savedView;
    this.state = { selected: [], errorNodes: new Set(), selectedLane: null };
    this.tool = 'select';
    this.snapToGrid = true;
    this.undoStack = [];
    this.redoStack = [];
    this.sim = null;
    this.simRunning = false;
    this.simTimer = null;
    this.issues = [];
    /** Grupo copiado con Ctrl+C: se pega con Ctrl+V junto al puntero. */
    this.clipboard = null;

    this.renderer = new Renderer(this.svg);
    this.interaction = new Interaction(this);

    this.bindUi();
    this.applyView();
    this.render();
    // Con una vista guardada se respeta el zoom y el paneo de la sesión anterior;
    // sólo se encuadra el diagrama cuando no hay ninguna.
    if (!savedView) this.zoomFit();
    this.toast('Listo. Arrastra herramientas desde la paleta o pulsa una tecla.');
  }

  /* ================================ estado ================================ */

  get selectedNode() {
    return this.state.selected.map((s) => s.id).length === 1 ? this.state.selected[0] : null;
  }

  isSelected(ref) {
    return this.state.selected.some((s) => s.type === ref.type && s.id === ref.id);
  }

  select(ref) { this.setSelection([ref]); }

  toggleSelect(ref) {
    const list = this.isSelected(ref)
      ? this.state.selected.filter((s) => !(s.type === ref.type && s.id === ref.id))
      : [...this.state.selected, ref];
    this.setSelection(list);
  }

  clearSelection() { this.setSelection([]); }

  setSelection(list) {
    this.state.selected = list;
    this.render();
  }

  selectAll() {
    this.setSelection([
      ...this.diagram.nodes.map((n) => ({ type: 'node', id: n.id })),
      ...this.diagram.edges.map((e) => ({ type: 'edge', id: e.id })),
    ]);
  }

  status(msg) {
    const n = this.state.selected.length;
    const el = document.getElementById('status-sel');
    if (!msg) {
      if (!n) el.textContent = 'Sin selección';
      else if (n === 1) {
        const s = this.state.selected[0];
        el.textContent = s.type === 'node'
          ? `${NODE_TYPES[nodeById(this.diagram, s.id).type].label}: ${nodeById(this.diagram, s.id).label}`
          : `Flujo: ${edgeById(this.diagram, s.id).label || 'sin etiqueta'}`;
      } else el.textContent = `${n} elementos seleccionados`;
    } else el.textContent = msg;
  }

  /* =============================== renderizado ============================= */

  render() {
    this.renderer.render(this.diagram, {
      selected: this.state.selected.length === 1 ? this.state.selected[0] : null,
      selectedSet: this.state.selected,
      selectedLane: this.state.selectedLane,
      tokens: this.simRunning ? simView(this.sim).tokens : null,
      activeEdges: this.simRunning ? simView(this.sim).activeEdges : null,
      errorNodes: this.state.errorNodes,
      simulating: this.simRunning,
    });
    this.interaction?.drawResizeHandle();
    this.interaction?.drawRouteHandles();
    this.renderInspector();
    this.renderLaneList();
    this.renderCounts();
    this.status();
    this.persistSoon();
  }

  /** Render ligero durante arrastres. */
  refresh() {
    this.renderer.refresh(this.diagram, {
      selected: this.state.selected.length === 1 ? this.state.selected[0] : null,
      selectedSet: this.state.selected,
      tokens: this.simRunning ? simView(this.sim).tokens : null,
      activeEdges: this.simRunning ? simView(this.sim).activeEdges : null,
      errorNodes: this.state.errorNodes,
      simulating: this.simRunning,
    });
    this.interaction?.drawResizeHandle();
    this.interaction?.drawRouteHandles();
    this.renderCounts();
  }

  commit(label) {
    this.render();
    if (label) this.persist();
  }

  applyView() {
    this.renderer.setView(this.diagram.view);
    document.getElementById('zoom-label').textContent = `${Math.round(this.diagram.view.k * 100)}%`;
    // Zoom y paneo también se recuerdan entre recargas (con el mismo debounce
    // que el resto de la persistencia).
    this.persistSoon();
  }

  renderCounts() {
    const { nodes, edges } = this.diagram;
    document.getElementById('status-count').textContent = `${nodes.length} nodos · ${edges.length} flujos`;
  }

  /* ================================ historial ============================= */

  snapshot() {
    return JSON.stringify({ name: this.diagram.name, lanes: this.diagram.lanes, nodes: this.diagram.nodes, edges: this.diagram.edges });
  }

  pushHistory() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
    this.updateHistoryButtons();
  }

  restore(snap) {
    const d = deserialize(snap);
    d.view = this.diagram.view;
    this.diagram = d;
    this.state.selected = [];
    this.render();
  }

  undo() {
    if (!this.undoStack.length) return this.toast('Nada que deshacer');
    const current = this.snapshot();
    const snap = this.undoStack.pop();
    this.redoStack.push(current);
    this.restore(snap);
    this.updateHistoryButtons();
  }

  redo() {
    if (!this.redoStack.length) return this.toast('Nada que rehacer');
    const current = this.snapshot();
    const snap = this.redoStack.pop();
    this.undoStack.push(current);
    this.restore(snap);
    this.updateHistoryButtons();
  }

  updateHistoryButtons() {
    document.getElementById('btn-undo').disabled = !this.undoStack.length;
    document.getElementById('btn-redo').disabled = !this.redoStack.length;
  }

  /* ============================== operaciones ============================= */

  /**
   * Crea un flujo. `way` son los puntos de giro que ha indicado el usuario y
   * `fromSide`/`toSide` las bolitas por las que sale y entra.
   */
  addConnection(fromId, toId, way = [], fromSide = 'right', toSide = 'left') {
    if (fromId === toId || this.diagram.edges.some((e) => e.from === fromId && e.to === toId)) {
      this.toast('Ese flujo ya existe o es un bucle hacia sí mismo.');
      return;
    }
    // El historial va antes de mutar para que deshacer retire la flecha.
    this.pushHistory();
    const edge = createEdge(fromId, toId, { way, fromSide, toSide });
    addEdge(this.diagram, edge);
    // Tras insertar la flecha se vuelve a selección y queda marcada.
    this.setTool('select');
    this.select({ type: 'edge', id: edge.id });
    this.commit('Conectar');
    this.toast(`Flujo añadido a «${nodeById(this.diagram, toId).label}». Doble clic para etiquetarlo.`);
  }

  deleteSelection(ref) {
    if (ref.type === 'edge') {
      const e = edgeById(this.diagram, ref.id);
      if (!e) return;
      this.pushHistory();
      removeEdge(this.diagram, ref.id);
    } else {
      const n = nodeById(this.diagram, ref.id);
      if (!n) return;
      if (n.type === 'start' && this.diagram.nodes.filter((x) => x.type === 'start').length === 1) {
        this.toast('No se puede borrar el único nodo de inicio.', true);
        return;
      }
      this.pushHistory();
      removeNode(this.diagram, ref.id);
      // Si el nodo borrado es el origen del trazado en curso, la flecha se queda
      // sin punto de partida: se cancela el trazado (y con él su preview). Si era
      // el destino apuntado, se olvida el enganche.
      const route = this.interaction?.route;
      if (route?.from === ref.id) this.interaction.cancelRoute();
      else if (route?.hover?.id === ref.id) {
        route.hover = null;
        this.interaction.clearPortHints();
      }
    }
    this.setSelection([]);
  }

  deleteSelected() {
    for (const s of [...this.state.selected]) this.deleteSelection(s);
  }

  duplicateSelection() {
    const nodes = this.state.selected.filter((s) => s.type === 'node')
      .map((s) => nodeById(this.diagram, s.id)).filter(Boolean);
    if (!nodes.length) return this.toast('Selecciona al menos un nodo para duplicar.');
    this.pushHistory();
    const map = new Map();
    for (const n of nodes) {
      const copy = createNode(n.type, n.x + n.w + 40, n.y + 30, {
        w: n.w, h: n.h, label: n.label, note: n.note,
      });
      copy.lane = n.lane;
      map.set(n.id, copy.id);
      addNode(this.diagram, copy);
    }
    for (const e of [...this.diagram.edges]) {
      if (map.has(e.from) && map.has(e.to)) {
        addEdge(this.diagram, createEdge(map.get(e.from), map.get(e.to), {
          label: e.label, condition: e.condition,
          fromSide: e.fromSide, toSide: e.toSide,
          // Los puntos de giro viajan con el desplazamiento de la copia.
          way: (e.way || []).map((p) => ({ x: p.x + n.w + 40, y: p.y + 30 })),
        }));
      }
    }
    this.setSelection([...map.values()].map((id) => ({ type: 'node', id })));
    this.commit('Duplicar');
  }

  /* ============================== alineación ============================== */

  /** Nodos seleccionados (ids), o una lista vacía si sólo hay flujos. */
  selectedNodeIds() {
    return this.state.selected.filter((s) => s.type === 'node').map((s) => s.id);
  }

  /** Aplica un plan `{id, x, y}` de `align.js` (que no muta por su cuenta). */
  applyPlan(plan) {
    for (const c of plan) {
      const n = nodeById(this.diagram, c.id);
      if (n) { n.x = c.x; n.y = c.y; }
    }
  }

  /**
   * Alinea los nodos seleccionados (`left|centerX|right|top|centerY|bottom`).
   * Con varios se alinean entre sí; con uno sólo se alinea contra el resto del
   * diagrama. Es el remate para lo que ya está colocado y a pelo.
   */
  alignSelection(mode) {
    const ids = this.selectedNodeIds();
    if (!ids.length) return this.toast('Selecciona algún nodo para alinearlo.');
    const plan = planAlign(this.diagram, ids, mode);
    if (!plan.length) return this.toast('Ya están alineados.');
    // El historial va antes de mutar, como en el resto de operaciones.
    this.pushHistory();
    this.applyPlan(plan);
    this.commit('Alinear');
    this.toast(ids.length === 1
      ? `Nodo alineado con el resto del diagrama (${plan.length === 1 ? '1 nodo' : `${plan.length} nodos`}).`
      : `${plan.length} nodo(s) alineados.`);
  }

  /** Reparte los nodos seleccionados en huecos iguales (3 o más). */
  distributeSelection(axis) {
    const ids = this.selectedNodeIds();
    if (ids.length < 3) return this.toast('Selecciona tres nodos o más para repartirlos.');
    const plan = planDistribute(this.diagram, ids, axis);
    if (!plan.length) return this.toast('No caben: los nodos seleccionados se pisan.');
    this.pushHistory();
    this.applyPlan(plan);
    this.commit('Repartir');
    this.toast(`${plan.length} nodo(s) repartidos en ${axis === 'x' ? 'horizontal' : 'vertical'}.`);
  }

  /* ============================== portapapeles ========================== */

  /** Ctrl+C: al portapapeles interno los nodos elegidos y sus flujos. */
  copySelection() {
    const clip = copyGroup(this.diagram, this.state.selected);
    if (!clip.nodes.length) return this.toast('Selecciona algún nodo para copiar (Ctrl+C).');
    this.clipboard = clip;
    this.toast(`${clip.nodes.length} nodo(s) y ${clip.edges.length} flujo(s) copiados. Ctrl+V los pega junto al ratón.`);
  }

  /**
   * Ctrl+V: pega el grupo copiado bajo el puntero (o en el centro visible si el
   * ratón está fuera del lienzo). Si ahí pisa algo, busca el hueco libre más
   * cercano en anillos alrededor del puntero.
   */
  pasteSelection() {
    const clip = this.clipboard;
    if (!clip || !clip.nodes.length) return this.toast('El portapapeles está vacío: copia algo primero (Ctrl+C).');
    const target = this.interaction.pointerWorld() || this.interaction.viewCenter();
    const bbox = groupBounds(clip.nodes);
    const spot = freeSpot(this.diagram.nodes, bbox, target);
    this.pushHistory();
    const { nodes, edges } = pasteGroup(this.diagram, clip, spot.x - bbox.x, spot.y - bbox.y);
    if (!nodes.length) { this.undoStack.pop(); return; }
    this.setSelection(nodes.map((n) => ({ type: 'node', id: n.id })));
    this.commit('Pegar');
    const donde = spot.moved ? ' (apartado para no solaparse)' : '';
    this.toast(`Pegado: ${nodes.length} nodo(s) y ${edges.length} flujo(s)${donde}.`);
  }

  /* ============================== zoom / vista ============================ */

  zoomAt(clientX, clientY, factor) {
    const v = this.diagram.view;
    const r = this.svg.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const wx = (px - v.x) / v.k;
    const wy = (py - v.y) / v.k;
    v.k = Math.max(0.2, Math.min(3, v.k * factor));
    v.x = px - wx * v.k;
    v.y = py - wy * v.k;
    this.applyView();
  }

  zoomFit() {
    const b = bounds(this.diagram);
    const r = this.svg.getBoundingClientRect();
    const v = this.diagram.view;
    const pad = 60;
    const bottom = this.diagram.lanes.length ? Math.max(b.y + b.h, this.diagram.lanes.reduce((s, l) => s + l.height, 0)) : b.y + b.h;
    const k = Math.min(2, Math.max(0.25, Math.min((r.width - pad * 2) / Math.max(200, b.w), (r.height - pad * 2) / Math.max(200, bottom - b.y))));
    v.k = k;
    v.x = (r.width - b.w * k) / 2 - b.x * k;
    v.y = (r.height - (bottom - b.y) * k) / 2 - b.y * k;
    this.applyView();
  }

  /* ================================ carriles ============================== */

  addLane() {
    this.pushHistory();
    const idx = this.diagram.lanes.length;
    // El carril nuevo se añade al final y queda vacío: los nodos no cambian de
    // pertenencia (n.lane es explícito).
    this.diagram.lanes.push({
      id: `l${Date.now().toString(36)}${idx}`,
      name: `Carril ${idx + 1}`,
      height: 200,
    });
    this.commit('Añadir carril');
  }

  async editLaneName(index) {
    const lane = this.diagram.lanes[index];
    if (!lane) return;
    const name = await askText('Renombrar carril', lane.name);
    if (name === null) return;
    this.pushHistory();
    lane.name = name || lane.name;
    this.state.selectedLane = index;
    this.commit('Renombrar carril');
  }

  removeLane(index) {
    if (this.diagram.lanes.length <= 1) return this.toast('Debe quedar al menos un carril.', true);
    this.pushHistory();
    removeLaneAt(this.diagram, index);
    this.commit('Eliminar carril');
  }

  renderLaneList() {
    const ul = document.getElementById('lane-list');
    ul.textContent = '';
    this.diagram.lanes.forEach((lane, i) => {
      const li = document.createElement('li');
      const count = this.diagram.nodes.filter((n) => n.lane === i).length;
      li.innerHTML = `<span class="name" title="Doble clic para renombrar"></span>
        <button class="mini" data-act="del" title="Eliminar" aria-label="Eliminar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg></button>`;
      li.querySelector('.name').textContent = `${lane.name} (${count})`;
      li.querySelector('.name').ondblclick = () => this.editLaneName(i);
      li.querySelector('[data-act=del]').onclick = () => this.removeLane(i);
      ul.appendChild(li);
    });
  }

  /* ============================== inspector =============================== */

  renderInspector() {
    const body = document.getElementById('inspector-body');
    const sel = this.state.selected;
    const scroll = body.scrollTop;

    if (!sel.length) { body.innerHTML = this.inspectorEmpty(); this.wireCommon(body); return; }
    if (sel.length > 1) { body.innerHTML = this.inspectorMulti(sel); this.wireCommon(body); return; }
    body.innerHTML = sel[0].type === 'node' ? this.inspectorNode(sel[0].id) : this.inspectorEdge(sel[0].id);
    body.scrollTop = scroll;
    this.wireCommon(body);
  }

  inspectorEmpty() {
    const d = this.diagram;
    const count = (t) => d.nodes.filter((n) => n.type === t).length;
    return `
      <h2>Diagrama</h2>
      <div class="field"><label>Nombre</label><input type="text" id="f-name" value="${esc(d.name)}" /></div>
      <div class="stat-grid">
        <div><b>${count('activity')}</b><span>Acciones</span></div>
        <div><b>${count('decision')}</b><span>Decisiones</span></div>
        <div><b>${count('fork') + count('join')}</b><span>Fork / Join</span></div>
        <div><b>${d.lanes.length}</b><span>Carriles</span></div>
      </div>`;
  }

  inspectorMulti(sel) {
    const nodos = this.state.selected.filter((s) => s.type === 'node').length;
    return `
      <h2>Selección múltiple</h2>
      <p class="empty">${sel.length} elementos seleccionados.</p>
      <div class="field">
        <label>Asignar carril (nodos)</label>
        <select id="f-lane">
          <option value="">— sin carril —</option>
          ${this.diagram.lanes.map((l, i) => `<option value="${i}">${esc(l.name)}</option>`).join('')}
        </select>
      </div>
      ${nodos ? `
      <div class="field">
        <label>Alinear entre ellos</label>
        ${alignRow('data-align', ALIGN_BUTTONS)}
      </div>
      ${nodos >= 3 ? `
      <div class="field">
        <label>Repartir</label>
        ${alignRow('data-dist', DIST_BUTTONS)}
      </div>` : ''}` : ''}
      <div class="actions">
        <button class="btn" id="b-dup">Duplicar</button>
        <button class="btn danger" id="b-del">Eliminar</button>
      </div>`;
  }

  inspectorNode(id) {
    const n = nodeById(this.diagram, id);
    if (!n) return '';
    const ins = inEdges(this.diagram, id);
    const outs = outEdges(this.diagram, id);
    const typeOptions = Object.entries(NODE_TYPES)
      .map(([k, v]) => `<option value="${k}"${k === n.type ? ' selected' : ''}>${v.label}</option>`).join('');

    const isDot = n.type === 'start' || n.type === 'end' || n.type === 'stop';
    // En el objeto el campo inferior es el estado, que se muestra entre << >>.
    const subLabel = n.type === 'objeto' ? 'Estado' : 'Nota';
    const subPlaceholder = n.type === 'objeto' ? 'entre << >>' : 'opcional';
    return `
      <h2>Nodo</h2>
      <div class="field">
        <label>Tipo</label>
        <select id="f-type">${typeOptions}</select>
      </div>
      ${isDot ? '' : `
      <div class="field">
        <label>Etiqueta</label>
        <input type="text" id="f-label" value="${esc(n.label)}" />
      </div>
      <div class="field">
        <label>${subLabel}</label>
        <input type="text" id="f-note" value="${esc(n.note || '')}" placeholder="${subPlaceholder}" />
      </div>`}
      <div class="field">
        <label>Carril</label>
        <select id="f-lane">
          <option value="">— sin carril —</option>
          ${this.diagram.lanes.map((l, i) => `<option value="${i}"${n.lane === i ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Alinear con el resto</label>
        ${alignRow('data-align', ALIGN_BUTTONS)}
      </div>
      <div class="actions">
        <button class="btn" id="b-dup">Duplicar</button>
        <button class="btn danger" id="b-del">Eliminar</button>
      </div>

      ${(ins.length || outs.length) ? `
      <details class="acc">
        <summary>Conexiones · ${ins.length} entradas · ${outs.length} salidas</summary>
        ${ins.length ? `<ul class="conn-list">${ins.map((e) => this.connItem(e, 'entrada')).join('')}</ul>` : ''}
        ${outs.length ? `<ul class="conn-list">${outs.map((e) => this.connItem(e, 'salida')).join('')}</ul>` : ''}
      </details>` : ''}
      ${this.semanticHint(n, ins, outs)}`;
  }

  semanticHint(n, ins, outs) {
    const bits = [];
    if (n.type === 'fork' && outs.length < 2) bits.push('Un fork necesita al menos 2 salidas para paralelizar.');
    if (n.type === 'join' && ins.length < 2) bits.push('Un join necesita al menos 2 entradas para sincronizar.');
    if (n.type === 'decision' && outs.length > 1) {
      const unlabeled = outs.filter((e) => !e.label && !e.condition).length;
      if (unlabeled) bits.push(`${unlabeled} salida(s) sin etiqueta: escribe un texto (doble clic en la flecha) o una condición.`);
    }
    if (!bits.length) return '';
    return `<p class="hint">${bits.map(esc).join('<br/>')}</p>`;
  }

  connItem(edge, kind) {
    const otherId = kind === 'entrada' ? edge.from : edge.to;
    const other = nodeById(this.diagram, otherId);
    const text = `${edge.label || edge.condition || 'sin etiqueta'}`;
    return `<li>
      <span class="lbl" title="Doble clic para editar">${kind === 'entrada' ? '←' : '→'} ${esc(other ? other.label : '?')} · ${esc(text)}</span>
      <button class="mini" data-eid="${edge.id}" data-kind="${kind}" title="Editar flujo" aria-label="Editar flujo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg></button>
      <button class="mini" data-del="${edge.id}" title="Eliminar flujo" aria-label="Eliminar flujo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
    </li>`;
  }

  inspectorEdge(id) {
    const e = edgeById(this.diagram, id);
    if (!e) return '';
    const from = nodeById(this.diagram, e.from);
    const to = nodeById(this.diagram, e.to);
    const giros = (e.way || []).length;
    const opciones = (sel, lados) => {
      const lista = lados.includes(sel) ? lados : [...lados, sel];
      return lista.map((s) => `<option value="${s}"${s === sel ? ' selected' : ''}>${SIDE_LABEL[s]}</option>`).join('');
    };
    return `
      <h2>Flujo</h2>
      <p class="kv"><b>${esc(from?.label ?? '?')}</b> → <b>${esc(to?.label ?? '?')}</b></p>
      <div class="field">
        <label>Sale por</label>
        <select id="f-side-out">${opciones(e.fromSide, nodeSides(from))}</select>
      </div>
      <div class="field">
        <label>Entra por</label>
        <select id="f-side-in">${opciones(e.toSide, nodeSides(to))}</select>
      </div>
      <div class="field">
        <label>Etiqueta</label>
        <input type="text" id="f-elabel" value="${esc(e.label)}" placeholder="sí, no" />
      </div>
      <div class="chip-row" id="quick-labels">
        ${['sí', 'no', 'quizá', 'loop', 'error'].map((t) => `<span class="chip" data-q="${t}">${t}</span>`).join('')}
      </div>
      <div class="field">
        <label>Condición</label>
        <input type="text" id="f-econd" value="${esc(e.condition)}" placeholder="stock > 0" />
      </div>
      <p class="kv" id="cond-check"></p>
      <div class="field">
        <label>Recorrido</label>
        <p class="kv">${giros
          ? `${giros} punto(s) de giro indicados a mano.`
          : 'Corte en L entre las dos bolitas (puedes añadir giros con el clic derecho al trazar).'}</p>
        <button class="btn" id="b-route">${giros ? 'Editar puntos de giro' : 'Indicar el recorrido'}</button>
      </div>
      <div class="actions">
        <button class="btn" id="b-rev">Invertir sentido</button>
        <button class="btn danger" id="b-del">Eliminar flujo</button>
      </div>`;
  }

  wireCommon(body) {
    const on = (id, ev, fn) => body.querySelector(`#${id}`)?.addEventListener(ev, fn);
    const n = this.state.selected.length === 1 && this.state.selected[0].type === 'node'
      ? nodeById(this.diagram, this.state.selected[0].id) : null;
    const e = this.state.selected.length === 1 && this.state.selected[0].type === 'edge'
      ? edgeById(this.diagram, this.state.selected[0].id) : null;

    if (!this.state.selected.length) {
      const name = body.querySelector('#f-name');
      if (name) name.addEventListener('change', () => {
        this.pushHistory();
        this.diagram.name = name.value || 'Diagrama';
        this.persist();
      });
    }

    if (n) {
      on('f-type', 'change', (ev) => {
        const type = ev.target.value;
        this.pushHistory();
        const t = NODE_TYPES[type];
        n.type = type;
        if (type === 'decision' || type === 'tiempo' || type === 'start' || type === 'end' || type === 'stop') {
          const base = Math.max(t.minW, t.minH, n.w, n.h);
          const s = type === 'start' || type === 'end' || type === 'stop' ? Math.min(dotMax(type), base) : base;
          n.w = s; n.h = s;
        } else {
          n.w = Math.max(t.minW, n.w);
          n.h = Math.max(t.minH, n.h);
        }
        this.commit('Cambiar tipo');
      });
      on('f-label', 'input', (ev) => { n.label = ev.target.value; this.refresh(); this.status(); this.persistSoon(); });
      on('f-note', 'input', (ev) => { n.note = ev.target.value; this.refresh(); this.persistSoon(); });
      on('f-lane', 'change', (ev) => {
        this.pushHistory();
        n.lane = ev.target.value === '' ? null : Number(ev.target.value);
        this.commit('Mover de carril');
      });
      on('b-dup', 'click', () => this.duplicateSelection());
      on('b-del', 'click', () => this.deleteSelection({ type: 'node', id: n.id }));
    }

    if (e) {
      on('f-elabel', 'input', (ev) => { e.label = ev.target.value; this.refresh(); this.status(); this.persistSoon(); });
      on('f-econd', 'input', (ev) => { e.condition = ev.target.value; this.checkCondition(e); this.persistSoon(); });
      on('f-side-out', 'change', (ev) => {
        this.pushHistory();
        e.fromSide = ev.target.value;
        this.commit('Bolita de salida');
      });
      on('f-side-in', 'change', (ev) => {
        this.pushHistory();
        e.toSide = ev.target.value;
        this.commit('Bolita de entrada');
      });
      on('b-route', 'click', () => {
        this.interaction.routeEdge = e.id;
        this.setTool('route');
        this.toast('Clic sobre la flecha para fijar un giro · arrastra los puntos para moverlos · clic derecho sobre un punto para quitarlo.');
      });
      on('b-rev', 'click', () => {
        this.pushHistory();
        [e.from, e.to] = [e.to, e.from];
        [e.fromSide, e.toSide] = [e.toSide, e.fromSide];
        this.commit('Invertir flujo');
      });
      on('b-del', 'click', () => this.deleteSelection({ type: 'edge', id: e.id }));
      body.querySelectorAll('#quick-labels .chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          this.pushHistory();
          e.label = chip.dataset.q;
          this.commit('Etiquetar flujo');
        });
      });
      this.checkCondition(e);
    }

    if (this.state.selected.length > 1) {
      on('b-dup', 'click', () => this.duplicateSelection());
      on('b-del', 'click', () => this.deleteSelected());
      on('f-lane', 'change', (ev) => {
        this.pushHistory();
        const lane = ev.target.value === '' ? null : Number(ev.target.value);
        for (const s of this.state.selected) {
          if (s.type === 'node') nodeById(this.diagram, s.id).lane = lane;
        }
        this.commit('Asignar carril');
      });
    }

    body.querySelectorAll('[data-eid]').forEach((btn) => {
      btn.addEventListener('click', () => this.editEdge(btn.dataset.eid));
    });
    body.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => this.deleteSelection({ type: 'edge', id: btn.dataset.del }));
    });
    body.querySelectorAll('[data-align]').forEach((btn) => {
      btn.addEventListener('click', () => this.alignSelection(btn.dataset.align));
    });
    body.querySelectorAll('[data-dist]').forEach((btn) => {
      btn.addEventListener('click', () => this.distributeSelection(btn.dataset.dist));
    });

    // Enter acepta el texto del campo: los cambios ya se aplican en vivo, sólo
    // hay que cerrar el campo (dispara 'change' en los que lo escuchan).
    body.querySelectorAll('input[type="text"]').forEach((inp) => {
      inp.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        inp.blur();
      });
    });
  }

  closeMenus() {
    document.querySelectorAll('details.menu[open]').forEach((d) => { d.open = false; });
  }

  checkCondition(e) {
    const box = document.getElementById('cond-check');
    if (!box) return;
    if (!e.condition.trim()) { box.textContent = 'Sin condición: la simulación pedirá elegir la rama o usará la única salida.'; return; }
    try {
      const sampleVars = this.sim?.vars || { stock: 3, x: 3, urgente: 0 };
      const val = evaluate(e.condition, sampleVars);
      box.textContent = `Expresión válida. Con las variables actuales = ${val}.`;
    } catch (err) {
      box.textContent = `Expresión inválida: ${err.message}`;
    }
  }

  /* ============================ edición rápida =========================== */

  async editNodeLabel(id) {
    const n = nodeById(this.diagram, id);
    if (!n) return;
    const v = await askText('Etiqueta del nodo', n.label);
    if (v === null) return;
    this.pushHistory();
    n.label = v;
    this.commit('Renombrar');
  }

  async editEdge(id) {
    const e = edgeById(this.diagram, id);
    if (!e) return;
    const v = await askText(`Flujo a «${nodeById(this.diagram, e.to)?.label ?? '?'}» — etiqueta`, e.label);
    if (v === null) return;
    const c = await askText('Condición (ej. stock > 0, déjala vacía para none)', e.condition);
    this.pushHistory();
    e.label = v;
    // Cancelar la segunda ventana no debe tirar la etiqueta: la condición se
    // deja como estaba.
    if (c !== null) e.condition = c;
    this.commit('Editar flujo');
  }

  /** Doble clic en la flecha o su etiqueta: sólo el texto, en un único diálogo. */
  async editEdgeLabel(id) {
    const e = edgeById(this.diagram, id);
    if (!e) return;
    const from = nodeById(this.diagram, e.from);
    const dest = nodeById(this.diagram, e.to)?.label ?? '?';
    const title = from?.type === 'decision'
      ? `Etiqueta de la rama «${from.label}» → «${dest}»`
      : `Etiqueta del flujo a «${dest}»`;
    const v = await askText(title, e.label);
    if (v === null) return;
    this.pushHistory();
    e.label = v;
    this.commit('Etiquetar flujo');
  }

  /* ============================== validación ============================= */

  runValidation() {
    this.issues = validate(this.diagram);
    const s = summary(this.issues);
    const box = document.getElementById('issues');
    const list = document.getElementById('issues-list');
    list.textContent = '';
    this.state.errorNodes = new Set(this.issues.filter((i) => i.level === 'error').map((i) => i.nodeId).filter(Boolean));

    for (const issue of this.issues) {
      const li = document.createElement('li');
      li.className = issue.level;
      li.innerHTML = `<span class="ico">${issue.level === 'error' ? '✕' : issue.level === 'warn' ? '!' : 'i'}</span><span>${esc(issue.msg)}</span>`;
      li.onclick = () => this.focusIssue(issue);
      list.appendChild(li);
    }
    box.hidden = false;
    this.render();
    if (!this.issues.length) this.toast('Sin problemas: el diagrama es consistente.');
    else this.toast(`${s.error} errores · ${s.warn} avisos · ${s.info} notas`);
    return this.issues;
  }

  focusIssue(issue) {
    if (issue.nodeId) {
      this.select({ type: 'node', id: issue.nodeId });
      const n = nodeById(this.diagram, issue.nodeId);
      if (n) {
        const r = this.svg.getBoundingClientRect();
        const v = this.diagram.view;
        v.x = r.width / 2 - (n.x + n.w / 2) * v.k;
        v.y = r.height / 2 - (n.y + n.h / 2) * v.k;
        this.applyView();
      }
    } else if (issue.edgeId) this.select({ type: 'edge', id: issue.edgeId });
  }

  /* ============================= simulación ============================== */

  toggleSim() {
    if (this.simRunning) this.stopSim();
    else this.startSim();
  }

  startSim() {
    const issues = validate(this.diagram).filter((i) => i.level === 'error');
    if (issues.length) {
      this.runValidation();
      this.toast('Corrige los errores antes de simular.', true);
      return;
    }
    this.sim = createSim(this.diagram);
    this.sim.vars = { stock: 3, x: 3, urgente: 0, ...(this.sim.vars || {}) };
    simStart(this.diagram, this.sim);
    this.simRunning = true;
    this.interaction.clearInsertPreview();
    document.getElementById('sim-bar').hidden = false;
    document.getElementById('btn-sim').classList.add('active');
    this.render();
    this.simStatus();
  }

  stopSim() {
    this.simRunning = false;
    this.interaction.clearInsertPreview();
    clearInterval(this.simTimer);
    this.simTimer = null;
    document.getElementById('sim-bar').hidden = true;
    document.getElementById('btn-sim').classList.remove('active');
    this.render();
  }

  simStep(pushHistoryFirst = true) {
    if (!this.simRunning) return;
    if (pushHistoryFirst) this.sim.history.push(cloneSim(this.sim));
    simStep(this.diagram, this.sim, this.sim.chosen || null);
    this.sim.chosen = null;
    this.render();

    if (this.sim.status === 'choice') {
      const node = nodeById(this.diagram, this.sim.pending.node);
      const opts = this.sim.pending.options.map((eid) => {
        const e = edgeById(this.diagram, eid);
        const tag = e.label || e.condition;
        const dest = nodeById(this.diagram, e.to)?.label ?? '?';
        return { id: eid, text: tag ? `${tag} → ${dest}` : dest };
      });
      askChoice(`«${node?.label}»: elige una salida`, opts).then((choice) => {
        if (!choice) return;
        this.sim.chosen = choice;
        this.simStep(false);
      });
      return;
    }
    this.simStatus();
  }

  simRun() {
    clearInterval(this.simTimer);
    this.simTimer = setInterval(() => {
      if (!this.simRunning) { clearInterval(this.simTimer); return; }
      if (this.sim.status === 'choice' || this.sim.finished || this.sim.deadlocked) {
        clearInterval(this.simTimer);
        this.simStatus();
        return;
      }
      this.simStep();
    }, 550);
  }

  simBack() {
    const prev = this.sim.history.pop();
    if (!prev) return this.toast('No hay pasos anteriores.');
    this.sim = prev;
    this.render();
    this.simStatus();
  }

  simReset() {
    this.sim.vars = { ...this.sim.vars };
    simStart(this.diagram, this.sim);
    this.render();
    this.simStatus();
  }

  simStatus() {
    const s = this.sim;
    const out = document.getElementById('sim-status');
    if (!s) return;
    const last = s.log[s.log.length - 1];
    let prefix = 'En curso';
    if (s.finished) prefix = 'Finalizado';
    if (s.deadlocked) prefix = 'Bloqueado';
    if (s.status === 'choice') prefix = 'Decisión';
    out.textContent = `${prefix} · ${last ? last.text : 'listo para empezar'}`;
  }

  /* ============================== persistencia =========================== */

  persist() {
    try {
      localStorage.setItem(STORAGE_KEY, serialize(this.diagram));
      localStorage.setItem(VIEW_KEY, JSON.stringify(this.diagram.view));
    } catch { /* almacenamiento lleno o no disponible */ }
  }

  persistSoon() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.persist(), 400);
  }

  load() {
    const file = document.getElementById('file-input');
    file.value = '';
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const d = deserialize(await f.text());
        this.pushHistory();
        this.diagram = d;
        this.state.selected = [];
        this.undoStack.pop();
        this.commit('Abrir');
        this.zoomFit();
        this.toast(`Diagrama «${d.name}» cargado.`);
      } catch (err) {
        this.toast(`No se pudo abrir: ${err.message}`, true);
      }
    };
    file.click();
  }

  saveFile() {
    download(`${slug(this.diagram.name)}.json`, serialize(this.diagram), 'application/json');
    this.toast('Diagrama exportado a JSON.');
  }

  saveSvg() {
    const text = exportSvg(this.svg, this.diagram);
    download(`${slug(this.diagram.name)}.svg`, text, 'image/svg+xml');
    this.toast('SVG exportado.');
  }

  async savePng() {
    const text = exportSvg(this.svg, this.diagram, { forPng: true });
    const ok = await exportPng(text, `${slug(this.diagram.name)}.png`);
    this.toast(ok ? 'PNG exportado.' : 'El navegador bloqueó la descarga del PNG.', !ok);
  }

  newDiagram() {
    this.pushHistory();
    this.diagram = createDiagram({ name: 'Nuevo diagrama', lanes: [{ id: 'l1', name: 'Actor', height: 320 }] });
    this.state.selected = [];
    this.commit('Nuevo');
    this.zoomFit();
  }

  /* ================================ interfaz ============================= */

  setTool(tool) {
    this.tool = tool;
    this.interaction?.clearInsertPreview();
    // Cambiar de herramienta abandona cualquier trayectoria a medio trazar.
    if (tool !== 'connect') this.interaction?.cancelRoute();
    if (tool !== 'route') this.interaction?.setRouteEdge(null);
    for (const btn of document.querySelectorAll('#tools .tool')) {
      btn.classList.toggle('sel', btn.dataset.tool === tool);
    }
    const label = NODE_TYPES[tool]?.label || EXTRA_TOOLS[tool] || tool;
    this.status(`Herramienta: ${label}`);
    if (this.svg) {
      this.svg.style.cursor = tool === 'select' ? '' : 'crosshair';
      // Las bolitas de conexión se resaltan al conectar o editar recorridos.
      this.svg.classList.toggle('conectando', tool === 'connect' || tool === 'route');
    }
    this.interaction?.drawRouteHandles();
  }

  bindUi() {
    for (const btn of document.querySelectorAll('#tools .tool[data-tool]')) {
      const tool = btn.dataset.tool;
      btn.addEventListener('click', () => this.setTool(tool));
      btn.draggable = true;
      btn.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', tool);
        e.dataTransfer.effectAllowed = 'copy';
      });
    }
    document.getElementById('btn-lane-add').addEventListener('click', () => this.addLane());

    const stage = document.getElementById('stage');
    stage.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      const tool = e.dataTransfer.getData('text/plain');
      if (!NODE_TYPES[tool]) return;
      const w = this.interaction.toWorld(e.clientX, e.clientY);
      this.interaction.placeNode(tool, w);
    });

    document.getElementById('btn-undo').addEventListener('click', () => this.undo());
    document.getElementById('btn-redo').addEventListener('click', () => this.redo());
    document.getElementById('btn-new').addEventListener('click', () => {
      if (confirm('¿Crear un diagrama vacío? Lo actual se perderá (puedes deshacer).')) this.newDiagram();
    });
    document.getElementById('btn-open').addEventListener('click', () => this.load());
    document.getElementById('btn-save').addEventListener('click', () => this.saveFile());
    document.getElementById('btn-svg').addEventListener('click', () => this.saveSvg());
    document.getElementById('btn-png').addEventListener('click', () => this.savePng());

    // Los menús desplegables se cierran al pulsar fuera o al elegir una opción.
    document.addEventListener('pointerdown', (ev) => {
      if (!ev.target.closest('.menu')) this.closeMenus();
    });
    document.querySelectorAll('.menu-item').forEach((b) => b.addEventListener('click', () => this.closeMenus()));
    document.getElementById('btn-validate').addEventListener('click', () => this.runValidation());
    document.getElementById('btn-sim').addEventListener('click', () => this.toggleSim());

    document.getElementById('zoom-in').addEventListener('click', () => this.interaction.zoomBy(1.2));
    document.getElementById('zoom-out').addEventListener('click', () => this.interaction.zoomBy(1 / 1.2));
    document.getElementById('zoom-fit').addEventListener('click', () => this.zoomFit());

    document.getElementById('sim-reset').addEventListener('click', () => this.simReset());
    document.getElementById('sim-back').addEventListener('click', () => this.simBack());
    document.getElementById('sim-step').addEventListener('click', () => this.simStep());
    document.getElementById('sim-run').addEventListener('click', () => this.simRun());
    document.getElementById('sim-exit').addEventListener('click', () => this.stopSim());
    const varName = document.getElementById('sim-var-name');
    const varValue = document.getElementById('sim-var-value');
    const applyVar = () => {
      if (!this.sim) return;
      const v = varValue.value.trim();
      this.sim.vars[varName.value.trim() || 'x'] = v === '' ? 0 : isNaN(Number(v)) ? (v === 'true') : Number(v);
      this.simStatus();
    };
    varName.addEventListener('change', applyVar);
    varValue.addEventListener('change', applyVar);

    document.getElementById('grid-rect').addEventListener('dblclick', () => {
      this.snapToGrid = !this.snapToGrid;
      this.toast(`Ajuste a rejilla: ${this.snapToGrid ? 'activado' : 'desactivado'}`);
    });

    // Los diálogos modales se cierran al pulsar fuera de ellos.
    const dlg = document.getElementById('prompt-dialog');
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close('cancel'); });

    window.addEventListener('beforeunload', (e) => {
      // El debounce de `persistSoon` puede no haber llegado a dispararse: la
      // vista se guarda al salir para no perder el último zoom o paneo.
      this.persist();
      if (this.undoStack.length > 3) { e.preventDefault(); e.returnValue = ''; }
    });
    // `pagehide` cubre la recarga en navegadores que no ejecutan `beforeunload`.
    window.addEventListener('pagehide', () => this.persist());

    this.updateHistoryButtons();
    this.setTool('select');
  }

  toast(msg, isError = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `toast${isError ? ' err' : ''}`;
    t.hidden = false;
    clearTimeout(this._toast);
    this._toast = setTimeout(() => { t.hidden = true; }, 3200);
  }
}

/* ============================== utilidades ============================== */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function slug(s) {
  return String(s || 'diagrama').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'diagrama';
}

function askText(title, value) {
  const dlg = document.getElementById('prompt-dialog');
  document.getElementById('prompt-title').textContent = title;
  const input = document.getElementById('prompt-input');
  input.value = value ?? '';
  dlg.returnValue = '';
  return new Promise((resolve) => {
    // Enter acepta. Sin esto el envío implícito del <form> pulsaría el primer
    // botón, que es «Cancelar».
    const onKey = (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      dlg.close('ok');
    };
    dlg.addEventListener('close', () => {
      input.removeEventListener('keydown', onKey);
      resolve(dlg.returnValue === 'ok' ? input.value : null);
    }, { once: true });
    input.addEventListener('keydown', onKey);
    dlg.showModal();
    // Texto seleccionado de entrada: al abrir el diálogo desde un clic (p. ej.
    // al insertar un nodo) el navegador todavía puede devolverle el foco al
    // lienzo y dejar la caja sin seleccionar, así que se reafirma en el
    // siguiente fotograma y cada vez que la caja recibe el foco.
    const seleccionar = () => {
      input.focus({ preventScroll: true });
      input.select();
    };
    seleccionar();
    requestAnimationFrame(seleccionar);
    input.addEventListener('focus', seleccionar);
  });
}

function askChoice(title, options) {
  return new Promise((resolve) => {
    const pop = document.createElement('div');
    pop.className = 'choice-pop';
    pop.innerHTML = `<strong>${esc(title)}</strong>` +
      options.map((o, i) => `<button class="btn" data-id="${o.id}">${i + 1}. ${esc(o.text)}</button>`).join('') +
      '<button class="btn" data-id="">Cancelar</button>';
    document.body.appendChild(pop);
    // Clic fuera o Escape equivale a cancelar.
    const done = (value) => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', onEsc);
      pop.remove();
      resolve(value);
    };
    const outside = (ev) => {
      if (!pop.contains(ev.target)) { ev.stopPropagation(); done(null); }
    };
    const onEsc = (ev) => { if (ev.key === 'Escape') done(null); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', onEsc);
    pop.querySelectorAll('[data-id]').forEach((b) => {
      b.addEventListener('click', () => done(b.dataset.id || null));
    });
    pop.querySelector('button')?.focus();
  });
}

function loadInitial() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return deserialize(raw);
  } catch { /* ignorar */ }
  return sampleDiagram();
}

/**
 * Vista guardada de la sesión anterior (`{x, y, k}`). Devuelve `null` si no hay
 * nada válido, en cuyo caso el arranque encuadra el diagrama con `zoomFit()`.
 */
function loadSavedView() {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const x = Number(v?.x);
    const y = Number(v?.y);
    const k = Number(v?.k);
    if (![x, y, k].every(Number.isFinite) || k <= 0) return null;
    return { x, y, k: Math.max(0.2, Math.min(3, k)) };
  } catch {
    return null;
  }
}

void [laneIndexAt];

window.app = new App();
