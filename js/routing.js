/**
 * Geometría de los flujos.
 *
 * El usuario manda: el lado por el que la flecha sale y entra se elige pulsando
 * las bolitas del nodo (`edge.fromSide` / `edge.toSide`) y el recorrido se
 * indica con puntos de giro (`edge.way`). Aquí sólo se calcula dónde cae
 * exactamente cada flecha en su lado (centrada, o repartida si comparte lado con
 * más) y se ortogonala el recorrido en tramos rectos. No hay trazado automático.
 * Módulo autónomo (sin imports) para evitar ciclos con model.js.
 *
 * Dos reglas rigen siempre el trazado:
 *  - la flecha **sale y entra perpendicular** al lado del nodo: el primer tramo
 *    va por la normal de salida (`exitStub`) y el último por la normal de
 *    entrada (`withEntry`);
 *  - la flecha **no atraviesa nodos**: mientras se traza, la punta se detiene
 *    contra la cara del nodo (`wallLimit`) y el recorrido automático elige la
 *    forma de acercarse que no cruza ningún nodo (`obstaclesOf`).
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
  if (node.type === 'tiempo' || node.type === 'fork' || node.type === 'join') {
    // La barra de paralelismo y el reloj de arena sólo reciben y reparten por
    // su cara plana, que gira con el nodo: tumbados entran por los lados y de
    // pie por arriba y por abajo.
    if (node.rot === 90) {
      return {
        top: { x: cx, y: node.y },
        bottom: { x: cx, y: node.y + node.h },
      };
    }
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
 * sale por su cara plana (y la barra de paralelismo, fork/join, igual): tumbados
 * por los lados y de pie por arriba y por abajo. El resto de figuras admiten los
 * cuatro.
 */
export function nodeSides(node) {
  if (!node) return SIDES;
  if (node.type === 'tiempo' || node.type === 'fork' || node.type === 'join') {
    return node.rot === 90 ? ['top', 'bottom'] : ['left', 'right'];
  }
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
  if (node.type === 'tiempo' || node.type === 'fork' || node.type === 'join') {
    // Sólo tienen dos lados: el que mira al puntero en el eje de su cara plana.
    if (node.rot === 90) return p.y - centerY(node) > 0 ? 'bottom' : 'top';
    return p.x - centerX(node) > 0 ? 'right' : 'left';
  }
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
/**
 * Separación automática del primer tramo cuando el flujo discurre paralelo al
 * lado por el que sale: evita que la flecha se dibuje pegada al borde del nodo.
 * Es el único cambio de dirección que no marca el usuario con un clic.
 */
export const EXIT_GAP = STUB;
/**
 * Separación que se deja entre el trazo de una flecha y un nodo por el que no
 * puede pasar: la punta se detiene contra su cara, a esta distancia.
 */
export const WALL_MARGIN = 6;
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
  // Nodos que el flujo no puede atravesar (ni el origen ni el destino: de
  // esos sale y entra por sus lados).
  const obst = obstaclesOf(d, edge);
  const pts = way.length
    ? userRoute(p0, n0, p3, n1, way, obst)
    : linkRoute(p0, n0, p3, n1, obst, { from, to });
  // La flecha no atraviesa nodos ni en el trazo en curso ni una vez confirmado:
  // el recorrido final se detiene en la primera pared que encontraría. El resto
  // de nodos se aparta WALL_MARGIN; el origen y el destino, margen 0, porque la
  // flecha nace y muere a unos píxeles de su cara y con margen positivo se
  // recortaría a sí misma en el primer tramo.
  const otros = (d.nodes || []).filter((n) => n.id !== from.id && n.id !== to.id);
  let final = wallLimit(pts, otros);
  final = wallLimit(final, [from], 0);
  final = wallLimit(final, [to], 0);
  return { p1: p0, p2: p3, pts: final, mid: polyMid(final), sides };
}

/**
 * Nodos que un flujo no puede atravesar: todos los del diagrama menos el
 * origen y el destino (de esos sale y entra por sus lados).
 */
