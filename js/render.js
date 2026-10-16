/**
 * Render del diagrama en SVG. Reconstruye las capas de carriles, flujos y nodos
 * y expone un render "suave" para el arrastre (actualiza sólo atributos).
 */
import {
  edgePath, edgeGeometry, anchors, anchorFor, pickSides, SIDES, END_RING_GAP, labelSpot,
} from './routing.js';
import { laneTop, NODE_TYPES, nodeById } from './model.js';

const NS = 'http://www.w3.org/2000/svg';
export const LANE_HEADER = 190;

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

function textLines(label, maxChars) {
  const words = String(label || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}

export const ACTIVITY_RX = 12;
/** Separación entre el círculo final y su contorno exterior. */
const RING_W = 1.4;

function dotRadius(node) {
  return Math.min(node.w, node.h) / 2;
}

function shapeFor(node) {
  const { x, y, w, h, type } = node;
  switch (type) {
    case 'start':
    case 'end':
      // Nodos inicial/final: círculos relleno (el final añade su contorno en updateNode).
      return el('circle', { cx: x + w / 2, cy: y + h / 2, r: dotRadius(node), class: 'node-shape node-dot' });
    case 'stop':
      // Punto muerto: círculo con una diagonal de abajo a arriba (updateNode la dibuja).
      return el('circle', { cx: x + w / 2, cy: y + h / 2, r: dotRadius(node), class: 'node-shape node-stop-dot' });
    case 'activity':
      return el('rect', { x, y, width: w, height: h, rx: ACTIVITY_RX, ry: ACTIVITY_RX, class: 'node-shape' });
    case 'decision': {
      const pts = `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`;
      return el('polygon', { points: pts, class: 'node-shape', 'stroke-linejoin': 'miter', 'stroke-miterlimit': 4 });
    }
    case 'fork':
    case 'join':
      // Barra de paralelismo: banda fina, alta y de esquinas rectas.
      return el('rect', { x, y, width: w, height: h, class: 'node-shape node-bar' });
    case 'note': {
      const fold = Math.min(18, h * 0.35);
      const pts = `${x},${y} ${x + w - fold},${y} ${x + w},${y + fold} ${x + w},${y + h} ${x},${y + h}`;
      return el('polygon', { points: pts, class: 'node-shape', 'stroke-linejoin': 'miter', 'stroke-miterlimit': 4 });
    }
    default:
      return el('rect', { x, y, width: w, height: h, class: 'node-shape' });
  }
}

/** Puntos de conexión que se muestran al seleccionar un nodo. */
function handlePositions(node) {
  const out = {};
  for (const [side, p] of Object.entries(anchors(node))) {
    if (side === 'left' || side === 'right' || side === 'top' || side === 'bottom') out[side] = p;
  }
  return out;
}

/**
 * Bolitas de conexión de cada nodo: una por cada flecha que ya usa ese lado, en
 * la posición exacta que ocupa (el reparto equitativo), o en el centro del lado
 * si está libre. Así el punto que se ve es el punto por el que entra o sale la
 * flecha, no un centro genérico que luego no coincide con nada.
 * @returns Map<nodeId, Map<side, Array<{x,y,used}>>>
 */
export function buildPorts(d) {
  const map = new Map();
  const put = (node, side, p) => {
    if (!node || !p) return;
    let g = map.get(node.id);
    if (!g) { g = new Map(); map.set(node.id, g); }
    const lista = g.get(side) || [];
    // Los círculos y rombos comparten punto: una sola bolita aunque haya varias.
    if (lista.some((q) => Math.abs(q.x - p.x) < 0.5 && Math.abs(q.y - p.y) < 0.5)) return;
    lista.push({ x: p.x, y: p.y, used: true });
    g.set(side, lista);
  };
  for (const e of d.edges) {
    const sides = pickSides(d, e);
    if (!sides) continue;
    put(nodeById(d, e.from), sides.from, anchorFor(d, e, sides.from, true));
    put(nodeById(d, e.to), sides.to, anchorFor(d, e, sides.to, false));
  }
  return map;
}

export class Renderer {
  constructor(svg) {
    this.svg = svg;
    this.viewport = svg.querySelector('#viewport');
    this.layerLanes = svg.querySelector('#layer-lanes');
    this.layerEdges = svg.querySelector('#layer-edges');
    this.layerNodes = svg.querySelector('#layer-nodes');
    this.layerOverlay = svg.querySelector('#layer-overlay');
    this.gridRect = svg.querySelector('#grid-rect');
    this.nodeEls = new Map();
    this.edgeEls = new Map();
  }

  setView(view) {
    this.viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    this.gridRect.setAttribute('opacity', view.k < 0.45 ? 0 : 1);
  }

  render(d, state = {}) {
    this.ports = buildPorts(d);
    this.renderLanes(d, state);
    this.renderEdges(d, state);
    this.renderNodes(d, state);
  }

  /** Bolitas de conexión de un nodo (las de `buildPorts`, con los libres). */
  portsOf(node) {
    const usados = this.ports?.get(node.id);
    const libres = handlePositions(node);
    const out = [];
    for (const side of SIDES) {
      const lista = usados?.get(side);
      const puntos = lista && lista.length ? lista : [{ ...libres[side], used: false }];
      for (const p of puntos) out.push({ side, ...p });
    }
    return out;
  }

  renderLanes(d, state) {
    const layer = this.layerLanes;
    layer.textContent = '';
    if (!d.lanes.length) return;
    let y = 0;
    d.lanes.forEach((lane, i) => {
      const h = lane.height;
      el('rect', {
        x: -4000, y, width: 12000, height: h,
        class: `lane-band${i % 2 ? ' alt' : ''}`,
      }, layer);
      el('rect', { x: 0, y, width: LANE_HEADER, height: h, class: 'lane-head' }, layer);
      const active = state.selectedLane === i;
      const title = el('text', {
        x: 14, y: y + Math.min(24, h / 2), class: `lane-title${active ? ' dragging' : ''}`,
        'data-lane-title': i,
      }, layer);
      title.textContent = lane.name;
      el('rect', {
        x: 0, y: y + h - 22, width: LANE_HEADER, height: 22,
        class: 'lane-head', 'data-lane-resize': i, style: 'cursor: ns-resize',
      }, layer);
      const grip = el('text', { x: 8, y: y + h - 7, class: 'lane-sub' }, layer);
      grip.textContent = `${d.nodes.filter((n) => laneIndexOf(d, n) === i).length} nodos · arrastra para redimensionar`;
      y += h;
    });
  }

  renderNodes(d, state) {
    const seen = new Set();
    for (const node of d.nodes) {
      seen.add(node.id);
      let g = this.nodeEls.get(node.id);
      if (!g) {
        g = this.buildNode(node);
        this.nodeEls.set(node.id, g);
        this.layerNodes.appendChild(g);
      }
      this.updateNode(g, node, d, state);
    }
    for (const [id, g] of this.nodeEls) {
      if (!seen.has(id)) { g.remove(); this.nodeEls.delete(id); }
    }
  }

  buildNode(node) {
    const g = el('g', { class: `node type-${node.type}`, 'data-id': node.id });
    g.__glow = el('rect', { class: 'node-token-glow', rx: 12 }, g);
    g.__shape = shapeFor(node);
    g.appendChild(g.__shape);
    g.__ring = null; // contorno exterior del nodo final
    // Diagonal interior del punto muerto (de abajo a arriba), sobre la figura.
    g.__slash = el('line', { class: 'node-slash', opacity: 0 });
    g.appendChild(g.__slash);
    g.__labels = el('g', {}, g);
    g.__hit = el('rect', { class: 'node-hit' }, g);
    g.__handles = el('g', {}, g);
    return g;
  }

  updateNode(g, node, d, state) {
    const t = NODE_TYPES[node.type];
    // `selected` es el elemento activo (inspisor); `selectedSet`, la multiselección.
    const isSel = (state.selected?.type === 'node' && state.selected.id === node.id)
      || (state.selectedSet || []).some((s) => s.type === 'node' && s.id === node.id);
    g.setAttribute('class', `node type-${node.type}${
      isSel ? ' selected' : ''}${
      state.tokens?.has(node.id) ? ' token' : ''}${
      state.errorNodes?.has(node.id) ? ' error' : ''}`);

    // Si cambió el tipo, reconstruir la forma (rect <-> polygon <-> circle).
    const wantTag = node.type === 'decision' || node.type === 'note'
      ? 'polygon'
      : (node.type === 'start' || node.type === 'end' || node.type === 'stop') ? 'circle' : 'rect';
    if (g.__shape.tagName !== wantTag) {
      g.__shape.remove();
      g.__shape = shapeFor(node);
      g.insertBefore(g.__shape, g.__slash);
    }
    const shape = g.__shape;
    if (node.type === 'decision') {
      const s = Math.max(node.w, node.h);
      shape.setAttribute('points', `${node.x + s / 2},${node.y} ${node.x + s},${node.y + s / 2} ${node.x + s / 2},${node.y + s} ${node.x},${node.y + s / 2}`);
    } else if (node.type === 'note') {
      const fold = Math.min(18, node.h * 0.35);
      shape.setAttribute('points', `${node.x},${node.y} ${node.x + node.w - fold},${node.y} ${node.x + node.w},${node.y + fold} ${node.x + node.w},${node.y + node.h} ${node.x},${node.y + node.h}`);
    } else if (node.type === 'start' || node.type === 'end' || node.type === 'stop') {
      shape.setAttribute('cx', node.x + node.w / 2);
      shape.setAttribute('cy', node.y + node.h / 2);
      shape.setAttribute('r', dotRadius(node));
    } else {
      shape.setAttribute('x', node.x);
      shape.setAttribute('y', node.y);
      shape.setAttribute('width', node.w);
      shape.setAttribute('height', node.h);
      if (node.type === 'activity') {
        shape.setAttribute('rx', ACTIVITY_RX);
        shape.setAttribute('ry', ACTIVITY_RX);
      }
    }

    // Diagonal del punto muerto: de abajo a arriba, dentro del círculo.
    const slash = g.__slash;
    if (node.type === 'stop') {
      const r = dotRadius(node);
      const cx = node.x + node.w / 2;
      const cy = node.y + node.h / 2;
      const d = r * 0.72;
      slash.setAttribute('x1', cx - d);
      slash.setAttribute('y1', cy + d);
      slash.setAttribute('x2', cx + d);
      slash.setAttribute('y2', cy - d);
      slash.setAttribute('stroke-width', Math.max(1.6, r * 0.22));
      slash.setAttribute('opacity', '1');
    } else {
      slash.setAttribute('opacity', '0');
    }

    // Contorno exterior del nodo final, separado del círculo relleno.
    if (node.type === 'end') {
      if (!g.__ring) {
        g.__ring = el('circle', { class: 'node-ring' });
        g.insertBefore(g.__ring, g.__labels);
      }
      g.__ring.setAttribute('cx', node.x + node.w / 2);
      g.__ring.setAttribute('cy', node.y + node.h / 2);
      g.__ring.setAttribute('r', dotRadius(node) + END_RING_GAP + RING_W / 2);
      g.__ring.setAttribute('opacity', '1');
    } else if (g.__ring) {
      g.__ring.setAttribute('opacity', '0');
    }

    const glow = g.__glow;
    if (state.tokens?.has(node.id)) {
      const pad = 7 + (node.type === 'end' ? END_RING_GAP : 0);
      const side = dotRadius(node) * 2 + pad * 2;
      glow.setAttribute('x', node.x + node.w / 2 - side / 2);
      glow.setAttribute('y', node.y + node.h / 2 - side / 2);
      glow.setAttribute('width', side);
      glow.setAttribute('height', side);
      glow.setAttribute('rx', side / 2);
      glow.setAttribute('opacity', '1');
    } else {
      glow.setAttribute('opacity', '0');
    }

    g.__hit.setAttribute('x', node.x - 4);
    g.__hit.setAttribute('y', node.y - 4);
    g.__hit.setAttribute('width', node.w + 8);
    g.__hit.setAttribute('height', node.h + 8);
    g.__hit.setAttribute('rx', 10);

    // Etiquetas
    const labels = g.__labels;
    labels.textContent = '';
    const cx = node.x + node.w / 2;
    const cy = node.y + node.h / 2;
if (node.type === 'start' || node.type === 'end' || node.type === 'stop') {
      // Los nodos inicial/final/punto muerto no llevan texto (notación UML).
    } else if (node.type === 'fork' || node.type === 'join') {
      const vertical = node.h > node.w;
      const t1 = el('text', { class: 'node-label', 'font-size': 11.5 }, labels);
      t1.textContent = node.label;
      if (vertical) {
        t1.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
        t1.setAttribute('x', cx);
        t1.setAttribute('y', cy - node.h / 2 - 12);
      } else {
        t1.setAttribute('x', node.x + node.w + 10);
        t1.setAttribute('y', cy);
        t1.setAttribute('text-anchor', 'start');
      }
      const sub = el('text', { class: 'node-sub', 'font-size': 10.5 }, labels);
      sub.textContent = node.note || '';
      if (vertical) {
        sub.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
        sub.setAttribute('x', cx);
        sub.setAttribute('y', cy - node.h / 2 - 26);
      } else {
        sub.setAttribute('x', node.x + node.w + 10);
        sub.setAttribute('y', cy + 14);
        sub.setAttribute('text-anchor', 'start');
      }
    } else {
      const isDiamond = node.type === 'decision';
      const maxChars = isDiamond
        ? Math.max(6, Math.floor(node.w / 11))
        : Math.max(8, Math.floor(node.w / 8.2));
      // El objeto guarda su estado en `note`, que se muestra entre << >>.
      const sub2 = node.type === 'objeto' && node.note
        ? (node.note.length > 26 ? `<< ${node.note.slice(0, 25)}… >>` : `<< ${node.note} >>`)
        : (node.note && node.note.length > 30 ? `${node.note.slice(0, 29)}…` : node.note || '');
      const lines = textLines(node.label, maxChars);
      const lh = 15;
      const startY = cy - ((lines.length - 1) * lh) / 2 + (sub2 ? -6 : 0);
      lines.forEach((line, i) => {
        const t2 = el('text', { class: 'node-label', x: cx, y: startY + i * lh }, labels);
        t2.textContent = line;
      });
      if (sub2) {
        const sub = el('text', { class: 'node-sub', x: cx, y: cy + (lines.length * lh) / 2 + 2 }, labels);
        sub.textContent = sub2;
      }
    }

    // Puntos de conexión: donde entran y salen las flechas de verdad.
    g.__handles.textContent = '';
    if (!state.simulating) {
      const usados = this.ports?.get(node.id);
      const libres = handlePositions(node);
      for (const side of SIDES) {
        const lista = usados?.get(side);
        const puntos = lista && lista.length ? lista : [{ ...libres[side], used: false }];
        for (const p of puntos) {
          const h = el('circle', {
            class: `handle${p.used ? ' used' : ''}`, cx: p.x, cy: p.y, r: 6,
            'data-handle': side, 'data-node-id': node.id,
          }, g.__handles);
          h.__side = side;
          h.__nodeId = node.id;
        }
      }
    }
    void t;
  }

  renderEdges(d, state) {
    const seen = new Set();
    const geoCache = new Map();

    for (const edge of d.edges) {
      const geo = edgeGeometry(d, edge);
      if (!geo) continue;
      geoCache.set(edge.id, geo);
      seen.add(edge.id);

      let rec = this.edgeEls.get(edge.id);
      if (!rec) {
        rec = this.buildEdge(edge);
        this.edgeEls.set(edge.id, rec);
        this.layerEdges.appendChild(rec.g);
      }
      const selected = (state.selected?.type === 'edge' && state.selected.id === edge.id)
        || (state.selectedSet || []).some((s) => s.type === 'edge' && s.id === edge.id);
      const active = state.activeEdges?.has(edge.id);
      rec.g.setAttribute('class', `edge-wrap${selected ? ' selected' : ''}${active ? ' token' : ''}`);
      const dash = edge.kind === 'message' ? '7 6' : null;
      const dAttr = edgePath(geo);
      rec.path.setAttribute('d', dAttr);
      rec.hit.setAttribute('d', dAttr);
      rec.path.setAttribute('class', `edge${selected ? ' selected' : ''}${active ? ' token' : ''}`);
      rec.path.setAttribute('marker-end', active ? 'url(#arrow-token)' : selected ? 'url(#arrow-selected)' : 'url(#arrow)');
      if (dash) rec.path.setAttribute('stroke-dasharray', dash);
      else rec.path.removeAttribute('stroke-dasharray');

      // La etiqueta va fuera de la línea, entre corchetes y siguiendo la
      // orientación del tramo más largo de la flecha.
      const text = edge.label || edge.condition;
      const spot = labelSpot(geo);
      rec.labelGroup.setAttribute('transform',
        `translate(${spot.x} ${spot.y})${spot.vertical ? ' rotate(-90)' : ''}`);
      if (text) {
        const half = Math.min(120, text.length * 3.2 + 5);
        rec.text.textContent = text.length > 30 ? `${text.slice(0, 29)}…` : text;
        rec.text.setAttribute('opacity', '1');
        rec.open.setAttribute('opacity', '1');
        rec.close.setAttribute('opacity', '1');
        // Cada corchete se dibuja con el trazo vertical en el extremo exterior:
        // el de apertura a la izquierda, el de cierre a la derecha.
        rec.open.setAttribute('d', `M ${-half - 3} -8 L ${-half - 9} -8 L ${-half - 9} 8 L ${-half - 3} 8`);
        rec.close.setAttribute('d', `M ${half + 3} -8 L ${half + 9} -8 L ${half + 9} 8 L ${half + 3} 8`);
      } else {
        rec.text.setAttribute('opacity', '0');
        rec.open.setAttribute('opacity', '0');
        rec.close.setAttribute('opacity', '0');
      }
    }

    for (const [id, rec] of this.edgeEls) {
      if (!seen.has(id)) { rec.g.remove(); this.edgeEls.delete(id); }
    }
    this.lastGeo = geoCache;
  }

  buildEdge(edge) {
    const g = el('g', { class: 'edge', 'data-edge': edge.id });
    const hit = el('path', { class: 'edge-hit' }, g);
    const path = el('path', { class: 'edge', 'data-edge': edge.id }, g);
    const labelGroup = el('g', { class: 'edge-label-group', 'data-edge-label': edge.id }, g);
    const open = el('path', { class: 'edge-label-bracket', opacity: 0 }, labelGroup);
    const close = el('path', { class: 'edge-label-bracket', opacity: 0 }, labelGroup);
    const text = el('text', { class: 'edge-label', opacity: 0 }, labelGroup);
    hit.__edgeId = edge.id;
    return { g, hit, path, labelGroup, open, close, text };
  }

  /** Actualización ligera durante el arrastre de nodos. */
  refresh(d, state) {
    this.ports = buildPorts(d);
    this.renderEdges(d, state);
    this.renderNodes(d, state);
  }

  edgeScreenShape(edgeId) {
    return this.edgeEls.get(edgeId);
  }
}

function laneIndexOf(d, node) {
  if (Number.isInteger(node.lane)) return node.lane;
  let acc = 0;
  for (let i = 0; i < d.lanes.length; i += 1) {
    acc += d.lanes[i].height;
    if (node.y + node.h / 2 < acc) return i;
  }
  return 0;
}

export { laneTop };
