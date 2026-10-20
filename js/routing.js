/**
 * Geometría de los flujos.
 *
 * El usuario manda: el lado por el que la flecha sale y entra se elige pulsando
 * las bolitas del nodo (`edge.fromSide` / `edge.toSide`) y el recorrido se
 * indica con puntos de giro (`edge.way`). Aquí sólo se calcula dónde cae
 * exactamente cada flecha en su lado (centrada, o repartida si comparte lado con
 * más) y se ortogonala el recorrido en tramos rectos. No hay trazado automático.
 * Módulo autónomo (sin imports) para evitar ciclos con model.js.
 */

const DOT_TYPES = new Set(['start', 'end', 'stop']);

/**
 * Puntos de anclaje de un nodo en el centro de cada lado: son las bolitas por
 * las que entran y salen las flechas. El punto exacto de cada flujo lo reparte
 * `anchorFor` entre las que comparten lado.
 */
export function anchors(node) {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  if (node.type === 'tiempo') {
    // El reloj de arena está girado 90°: sus barras planas quedan a izquierda y
    // derecha, así que sólo se conecta por los lados.
    return {
      left: { x: node.x, y: cy },
      right: { x: node.x + node.w, y: cy },
    };
  }
  if (node.type === 'fork' || node.type === 'join') {
    // La barra de paralelismo sólo recibe y reparte por los lados.
    return {
      left: { x: node.x, y: cy },
      right: { x: node.x + node.w, y: cy },
    };
  }
  if (DOT_TYPES.has(node.type)) {
    const r = Math.min(node.w, node.h) / 2;
    return {
      left: { x: cx - r, y: cy },
      right: { x: cx + r, y: cy },
      top: { x: cx, y: cy - r },
      bottom: { x: cx, y: cy + r },
    };
  }
  return {
    left: { x: node.x, y: cy },
    right: { x: node.x + node.w, y: cy },
    top: { x: cx, y: node.y },
    bottom: { x: cx, y: node.y + node.h },
  };
}

export function sideNormal(side) {
  if (side === 'left') return { x: -1, y: 0 };
  if (side === 'right') return { x: 1, y: 0 };
  if (side === 'top') return { x: 0, y: -1 };
  return { x: 0, y: 1 };
}

/** Los cuatro lados de conexión de un nodo. */
export const SIDES = ['left', 'right', 'top', 'bottom'];

/**
 * Lados de conexión que admite un nodo. El reloj de arena (tiempo) sólo entra y
 * sale por los lados (sus barras planas); la barra de paralelismo (fork/join)
 * también; el resto de figuras admiten los cuatro.
 */
export function nodeSides(node) {
  if (!node) return SIDES;
  if (node.type === 'tiempo' || node.type === 'fork' || node.type === 'join') return ['left', 'right'];
  return SIDES;
}

/** Eje de reparto de un lado: arriba/abajo reparten en X, izquierda/derecha en Y. */
const sideAxis = (side) => (side === 'top' || side === 'bottom' ? 'x' : 'y');

const centerX = (n) => n.x + n.w / 2;
const centerY = (n) => n.y + n.h / 2;

function nodeOf(d, id) {
  return d.nodes.find((n) => n.id === id);
}

/**
 * Lado que «mira» al punto indicado: el más cercano **en términos relativos**
 * (qué parte de la mitad del ancho o del alto se ha recorrido), no una
 * comparación en píxeles sueltos — en una caja alargada eso manda siempre al
 * lado horizontal y acaba metiendo la flecha por el que no toca. A igualdad
 * gana el lado horizontal, que es por donde suelen ir las flechas. Sólo sirve de
 * ayuda cuando el usuario no ha pulsado una bolita concreta (por ejemplo, si
 * hace clic en el cuerpo del nodo): el lado definitivo es el que él elija.
 */
