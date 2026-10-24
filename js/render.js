/**
 * Render del diagrama en SVG. Reconstruye las capas de carriles, flujos y nodos
 * y expone un render "suave" para el arrastre (actualiza sólo atributos).
 */
import {
  edgePath, edgeGeometry, anchors, anchorFor, pickSides, nodeSides, END_RING_GAP, labelSpot,
} from './routing.js';
import { laneTop, NODE_TYPES, nodeById, isVerticalLanes } from './model.js';

const NS = 'http://www.w3.org/2000/svg';
/**
 * La cabecera de carril es una barra vertical fina pegada al borde izquierdo,
 * con el nombre del actor escrito de lado. Es también el margen que los nodos
 * no pueden pisar (`interact.js:snapSpot`).
 */
export const LANE_HEADER = 40;
/** Alto de la franja inferior de la barra que arrastra para redimensionar. */
export const LANE_GRIP = 12;

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

/** Ancho aproximado de un carácter del nombre de carril (12px semibold). */
const LANE_CHAR_W = 6.9;

/**
 * Recorta el nombre del actor para que quepa girado dentro de su banda: si no
 * cabe entero se corta con puntos suspensivos en vez de salirse de la barra.
 */
function fitLaneName(name, height) {
  const hueco = Math.max(0, height - LANE_GRIP - 10);
  const max = Math.floor(hueco / LANE_CHAR_W);
  const txt = String(name || '');
  if (txt.length <= max) return txt;
  return `${txt.slice(0, Math.max(1, max - 1))}…`;
}

export const ACTIVITY_RX = 12;
/** Separación entre el círculo final y su contorno exterior. */
const RING_W = 1.4;
/** Trazo del círculo del punto muerto (`.node.type-stop .node-shape`). */
const STOP_STROKE_W = 1.6;
/** Profundidad del pico del nodo de enviar/recibir notificación. */
const PICO = 26;
/** Tridente del nodo de proceso: una barra con tres púas rectas hacia abajo. */
const TRIDENTE_W = 14;
const TRIDENTE_H = 9;
const TRIDENTE_MARGEN = 8;

function dotRadius(node) {
  return Math.min(node.w, node.h) / 2;
}

/** Puntos de la decisión: cuadrado de puntas verticales. */
export function romboPoints(x, y, w, h) {
  return `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`;
}

/** Reloj de arena girado 90°: barras verticales a los lados y la cruz de diagonales. */
export function relojPoints(x, y, w, h) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return `${x},${y} ${x},${y + h} ${cx},${cy} ${x + w},${y + h} ${x + w},${y} ${cx},${cy}`;
}

/**
 * Reloj de arena de pie (el nodo girado 90°): las barras planas quedan arriba y
 * abajo y la cruz de diagonales sigue cruzándose en el centro.
 */
export function relojPointsVertical(x, y, w, h) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return `${x + w},${y} ${x},${y} ${cx},${cy} ${x},${y + h} ${x + w},${y + h} ${cx},${cy}`;
}

/** Enviar notificación: el pico sale hacia fuera por la derecha. */
export function enviarPoints(x, y, w, h) {
  const p = Math.min(PICO, w * 0.3);
  return `${x},${y} ${x + w - p},${y} ${x + w},${y + h / 2} ${x + w - p},${y + h} ${x},${y + h}`;
}

/** Recibir notificación: la muesca triangular entra hacia dentro por la izquierda. */
export function recibirPoints(x, y, w, h) {
  const p = Math.min(PICO, w * 0.3);
  return `${x},${y} ${x + w},${y} ${x + w},${y + h} ${x},${y + h} ${x + p},${y + h / 2}`;
}

/** Nota: rectángulo con la esquina superior derecha doblada. */
function notaPoints(x, y, w, h) {
  const fold = Math.min(18, h * 0.35);
  return `${x},${y} ${x + w - fold},${y} ${x + w},${y + fold} ${x + w},${y + h} ${x},${y + h}`;
}

/** El tridente invertido del nodo de proceso (líneas rectas, sin curvas). */
export function tridentePuntos(node) {
  const w = Math.min(TRIDENTE_W, Math.max(0, node.w - TRIDENTE_MARGEN * 2));
  const h = Math.min(TRIDENTE_H, Math.max(0, node.h - TRIDENTE_MARGEN * 2));
  const x0 = node.x + node.w - TRIDENTE_MARGEN - w;
  const y0 = node.y + node.h - TRIDENTE_MARGEN - h;
  return [
    { x1: x0, y1: y0, x2: x0 + w, y2: y0 },
    { x1: x0, y1: y0, x2: x0, y2: y0 + h },
    { x1: x0 + w / 2, y1: y0, x2: x0 + w / 2, y2: y0 + h },
    { x1: x0 + w, y1: y0, x2: x0 + w, y2: y0 + h },
  ];
}

/**
 * Cómo es la figura de un nodo: etiqueta del elemento y sus atributos. Es la
 * única fuente de la forma (la usan tanto el nodo del diagrama como el fantasma
 * que preview la herramienta de inserción).
 */