export function obstaclesOf(d, edge) {
  if (!d || !edge) return [];
  return (d.nodes || []).filter((n) => n.id !== edge.from && n.id !== edge.to);
}

/* ------------------------------------------------------------------ */
/* Trayectoria: los puntos que indica el usuario                      */
/* ------------------------------------------------------------------ */

/**
 * Recorrido con puntos de control: sale del ancla perpendicular a su lado,
 * encuadra cada tramo en un ángulo recto y entra en el destino por el lado que
 * indicó el usuario. El usuario sólo marca los puntos; aquí únicamente se
 * orthonormaliza el trazado. La salida usa el punto ya separado que guardó el
 * preview y la llegada se construye con `withEntry` para entrar perpendicular.
 * @returns Array<{x,y>} vértices de la polilínea
 */
export function userRoute(p0, n0, p3, n1, way, obst = []) {
  const body = orthogonalize([p0, exitStub(p0, n0, way[0] || p3), ...way]);
  return withEntry(body, p3, n1, obst);
}

/**
 * Recorrido sin puntos de giro: un único corte en L entre la salida y la
 * entrada. Es la flecha «por defecto»; si sale en paralelo al lado de un nodo,
 * el tramo se separa EXIT_GAP para no dibujarse encima del borde, y la llegada
 * siempre entra perpendicular (`withEntry`).
 *
 * Cuando se conocen los dos extremos (`opts.from` / `opts.to`) la L se elige
 * mirando también sus figuras: si las dos formas de la L atraviesan el nodo de
 * origen o el de destino, se prueba una S por un pasillo libre (`autoRoute`).
 * Sin esos datos el resultado es la L de siempre (lo usan las pruebas de la
 * geometría básica).
 */
export function linkRoute(p0, n0, p3, n1, obst = [], opts = null) {
  const body = orthogonalize([p0, exitStub(p0, n0, p3)]);
  if (opts && (opts.from || opts.to)) {
    return autoRoute(p0, n0, p3, n1, obst, opts.from, opts.to);
  }
  return withEntry(body, p3, n1, obst);
}

/**
 * Trazado por defecto de una flecha sin puntos de giro. Prueba las dos L
 * posibles (entrar en horizontal o en vertical primero) y, si ambas chocan con
 * el origen o el destino, una S que pasa por un pasillo libre entre las dos
 * figuras. Elige la primera forma que no atraviesa ningún nodo; a igualdad,
 * la de menos codos y más corta.
 *
 * Así una flecha que sale por abajo hacia un nodo que está arriba y a la
 * derecha no puede «volver a entrar» en su propio nodo de origen: la L que lo
 * hacía pierde frente a la S que lo rodea.
 *
 * @param obst nodos intermedios (sin origen ni destino)
 * @param from,to nodos de los dos extremos (para conocer sus cajas)
 */
export function autoRoute(p0, n0, p3, n1, obst = [], from = null, to = null) {
  const body = orthogonalize([p0, exitStub(p0, n0, p3)]);
  const prev = body[body.length - 1] || p3;
  const rects = [from, to, ...(obst || [])].filter(Boolean);
  const candidatas = [];

  // Las dos L: acercarse al destino en horizontal o en vertical primero.
  for (const variante of ['a', 'b']) {
    candidatas.push(dedupe([...body, ...entryTail(prev, p3, n1, variante)]));
  }

  // Sólo tiene sentido la S cuando los dos extremos salen/entran por caras
  // paralelas: el pasillo va en el eje perpendicular.
  if (n0.x === 0 && n1.x === 0) {
    for (const xc of pasillosX(from, to, p0, p3)) {
      candidatas.push(zRouteV(p0, prev, p3, n1, xc));
    }
  }
  if (n0.y === 0 && n1.y === 0) {
    for (const yc of pasillosY(from, to, p0, p3)) {
      candidatas.push(zRouteH(p0, prev, p3, n1, yc));
    }
  }

  let mejor = null;
  for (const pts of candidatas) {
    const score = routeScore(pts, rects, from, to);
    if (!mejor || score < mejor.score) mejor = { pts, score };
  }
  return mejor ? mejor.pts : body;
}

