/**
 * Alineación de nodos.
 *
 * Tres piezas, todas de lógica pura (sin DOM ni `document`, importables en Node
 * para las pruebas):
 *  - `unionBox`: la caja que engloba un grupo de rectángulos.
 *  - `snapMove`: las guías de arrastre. Mientras se mueve un grupo se buscan las
 *    líneas de los nodos que se quedan quietos (su borde inicial, su centro y su
 *    borde final, en horizontal y en vertical) y se corrige el desplazamiento
 *    para que alguna coincida. Es lo que hace que dos nodos de distinto tamaño
 *    queden de verdad en la misma fila o columna en vez de «casi».
 *  - `planAlign` / `planDistribute`: los comandos del inspector, que devuelven
 *    el plan de cambios en vez de aplicarlos (así el historial va antes de
 *    mutar).
 */

/** Caja que engloba unos rectángulos `{x, y, w, h}`; null si no hay ninguno. */
export function unionBox(rects) {
  const list = (rects || []).filter(Boolean);
  if (!list.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of list) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Las tres líneas de un rectángulo en un eje: inicio, centro y final. */
function marks(v, size) { return [v, v + size / 2, v + size]; }

/**
 * Líneas de alineación que ofrecen los nodos que no se están moviendo: por cada
 * uno, sus bordes y su centro en los dos ejes.
 * @param nodes nodos del diagrama
 * @param skip (opcional) Set de ids que se mueven y por tanto no son referencia
 */
export function alignTargets(nodes, skip) {
  const xs = [];
  const ys = [];
  for (const n of nodes || []) {
    if (skip && skip.has(n.id)) continue;
    for (const v of marks(n.x, n.w)) xs.push({ v, node: n });
    for (const v of marks(n.y, n.h)) ys.push({ v, node: n });
  }
  return { xs, ys };
}

/** Gana la corrección más pequeña y, a igualdad de distancia, la del centro. */
function mejorCorreccion(targets, lines0, tol) {
  let mejor = null;
  for (const t of targets) {
    for (let i = 0; i < lines0.length; i += 1) {
      const d = t.v - lines0[i];
      if (Math.abs(d) > tol) continue;
      if (mejor) {
        const cerca = Math.abs(d) < Math.abs(mejor.d) - 0.01;
        const empate = Math.abs(d) <= Math.abs(mejor.d) + 0.01 && i === 1;
        if (!cerca && !empate) continue;
      }
      mejor = { d, v: t.v, node: t.node, i };
    }
  }
  return mejor;
}

/** Margen con el que la guía sobresale por los dos extremos. */
const GUIDE_PAD = 16;

/**
 * Corrige el desplazamiento de un grupo en movimiento para que encaje en las
 * líneas de los nodos que no se mueven.
 *
 * Se comparan las tres líneas de la caja del grupo (borde, centro y borde) con
 * las de los demás nodos y, si alguna queda a menos de `tol`, se desplaza lo que
 * haga falta para que coincidan exactamente. La corrección se mide en unidades
 * del mundo: `tol` se pasa ya dividido por el zoom.
 *
 * @param nodes nodos del diagrama (los que se mueven pueden seguir ahí)
 * @param moving rectángulos del grupo, ya desplazados con `dx`/`dy`
 * @param dx,dy desplazamiento aplicado hasta ahora
 * @returns {{dx:number, dy:number, guides:Array}} `guides` describe las líneas
 *   cogidas (`{axis:'x'|'y', value, from, to}`) para poder dibujarlas
 */
export function snapMove(nodes, moving, dx, dy, { tol = 6, skip = null } = {}) {
  const box = unionBox(moving);
  if (!box) return { dx, dy, guides: [] };
  const targets = alignTargets(nodes, skip);
  const hx = mejorCorreccion(targets.xs, marks(box.x, box.w), tol);
  const hy = mejorCorreccion(targets.ys, marks(box.y, box.h), tol);
  const guides = [];
  if (hx) {
    const b = unionBox(moving.map((r) => ({ ...r, x: r.x + hx.d })));
    guides.push({
      axis: 'x', value: hx.v,
      from: Math.min(b.y, hx.node.y) - GUIDE_PAD,
      to: Math.max(b.y + b.h, hx.node.y + hx.node.h) + GUIDE_PAD,
    });
  }
  if (hy) {
    const b = unionBox(moving.map((r) => ({ ...r, y: r.y + hy.d })));
    guides.push({
      axis: 'y', value: hy.v,
      from: Math.min(b.x, hy.node.x) - GUIDE_PAD,
      to: Math.max(b.x + b.w, hy.node.x + hy.node.w) + GUIDE_PAD,
    });
  }
  return { dx: dx + (hx ? hx.d : 0), dy: dy + (hy ? hy.d : 0), guides };
}

/* ------------------------------------------------------------------ */
/* Comandos del inspector                                              */
/* ------------------------------------------------------------------ */

export const ALIGN_MODES = ['left', 'centerX', 'right', 'top', 'centerY', 'bottom'];

/**
 * Plan de alineación de `ids` según `mode` (`left|centerX|right|top|centerY|
 * bottom`). Con varios nodos se alinean entre sí; con uno solo se alinea contra
 * el resto del diagrama (si no hay nadie más, no hay nada que hacer).
 * @returns Array<{id, x, y>} sólo lo que cambia de sitio
 */
export function planAlign(d, ids, mode) {
  if (!ALIGN_MODES.includes(mode)) return [];
  const elegidos = d.nodes.filter((n) => ids.includes(n.id));
  if (!elegidos.length) return [];
  const otros = d.nodes.filter((n) => !ids.includes(n.id));
  const ref = elegidos.length > 1 ? unionBox(elegidos) : unionBox(otros);
  if (!ref) return [];
  const out = [];
  for (const n of elegidos) {
    let x = n.x;
    let y = n.y;
    if (mode === 'left') x = ref.x;
    else if (mode === 'right') x = ref.x + ref.w - n.w;
    else if (mode === 'centerX') x = ref.x + (ref.w - n.w) / 2;
    else if (mode === 'top') y = ref.y;
    else if (mode === 'bottom') y = ref.y + ref.h - n.h;
    else if (mode === 'centerY') y = ref.y + (ref.h - n.h) / 2;
    x = Math.round(x); y = Math.round(y);
    if (x !== n.x || y !== n.y) out.push({ id: n.id, x, y });
  }
  return out;
}

/**
 * Plan de reparto: reparte `ids` en huecos iguales a lo largo de `axis` (`x` o
 * `y`) dejando fijos el primero y el último. Necesita tres nodos o más y, si se
 * pisan entre sí (no caben), no propone nada.
 * @returns Array<{id, x, y}>
 */
export function planDistribute(d, ids, axis) {
  if (axis !== 'x' && axis !== 'y') return [];
  const horizontal = axis === 'x';
  const otros = d.nodes.filter((n) => ids.includes(n.id));
  if (otros.length < 3) return [];
  const orden = [...otros].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  const primero = orden[0];
  const ultimo = orden[orden.length - 1];
  const suma = orden.reduce((s, n) => s + (horizontal ? n.w : n.h), 0);
  const span = (horizontal ? ultimo.x + ultimo.w : ultimo.y + ultimo.h) - (horizontal ? primero.x : primero.y);
  const hueco = (span - suma) / (orden.length - 1);
  if (hueco < 0) return [];
  const out = [];
  let cursor = horizontal ? primero.x : primero.y;
  for (const n of orden) {
    const v = Math.round(cursor);
    const actual = horizontal ? n.x : n.y;
    if (v !== actual) out.push({ id: n.id, x: horizontal ? v : n.x, y: horizontal ? n.y : v });
    cursor += (horizontal ? n.w : n.h) + hueco;
  }
  return out;
}