export function shapeAttrs(node) {
  const { x, y, w, h, type } = node;
  const poly = (points, join = 'miter') => ({
    tag: 'polygon',
    attrs: { points, class: 'node-shape', 'stroke-linejoin': join, 'stroke-miterlimit': 4 },
  });
  switch (type) {
    case 'start':
    case 'end':
      // Nodos inicial/final: círculos relleno (el final añade su contorno en updateNode).
      return { tag: 'circle', attrs: { cx: x + w / 2, cy: y + h / 2, r: dotRadius(node), class: 'node-shape node-dot' } };
    case 'stop':
      // Punto muerto: círculo con una diagonal (updateNode la dibuja encima).
      return { tag: 'circle', attrs: { cx: x + w / 2, cy: y + h / 2, r: dotRadius(node), class: 'node-shape node-stop-dot' } };
    case 'activity':
    case 'proceso':
      return { tag: 'rect', attrs: { x, y, width: w, height: h, rx: ACTIVITY_RX, ry: ACTIVITY_RX, class: 'node-shape' } };
    case 'decision':
      return poly(romboPoints(x, y, w, h));
    case 'tiempo':
      // El reloj va tumbado de fábrica y de pie si el nodo está girado.
      return poly(
        node.rot === 90 ? relojPointsVertical(x, y, w, h) : relojPoints(x, y, w, h),
        'round',
      );
    case 'enviar':
      return poly(enviarPoints(x, y, w, h));
    case 'recibir':
      return poly(recibirPoints(x, y, w, h));
    case 'fork':
    case 'join':
      // Barra de paralelismo: banda fina, alta y de esquinas rectas.
      return { tag: 'rect', attrs: { x, y, width: w, height: h, class: 'node-shape node-bar' } };
    case 'note':
      return poly(notaPoints(x, y, w, h));
    default:
      return { tag: 'rect', attrs: { x, y, width: w, height: h, class: 'node-shape' } };
  }
}