/** S con dos codos cuando la salida y la entrada son verticales. */
function zRouteV(p0, prev, p3, n1, xc) {
  const ey = p3.y + n1.y * EXIT_GAP;
  return dedupe([
    { x: p0.x, y: p0.y },
    { x: prev.x, y: prev.y },
    { x: xc, y: prev.y },
    { x: xc, y: ey },
    { x: p3.x, y: ey },
    { x: p3.x, y: p3.y },
  ]);
}

/** S con dos codos cuando la salida y la entrada son horizontales. */
function zRouteH(p0, prev, p3, n1, yc) {
  const ex = p3.x + n1.x * EXIT_GAP;
  return dedupe([
    { x: p0.x, y: p0.y },
    { x: prev.x, y: prev.y },
    { x: prev.x, y: yc },
    { x: ex, y: yc },
    { x: ex, y: p3.y },
    { x: p3.x, y: p3.y },
  ]);
}

/**
 * Pasillos verticales por los que puede bajar/subir la S: los bordes de las dos
 * figuras separados EXIT_GAP, el hueco entre ellas y las propias líneas de los
 * anclajes.
 */
function pasillosX(from, to, p0, p3) {
  const out = [];
  const push = (v) => {
    if (!Number.isFinite(v)) return;
    if (out.some((q) => Math.abs(q - v) <= ALIGN)) return;
    out.push(v);
  };
  if (from) {
    push(from.x - EXIT_GAP);
    push(from.x + from.w + EXIT_GAP);
  }
  if (to) {
    push(to.x - EXIT_GAP);
    push(to.x + to.w + EXIT_GAP);
  }
  if (from && to) {
    if (from.x + from.w < to.x) push((from.x + from.w + to.x) / 2);
    if (to.x + to.w < from.x) push((to.x + to.w + from.x) / 2);
  }
  push(p0.x);
  push(p3.x);
  const minX = Math.min(from ? from.x : p0.x, to ? to.x : p3.x);
  const maxX = Math.max(from ? from.x + from.w : p0.x, to ? to.x + to.w : p3.x);
  push(minX - EXIT_GAP);
  push(maxX + EXIT_GAP);
  return out;
}

/** Lo mismo que `pasillosX`, en horizontal. */
function pasillosY(from, to, p0, p3) {
  const out = [];
  const push = (v) => {
    if (!Number.isFinite(v)) return;
    if (out.some((q) => Math.abs(q - v) <= ALIGN)) return;
    out.push(v);
  };
  if (from) {
    push(from.y - EXIT_GAP);
    push(from.y + from.h + EXIT_GAP);
  }
  if (to) {
    push(to.y - EXIT_GAP);
    push(to.y + to.h + EXIT_GAP);
  }
  if (from && to) {
    if (from.y + from.h < to.y) push((from.y + from.h + to.y) / 2);
    if (to.y + to.h < from.y) push((to.y + to.h + from.y) / 2);
  }
  push(p0.y);
  push(p3.y);
  const minY = Math.min(from ? from.y : p0.y, to ? to.y : p3.y);
  const maxY = Math.max(from ? from.y + from.h : p0.y, to ? to.y + to.h : p3.y);
  push(minY - EXIT_GAP);
  push(maxY + EXIT_GAP);
  return out;
}

/**
 * Puntuación de una candidata: atravesar un nodo pesa muchísimo (el origen
 * todavía más: una flecha nunca puede cruzarse a sí misma), y entre las que
 * están limpias gana la de menos codos y, después, la más corta.
 */
