import { edgeGeometry, SIDES } from './routing.js';

/**
 * Modelo de datos del diagrama de actividades.
 *
 * Nodos: start | end | activity | decision | fork | join | note
 * Flujos: { id, from, to, label, condition, kind }
 * Carriles (swimlanes): bandas horizontales que agrupan nodos por responsabilidad.
 */

/** Diámetro máximo de los círculos inicial/final. */
export const DOT_MAX = 28;
/**
 * El punto muerto es el mismo círculo que el inicio/fin, pero STOP_SCALE veces
 * más grande en todo su rango de tamaños (de ahí que su lado por defecto, su
 * mínimo y su máximo se deriven de los del inicio/fin en lugar de ir a mano).
 */
export const STOP_SCALE = 2.25;
/** Diámetro máximo del punto muerto. */
export const DOT_MAX_STOP = Math.round(DOT_MAX * STOP_SCALE);

/** Diámetro máximo de un nodo circular según su tipo. */
export function dotMax(type) {
  return type === 'stop' ? DOT_MAX_STOP : DOT_MAX;
}

/**
 * Margen que se deja arriba y abajo dentro de un carril: los nodos no quedan
 * pegados al borde ni al asidero de la cabecera.
 */
export const LANE_PAD = 12;

export const NODE_TYPES = {
  // Nodo inicial: círculo relleno.
  start: { label: 'Inicio', shape: 'initial', w: 20, h: 20, minW: 12, minH: 12, terminal: true },
  // Nodo final: círculo relleno con su contorno exterior.
  end: { label: 'Fin', shape: 'final', w: 20, h: 20, minW: 12, minH: 12, terminal: true },
  // Punto muerto: círculo con una diagonal (de abajo a arriba): el flujo se
  // detiene aquí y no continúa (una vía muerta del proceso). Es un círculo
  // STOP_SCALE veces mayor que el de inicio/fin (45 de lado por defecto, hasta 63).
  stop: { label: 'Punto muerto', shape: 'stop', w: 20 * STOP_SCALE, h: 20 * STOP_SCALE, minW: 12 * STOP_SCALE, minH: 12 * STOP_SCALE, terminal: true },
  activity: { label: 'Actividad', shape: 'activity', w: 176, h: 64, minW: 100, minH: 44 },
  // Proceso: la misma caja redondeada que la acción, con un tridente invertido
  // (una barra y sus tres púas hacia abajo) en la esquina inferior derecha.
  proceso: { label: 'Proceso', shape: 'process', w: 176, h: 64, minW: 100, minH: 44 },
  // Tiempo: la figura es el propio reloj de arena girado 90° (dos barras
  // verticales a los lados y la cruz de las diagonales). Es cuadrado y algo más
  // pequeño que una actividad (176x64); no cabe texto dentro, así que va sin nombre.
  // Es orientable: girado 90° el reloj queda de pie (barras arriba y abajo).
  tiempo: { label: 'Tiempo', shape: 'time', w: 56, h: 56, minW: 40, minH: 40, rotatable: true },
  // Enviar notificación: caja de esquinas rectas que acaba en un pico hacia
  // fuera por la derecha.
  enviar: { label: 'Enviar notificación', shape: 'send', w: 176, h: 64, minW: 110, minH: 44 },
  // Recibir notificación: la misma caja, con una muesca triangular hacia
  // dentro por la izquierda.
  recibir: { label: 'Recibir notificación', shape: 'receive', w: 176, h: 64, minW: 110, minH: 44 },
  // Objeto: caja de esquinas rectas con nombre y, opcionalmente, un estado
  // entre << >> debajo. Admite cualquier número de entradas y salidas.
  objeto: { label: 'Objeto', shape: 'object', w: 148, h: 60, minW: 96, minH: 48 },
  // Decisión: cuadrado rotado 45° (puntas arriba/abajo/izq/der). w == h para que sea un cuadrado perfecto.
  decision: { label: 'Decisión', shape: 'decision', w: 132, h: 132, minW: 88, minH: 88 },
  // Barras de paralelismo: banda fina y alta, con esquinas rectas. Orientables:
  // giradas 90° la banda queda tumbada (horizontal).
  fork: { label: 'Paralelo (fork)', shape: 'bar', w: 12, h: 136, minW: 8, minH: 72, rotatable: true },
  join: { label: 'Paralelo (join)', shape: 'bar', w: 12, h: 136, minW: 8, minH: 72, rotatable: true },
  note: { label: 'Nota', shape: 'note', w: 168, h: 76, minW: 110, minH: 52 },
};