export function sideNear(node, p) {
  if (node.type === 'tiempo' || node.type === 'fork' || node.type === 'join') return p.x - centerX(node) > 0 ? 'right' : 'left';
  const dx = (p.x - centerX(node)) / (node.w / 2 || 1);
  const dy = (p.y - centerY(node)) / (node.h / 2 || 1);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

/** Lados por defecto (flujos antiguos que no guardan los suyos). */
function fallbackSides(edge) {
  return { from: edge.fromSide || 'right', to: edge.toSide || 'left' };
}

/**
 * Punto de anclaje de un flujo en su nodo: el del lado que eligió el usuario,
 * repartido con las demás flechas de ese mismo lado — centrada si es la única,
 * distribuida equitativamente si hay varias. El reparto es conjunto: una flecha
 * que sale y otra que entra por el mismo lado ocupan huecos distintos, nunca el
 * mismo punto.
 *
 * En círculos y rombos hay un único punto por lado (repartirlo sacaría la
 * flecha de la figura); barras y rectángulos sí admiten reparto.
 * @param out true = ancla en el nodo de origen del flujo
 */
export function anchorFor(d, edge, side, out) {
  const node = nodeOf(d, out ? edge.from : edge.to);
  if (!node) return null;
  const base = anchors(node)[side];
  if (!base) return null;
  if (DOT_TYPES.has(node.type) || node.type === 'decision') return base;

  const eje = sideAxis(side) === 'x';
  const pos = (otro) => (eje ? centerX(otro) : centerY(otro));
  const peers = [];
  for (const e of d.edges) {
    let otra = null;
    if (e.from === node.id) otra = (e.fromSide || fallbackSides(e).from) === side ? nodeOf(d, e.to) : null;
    else if (e.to === node.id) otra = (e.toSide || fallbackSides(e).to) === side ? nodeOf(d, e.from) : null;
    if (!otra) continue;
    // Ordenadas por la posición del otro extremo en el eje de reparto: el
    // reparto es estable y legible al mover las figuras.
    peers.push({ id: e.id, x: pos(otra) });
  }
  peers.sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : 1));

  const k = peers.findIndex((p) => p.id === edge.id);
  const t = peers.length ? (k + 0.5) / peers.length : 0.5;
  if (eje) return { x: node.x + t * node.w, y: base.y };
  return { x: base.x, y: node.y + t * node.h };
}

/** Lados de salida y entrada de un flujo: los que fijó el usuario. */
export function pickSides(d, edge) {
  const from = nodeOf(d, edge.from);
  const to = nodeOf(d, edge.to);
  if (!from || !to) return null;
  const s = fallbackSides(edge);
  return { from: clampSide(from, s.from), to: clampSide(to, s.to) };
}

/**
 * Ajusta un lado guardado a los que admite el nodo: si el reloj de arena tiene
 * un flujo antiguo que sale por arriba o por abajo, se recoloca a un lado.
 */
function clampSide(node, side) {
  const validos = nodeSides(node);
  if (validos.includes(side)) return side;
  return side === 'right' || side === 'bottom' ? validos[validos.length - 1] : validos[0];
}

/**
 * Trazado de un flujo: polilínea ortogonal (sólo tramos rectos y cortes a 90º)
 * entre los dos anclajes pasando por los puntos de giro del usuario.
 * Devuelve los vértices, los extremos y el punto donde va la etiqueta.
 * La punta se retrasa unos píxeles para que la flecha no quede enterrada en el nodo.
 */
export const ARROW_GAP = 3;
/** Separación del contorno exterior del nodo final. */
export const END_RING_GAP = 5;
const RING_W = 1.4;
/** Tramo inicial perpendicular al nodo antes de girar. */
const STUB = 24;
/** Separación mínima entre nodos para considerar que el tramo es recto. */
const ALIGN = 0.5;

export function edgeGeometry(d, edge) {
  const from = nodeOf(d, edge.from);
  const to = nodeOf(d, edge.to);
  if (!from || !to) return null;

  const sides = pickSides(d, edge);
  if (!sides) return null;
  const raw0 = anchorFor(d, edge, sides.from, true);
  const raw3 = anchorFor(d, edge, sides.to, false);
  const n0 = sideNormal(sides.from);
  const n1 = sideNormal(sides.to);

  // Separar un poco los extremos del nodo: la punta respira y el trazo no nace pegado al borde.
  const p0 = { x: raw0.x + n0.x * 1.5, y: raw0.y + n0.y * 1.5 };
  // En el nodo final la punta debe quedar fuera del contorno exterior, no encima:
  // el anillo está END_RING_GAP + RING_W/2 más allá del círculo relleno.
  const gap = to.type === 'end'
    ? END_RING_GAP + RING_W / 2 + ARROW_GAP
    : ARROW_GAP;
  const p3 = { x: raw3.x + n1.x * gap, y: raw3.y + n1.y * gap };

  const way = Array.isArray(edge.way)
    ? edge.way.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    : [];
  const pts = way.length ? userRoute(p0, n0, p3, n1, way) : linkRoute(p0, n0, p3, n1);
  return { p1: p0, p2: p3, pts, mid: polyMid(pts), sides };
}