function routeScore(pts, rects, from, to) {
  let peso = 0;
  for (const r of rects) {
    if (!cruzaNodos(pts, [r], 0)) continue;
    peso += r === from ? 1e6 : r === to ? 1e5 : 1e3;
  }
  let largo = 0;
  for (let i = 1; i < pts.length; i += 1) {
    largo += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return peso * 1e6 + (pts.length - 2) * 1e4 + largo;
}

/**
 * Trozo visible mientras se traza: desde el ancla de salida, pasando por los
 * puntos de giro ya fijados y terminando en `cola`. `cola` es el punto guiado
 * por el cursor (`guidePoint`/`exitGuide`); no se añade ningún codo automático
 * hacia el puntero: cada cambio de dirección lo fija el usuario con un clic.
 */
export function userRouteTip(p0, n0, way, cola) {
  const fin = (Array.isArray(cola) ? cola : [cola]).filter(Boolean);
  const objetivo = way[0] || fin[0] || p0;
  const pts = [p0, exitStub(p0, n0, objetivo)];
  for (const p of way) pts.push({ x: p.x, y: p.y });
  for (const p of fin) pts.push({ x: p.x, y: p.y });
  return orthogonalize(pts);
}

/**
 * Punto de arranque del recorrido: el primer tramo va por la normal del lado
 * por el que sale la flecha, así que **sale perpendicular** aunque el primer
 * punto de giro caiga en paralelo al borde del nodo.
 *
 * - Si el destino está en esa línea (a lo largo de la normal) se va recto
 *   hasta él, sin salirse del nodo.
 * - Si el destino se queda a un lado, la flecha se separa EXIT_GAP del borde
 *   antes de girar (y nunca sale hacia dentro del nodo).
 *
 * @param p ancla de salida
 * @param n normal del lado de salida
 * @param target primer punto hacia el que va el recorrido
 */
export function exitStub(p, n, target) {
  const dx = target.x - p.x;
  const dy = target.y - p.y;
  const d = dx * n.x + dy * n.y;               // distancia por la normal
  const lado = Math.abs(dx * n.y + dy * n.x);  // distancia a lo largo del lado
  // El primer tramo sale por la normal: si el objetivo no está en la dirección
  // de salida (o está justo en el ancla), igual hay que salir del nodo antes de
  // poder girar — nunca se deja el tramo pegado al borde con longitud 0.
  const largo = lado <= ALIGN
    ? Math.max(0, Math.min(EXIT_GAP, d > 0 ? d : EXIT_GAP))
    : (d > 0 ? Math.min(EXIT_GAP, d) : EXIT_GAP);
  return { x: p.x + n.x * largo, y: p.y + n.y * largo };
}

/**
 * Punto hacia el que se guía el trazo: se mueve en horizontal o en vertical
 * según el eje que domina desde `from`. `axis` fija el sentido ya elegido y sólo
 * cambia cuando el cursor se va claramente por el otro eje, para que la línea
 * no parpadee al mover el ratón en diagonal.
 */
export function guidePoint(from, cursor, axis = null) {
  const ax = guideAxis(from, cursor, axis);
  return ax === 'x' ? { x: cursor.x, y: from.y } : { x: from.x, y: cursor.y };
}

/**
 * Eje en el que se mueve el trazo. El eje elegido sólo cambia cuando el cursor
 * se va claramente por el otro, para que la línea no parpadee al mover el ratón
 * en diagonal. Se devuelve aparte porque el caller necesita recordarlo: si la
 * punta se para contra un nodo, el eje no debe cambiar por eso.
 */
export function guideAxis(from, cursor, axis = null) {
  const dx = Math.abs(cursor.x - from.x);
  const dy = Math.abs(cursor.y - from.y);
  let ax = axis;
  if (!ax || (dx <= ALIGN && dy <= ALIGN)) ax = dx >= dy ? 'x' : 'y';
  else if (ax === 'x' && dy > dx) ax = 'y';
  else if (ax === 'y' && dx > dy) ax = 'x';
  return ax;
}

/**
 * Punto guía del primer tramo: si el eje elegido corre paralelo al lado de
 * salida, se separa EXIT_GAP del nodo para que la flecha no se dibuje sobre el
 * borde; si no, pasa por la proyección del puntero. Es una de las dos
 * desviaciones automáticas; la otra es la llegada perpendicular (`withEntry`).
 * El resto de cambios de dirección los fija el usuario al clicar.
 */
export function exitGuide(p0, n0, axis, cursor) {
  const d = saleParalelo(n0, axis) ? EXIT_GAP : 0;
  const tip = axis === 'x'
    ? { x: cursor.x, y: p0.y + n0.y * d }
    : { x: p0.x + n0.x * d, y: cursor.y };
  // El guiado puede apuntar hacia dentro del nodo (por ejemplo: salir por abajo y
  // dirigirse a un destino que está más arriba). El primer tramo sale por la
  // normal (`exitStub`) y son los muros los que detienen la punta del trazo, no
  // el recalculo del punto guiado.
  return tip;
}

/** ¿El eje del primer tramo discurre paralelo al lado de salida? */
function saleParalelo(n, axis) {
  return n.x !== 0 ? axis === 'y' : axis === 'x';
}

/**
 * Cola de llegada: obliga a entrar perpendicular al lado del nodo destino. Se
 * pasa por un punto a EXIT_GAP del borde sobre la normal y desde ahí se entra
 * recto; el codo previo se coloca en la misma línea de separación para que el
 * último tramo nunca discurra pegado al borde. Si el recorrido ya venía por esa
 * normal, los puntos intermedios desaparecen al limpiar los colineales.
 * @param variante 'a' llega en horizontal primero; 'b', en vertical primero.
 */
function entryTail(prev, p3, n, variante) {
  const s = { x: p3.x + n.x * EXIT_GAP, y: p3.y + n.y * EXIT_GAP };
  const c = variante === 'b'
    ? (n.x !== 0 ? { x: prev.x, y: s.y } : { x: s.x, y: prev.y })
    : (n.x !== 0 ? { x: s.x, y: prev.y } : { x: prev.x, y: s.y });
  return [c, s, { x: p3.x, y: p3.y }];
}

/**
 * Añade la cola de llegada al cuerpo ya ortogonal y limpia los colineales.
 * La llegada es siempre perpendicular al lado del destino. Si con esa forma de
 * acercarse el recorrido cruza algún nodo, se prueba la otra (vertical primero
 * en vez de horizontal) y se queda con la que no lo cruza.
 */
function withEntry(body, p3, n, obst = []) {
  const prev = body[body.length - 1] || p3;
  const a = dedupe([...body, ...entryTail(prev, p3, n, 'a')]);
  if (!obst || !obst.length) return a;
  const b = dedupe([...body, ...entryTail(prev, p3, n, 'b')]);
  if (!cruzaNodos(a, obst)) return a;
  if (!cruzaNodos(b, obst)) return b;
  return a;
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

/* ------------------------------------------------------------------ */
/* Los nodos que el trazo no puede atravesar                            */
/* ------------------------------------------------------------------ */

/**
 * ¿El tramo entre `a` y `b` atraviesa el rectángulo `r`? Los tramos del
 * trazado son ortogonales, así que basta con mirar en qué eje se mueven y el
 * recorrido en el otro.
 */
export function segmentCrosses(a, b, r, margen = WALL_MARGIN) {
  if (!a || !b || !r) return false;
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  if (Math.abs(a.y - b.y) <= ALIGN) {
    // Tramo horizontal.
    if (a.y <= r.y - margen || a.y >= r.y + r.h + margen) return false;
    return x2 > r.x - margen && x1 < r.x + r.w + margen;
  }
  if (Math.abs(a.x - b.x) <= ALIGN) {
    // Tramo vertical.
    if (a.x <= r.x - margen || a.x >= r.x + r.w + margen) return false;
    return y2 > r.y - margen && y1 < r.y + r.h + margen;
  }
  return diagonalToca(a, b, r, margen);
}

/** ¿El segmento oblicuo (a,b) toca el rectángulo `r`? (Liang-Barsky.) */
function diagonalToca(a, b, r, margen) {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [
    a.x - (r.x - margen),
    (r.x + r.w + margen) - a.x,
    a.y - (r.y - margen),
    (r.y + r.h + margen) - a.y,
  ];
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return true;
}

/**
 * ¿Alguno de los tramos del recorrido atraviesa algún nodo?
 */
export function cruzaNodos(pts, rects = [], margen = WALL_MARGIN) {
  for (let i = 1; i < (pts || []).length; i += 1) {
    for (const r of rects || []) {
      if (segmentCrosses(pts[i - 1], pts[i], r, margen)) return true;
    }
  }
  return false;
}

/**
 * Recorta el recorrido para que **no atraviese nodos**: se queda con el trozo
 * que llega hasta la primera cara que encontraría. No se mira sólo el último
 * tramo: un giro ya fijado puede llevar el trazo contra un nodo antes de la
 * punta, y entonces la punta se para ahí. El primer punto siempre se conserva
 * (es el ancla de salida, ya fuera del nodo).
 *
 * Se usa mientras se traza; lo que el usuario ve es exactamente lo que puede
 * clicar. Los tramos ya confirmados no se reescriben: si un punto de giro
 * quedó mal, se arrastra.
 */
export function wallLimit(pts, rects = [], margen = WALL_MARGIN) {
  if (!pts || pts.length < 2 || !rects || !rects.length) return pts;
  const out = [{ x: pts[0].x, y: pts[0].y }];
  for (let i = 1; i < pts.length; i += 1) {
    const a = out[out.length - 1];
    const b = pts[i];
    const choque = primerChoque(a, b, rects, margen);
    if (choque) {
      if (Math.hypot(choque.x - a.x, choque.y - a.y) > ALIGN) out.push(choque);
      return out;
    }
    out.push({ x: b.x, y: b.y });
  }
  return out;
}

/**
 * Primer punto del tramo `a`→`b` que toca algún rectángulo. Devuelve `null` si
 * el tramo está libre. Los tramos ortogonales se resuelven con una comparación
 * de bandas; los oblicuos (no deberían llegar aquí) con Liang-Barsky.
 */
function primerChoque(a, b, rects, margen) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const largo = Math.hypot(dx, dy);
  if (largo <= ALIGN) return null;
  let t = null;
  for (const r of rects) {
    const tRect = entradaRect(a, b, r, margen);
    if (tRect !== null && (t === null || tRect < t)) t = tRect;
  }
  if (t === null) return null;
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/**
 * Instante `t` (0..1) en el que el tramo `a`→`b` entra en el rectángulo, o
 * `null` si no lo toca. Si el punto de partida ya está dentro, devuelve 0.
 */
function entradaRect(a, b, r, margen) {
  const x1 = r.x - margen;
  const x2 = r.x + r.w + margen;
  const y1 = r.y - margen;
  const y2 = r.y + r.h + margen;
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (a.x > x1 && a.x < x2 && a.y > y1 && a.y < y2) return 0;

  if (Math.abs(dy) <= ALIGN) {
    // Tramo horizontal: la banda vertical decide si pasa por el alto.
    if (a.y <= y1 || a.y >= y2) return null;
    const x = dx > 0 ? x1 : x2;
    if (dx > 0 ? (x >= a.x && x <= b.x) : (x <= a.x && x >= b.x)) {
      return Math.abs(dx) > ALIGN ? (x - a.x) / dx : null;
    }
    return null;
  }
  if (Math.abs(dx) <= ALIGN) {
    // Tramo vertical: la banda horizontal decide si pasa por el ancho.
    if (a.x <= x1 || a.x >= x2) return null;
    const y = dy > 0 ? y1 : y2;
    if (dy > 0 ? (y >= a.y && y <= b.y) : (y <= a.y && y >= b.y)) {
      return Math.abs(dy) > ALIGN ? (y - a.y) / dy : null;
    }
    return null;
  }
  return entradaOblicua(a, b, x1, x2, y1, y2);
}

/** Liang-Barsky: primer `t` del segmento dentro del rectángulo, o `null`. */
function entradaOblicua(a, b, x1, x2, y1, y2) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - x1, x2 - a.x, a.y - y1, y2 - a.y];
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return t0;
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