let counter = 0;
export function uid(prefix = 'n') {
  counter += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * Texto por defecto de un nodo nuevo. Las barras de paralelismo (fork/join) no
 * llevan etiqueta: su forma ya dice si dividen o sincronizan el flujo.
 */
export function defaultLabel(type) {
  return type === 'fork' || type === 'join' ? '' : (NODE_TYPES[type]?.label ?? '');
}

export function createNode(type, x, y, patch = {}) {
  const t = NODE_TYPES[type] || NODE_TYPES.activity;
  let w = patch.w ?? t.w;
  let h = patch.h ?? t.h;
  if (type === 'decision' || type === 'tiempo') {
    // Mantener siempre un cuadrado perfecto (la decisión con puntas verticales,
    // el reloj de arena con sus barras horizontales).
    const s = Math.max(w, h, t.minW, t.minH);
    w = s; h = s;
  }
  if (type === 'start' || type === 'end' || type === 'stop') {
    // Los nodos inicial/final/punto muerto son círculos: siempre cuadrados y
    // sin pasar de su diámetro máximo (el del punto muerto es mayor).
    const s = Math.min(dotMax(type), Math.max(w, h, t.minW, t.minH));
    w = s; h = s;
  }
  const { w: _pw, h: _ph, x: _px, y: _py, rot: _rot, ...rest } = patch;
  void _pw; void _ph; void _px; void _py; void _rot;
  return {
    id: uid('n'),
    type,
    x: Math.round(x - w / 2),
    y: Math.round(y - h / 2),
    w,
    h,
    label: rest.label ?? defaultLabel(type),
    note: '',
    lane: null,
    // Orientación: 0 = tal como viene de fábrica, 90 = girado un cuarto de
    // vuelta. Sólo la usan los nodos orientables (ver `isRotatable`).
    rot: _rot === 90 ? 90 : 0,
    ...rest,
  };
}

/* ------------------------------------------------------------------ */
/* Orientación de los nodos                                           */
/* ------------------------------------------------------------------ */

/**
 * Tipos de nodo que se pueden girar: la barra de paralelismo (fork/join) y el
 * reloj de arena (tiempo). Los demás nodos no tienen orientación: su figura
 * es la misma en cualquier sentido.
 */
export function isRotatable(node) {
  return !!(node && NODE_TYPES[node.type]?.rotatable);
}

/**
 * Lado equivalente al girar el nodo un cuarto de vuelta: la cara plana por la
 * que entran las flechas pasa del lateral al horizontal (o al revés).
 */
const SIDE_GIRO = { left: 'top', right: 'bottom', top: 'left', bottom: 'right' };

/**
 * Gira el nodo 90° **sobre su centro**: el nodo se queda donde está y sólo
 * cambia de forma. Sus medidas se intercambian y las bolitas de los flujos
 * pasan al lado equivalente (izquierda<->arriba, derecha<->abajo) para que la
 * flecha siga entrando y saliendo por el mismo sitio relativo.
 *
 * Sólo hay dos orientaciones: la de fábrica (0) y la girada (90). Como estas
 * figuras son simétricas respecto de su centro, girar dos veces vuelve al
 * punto de partida.
 * @param dir 1 = sentido horario, -1 = antihorario.
 * @returns true si el nodo ha cambiado de orientación.
 */
export function rotateNode(d, node, dir = 1) {
  if (!isRotatable(node)) return false;
  const antes = node.rot || 0;
  const despues = (((antes + 90 * dir) % 180) + 180) % 180;
  if (despues === antes) return false;
  node.rot = despues;
  // Al intercambiarse ancho y alto, se compensa la esquina para que el centro
  // no se mueva (antes giraba alrededor de la esquina superior izquierda).
  const w = node.w;
  const h = node.h;
  node.x += (w - h) / 2;
  node.y += (h - w) / 2;
  node.w = h;
  node.h = w;
  for (const e of (d && d.edges) || []) {
    if (e.from === node.id) e.fromSide = SIDE_GIRO[e.fromSide] || e.fromSide;
    if (e.to === node.id) e.toSide = SIDE_GIRO[e.toSide] || e.toSide;
  }
  return true;
}

/**
 * Nombre de la orientación actual del nodo, para el inspector.
 */
export function orientationLabel(node) {
  if (!isRotatable(node)) return '';
  if (node.type === 'tiempo') {
    // El reloj de fábrica está tumbado (sus barras planas quedan a los lados).
    return node.rot === 90
      ? 'Vertical (barras arriba y abajo)'
      : 'Horizontal (barras a los lados)';
  }
  return node.rot === 90 ? 'Horizontal' : 'Vertical';
}

/**
 * Medidas mínimas de un nodo en su orientación actual: la barra de paralelismo
 * girada se acorta por el otro lado.
 */
export function minSize(node) {
  const t = NODE_TYPES[node.type];
  if (!t) return { w: 0, h: 0 };
  if (node.rot === 90 && (node.type === 'fork' || node.type === 'join')) {
    return { w: t.minH, h: t.minW };
  }
  return { w: t.minW, h: t.minH };
}

/**
 * Tamaño que le corresponde a un nodo al estirarlo con el asidero. La barra de
 * paralelismo **sólo se estira por su largo**: su grosor (lo que mide la barra
 * de ancho estando vertical, o de alto estando horizontal) no cambia nunca.
 * El resto de nodos se queda con el tamaño pedido, sin bajar de sus mínimos.
 */
export function resizeTo(node, w, h) {
  const min = minSize(node);
  if (node.type === 'fork' || node.type === 'join') {
    return node.rot === 90
      ? { w: Math.max(min.w, w), h: Math.max(min.h, node.h) }
      : { w: Math.max(min.w, node.w), h: Math.max(min.h, h) };
  }
  return { w: Math.max(min.w, w), h: Math.max(min.h, h) };
}

/**
 * `fromSide`/`toSide` son las bolitas por las que la flecha sale y entra: las
 * elige el usuario al conectar. `way` son sus puntos de giro: si hay alguno, el
 * recorrido es el que ha indicado; si no, un único corte en L entre las dos
 * bolitas (la flecha «por defecto»).
 */
export function createEdge(from, to, patch = {}) {
  return {
    id: uid('e'),
    from,
    to,
    fromSide: 'right',
    toSide: 'left',
    label: '',
    condition: '',
    kind: 'flow',
    way: [],
    ...patch,
  };
}

export function createLane(name, index) {
  return { id: uid('l'), name: name || `Carril ${index + 1}`, height: 180 };
}

export function createDiagram(patch = {}) {
  return {
    version: 1,
    name: 'Diagrama de actividades',
    // Los carriles son bandas horizontales (una fila por actor) salvo que el
    // diagrama se ponga en vertical (una columna por actor). `lane.height` es
    // siempre el grosor de la banda: el alto en horizontal y el ancho en vertical.
    laneOrientation: 'horizontal',
    lanes: [],
    nodes: [],
    edges: [],
    view: { x: 0, y: 0, k: 1 },
    ...patch,
  };
}

/** Diagrama de ejemplo: pedido con decisión, fork/join y dos carriles. */
export function sampleDiagram() {
  const lanes = [createLane('Cliente', 0), createLane('Sistema', 1)];
  lanes[0].height = 200;
  lanes[1].height = 440;

  const mk = (type, x, y, patch) => createNode(type, x, y, patch);
  const nodes = [
    mk('start', 140, 300, { label: 'Solicitar producto' }),
    mk('activity', 380, 300, { label: 'Registrar pedido' }),
    mk('decision', 640, 300, { label: '¿Stock disponible?' }),
    mk('activity', 900, 190, { label: 'Reservar stock' }),
    mk('activity', 900, 410, { label: 'Notificar falta' }),
    // El fork tiene una sola entrada y varias salidas.
    mk('fork', 1130, 300, { label: 'Fork' }),
    mk('activity', 1330, 190, { label: 'Generar factura' }),
    mk('activity', 1330, 410, { label: 'Enviar correo' }),
    // El join tiene varias entradas y una sola salida.
    mk('join', 1560, 300, { label: 'Join' }),
    mk('end', 1800, 300, { label: 'Pedido confirmado' }),
    mk('end', 1150, 560, { label: 'Pedido rechazado' }),
    mk('note', 640, 560, { label: 'Si no hay stock, se ofrece un producto similar.' }),
  ];
  const e = (from, to, label, condition, patch) =>
    createEdge(from, to, { label, condition, ...patch });
  const byLabel = (l) => nodes.find((n) => n.label === l).id;

  const edges = [
    e(byLabel('Solicitar producto'), byLabel('Registrar pedido')),
    e(byLabel('Registrar pedido'), byLabel('¿Stock disponible?')),
    // Las ramas se escriben a mano: la condición es la guarda UML y la etiqueta
    // es el texto que se ve junto a la flecha. Cada rama sale por su bolita
    // (arriba la afirmativa, abajo la negativa) y lleva su punto de giro.
    e(byLabel('¿Stock disponible?'), byLabel('Reservar stock'), 'hay stock', 'stock > 0', {
      fromSide: 'top', toSide: 'left', way: [{ x: 700, y: 190 }],
    }),
    e(byLabel('¿Stock disponible?'), byLabel('Notificar falta'), 'no hay stock', 'stock <= 0', {
      fromSide: 'bottom', toSide: 'left', way: [{ x: 700, y: 410 }],
    }),
    e(byLabel('Reservar stock'), byLabel('Fork')),
    e(byLabel('Fork'), byLabel('Generar factura')),
    e(byLabel('Fork'), byLabel('Enviar correo')),
    e(byLabel('Generar factura'), byLabel('Join')),
    e(byLabel('Enviar correo'), byLabel('Join')),
    e(byLabel('Join'), byLabel('Pedido confirmado')),
    e(byLabel('Notificar falta'), byLabel('Pedido rechazado')),
  ];

  // El fork y el join se dibujan sin texto (fueron sólo el asidero para montar
  // los flujos): una barra de paralelismo no necesita nombre.
  for (const n of nodes) if (n.type === 'fork' || n.type === 'join') n.label = '';

  const d = createDiagram({ name: 'Pedido de producto', lanes, nodes, edges });
  assignLanes(d);
  return d;
}

/* ------------------------------------------------------------------ */
/* Consultas y operaciones                                            */
/* ------------------------------------------------------------------ */

export const byId = (list, id) => list.find((it) => it.id === id);

export function nodeById(d, id) { return byId(d.nodes, id); }
export function edgeById(d, id) { return byId(d.edges, id); }

export function outEdges(d, id) { return d.edges.filter((e) => e.from === id); }
export function inEdges(d, id) { return d.edges.filter((e) => e.to === id); }

/**
 * Papel real de una barra de paralelo según sus flechas, no según su tipo
 * guardado. Una misma barra es fork o join dependiendo de lo que la conectan:
 * - `fork`: reparte el flujo (2+ salidas y como mucho una entrada).
 * - `join`: sincroniza ramas (2+ entradas y como mucho una salida).
 * - `both`: hace las dos cosas (2+ entradas y 2+ salidas).
 * - `none`: todavía no tiene flechas suficientes para ser ninguna de las dos.
 */
export function barRole(d, id) {
  const ins = inEdges(d, id).length;
  const outs = outEdges(d, id).length;
  if (ins >= 2 && outs >= 2) return 'both';
  if (ins >= 2) return 'join';
  if (outs >= 2) return 'fork';
  return 'none';
}

/**
 * Ajusta el tipo (`fork` o `join`) de una barra al papel que le dan sus flechas.
 * Con `both` o `none` se respeta el tipo actual: el usuario aún puede estar
 * montando el flujo o la barra es a la vez unión y bifurcación.
 * @returns el papel calculado, o null si el nodo no es una barra.
 */
export function syncBarType(d, id) {
  const n = nodeById(d, id);
  if (!n || (n.type !== 'fork' && n.type !== 'join')) return null;
  const role = barRole(d, id);
  if (role === 'fork') n.type = 'fork';
  else if (role === 'join') n.type = 'join';
  return role;
}

/** Sincroniza el tipo de varias barras (ignora ids repetidos o ajenos). */
export function syncBarTypes(d, ids) {
  for (const id of new Set(ids)) syncBarType(d, id);
}

/** Ids de las barras de paralelo del diagrama. */
export function barIds(d) {
  return d.nodes.filter((n) => n.type === 'fork' || n.type === 'join').map((n) => n.id);
}

export function center(n) { return { x: n.x + n.w / 2, y: n.y + n.h / 2 }; }

export function bounds(d) {
  if (!d.nodes.length) return { x: 0, y: 0, w: 1200, h: 700 };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of d.nodes) {
    x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y);
    x2 = Math.max(x2, n.x + n.w); y2 = Math.max(y2, n.y + n.h);
  }
  // Los flujos también cuentan: una trayectoria indicada a mano puede salirse
  // del recuadro de los nodos y si no, se recortaría al exportar o al encuadrar.
  for (const e of d.edges) {
    for (const p of edgeGeometry(d, e)?.pts || []) {
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
    }
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** ¿Los carriles son columnas verticales? */
export function isVerticalLanes(d) {
  return d?.laneOrientation === 'vertical';
}

/**
 * Coordenada de un nodo en el eje de los carriles: su `y` cuando las bandas son
 * horizontales y su `x` cuando son verticales. Es lo que decide a qué carril
 * pertenece.
 */
export function laneCoord(d, node) {
  return isVerticalLanes(d) ? node.x + node.w / 2 : node.y + node.h / 2;
}

/** Grosor total ocupado por los carriles (0 si no hay). */
export function lanesHeight(d) {
  return d.lanes.reduce((s, l) => s + l.height, 0);
}

/**
 * Carril que cae en la coordenada indicada del eje de carriles (la `y` en
 * horizontal, la `x` en vertical).
 */
export function laneIndexAt(d, coord) {
  let acc = 0;
  for (let i = 0; i < d.lanes.length; i += 1) {
    acc += d.lanes[i].height;
    if (coord < acc) return i;
  }
  return d.lanes.length ? d.lanes.length - 1 : -1;
}

/** Asigna cada nodo al carril según su posición en el eje de carriles. */
export function assignLanes(d) {
  if (!d.lanes.length) return;
  for (const n of d.nodes) n.lane = laneIndexAt(d, laneCoord(d, n));
}

/**
 * Grosor mínimo de un carril: la banda no puede quedar más estrecha que el nodo
 * más grueso que contiene (más un margen para que no quede pegado al borde).
 * En vertical se mide el ancho de los nodos; en horizontal, su alto.
 * Es lo que evita que al encoger el carril sus nodos se salgan de la banda.
 * @param index carril a medir
 * @param min por debajo de este valor nunca se encoge
 */
export function laneMinHeight(d, index, min = 80) {
  if (index < 0 || index >= d.lanes.length) return min;
  const vertical = isVerticalLanes(d);
  let grosor = 0;
  for (const n of d.nodes) {
    if (n.lane === index) grosor = Math.max(grosor, vertical ? n.w : n.h);
  }
  return Math.max(min, grosor + LANE_PAD * 2);
}

/**
 * Mantiene los nodos dentro de su carril cuando cambia el grosor de uno: los de
 * los carriles posteriores se desplazan el mismo delta y los del propio carril
 * se quedan donde están, sin salirse de la banda. `n.lane` es explícito y no se
 * recalcula por posición.
 * @param fromIndex carril cuyo borde final se ha movido `delta` px
 */
export function shiftLanes(d, fromIndex, delta) {
  if (!delta || fromIndex < 0 || fromIndex >= d.lanes.length) return;
  const vertical = isVerticalLanes(d);
  for (const n of d.nodes) {
    if (!Number.isInteger(n.lane) || n.lane < fromIndex) continue;
    if (n.lane > fromIndex) {
      if (vertical) n.x += delta;
      else n.y += delta;
    }
    clampToLane(d, n);
  }
}

export function laneTop(d, index) {
  let acc = 0;
  for (let i = 0; i < index; i += 1) acc += d.lanes[i].height;
  return acc;
}

/** Mantiene un nodo dentro de la banda de su carril (si el carril existe). */
function clampToLane(d, n) {
  if (!Number.isInteger(n.lane) || n.lane < 0 || n.lane >= d.lanes.length) return;
  const top = laneTop(d, n.lane);
  const end = top + d.lanes[n.lane].height;
  if (isVerticalLanes(d)) n.x = Math.max(top, Math.min(n.x, Math.max(top, end - n.w)));
  else n.y = Math.max(top, Math.min(n.y, Math.max(top, end - n.h)));
}

/** Intercambia un carril con el de antes o el de después y mueve sus nodos. */
export function swapLanes(d, index, dir) {
  const j = index + dir;
  if (index < 0 || index >= d.lanes.length || j < 0 || j >= d.lanes.length) return false;
  const vertical = isVerticalLanes(d);
  const antes = d.lanes.map((_, i) => laneTop(d, i));
  const previo = new Map(d.nodes.map((n) => [n.id, n.lane]));
  [d.lanes[index], d.lanes[j]] = [d.lanes[j], d.lanes[index]];
  // Los nodos viajan con su carril: cambian de índice y de sitio.
  for (const n of d.nodes) {
    if (n.lane === index) n.lane = j;
    else if (n.lane === j) n.lane = index;
  }
  const despues = d.lanes.map((_, i) => laneTop(d, i));
  for (const n of d.nodes) {
    const prev = previo.get(n.id);
    if (!Number.isInteger(prev) || !Number.isInteger(n.lane)) continue;
    const delta = despues[n.lane] - antes[prev];
    if (vertical) n.x += delta;
    else n.y += delta;
    clampToLane(d, n);
  }
  return true;
}

/**
 * Elimina un carril: sus nodos pasan al de antes (sin moverse) y los de los
 * carriles posteriores retroceden y renumeran.
 */
export function removeLaneAt(d, index) {
  if (index < 0 || index >= d.lanes.length) return false;
  const vertical = isVerticalLanes(d);
  const h = d.lanes[index].height;
  const destino = Math.max(0, index - 1);
  for (const n of d.nodes) {
    if (n.lane === index) n.lane = destino;
    else if (Number.isInteger(n.lane) && n.lane > index) {
      n.lane -= 1;
      if (vertical) n.x -= h;
      else n.y -= h;
    }
  }
  d.lanes.splice(index, 1);
  for (const n of d.nodes) clampToLane(d, n);
  return true;
}

/** Lado equivalente al girar el diagrama 90° (transponer x e y). */
const SIDE_TRANSPUESTO = { left: 'top', right: 'bottom', top: 'left', bottom: 'right' };

/**
 * Cambia los carriles de horizontales a verticales (o al revés) **transponiendo
 * todo el diagrama**: cada nodo conserva su carril y el flujo se lee en el nuevo
 * eje. La operación es simétrica: llamarla dos veces deja el diagrama como estaba.
 *
 * - El centro de cada nodo pasa de `(x, y)` a `(y, x)`; las figuras no giran
 *   salvo las orientables (fork/join/tiempo), que sí cambian de orientación
 *   para que su cara plana siga mirando al flujo.
 * - Las bolitas de los flujos se recolocan al lado equivalente y los puntos de
 *   giro se transponen con el resto.
 * - El grosor de cada carril (`lane.height`) no cambia: pasa de alto a ancho.
 *
 * @param orientation 'horizontal' | 'vertical'
 * @returns true si el diagrama ha cambiado de orientación.
 */
export function setLaneOrientation(d, orientation) {
  const vertical = orientation === 'vertical';
  if (isVerticalLanes(d) === vertical) return false;
  for (const n of d.nodes) {
    const cx = n.x + n.w / 2;
    const cy = n.y + n.h / 2;
    if (isRotatable(n)) {
      // La barra/reloj gira con el flujo; su centro se conserva al transponer.
      n.rot = n.rot === 90 ? 0 : 90;
      const w = n.w;
      n.w = n.h;
      n.h = w;
    }
    n.x = Math.round(cy - n.w / 2);
    n.y = Math.round(cx - n.h / 2);
  }
  for (const e of d.edges) {
    e.way = readWay(e.way).map((p) => ({ x: p.y, y: p.x }));
    e.fromSide = SIDE_TRANSPUESTO[e.fromSide] || e.fromSide;
    e.toSide = SIDE_TRANSPUESTO[e.toSide] || e.toSide;
  }
  d.laneOrientation = vertical ? 'vertical' : 'horizontal';
  return true;
}

export function addNode(d, node) { d.nodes.push(node); return node; }

export function removeNode(d, id) {
  // Antes de quitar las flechas, apunta las barras del otro extremo: al perder
  // una conexión pueden dejar de ser fork/join y hay que recalcular su tipo.
  const vecinas = d.edges
    .filter((e) => e.from === id || e.to === id)
    .flatMap((e) => [e.from, e.to])
    .filter((otro) => otro !== id);
  d.nodes = d.nodes.filter((n) => n.id !== id);
  d.edges = d.edges.filter((e) => e.from !== id && e.to !== id);
  syncBarTypes(d, vecinas);
}

export function addEdge(d, edge) {
  if (edge.from === edge.to) return null;
  if (d.edges.some((e) => e.from === edge.from && e.to === edge.to)) return null;
  d.edges.push(edge);
  // El tipo de la barra se deriva de sus flechas: al conectar puede pasar de
  // fork a join (o al revés).
  syncBarTypes(d, [edge.from, edge.to]);
  return edge;
}

export function removeEdge(d, id) {
  const e = edgeById(d, id);
  d.edges = d.edges.filter((x) => x.id !== id);
  if (e) syncBarTypes(d, [e.from, e.to]);
}

/* ------------------------------------------------------------------ */
/* Portapapeles: copiar y pegar grupos                                 */
/* ------------------------------------------------------------------ */

/** Caja que engloba un conjunto de nodos (o null si está vacío). */
export function groupBounds(list) {
  if (!list || !list.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of list) {
    x1 = Math.min(x1, n.x);
    y1 = Math.min(y1, n.y);
    x2 = Math.max(x2, n.x + n.w);
    y2 = Math.max(y2, n.y + n.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Esquina superior izquierda del grupo, lo más cerca posible de `target` y sin
 * pisar ningún nodo: se prueban anillos cada vez más amplios alrededor del
 * punto de pegado y gana el primero despejado (si no hay ninguno, el punto de
 * pegado tal cual). `moved` indica que hubo que apartarlo del puntero.
 * @returns {{x:number, y:number, moved:boolean}}
 */
export function freeSpot(rects, bbox, target, step = 24, pad = 14) {
  const base = {
    x: Math.round((target.x - bbox.w / 2) / step) * step,
    y: Math.round((target.y - bbox.h / 2) / step) * step,
  };
  const choca = (b) => (rects || []).some((r) => b.x < r.x + r.w + pad && b.x + bbox.w > r.x - pad
    && b.y < r.y + r.h + pad && b.y + bbox.h > r.y - pad);
  if (!choca(base)) return { ...base, moved: false };
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  for (let ring = 1; ring <= 10; ring += 1) {
    const dist = (c) => Math.hypot(c.x - base.x, c.y - base.y);
    const cands = dirs.map(([ox, oy]) => ({ x: base.x + ox * ring * step, y: base.y + oy * ring * step }))
      .sort((a, b) => dist(a) - dist(b) || a.y - b.y || a.x - b.x);
    for (const c of cands) if (!choca(c)) return { x: c.x, y: c.y, moved: true };
  }
  return { ...base, moved: false };
}

/**
 * Copia al portapapeles: los nodos seleccionados y los flujos que los unen.
 * Los ids no se copian (al pegar se generan nuevos) y un flujo suelto sólo
 * viaja si sus dos extremos están entre los nodos copiados.
 * @param refs Array<{type:'node'|'edge', id:string}>
 */
export function copyGroup(d, refs = []) {
  const selNodes = refs.filter((r) => r.type === 'node').map((r) => r.id);
  const orig = d.nodes.filter((n) => selNodes.includes(n.id));
  const idx = new Map(orig.map((n, i) => [n.id, i]));
  const nodes = orig.map((n) => ({
    type: n.type, x: n.x, y: n.y, w: n.w, h: n.h,
    label: n.label, note: n.note, lane: n.lane, rot: n.rot || 0,
  }));
  const edges = [];
  for (const e of d.edges) {
    const from = idx.has(e.from) ? idx.get(e.from) : null;
    const to = idx.has(e.to) ? idx.get(e.to) : null;
    if (from === null || to === null) continue;
    edges.push({
      from, to,
      fromSide: readSide(e.fromSide, 'right'),
      toSide: readSide(e.toSide, 'left'),
      label: e.label || '',
      condition: e.condition || '',
      kind: e.kind === 'message' ? 'message' : 'flow',
      way: readWay(e.way),
    });
  }
  return { nodes, edges };
}

/**
 * Pega un grupo desplazado `(dx, dy)`: crea los nodos con id nuevo, recoloca
 * cada nodo en el carril que le toca por posición y recrea los flujos internos
 * (sus puntos de trayectoria viajan con el mismo desplazamiento).
 */
export function pasteGroup(d, clip, dx = 0, dy = 0) {
  const idx = new Map();
  const nodes = [];
  clip.nodes.forEach((t, i) => {
    const n = createNode(t.type, t.x + dx + (t.w || 0) / 2, t.y + dy + (t.h || 0) / 2, {
      w: t.w, h: t.h, label: t.label, note: t.note, rot: t.rot,
    });
    n.lane = d.lanes.length ? laneIndexAt(d, laneCoord(d, n)) : null;
    idx.set(i, n.id);
    d.nodes.push(n);
    nodes.push(n);
  });
  const edges = [];
  for (const t of clip.edges) {
    const from = idx.get(t.from);
    const to = idx.get(t.to);
    if (!from || !to) continue;
    const e = createEdge(from, to, {
      label: t.label,
      condition: t.condition,
      kind: t.kind,
      fromSide: t.fromSide,
      toSide: t.toSide,
      way: readWay(t.way).map((p) => ({ x: p.x + dx, y: p.y + dy })),
    });
    if (addEdge(d, e)) edges.push(e);
  }
  return { nodes, edges };
}

export function nodeAt(d, x, y) {
  for (let i = d.nodes.length - 1; i >= 0; i -= 1) {
    const n = d.nodes[i];
    if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) return n;
  }
  return null;
}

export function edgeAt(d, x, y, tolerance = 8) {
  for (let i = d.edges.length - 1; i >= 0; i -= 1) {
    const e = d.edges[i];
    if (distanceToEdge(d, e, x, y) <= tolerance) return e;
  }
  return null;
}

export function distanceToEdge(d, e, px, py) {
  const a = nodeById(d, e.from);
  const b = nodeById(d, e.to);
  if (!a || !b) return Infinity;
  return distToPolyline(px, py, edgeGeometry(d, e)?.pts || []);
}

/* --- Geometría del trazado (compartida con el render) --- */

/** Distancia mínima de un punto a una polilínea ortogonal. */
export function distToPolyline(px, py, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i += 1) {
    best = Math.min(best, distToSegment(px, py, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y));
  }
  return best;
}

export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export function cubicPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return {
    x: mt ** 3 * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t ** 3 * p3.x,
    y: mt ** 3 * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t ** 3 * p3.y,
  };
}

/* ------------------------------------------------------------------ */
/* Serialización                                                       */
/* ------------------------------------------------------------------ */

export function serialize(d) {
  return JSON.stringify({ ...d, view: undefined, savedAt: new Date().toISOString() }, null, 2);
}

export function deserialize(text) {
  const raw = typeof text === 'string' ? JSON.parse(text) : text;
  if (!raw || !Array.isArray(raw.nodes)) throw new Error('El archivo no contiene nodos válidos.');
  const d = createDiagram({
    name: typeof raw.name === 'string' ? raw.name : 'Diagrama importado',
    laneOrientation: raw.laneOrientation === 'vertical' ? 'vertical' : 'horizontal',
    lanes: Array.isArray(raw.lanes) ? raw.lanes.map((l, i) => ({
      id: l.id || uid('l'),
      name: l.name || `Carril ${i + 1}`,
      height: Number(l.height) > 0 ? Number(l.height) : 180,
    })) : [],
    nodes: [],
    edges: [],
  });
  const ids = new Set();
  for (const n of raw.nodes) {
    if (!n || !NODE_TYPES[n.type]) continue;
    const t = NODE_TYPES[n.type];
    let w = Math.max(t.minW, Number(n.w) || t.w);
    let h = Math.max(t.minH, Number(n.h) || t.h);
    if (n.type === 'decision' || n.type === 'tiempo') {
      // Migrar diagramas antiguos: forzar cuadrado (puntas verticales en la
      // decisión, reloj de arena cuadrado).
      const s = Math.max(w, h);
      w = s; h = s;
    }
    if (n.type === 'stop') {
      // Migrar diagramas antiguos: el punto muerto es un círculo: cuadrado
      // siempre, con su diámetro máximo (mayor que el de inicio/fin).
      const s = Math.min(Math.max(Math.min(w, h), t.minW), DOT_MAX_STOP);
      w = s; h = s;
    }
    if (n.type === 'start' || n.type === 'end') {
      // Migrar diagramas antiguos: los nodos inicial/final son círculos pequenos.
      const s = Math.min(Math.max(Math.min(w, h), t.minW), DOT_MAX);
      w = s; h = s;
    }
    const node = {
      id: n.id || uid('n'),
      type: n.type,
      x: Number(n.x) || 0,
      y: Number(n.y) || 0,
      w,
      h,
      label: typeof n.label === 'string' ? n.label : defaultLabel(n.type),
      note: typeof n.note === 'string' ? n.note : '',
      lane: Number.isInteger(n.lane) ? n.lane : null,
      // Orientación: sólo la guardan los nodos orientables y siempre vale 0
      // (tal cual) o 90 (girado un cuarto de vuelta).
      rot: t.rotatable && Number(n.rot) === 90 ? 90 : 0,
    };
    ids.add(node.id);
    d.nodes.push(node);
  }
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (!e || !ids.has(e.from) || !ids.has(e.to)) continue;
    d.edges.push({
      id: e.id || uid('e'),
      from: e.from,
      to: e.to,
      fromSide: readSide(e.fromSide, 'right'),
      toSide: readSide(e.toSide, 'left'),
      label: typeof e.label === 'string' ? e.label : '',
      condition: typeof e.condition === 'string' ? e.condition : '',
      kind: e.kind === 'message' ? 'message' : 'flow',
      way: readWay(e.way),
    });
  }
  // Al abrir un archivo (o restaurar el historial) la barra recupera el tipo que
  // le dan sus flechas guardadas, aunque el JSON traiga otro.
  syncBarTypes(d, barIds(d));
  return d;
}

/** Puntos de control de una trayectoria: sólo los pares x/y finitos. */
export function readWay(way) {
  if (!Array.isArray(way)) return [];
  return way
    .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
    .map((p) => ({ x: Math.round(Number(p.x)), y: Math.round(Number(p.y)) }));
}

/** Lado de conexión (`left`|`right`|`top`|`bottom`) con valor por defecto. */
export function readSide(side, def) {
  return SIDES.includes(side) ? side : def;
}

export function cloneDiagram(d) {
  return deserialize(JSON.stringify({ ...d, view: undefined }));
}