/* ------------------------------------------------------------------ */
/* Trayectoria: los puntos que indica el usuario                      */
/* ------------------------------------------------------------------ */

/**
 * Recorrido con puntos de control: sale del ancla perpendicular a su lado,
 * encuadra cada tramo en un ángulo recto y entra en el destino por el lado que
 * indicó el usuario. El usuario sólo marca los puntos; aquí únicamente se
 * orthonormaliza el trazado.
 * @returns Array<{x,y>} vértices de la polilínea
 */
export function userRoute(p0, n0, p3, n1, way) {
  const pts = [p0, stub(p0, n0, way[0])];
  for (const p of way) pts.push({ x: p.x, y: p.y });
  pts.push(stub(p3, n1, way[way.length - 1]), p3);
  return orthogonalize(pts);
}

/**
 * Recorrido sin puntos de giro: un único corte en L entre la salida y la
 * entrada. Es la flecha «por defecto»; con el botón derecho el usuario va
 * añadiendo giros hasta dejar el recorrido como quiere.
 */
export function linkRoute(p0, n0, p3, n1) {
  return orthogonalize([p0, stub(p0, n0, p3), stub(p3, n1, p0), p3]);
}

/**
 * Trozo visible mientras se traza: desde el ancla de salida, pasando por los
 * puntos de giro ya fijados y terminando en `cola`, que son los dos últimos
 * puntos del trazo: la proyección del puntero sobre la línea en la que se está
 * (`guidePoint`) y el puntero. Entre ambos se cuela **un** cambio de dirección
 * automático, que es lo que permite que, después de un giro, la flecha siga
 * recta y luego se desvíe hacia donde está el cursor sin tener que volver a
 * clicar. Más de uno no: `orthogonalize` mete como mucho un codo por tramo, así
 * que a partir del primero el último lado sólo se estira.
 */
export function userRouteTip(p0, n0, way, cola) {
  const fin = (Array.isArray(cola) ? cola : [cola]).filter(Boolean);
  const objetivo = way[0] || fin[0] || p0;
  const pts = [p0, stub(p0, n0, objetivo)];
  for (const p of way) pts.push({ x: p.x, y: p.y });
  for (const p of fin) pts.push({ x: p.x, y: p.y });
  return orthogonalize(pts);
}

/**
 * Punto hacia el que se guía el trazo: se mueve en horizontal o en vertical
 * según el eje que domina desde `from`. `axis` fija el sentido ya elegido y sólo
 * cambia cuando el cursor se va claramente por el otro eje, para que la línea
 * no parpadee al mover el ratón en diagonal.
 */
export function guidePoint(from, cursor, axis = null) {
  const dx = Math.abs(cursor.x - from.x);
  const dy = Math.abs(cursor.y - from.y);
  let ax = axis;
  if (!ax || (dx <= ALIGN && dy <= ALIGN)) ax = dx >= dy ? 'x' : 'y';
  else if (ax === 'x' && dy > dx) ax = 'y';
  else if (ax === 'y' && dx > dy) ax = 'x';
  return ax === 'x' ? { x: cursor.x, y: from.y } : { x: from.x, y: cursor.y };
}

/** Primer punto del recorrido a STUB del ancla, sin pasarse del objetivo. */
function stub(p, n, target) {
  const t = n.x !== 0 ? (target.x - p.x) * n.x : (target.y - p.y) * n.y;
  const d = Math.max(0, Math.min(STUB, t));
  return { x: p.x + n.x * d, y: p.y + n.y * d };
}

/** Convierte una lista de puntos libres en vértices ortogonales (un codo por tramo). */
function orthogonalize(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i += 1) {
    const a = out[out.length - 1];
    let b = pts[i];
    if (Math.abs(a.x - b.x) > ALIGN && Math.abs(a.y - b.y) > ALIGN) {
      out.push(Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
        ? { x: b.x, y: a.y }
        : { x: a.x, y: b.y });
    } else if (Math.abs(a.x - b.x) <= ALIGN) {
      // Tramo vertical: se empareja la x con el punto anterior para que el
      // trazado no quede torcido por décimas de píxel.
      b = { x: a.x, y: b.y };
    } else {
      b = { x: b.x, y: a.y };
    }
    out.push(b);
  }
  return dedupe(out);
}