function shapeFor(node) {
  const { tag, attrs } = shapeAttrs(node);
  return el(tag, attrs);
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
    for (const side of nodeSides(node)) {
      const lista = usados?.get(side);
      const libre = libres[side];
      if (!libre && !lista) continue;
      const puntos = lista && lista.length ? lista : [{ ...libre, used: false }];
      for (const p of puntos) out.push({ side, ...p });
    }
    return out;
  }

  renderLanes(d, state) {
    const layer = this.layerLanes;
    layer.textContent = '';
    const vertical = isVerticalLanes(d);
    // Firma de lo dibujado: `refresh` la usa para saber si tiene que repintar.
    this.laneFirma = `${vertical ? 'v' : 'h'}#${d.lanes.map((l) => `${l.id}:${l.height}`).join('|')}#${state.selectedLane}`;
    if (!d.lanes.length) return;
    let pos = 0;
    d.lanes.forEach((lane, i) => {
      const grosor = lane.height;
      const active = state.selectedLane === i;
      const attrs = { 'data-lane-resize': i };
      if (vertical) {
        // Carril vertical: banda que ocupa todo el alto y cabecera horizontal
        // pegada al borde superior, con el nombre del actor sin girar.
        el('rect', {
          x: pos, y: -4000, width: grosor, height: 12000,
          class: `lane-band${i % 2 ? ' alt' : ''}`,
        }, layer);
        el('rect', { x: pos, y: 0, width: grosor, height: LANE_HEADER, class: 'lane-head' }, layer);
        const cx = pos + (grosor - LANE_GRIP) / 2;
        const title = el('text', {
          x: cx, y: LANE_HEADER / 2, class: `lane-title${active ? ' dragging' : ''}`,
          'data-lane-title': i,
        }, layer);
        title.textContent = fitLaneName(lane.name, grosor);
        el('title', {}, title).textContent = `${lane.name} · doble clic para renombrar`;
        // Asidero de redimensión: franja fina en el borde derecho de la cabecera.
        const gripX = pos + grosor - LANE_GRIP;
        const grip = el('rect', {
          x: gripX, y: 0, width: LANE_GRIP, height: LANE_HEADER, class: 'lane-grip',
          ...attrs, style: 'cursor: ew-resize',
        }, layer);
        el('title', {}, grip).textContent = 'Arrastra para cambiar el ancho del carril';
        for (const dx of [-3, 3]) {
          el('line', {
            x1: gripX + LANE_GRIP / 2 + dx, y1: LANE_HEADER / 2 - 7,
            x2: gripX + LANE_GRIP / 2 + dx, y2: LANE_HEADER / 2 + 7,
            class: 'lane-grip-mark', ...attrs,
          }, layer);
        }
      } else {
        el('rect', {
          x: -4000, y: pos, width: 12000, height: grosor,
          class: `lane-band${i % 2 ? ' alt' : ''}`,
        }, layer);
        el('rect', { x: 0, y: pos, width: LANE_HEADER, height: grosor, class: 'lane-head' }, layer);
        // El actor va girado 90º, centrado en la barra y recortado a su alto.
        const cx = LANE_HEADER / 2;
        const cy = pos + (grosor - LANE_GRIP) / 2;
        const title = el('text', {
          x: cx, y: cy, class: `lane-title${active ? ' dragging' : ''}`,
          'data-lane-title': i, transform: `rotate(-90 ${cx} ${cy})`,
        }, layer);
        title.textContent = fitLaneName(lane.name, grosor);
        el('title', {}, title).textContent = `${lane.name} · doble clic para renombrar`;
        // Asidero de redimensión: franja fina en el borde inferior de la barra.
        const gripY = pos + grosor - LANE_GRIP;
        const grip = el('rect', {
          x: 0, y: gripY, width: LANE_HEADER, height: LANE_GRIP, class: 'lane-grip',
          ...attrs, style: 'cursor: ns-resize',
        }, layer);
        el('title', {}, grip).textContent = 'Arrastra para cambiar el alto del carril';
        for (const dy of [-3, 3]) {
          el('line', {
            x1: cx - 7, y1: gripY + LANE_GRIP / 2 + dy, x2: cx + 7, y2: gripY + LANE_GRIP / 2 + dy,
            class: 'lane-grip-mark', ...attrs,
          }, layer);
        }
      }
      pos += grosor;
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
    g.__type = node.type;
    g.appendChild(g.__shape);
    g.__ring = null; // contorno exterior del nodo final
    // Diagonal interior del punto muerto (de abajo a arriba), sobre la figura.
    g.__slash = el('line', { class: 'node-slash', opacity: 0 });
    g.appendChild(g.__slash);
    // Adornos sobre la figura (el tridente del nodo de proceso).
    g.__deco = el('g', { class: 'node-deco' });
    g.appendChild(g.__deco);
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

    // La figura se reconstruye si cambia de tipo (no sólo si cambia de
    // elemento): así no quedan atributos del tipo anterior pegados.
    const { tag, attrs } = shapeAttrs(node);
    if (g.__shape.tagName !== tag || g.__type !== node.type) {
      g.__shape.remove();
      g.__shape = shapeFor(node);
      g.__type = node.type;
      g.insertBefore(g.__shape, g.__slash);
    }
    const shape = g.__shape;
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, String(v));

    const deco = g.__deco;
    deco.textContent = '';
    if (node.type === 'proceso') {
      for (const l of tridentePuntos(node)) {
        el('line', {
          x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2,
          class: 'node-deco-line', 'stroke-width': 1.4,
        }, deco);
      }
    }

    // Diagonal del punto muerto: de izquierda a derecha, con el mismo
    // grosor que el círculo y de un borde al otro (sin holgura por medio).
    const slash = g.__slash;
    if (node.type === 'stop') {
      const r = dotRadius(node);
      const cx = node.x + node.w / 2;
      const cy = node.y + node.h / 2;
      const d = r / Math.SQRT2;
      slash.setAttribute('x1', cx - d);
      slash.setAttribute('y1', cy + d);
      slash.setAttribute('x2', cx + d);
      slash.setAttribute('y2', cy - d);
      slash.setAttribute('stroke-width', STOP_STROKE_W);
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
    if (node.type === 'start' || node.type === 'end' || node.type === 'stop' || node.type === 'tiempo') {
      // Inicio, fin, punto muerto y reloj de arena no llevan texto (la figura del
      // tiempo es el propio reloj de arena, sin hueco dentro).
    } else if (node.type === 'fork' || node.type === 'join') {
      // Barras de paralelismo: sin nombre no se dibuja nada (es lo habitual); si
      // el usuario le pone uno, va fuera, girado cuando la barra está de pie.
      const vertical = node.h > node.w;
      const t1 = node.label || node.note
        ? el('text', { class: 'node-label', 'font-size': 11.5 }, labels)
        : null;
      if (t1) {
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
      for (const side of nodeSides(node)) {
        const lista = usados?.get(side);
        const libre = libres[side];
        if (!libre && !lista) continue;
        const puntos = lista && lista.length ? lista : [{ ...libre, used: false }];
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

  /**
 * Actualización ligera durante el arrastre. Las bandas de carril también se
 * repintan (sólo si ha cambiado alguna medida): al redimensionar un carril el
 * alto tiene que verse mientras se mueve el ratón, no sólo al soltar.
 */
refresh(d, state) {
    this.ports = buildPorts(d);
    const vertical = isVerticalLanes(d);
    const firma = `${vertical ? 'v' : 'h'}#${d.lanes.map((l) => `${l.id}:${l.height}`).join('|')}#${state.selectedLane}`;
    if (firma !== this.laneFirma) this.renderLanes(d, state);
    this.renderEdges(d, state);
    this.renderNodes(d, state);
  }

  edgeScreenShape(edgeId) {
    return this.edgeEls.get(edgeId);
  }
}

export { laneTop };