/**
 * Empuja un punto fuera del interior de los nodos: un punto de giro nunca se
 * deja dentro de una figura, así el trazo visible no puede arise de ella.
 * @returns {x,y} el punto ya fuera (o el mismo si no hay nada que evitar)
 */
export function avoidNodes(p, rects = [], margen = 3) {
  let out = { x: p.x, y: p.y };
  for (const r of rects) {
    if (out.x <= r.x + margen || out.x >= r.x + r.w - margen) continue;
    if (out.y <= r.y + margen || out.y >= r.y + r.h - margen) continue;
    const d = {
      izq: out.x - (r.x - margen),
      der: r.x + r.w + margen - out.x,
      arr: out.y - (r.y - margen),
      aba: r.y + r.h + margen - out.y,
    };
    const min = Math.min(d.izq, d.der, d.arr, d.aba);
    if (min === d.izq) out = { x: r.x - margen, y: out.y };
    else if (min === d.der) out = { x: r.x + r.w + margen, y: out.y };
    else if (min === d.arr) out = { x: out.x, y: r.y - margen };
    else out = { x: out.x, y: r.y + r.h + margen };
  }
  return out;
}

/** Punto de una polilínea más cercano a (x, y): donde se engancha un control. */
export function nearestOnPolyline(pts, x, y) {
  let best = null;
  let bestD = Infinity;
  for (let i = 1; i < (pts || []).length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < bestD) { bestD = dist; best = { x: cx, y: cy }; }
  }
  return best;
}

/** Quita vértices duplicados o consecutivos colineales. */
function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.x - p.x) <= ALIGN && Math.abs(prev.y - p.y) <= ALIGN) continue;
    out.push({ x: p.x, y: p.y });
  }
  for (let i = out.length - 2; i >= 1; i -= 1) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    const collinear = (Math.abs(a.x - b.x) <= ALIGN && Math.abs(b.x - c.x) <= ALIGN)
      || (Math.abs(a.y - b.y) <= ALIGN && Math.abs(b.y - c.y) <= ALIGN);
    if (collinear) out.splice(i, 1);
  }
  return out;
}

/** Punto a mitad de recorrido de la polilínea (para la etiqueta del flujo). */
export function polyMid(pts) {
  if (!pts || !pts.length) return null;
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y };
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  let rest = total / 2;
  for (let i = 1; i < pts.length; i += 1) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (rest <= len) {
      const t = len ? rest / len : 0;
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
      };
    }
    rest -= len;
  }
  const last = pts[pts.length - 1];
  return { x: last.x, y: last.y };
}

/** Distancia de la etiqueta al eje del flujo. */
const LABEL_OFFSET = 15;

/**
 * Dónde y con qué orientación va la etiqueta de un flujo: se apoya sobre el
 * tramo más largo (por donde se lee la flecha) y se aparta de la línea, en
 * vertical si ese tramo es vertical y en horizontal si es horizontal.
 */
export function labelSpot(geo) {
  const pts = (geo && geo.pts) || [];
  let best = null;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!best || len > best.len) best = { a, b, len };
  }
  if (!best) {
    const p = (geo && geo.p2) || { x: 0, y: 0 };
    return { x: p.x, y: p.y - LABEL_OFFSET, vertical: false };
  }
  const x = (best.a.x + best.b.x) / 2;
  const y = (best.a.y + best.b.y) / 2;
  const vertical = Math.abs(best.b.y - best.a.y) >= Math.abs(best.b.x - best.a.x);
  return vertical
    ? { x: x + LABEL_OFFSET, y, vertical: true }
    : { x, y: y - LABEL_OFFSET, vertical: false };
}

export function edgePath(geo) {
  if (!geo) return '';
  const pts = geo.pts || [geo.p1, geo.p2];
  return pts.map((p, i) => `${i ? 'L' : 'M'} ${round(p.x)} ${round(p.y)}`).join(' ');
}

function round(v) {
  return Math.round(v * 100) / 100;
}

/** Rectángulo (con margen) que envuelve el trazado, para los puntos de selección. */
export function edgeBBox(geo, pad = 10) {
  if (!geo) return null;
  const pts = geo.pts || [geo.p1, geo.p2];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) - x + pad, h: Math.max(...ys) - y + pad };
}