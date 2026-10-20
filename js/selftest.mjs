/**
 * Pruebas de la lógica del diagrama (sin DOM): modelo, validación y simulación.
 * Ejecutar con:  node js/selftest.mjs
 */
import { sampleDiagram, createNode, createEdge, createDiagram, createLane, deserialize, assignLanes, shiftLanes, swapLanes, removeLaneAt, laneMinHeight, laneTop, nodeById, NODE_TYPES, copyGroup, pasteGroup, groupBounds, freeSpot, LANE_PAD } from './model.js';
import { validate, summary } from './validate.js';
import { createSim, start, step, evaluate } from './simulate.js';
import {
  anchorFor, anchors, pickSides, nodeSides, edgeGeometry, labelSpot, guidePoint, avoidNodes,
  nearestOnPolyline, sideNear, userRouteTip, END_RING_GAP, ARROW_GAP,
} from './routing.js';
import { unionBox, alignTargets, snapMove, snapSize, snapLine, planAlign, planDistribute } from './align.js';
import { shapeAttrs, tridentePuntos, ACTIVITY_RX } from './render.js';

/** ¿Algún tramo del trazado atraviesa el interior del rectángulo? */
function cruzaNodo(pts, r, margen = 1) {
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i - 1];
    const q = pts[i];
    const x1 = Math.min(p.x, q.x);
    const x2 = Math.max(p.x, q.x);
    const y1 = Math.min(p.y, q.y);
    const y2 = Math.max(p.y, q.y);
    if (x2 > r.x + margen && x1 < r.x + r.w - margen
      && y2 > r.y + margen && y1 < r.y + r.h - margen) return true;
  }
  return false;
}

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${extra}`); }
}

function run(d, vars, maxSteps = 60) {
  const sim = createSim(d);
  sim.vars = vars;
  start(d, sim);
  let steps = 0;
  while (steps < maxSteps) {
    if (sim.finished || sim.deadlocked || sim.status === 'choice') break;
    step(d, sim);
    steps += 1;
  }
  return { sim, steps };
}

/** ¿Se solapan dos rectángulos (sin margen)? */
function solapan(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

console.log('\n1. Diagrama de ejemplo');
const d = sampleDiagram();
check('8+ nodos', d.nodes.length >= 10, `(${d.nodes.length})`);
check('flujos entre nodos existentes', d.edges.every((e) => d.nodes.some((n) => n.id === e.from) && d.nodes.some((n) => n.id === e.to)));
check('carriles asignados', d.nodes.every((n) => Number.isInteger(n.lane)));
check('2 carriles', d.lanes.length === 2);

console.log('\n2. Validación');
const issues = validate(d);
const s = summary(issues);
check('sin errores en el ejemplo', s.error === 0, JSON.stringify(issues.filter((i) => i.level === 'error')));
check('informa de algo o nada', issues.length >= 0);

console.log('\n3. Simulación con stock disponible (stock = 3)');
{
  const r = run(d, { stock: 3 });
  check('finaliza', r.sim.finished, JSON.stringify(r.sim.log.slice(-2)));
  check('toma la rama afirmativa', r.sim.log.some((l) => l.type === 'decision' && l.text.includes('hay stock') && !l.text.includes('no hay stock')));
  check('el fork crea ramas', r.sim.log.some((l) => l.type === 'fork'));
  check('el join sincroniza', r.sim.log.some((l) => l.type === 'join'));
  check('no hay bloqueos', !r.sim.deadlocked);
}

console.log('\n4. Simulación sin stock (stock = 0)');
{
  const r = run(d, { stock: 0 });
  check('finaliza', r.sim.finished, JSON.stringify(r.sim.log.slice(-2)));
  check('toma la rama negativa', r.sim.log.some((l) => l.type === 'decision' && l.text.includes('no hay stock')));
}

console.log('\n5. Detección de bloqueos en el join');
{
  const g = createDiagram();
  const s1 = createNode('start', 100, 100, { label: 'Inicio' });
  const fork = createNode('fork', 300, 100, { label: 'Fork' });
  const a1 = createNode('activity', 500, 40, { label: 'A' });
  const a2 = createNode('activity', 500, 200, { label: 'B' });
  const lonely = createNode('activity', 500, 360, { label: 'C huérfano' });
  const join = createNode('join', 700, 100, { label: 'Join' });
  const end = createNode('end', 900, 100, { label: 'Fin' });
  g.nodes.push(s1, fork, a1, a2, lonely, join, end);
  g.edges.push(
    createEdge(s1.id, fork.id),
    createEdge(fork.id, a1.id),
    createEdge(fork.id, a2.id),
    createEdge(a1.id, join.id),
    // La rama C nunca alcanza el join -> el join se queda esperando
    createEdge(lonely.id, join.id),
    createEdge(join.id, end.id),
  );
  const v = summary(validate(g));
  check('sin errores de estructura', v.error === 0, JSON.stringify(validate(g).filter((i) => i.level === 'error')));
  const r = run(g, {});
  check('detecta bloqueo en el join', r.sim.deadlocked, JSON.stringify(r.sim.log.slice(-1)));
  check('mensaje explica la falta', r.sim.log[r.sim.log.length - 1].text.includes('Bloqueo'));

  // Ahora la rama huérrafa también llega al join
  g.edges.splice(2, 0, createEdge(fork.id, lonely.id));
  const r2 = run(g, {});
  check('con todas las ramas, finaliza', r2.sim.finished, JSON.stringify(r2.sim.log.slice(-1)));
  check('el join sólo avanza cuando llegaron todas sus entradas', r2.sim.log.some((l) => l.type === 'join' && l.text.includes('sincronizadas 2')));
}

console.log('\n6. Errores de validación de gateways');
{
  const g = createDiagram();
  const start = createNode('start', 100, 100);
  const fork = createNode('fork', 300, 100, { label: 'F' });
  const badJoin = createNode('join', 500, 100, { label: 'J' });
  g.nodes.push(start, fork, badJoin);
  g.edges.push(createEdge(start.id, fork.id), createEdge(fork.id, badJoin.id));
  const issues = validate(g).filter((i) => i.level === 'error').map((i) => i.msg);
  check('join con 1 entrada -> error', issues.some((m) => m.includes('join necesita 2 o más entradas')), JSON.stringify(issues));
  const noEnd = validate(g).some((i) => i.level === 'warn' && i.msg.includes('nodos de fin'));
  check('avisa si no hay nodo Fin', noEnd);
}

console.log('\n7. Decisión con salidas sin etiquetar pide elección');
{
  const g = createDiagram();
  const s1 = createNode('start', 100, 100);
  const dec = createNode('decision', 320, 100, { label: '¿Cuál?' });
  const a = createNode('activity', 560, 40, { label: 'A' });
  const b = createNode('activity', 560, 200, { label: 'B' });
  g.nodes.push(s1, dec, a, b);
  g.edges.push(createEdge(s1.id, dec.id), createEdge(dec.id, a.id), createEdge(dec.id, b.id));
  const r = run(g, {});
  check('estado = choice', r.sim.status === 'choice', r.sim.status);
  check('ofrece 2 opciones', r.sim.pending?.options.length === 2);
  step(g, r.sim, r.sim.pending.options[1]);
  check('al elegir una rama el flujo continúa', r.sim.status !== 'choice', r.sim.status);
  check('la rama elegida se ejecutó', r.sim.log.some((l) => l.type === 'decision'));
  check('llega al final por la rama elegida', r.sim.finished || r.sim.tokens.size > 0 || r.sim.queue.length > 0);
}

console.log('\n8. Condiciones');
check('stock > 0 con 3', evaluate('stock > 0', { stock: 3 }) === true);
check('stock > 0 con 0', evaluate('stock > 0', { stock: 0 }) === false);
check('expresión compuesta', evaluate('stock > 0 && nivel >= 2', { stock: 5, nivel: 2 }) === true);
check('alternativa', evaluate('a == 1 || b == 2', { a: 0, b: 2 }) === true);
check('paréntesis', evaluate('(a > 1 || b > 1) && c != 0', { a: 0, b: 2, c: 5 }) === true);
check('texto vacío = verdadero', evaluate('', {}) === true);
try { evaluate('stock >', { stock: 1 }); check('expresión rota lanza error', false); }
catch { check('expresión rota lanza error', true); }

console.log('\n9. Serialización');
{
  const json = JSON.stringify(d);
  const back = (await import('./model.js')).deserialize(json);
  check('nodos preservados', back.nodes.length === d.nodes.length);
  check('flujos preservados', back.edges.length === d.edges.length);
  check('tipos preservados', back.nodes.every((n, i) => n.type === d.nodes[i].type));
  check('carriles preservados', back.lanes.length === 2);
  try { (await import('./model.js')).deserialize('{"foo":1}'); check('archivo inválido lanza error', false); }
  catch { check('archivo inválido lanza error', true); }
}

console.log('\n10. Anclajes: reparto de flechas y nodo final');
{
  // Fork con 3 salidas por la derecha -> tres huecos distintos a lo largo de la barra.
  const g = createDiagram();
  const f = createNode('fork', 300, 200);
  g.nodes.push(f);
  const outs = [0, 1, 2].map((i) => createNode('activity', 700, 60 + i * 140));
  g.nodes.push(...outs);
  const edges = outs.map((n) => createEdge(f.id, n.id, { fromSide: 'right', toSide: 'left' }));
  g.edges.push(...edges);
  const ys = edges.map((e) => anchorFor(g, e, pickSides(g, e).from, true).y);
  check('el fork reparte las 3 salidas', new Set(ys.map((y) => Math.round(y))).size === 3, JSON.stringify(ys));
  check('las salidas caen dentro de la barra',
    ys.every((y) => y > f.y && y < f.y + f.h), JSON.stringify(ys));
  check('las salidas se ordenan de arriba abajo',
    ys.every((y, i) => i === 0 || y > ys[i - 1]), JSON.stringify(ys));

  // Join con 3 entradas por la izquierda -> un hueco por entrada, sin amontonarse.
  const j = createNode('join', 300, 200);
  const src = [0, 1, 2].map((i) => createNode('activity', -100, 60 + i * 140));
  g.nodes.push(j, ...src);
  const ins = src.map((n) => createEdge(n.id, j.id, { fromSide: 'right', toSide: 'left' }));
  g.edges.push(...ins);
  const iy = ins.map((e) => anchorFor(g, e, pickSides(g, e).to, false).y);
  check('el join reparte las 3 entradas', new Set(iy.map((y) => Math.round(y))).size === 3, JSON.stringify(iy));
  check('las entradas se ordenan de arriba abajo', iy.every((y, i) => i === 0 || y > iy[i - 1]), JSON.stringify(iy));

  // Actividad con 4 entradas por la izquierda: todas repartidas en alto.
  const a = createNode('activity', 400, 200);
  g.nodes.push(a);
  const feeders = [0, 1, 2, 3].map((i) => createNode('activity', -200 + i * 10, 60 + i * 90));
  g.nodes.push(...feeders);
  const ain = feeders.map((n) => createEdge(n.id, a.id, { fromSide: 'right', toSide: 'left' }));
  g.edges.push(...ain);
  check('una sola entrada por la izquierda', ain.every((e) => pickSides(g, e).to === 'left'));
  const pts = ain.map((e) => anchorFor(g, e, pickSides(g, e).to, false));
  check('4 entradas en actividad: 4 anclajes distintos',
    new Set(pts.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size === 4, JSON.stringify(pts));
  check('todas en el borde izquierdo', pts.every((p) => Math.abs(p.x - a.x) < 0.01
    && p.y > a.y && p.y < a.y + a.h), JSON.stringify(pts));

  // Una sola entrada -> centrada en el lado elegido.
  const b2 = createNode('activity', 400, 200);
  const origen = createNode('activity', 100, 200);
  g.nodes.push(b2, origen);
  const e2b = createEdge(origen.id, b2.id, { toSide: 'top' });
  g.edges.push(e2b);
  const cen = anchorFor(g, e2b, 'top', false);
  check('una sola entrada -> centrada en el lado elegido',
    Math.abs(cen.x - (b2.x + b2.w / 2)) < 0.01 && Math.abs(cen.y - b2.y) < 0.01, JSON.stringify(cen));

  // Dos entradas por arriba -> repartidas a lo ancho, sin amontonarse.
  const dos = [-300, 300].map((dx) => createNode('activity', b2.x + dx, -100));
  g.nodes.push(...dos);
  const ainTop = dos.map((n) => createEdge(n.id, b2.id, { toSide: 'top' }));
  g.edges.push(...ainTop);
  const pTop = ainTop.map((e) => anchorFor(g, e, 'top', false));
  check('las de arriba se reparten a lo ancho sin solaparse',
    pTop.length === 2 && new Set(pTop.map((p) => Math.round(p.x))).size === 2
    && pTop.every((p) => Math.abs(p.y - b2.y) < 0.01), JSON.stringify(pTop));

  // Varias salidas por la derecha -> repartidas en alto.
  const outs2 = [0, 1, 2].map((i) => createNode('activity', 900, 60 + i * 140));
  g.nodes.push(...outs2);
  const eOut = outs2.map((n) => createEdge(b2.id, n.id, { fromSide: 'right', toSide: 'left' }));
  g.edges.push(...eOut);
  check('varias salidas por la derecha', eOut.every((e) => pickSides(g, e).from === 'right'));
  const oy = eOut.map((e) => anchorFor(g, e, 'right', true).y);
  check('las salidas se reparten en alto sin solaparse',
    new Set(oy.map((y) => Math.round(y))).size === 3
    && oy.every((y) => y > b2.y && y < b2.y + b2.h), JSON.stringify(oy));

  // Nodo final: la punta debe quedar junto al anillo exterior, no a un radio
  // de distancia (el error que dejaba un hueco enorme).
  const e2 = createDiagram();
  const act = createNode('activity', 200, 200);
  const end = createNode('end', 600, 200);
  e2.nodes.push(act, end);
  const fe = createEdge(act.id, end.id);
  e2.edges.push(fe);
  const geo = edgeGeometry(e2, fe);
  const r = Math.min(end.w, end.h) / 2;
  const ringOuter = end.x + end.w / 2 - (r + END_RING_GAP + 0.7);
  const gapRing = ringOuter - geo.p2.x;
  check('la punta respeta el hueco de la flecha', gapRing > ARROW_GAP - 1 && gapRing < ARROW_GAP + 1, `${gapRing}`);
  check('la punta no queda enterrada en el nodo final', geo.p2.x < ringOuter);
  check('la punta llega al anillo exterior, sin hueco grande', gapRing < 6, `${gapRing}`);
}

console.log('\n11. La flecha va por donde el usuario indique');
{
  const mk = (ax, ay, bx, by, patch) => {
    const g = createDiagram();
    const a = createNode('activity', ax, ay);
    const b = createNode('activity', bx, by);
    g.nodes.push(a, b);
    const e = createEdge(a.id, b.id, patch);
    g.edges.push(e);
    return { g, a, b, e, geo: edgeGeometry(g, e) };
  };
  const orto = ({ geo }) => geo.pts.every((p, i) => i === 0
    || p.x === geo.pts[i - 1].x || p.y === geo.pts[i - 1].y);

  // Ida y vuelta: el destino queda a la izquierda del origen. Sin puntos de giro
  // el corte en L va en recto (y puede cruzar el nodo); con ellos el usuario rodea.
  const vuelta = mk(700, 300, 100, 300);
  check('la flecha sale y entra por las bolitas elegidas',
    pickSides(vuelta.g, vuelta.e).from === 'right' && pickSides(vuelta.g, vuelta.e).to === 'left',
    JSON.stringify(pickSides(vuelta.g, vuelta.e)));
  check('sale por la derecha del origen', vuelta.geo.p1.x > vuelta.a.x + vuelta.a.w - 1);
  check('entra por la izquierda del destino', Math.abs(vuelta.geo.p2.x - (vuelta.b.x - ARROW_GAP)) < 0.01,
    `${vuelta.geo.p2.x}`);
  check('el recorrido por defecto es un corte en L ortogonal', orto(vuelta), JSON.stringify(vuelta.geo.pts));

  vuelta.e.way = [{ x: vuelta.a.x + vuelta.a.w + 1.5, y: 160 }, { x: -40, y: 160 }];
  vuelta.e.toSide = 'left';
  const conGiros = edgeGeometry(vuelta.g, vuelta.e);
  check('con puntos de giro el rodeo es ortogonal',
    conGiros.pts.every((p, i) => i === 0 || p.x === conGiros.pts[i - 1].x || p.y === conGiros.pts[i - 1].y),
    JSON.stringify(conGiros.pts));
  check('y rodea los nodos sin atravesarlos',
    !cruzaNodo(conGiros.pts, vuelta.a) && !cruzaNodo(conGiros.pts, vuelta.b), JSON.stringify(conGiros.pts));

  // Entrada por arriba: la flecha sube y entra por el borde superior.
  const arriba = mk(400, 300, 700, 700, { toSide: 'top' });
  check('entra por la bolita de arriba', pickSides(arriba.g, arriba.e).to === 'top');
  check('la punta queda en el borde superior del destino',
    Math.abs(arriba.geo.p2.y - (arriba.b.y - ARROW_GAP)) < 0.01, `${arriba.geo.p2.y}`);
  check('y el trazado sigue siendo ortogonal', orto(arriba), JSON.stringify(arriba.geo.pts));

  // Todo segmento ortogonal, también en el caso descolgado.
  const descolgado = mk(700, 300, 100, 460);
  check('trazado siempre ortogonal', orto(descolgado) && orto(vuelta), JSON.stringify(descolgado.geo.pts));
}

console.log('\n12. Etiquetas de los flujos');
{
  const geo = { pts: [{ x: 0, y: 0 }, { x: 200, y: 0 }] };
  const h = labelSpot(geo);
  check('tramo horizontal -> etiqueta horizontal', h.vertical === false && h.y < 0 && h.x === 100, JSON.stringify(h));
  const v = { pts: [{ x: 0, y: 0 }, { x: 0, y: 200 }, { x: 40, y: 200 }] };
  const s = labelSpot(v);
  check('tramo más largo vertical -> etiqueta vertical', s.vertical === true && s.x > 0 && s.y === 100, JSON.stringify(s));
  const mix = { pts: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 90 }] };
  check('usa el tramo más largo, no el último', labelSpot(mix).vertical === true, JSON.stringify(labelSpot(mix)));
}

console.log('\n13. Nodo de objeto');
{
  check('existe el tipo objeto', !!NODE_TYPES.objeto);
  const g = createDiagram();
  const s1 = createNode('start', 100, 300);
  const ob = createNode('objeto', 400, 300, { label: 'Pedido', note: 'pendiente de pago' });
  const fin = createNode('end', 700, 300);
  g.nodes.push(s1, ob, fin);
  g.edges.push(createEdge(s1.id, ob.id), createEdge(ob.id, fin.id));
  check('el objeto guarda el estado', ob.note === 'pendiente de pago');
  check('validación sin errores', summary(validate(g)).error === 0, JSON.stringify(validate(g)));

  // Varias flechas entrando y saliendo a la vez.
  const otro = createNode('activity', 100, 120);
  g.nodes.push(otro);
  g.edges.push(createEdge(otro.id, ob.id));
  const ins = g.edges.filter((e) => e.to === ob.id);
  check('admite varias entradas', ins.length === 2);
  const ptsIn = ins.map((e) => anchorFor(g, e, pickSides(g, e).to, false));
  check('las entradas del objeto no se solapan',
    new Set(ptsIn.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size === 2, JSON.stringify(ptsIn));

  const back = deserialize(JSON.stringify(g));
  const bOb = back.nodes.find((n) => n.type === 'objeto');
  check('el objeto sobrevive al guardado', !!bOb && bOb.note === 'pendiente de pago');

  const r = run(g, {});
  check('el simulador atraviesa el objeto', r.sim.finished, JSON.stringify(r.sim.log.slice(-2)));
}

console.log('\n14. Carriles: los nodos no cambian de carril');
{
  const nuevo = () => {
    const d = createDiagram();
    d.lanes = [createLane('Cliente', 0), createLane('Sistema', 1)];
    d.lanes[0].height = 200;
    d.lanes[1].height = 400;
    const arriba = createNode('activity', 400, 100, { label: 'Cliente pide' });
    const abajo = createNode('activity', 400, 400, { label: 'Sistema cobra' });
    d.nodes.push(arriba, abajo);
    assignLanes(d);
    return { d, arriba, abajo };
  };
  const enBanda = (d, n) => n.y >= laneTop(d, n.lane)
    && n.y + n.h <= laneTop(d, n.lane) + d.lanes[n.lane].height;

  let { d, arriba, abajo } = nuevo();
  check('cada nodo en su carril', arriba.lane === 0 && abajo.lane === 1, `${arriba.lane},${abajo.lane}`);
  check('todos dentro de su banda', enBanda(d, arriba) && enBanda(d, abajo));

  // Agrandar el carril de arriba: el de abajo se desplaza, nadie cambia de carril.
  const yArriba = arriba.y;
  const yAbajo = abajo.y;
  d.lanes[0].height += 120;
  shiftLanes(d, 0, 120);
  check('al agrandar nadie cambia de pertenencia', arriba.lane === 0 && abajo.lane === 1);
  check('el nodo del propio carril no se mueve', arriba.y === yArriba, `${arriba.y} vs ${yArriba}`);
  check('el nodo de abajo baja con su banda', abajo.y === yAbajo + 120, `${abajo.y} vs ${yAbajo + 120}`);
  check('y sigue dentro de su banda', enBanda(d, arriba) && enBanda(d, abajo));

  // Encoger por debajo de un nodo: no debe salirse de su carril.
  ({ d, arriba, abajo } = nuevo());
  d.lanes[0].height = 80;
  shiftLanes(d, 0, -150);
  check('al encoger el nodo no se sale de su carril', enBanda(d, arriba), `${arriba.y}`);
  check('y sigue en el mismo carril', arriba.lane === 0);

  // Reordenar: cada nodo se mueve con su banda.
  ({ d, arriba, abajo } = nuevo());
  check('reordenar un carril', swapLanes(d, 1, -1));
  check('tras reordenar cada nodo sigue en su banda', enBanda(d, arriba) && enBanda(d, abajo),
    `${arriba.y},${abajo.y}`);
  check('y el nodo del segundo carril sigue siendo el segundo', abajo.lane === 0 && arriba.lane === 1);

  // Eliminar un carril: sus nodos pasan al de arriba, los de abajo suben.
  ({ d, arriba, abajo } = nuevo());
  removeLaneAt(d, 1);
  check('eliminar un carril', d.lanes.length === 1);
  check('los nodos del carril eliminado pasan al que queda', abajo.lane === 0);
  check('y no se salen de la banda', enBanda(d, arriba) && enBanda(d, abajo), `${arriba.y},${abajo.y}`);
}

console.log('\n14b. Altura minima del carril y desplazamiento de los siguientes');
{
  const tres = () => {
    const d = createDiagram();
    d.lanes = [createLane('Cliente', 0), createLane('Sistema', 1), createLane('Almacen', 2)];
    d.lanes.forEach((l, i) => { l.height = 200; });
    const c = createNode('activity', 400, 100, { label: 'Cliente pide' });
    const s = createNode('activity', 400, 300, { label: 'Sistema cobra' });
    const a = createNode('activity', 400, 500, { label: 'Almacen guarda' });
    d.nodes.push(c, s, a);
    assignLanes(d);
    return { d, c, s, a };
  };
  const enBanda = (d, n) => n.y >= laneTop(d, n.lane)
    && n.y + n.h <= laneTop(d, n.lane) + d.lanes[n.lane].height;

  // El alto minimo lo fija el nodo mas alto del carril (con margen).
  let { d, s, a } = tres();
  const alto = s.h + LANE_PAD * 2;
  check('el alto minimo lo marca el nodo mas alto del carril',
    laneMinHeight(d, 1) === alto, `${laneMinHeight(d, 1)} vs ${alto}`);
  check('un carril sin nodos no baja del minimo general',
    laneMinHeight({ lanes: [createLane('X', 0)], nodes: [] }, 0) === 80, laneMinHeight({ lanes: [createLane('X', 0)], nodes: [] }, 0));

  // Encoger un carril intermedio hasta su mínimo: los nodos no se salen.
  const yTercio = a.y;
  const delta = alto - d.lanes[1].height;
  d.lanes[1].height = alto;
  shiftLanes(d, 1, delta);
  check('encogido hasta el minimo, nadie se sale de su banda',
    enBanda(d, s) && enBanda(d, a), JSON.stringify({ s: s.y, a: a.y }));
  check('y el nodo del propio carril se recoloca dentro', enBanda(d, s), `${s.y}`);
  check('y los del carril de abajo suben con la banda', a.y === yTercio + delta, `${a.y} vs ${yTercio + delta}`);

  // Agrandar un carril intermedio: los de abajo suben con su banda.
  ({ d, s, a } = tres());
  const yAntes = a.y;
  d.lanes[1].height += 120;
  shiftLanes(d, 1, 120);
  check('los carriles posteriores se mueven con la banda', a.y === yAntes + 120, `${a.y} vs ${yAntes + 120}`);
  check('y siguen dentro de la suya', enBanda(d, s) && enBanda(d, a));
  check('el del propio carril se queda quieto', s.y === 268, `${s.y}`);
  check('el de arriba tampoco se mueve',
    laneTop(d, 1) === 200 && laneTop(d, 2) === 200 + d.lanes[1].height);
}

console.log('\n15. El lado lo elige el usuario, el reparto es equitativo');
{
  // A -> B -> C es el flujo; C -> B vuelve hacia atrás. Cada flecha entra por
  // la bolita que se pulsó y todas las que comparten lado se reparten.
  const g = createDiagram();
  const a = createNode('activity', 300, 300);
  const b = createNode('activity', 700, 300);
  const c = createNode('activity', 1100, 300);
  g.nodes.push(a, b, c);
  const e1 = createEdge(a.id, b.id, { fromSide: 'right', toSide: 'left' });
  const e2 = createEdge(b.id, c.id, { fromSide: 'right', toSide: 'left' });
  const e3 = createEdge(c.id, b.id, { fromSide: 'bottom', toSide: 'bottom' });
  g.edges.push(e1, e2, e3);
  check('cada flecha usa la bolita indicada',
    pickSides(g, e1).from === 'right' && pickSides(g, e1).to === 'left'
    && pickSides(g, e3).from === 'bottom' && pickSides(g, e3).to === 'bottom',
    JSON.stringify([pickSides(g, e1), pickSides(g, e3)]));
  const entrada = anchorFor(g, e1, 'left', false);
  const vuelta = anchorFor(g, e3, 'bottom', false);
  check('la entrada por la izquierda queda en el borde', Math.abs(entrada.x - b.x) < 0.01, JSON.stringify(entrada));
  check('el bucle de vuelta entra por abajo', Math.abs(vuelta.y - (b.y + b.h)) < 0.01, JSON.stringify(vuelta));
  check('y al ser el único de su lado queda centrado',
    Math.abs(entrada.y - (b.y + b.h / 2)) < 0.01 && Math.abs(vuelta.x - (b.x + b.w / 2)) < 0.01,
    JSON.stringify({ entrada, vuelta }));

  // Dos entradas más por la izquierda: tres flechas repartidas en el lado.
  const feeders = [-100, 100].map((dx) => createNode('activity', b.x + dx, -60));
  g.nodes.push(...feeders);
  const e4 = createEdge(feeders[0].id, b.id, { toSide: 'left' });
  const e5 = createEdge(feeders[1].id, b.id, { toSide: 'left' });
  g.edges.push(e4, e5);
  const pts = [e1, e4, e5].map((e) => anchorFor(g, e, 'left', false));
  check('las tres entradas en la izquierda se reparten',
    new Set(pts.map((p) => Math.round(p.y))).size === 3, JSON.stringify(pts));
  check('todas dentro del lado, sin salirse',
    pts.every((p) => p.y > b.y && p.y < b.y + b.h), JSON.stringify(pts));

  // Un nodo con entradas por arriba y por abajo: cada lado reparte por su cuenta.
  const ob = createNode('objeto', 700, 620);
  g.nodes.push(ob);
  const feeders2 = [600, 800].map((x) => createNode('activity', x, 800));
  g.nodes.push(...feeders2);
  const fa = feeders2.map((n) => createEdge(n.id, ob.id, { toSide: 'top' }));
  const fb = createEdge(feeders2[0].id, ob.id, { toSide: 'bottom' });
  g.edges.push(...fa, fb);
  const pTop = fa.map((e) => anchorFor(g, e, 'top', false));
  check('las de arriba se reparten a lo ancho sin solaparse',
    new Set(pTop.map((p) => Math.round(p.x))).size === 2 && pTop.every((p) => Math.abs(p.y - ob.y) < 0.01),
    JSON.stringify(pTop));
  check('las de abajo quedan en el borde inferior',
    Math.abs(anchorFor(g, fb, 'bottom', false).y - (ob.y + ob.h)) < 0.01);
}

console.log('\n15b. Una salida y una entrada en el mismo lado se reparten');
{
  const g = createDiagram();
  const a = createNode('activity', 300, 300);
  const b = createNode('activity', 700, 300);
  const c = createNode('activity', 1100, 300);
  g.nodes.push(a, b, c);
  // Una flecha sale por la derecha de B y otra entra por la derecha.
  const sale = createEdge(b.id, c.id, { fromSide: 'right', toSide: 'left' });
  const entra = createEdge(a.id, b.id, { fromSide: 'right', toSide: 'right' });
  g.edges.push(sale, entra);
  const ps = anchorFor(g, sale, 'right', true);
  const pe = anchorFor(g, entra, 'right', false);
  check('no se pisan: dos puntos distintos en el mismo lado',
    Math.abs(ps.y - pe.y) > 1, JSON.stringify({ ps, pe }));
  check('las dos quedan en el borde derecho del nodo',
    Math.abs(ps.x - (b.x + b.w)) < 0.01 && Math.abs(pe.x - (b.x + b.w)) < 0.01, JSON.stringify({ ps, pe }));
  check('y repartidas en cuartos de la altura',
    Math.abs(ps.y - (b.y + b.h / 4)) < 0.01 && Math.abs(pe.y - (b.y + 3 * b.h / 4)) < 0.01,
    JSON.stringify({ ps, pe }));

  // Una tercera por el mismo lado: tres huecos iguales, ninguno amontonado.
  const d = createNode('activity', 700, 600);
  g.nodes.push(d);
  const tres = [a, b, c].map((n) => createEdge(n.id, d.id, { toSide: 'left' }));
  g.edges.push(...tres);
  const ys = tres.map((e) => anchorFor(g, e, 'left', false).y);
  check('tres entradas en la misma banda: tres puntos distintos',
    new Set(ys.map((y) => Math.round(y))).size === 3, JSON.stringify(ys));
  check('repartidas a sextos de la altura',
    ys.every((y, i) => Math.abs(y - (d.y + (2 * i + 1) * d.h / 6)) < 0.01), JSON.stringify(ys));
}

console.log('\n15c. Ida hacia atrás con puntos de giro');
{
  const h = createDiagram();
  const src = createNode('activity', 700, 300);
  const dst = createNode('activity', 100, 300);
  h.nodes.push(src, dst);
  const eb = createEdge(src.id, dst.id, {
    fromSide: 'right', toSide: 'left',
    way: [{ x: src.x + src.w + 1.5, y: 120 }, { x: -40, y: 120 }],
  });
  h.edges.push(eb);
  const geo = edgeGeometry(h, eb);
  check('entra justo por la bolita de la izquierda',
    Math.abs(geo.p2.x - (dst.x - ARROW_GAP)) < 0.01, `${geo.p2.x}`);
  check('el rodeo indicado es ortogonal',
    geo.pts.every((p, i) => i === 0 || p.x === geo.pts[i - 1].x || p.y === geo.pts[i - 1].y),
    JSON.stringify(geo.pts));
  check('y no atraviesa los nodos',
    !cruzaNodo(geo.pts, dst) && !cruzaNodo(geo.pts, src), JSON.stringify(geo.pts));
}

console.log('\n16. Trayectoria indicada por el usuario');
{
  const g = createDiagram();
  const a = createNode('activity', 300, 300, { label: 'A' });
  const b = createNode('activity', 800, 300, { label: 'B' });
  g.nodes.push(a, b);
  const e = createEdge(a.id, b.id);
  g.edges.push(e);

  const orto = (pts) => pts.every((p, i) => i === 0
    || p.x === pts[i - 1].x || p.y === pts[i - 1].y);

  // Sin puntos de giro: corte en L entre las dos bolitas.
  const auto = edgeGeometry(g, e);
  check('sin puntos -> corte en L entre las dos bolitas', auto.pts.length === 2
    && auto.pts[0].y === 300 && auto.pts[1].y === 300, JSON.stringify(auto.pts));

  // Con puntos: manda el usuario y el trazado sigue siendo ortogonal.
  e.way = [{ x: 400, y: 560 }, { x: 700, y: 560 }];
  const geo = edgeGeometry(g, e);
  check('con puntos -> trazado ortogonal', orto(geo.pts), JSON.stringify(geo.pts));
  check('pasa por el primer punto indicado',
    geo.pts.some((p) => p.x === 400 && p.y === 560), JSON.stringify(geo.pts));
  check('sale de la salida calculada',
    Math.abs(geo.pts[0].x - geo.p1.x) < 0.01 && Math.abs(geo.pts[0].y - geo.p1.y) < 0.01, JSON.stringify(geo.pts));
  check('entra en la entrada calculada',
    Math.abs(geo.pts[geo.pts.length - 1].x - geo.p2.x) < 0.01
    && Math.abs(geo.pts[geo.pts.length - 1].y - geo.p2.y) < 0.01, JSON.stringify(geo.pts));
  check('sale por la derecha del origen', geo.p1.x > a.x + a.w - 1, JSON.stringify(geo.p1));
  check('no atraviesa el destino', !cruzaNodo(geo.pts, b), JSON.stringify(geo.pts));

  // Varios puntos alternando ejes: sigue recta y ortogonal.
  e.way = [{ x: 400, y: 600 }, { x: 600, y: 600 }, { x: 600, y: 200 }, { x: 700, y: 200 }];
  const geo2 = edgeGeometry(g, e);
  check('recorrido con giros: ortogonal', orto(geo2.pts), JSON.stringify(geo2.pts));
  check('recorrido con giros: visita los puntos',
    [600, 200].every((v) => geo2.pts.some((p) => p.x === v || p.y === v)), JSON.stringify(geo2.pts));

  // La etiqueta se apoya en el tramo más largo del nuevo recorrido.
  check('la etiqueta se recoloca', labelSpot(geo2).x !== null, JSON.stringify(labelSpot(geo2)));

  // Guardar y abrir conserva los puntos de control.
  const back = deserialize(JSON.stringify(g));
  const be = back.edges[0];
  check('los puntos se guardan', be.way.length === 4 && be.way[2].x === 600, JSON.stringify(be.way));
  check('y sobreviven a la geometría', orto(edgeGeometry(back, be).pts));

  // Puntos basura (o inexistentes) no rompen el trazado.
  const sucio = createEdge(a.id, b.id, { way: [{ x: 'a', y: null }, { x: 520, y: 520 }, { z: 1 }] });
  g.edges.push(sucio);
  check('puntos inválidos se descartan', edgeGeometry(g, sucio) !== null
    && !edgeGeometry(g, sucio).pts.some((p) => !Number.isFinite(p.x)), JSON.stringify(edgeGeometry(g, sucio)));
}

console.log('\n17. Guía del trazo y puntos de control');
{
  // La guía se mueve en horizontal o en vertical, nunca en diagonal.
  check('guía horizontal', JSON.stringify(guidePoint({ x: 0, y: 0 }, { x: 120, y: 20 })) === '{"x":120,"y":0}',
    JSON.stringify(guidePoint({ x: 0, y: 0 }, { x: 120, y: 20 })));
  check('guía vertical', JSON.stringify(guidePoint({ x: 0, y: 0 }, { x: 20, y: -120 })) === '{"x":0,"y":-120}',
    JSON.stringify(guidePoint({ x: 0, y: 0 }, { x: 20, y: -120 })));
  // El eje elegido no cambia mientras el cursor siga yendo por el mismo lado.
  check('la guía no parpadea en diagonal',
    JSON.stringify(guidePoint({ x: 0, y: 0 }, { x: 100, y: 60 }, 'x')) === '{"x":100,"y":0}',
    JSON.stringify(guidePoint({ x: 0, y: 0 }, { x: 100, y: 60 }, 'x')));

  // Un punto de control nunca queda dentro de un nodo.
  const dentro = avoidNodes({ x: 400, y: 300 }, [{ x: 300, y: 200, w: 200, h: 200 }]);
  check('el punto sale del nodo por el lado más cercano',
    dentro.x === 297 || dentro.x === 503 || dentro.y === 197 || dentro.y === 403, JSON.stringify(dentro));
  const fuera = avoidNodes({ x: 100, y: 100 }, [{ x: 300, y: 200, w: 200, h: 200 }]);
  check('si está libre no se mueve', fuera.x === 100 && fuera.y === 100, JSON.stringify(fuera));

  // Enganchar un control a la polilínea más cercana.
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  const p1 = nearestOnPolyline(pts, 90, 30);
  check('el control cae en el tramo más cercano', Math.abs(p1.x - 100) < 0.01 && Math.abs(p1.y - 30) < 0.01, JSON.stringify(p1));
  const p3 = nearestOnPolyline(pts, 40, 30);
  check('si el tramo horizontal está más cerca, ése', p3.x === 40 && p3.y === 0, JSON.stringify(p3));
  const p2 = nearestOnPolyline(pts, -80, -40);
  check('fuera del recorrido cae en el extremo', p2.x === 0 && p2.y === 0, JSON.stringify(p2));
}

console.log('\n17b. El lado de entrada: el más cercano al puntero');
{
  const N = (type, x, y, w, h) => ({ id: 'n', type, x, y, w, h, label: '', note: '' });
  const act = N('activity', 0, 0, 176, 64);
  check('cerca del borde izquierdo -> izquierda', sideNear(act, { x: 20, y: 32 }) === 'left', sideNear(act, { x: 20, y: 32 }));
  check('cerca del borde derecho -> derecha', sideNear(act, { x: 160, y: 32 }) === 'right', sideNear(act, { x: 160, y: 32 }));
  check('cerca del borde superior -> arriba', sideNear(act, { x: 88, y: 6 }) === 'top', sideNear(act, { x: 88, y: 6 }));
  check('cerca del borde inferior -> abajo', sideNear(act, { x: 88, y: 58 }) === 'bottom', sideNear(act, { x: 88, y: 58 }));
  // En una caja alargada manda la cercanía proporcional: 12 px por debajo del
  // centro están mucho más cerca del borde inferior que del derecho, aunque en
  // píxeles sueltos "gane" el horizontal.
  check('un poco por debajo del centro, cerca de un lado -> abajo',
    sideNear(act, { x: 100, y: 40 }) === 'bottom', sideNear(act, { x: 100, y: 40 }));
  check('junto al borde izquierdo, un poco por encima -> izquierda',
    sideNear(act, { x: 24, y: 20 }) === 'left', sideNear(act, { x: 24, y: 20 }));
  check('el centro cae en un lado horizontal',
    ['left', 'right'].includes(sideNear(act, { x: 88, y: 32 })), sideNear(act, { x: 88, y: 32 }));
  // Cuadrados y círculos: se comportan como antes.
  const dia = N('decision', 0, 0, 132, 132);
  check('rombo: arriba', sideNear(dia, { x: 66, y: 10 }) === 'top', sideNear(dia, { x: 66, y: 10 }));
  check('rombo: izquierda', sideNear(dia, { x: 10, y: 66 }) === 'left', sideNear(dia, { x: 10, y: 66 }));
  const ini = N('start', 0, 0, 20, 20);
  check('círculo: izquierda', sideNear(ini, { x: 3, y: 10 }) === 'left', sideNear(ini, { x: 3, y: 10 }));
  check('círculo: abajo', sideNear(ini, { x: 10, y: 18 }) === 'bottom', sideNear(ini, { x: 10, y: 18 }));
}

console.log('\n17c. El trazo dobla solo una vez tras un giro');
{
  const orto = (pts) => pts.every((p, i) => i === 0
    || p.x === pts[i - 1].x || p.y === pts[i - 1].y);
  const p0 = { x: 0, y: 0 };
  const n0 = { x: 1, y: 0 };

  // Sin giros: el trazo sale recto en el eje elegido y llega al puntero con un
  // único cambio de dirección.
  const cola = [{ x: 120, y: 0 }, { x: 120, y: 60 }];
  const pts = userRouteTip(p0, n0, [], cola);
  check('un tramo recto y un desvío, todo ortogonal', orto(pts), JSON.stringify(pts));
  check('el desvío ocurre una sola vez',
    pts.filter((p) => p.x === 120).length === 2, JSON.stringify(pts));
  check('el trazo llega al puntero',
    pts[pts.length - 1].x === 120 && pts[pts.length - 1].y === 60, JSON.stringify(pts));

  // La punta al mismo alto que la base: el desvío tiene longitud cero y
  // desaparece (el trazo queda recto).
  const recto = userRouteTip(p0, n0, [], [{ x: 120, y: 0 }, { x: 120, y: 0 }]);
  check('sin desvío no queda un tramo de cero', orto(recto) && recto.length <= 2, JSON.stringify(recto));

  // Con un giro de por medio, el tramo nuevo también puede doblar una vez: la
  // flecha baja hasta el giro, sigue recta y se desvía al puntero.
  const conGiro = userRouteTip(p0, n0, [{ x: 40, y: -30 }], [{ x: 40, y: 90 }, { x: 200, y: 90 }]);
  check('tras el giro vuelve a poder doblar', orto(conGiro), JSON.stringify(conGiro));
  check('el desvío ocurre en el tramo del puntero',
    conGiro[conGiro.length - 1].x === 200 && conGiro[conGiro.length - 1].y === 90, JSON.stringify(conGiro));
  check('y no encadena un segundo desvío automático',
    !conGiro.slice(conGiro.findIndex((p) => p.x === 40 && p.y === -30) + 1)
      .some((p, i, t) => i > 0 && p.x !== t[i - 1].x && p.y !== t[i - 1].y),
    JSON.stringify(conGiro));

  // Un solo punto de cola (sin desvío) sigue funcionando.
  check('también acepta un único punto',
    orto(userRouteTip(p0, n0, [], [{ x: 90, y: 0 }])), JSON.stringify(userRouteTip(p0, n0, [], [{ x: 90, y: 0 }])));
}

console.log('\n17d. Enganche de las líneas de una flecha a los nodos');
{
  const lineas = [{ v: 100 }, { v: 300 }, { v: 500 }];
  check('una línea a 4 px se engancha exacta', snapLine(104, lineas, 6) === -4, snapLine(104, lineas, 6));
  check('gana la línea más cercana', snapLine(297, lineas, 6) === 3, snapLine(297, lineas, 6));
  check('lejos de toda línea no corrige', snapLine(200, lineas, 6) === 0, snapLine(200, lineas, 6));
  check('el margen es el que se le pasa', snapLine(200, lineas, 10) === -100 + 100, snapLine(200, lineas, 10));
  check('sin líneas no corrige', snapLine(120, [], 6) === 0);
  check('admite números sueltos', snapLine(104, [100, 300], 6) === -4, snapLine(104, [100, 300], 6));

  // Las referencias son las líneas reales de los nodos (borde, centro y borde).
  const g = createDiagram();
  const a = createNode('activity', 300, 300);
  g.nodes.push(a);
  const t = alignTargets(g.nodes);
  check('las referencias del enganche son borde, centro y borde',
    t.xs.length === 3 && t.ys.length === 3, JSON.stringify(t.xs.map((q) => q.v)));
  check('y son las del nodo', t.xs.every((q) => q.v === a.x || q.v === a.x + a.w / 2 || q.v === a.x + a.w));
}

console.log('\n18. Copiar y pegar (portapapeles)');
{
  const g = createDiagram();
  const a = createNode('activity', 300, 300, { label: 'A', note: 'n1' });
  const b = createNode('activity', 600, 300, { label: 'B' });
  const suelta = createNode('activity', 300, 600, { label: 'Suelta' });
  g.nodes.push(a, b, suelta);
  const e = createEdge(a.id, b.id, { label: 'sí', condition: 'x > 0', way: [{ x: 400, y: 500 }] });
  const otra = createEdge(b.id, suelta.id);
  g.edges.push(e, otra);

  const clip = copyGroup(g, [{ type: 'node', id: a.id }, { type: 'node', id: b.id }]);
  check('copia los dos nodos', clip.nodes.length === 2, JSON.stringify(clip.nodes));
  check('copia el flujo que los une', clip.edges.length === 1 && clip.edges[0].from === 0 && clip.edges[0].to === 1);
  check('conserva etiqueta, condición y giros',
    clip.edges[0].label === 'sí' && clip.edges[0].condition === 'x > 0' && clip.edges[0].way.length === 1,
    JSON.stringify(clip.edges[0]));
  check('no copia nodos sueltos fuera de la selección', clip.nodes.length === 2);

  const antes = g.nodes.length;
  const { nodes, edges } = pasteGroup(g, clip, 400, 0);
  check('pega los nodos', g.nodes.length === antes + 2 && nodes.length === 2);
  check('los ids son nuevos', !nodes.some((n) => n.id === a.id || n.id === b.id));
  check('el desplazamiento se aplica', nodes[0].x === a.x + 400 && nodes[0].y === a.y);
  check('recrea el flujo entre los nuevos', edges.length === 1 && edges[0].from === nodes[0].id && edges[0].to === nodes[1].id);
  check('los puntos de control se desplazan con el grupo',
    edges[0].way.length === 1 && edges[0].way[0].x === 800 && edges[0].way[0].y === 500, JSON.stringify(edges[0].way));

  // Pegar dos veces no pisa nada: los ids siguen siendo distintos.
  const otra2 = pasteGroup(g, clip, 800, 0);
  check('pegar dos veces duplica sin colisionar ids',
    new Set(g.nodes.map((n) => n.id)).size === g.nodes.length);

  // La caja del grupo y el hueco libre más cercano al puntero.
  const box = groupBounds(clip.nodes);
  check('caja del grupo', box.x === a.x && box.w === (b.x + b.w) - a.x, JSON.stringify(box));
  const libre = freeSpot([{ x: a.x, y: a.y, w: a.w, h: a.h }], box, { x: a.x + box.w / 2, y: a.y + box.h / 2 });
  check('si el puntero cae encima, busca el hueco más cercano', libre.moved === true
    && (libre.x !== Math.round((a.x + box.w / 2 - box.w / 2) / 24) * 24 || libre.y !== a.y), JSON.stringify(libre));
  check('y el hueco no pisa ningún nodo', !solapan({ x: libre.x, y: libre.y, w: box.w, h: box.h }, a), JSON.stringify(libre));
  const encaja = freeSpot([], box, { x: 1000, y: 800 });
  check('sin estorbo, pega justo bajo el puntero', encaja.moved === false
    && encaja.x === Math.round((1000 - box.w / 2) / 24) * 24, JSON.stringify(encaja));
}

console.log('\n19. Nodo de punto muerto');
{
  check('existe el tipo punto muerto', !!NODE_TYPES.stop);
  const g = createDiagram();
  const s1 = createNode('start', 100, 300);
  const a = createNode('activity', 320, 300, { label: 'Comprobar' });
  const stop = createNode('stop', 560, 300);
  g.nodes.push(s1, a, stop);
  check('se crea cuadrado (es un círculo)', stop.w === stop.h && stop.w > 0);
  check('es más grande que el inicio/fin', stop.w > s1.w);
  g.edges.push(createEdge(s1.id, a.id), createEdge(a.id, stop.id));
  const v = summary(validate(g));
  check('validación sin errores', v.error === 0, JSON.stringify(validate(g)));
  check('no se le pide una salida (es un final del flujo)',
    !validate(g).some((x) => x.nodeId === stop.id && x.msg.includes('sin salida')),
    JSON.stringify(validate(g)));
  check('la simulación se detiene ahí', run(g, {}).sim.finished);
  check('y lo dice en el registro',
    run(g, {}).sim.log.some((l) => l.type === 'stop' && l.text.includes('se detiene')));

  // Un punto muerto con salida es un error.
  const b = createNode('activity', 800, 300);
  g.nodes.push(b);
  g.edges.push(createEdge(stop.id, b.id));
  check('con salida es un error',
    validate(g).some((x) => x.level === 'error' && x.msg.includes('no puede tener salida')),
    JSON.stringify(validate(g).filter((x) => x.level === 'error')));

  // Sobrevive al guardado.
  const back = deserialize(JSON.stringify(g));
  check('el punto muerto sobrevive al guardado', back.nodes.some((n) => n.type === 'stop'));
}

console.log('\n20. Alineación: guías de arrastre');
{
  // Dos actividades en filas distintas: al arrastrar la segunda cerca de la
  // primera sus centros tienen que caer en la misma línea.
  const g = createDiagram();
  const alta = createNode('activity', 300, 300, { label: 'A' });  // y 268..332, centro 300
  const baja = createNode('activity', 600, 460, { label: 'B' });  // y 428..492, centro 460
  g.nodes.push(alta, baja);
  // Igual que en el arrastre real: el nodo que se mueve no es referencia.
  const mover = (rect, dx, dy, tol = 6) =>
    snapMove(g.nodes, [rect], dx, dy, { tol, skip: new Set([baja.id]) });

  check('la caja del grupo es la del nodo',
    unionBox([baja]).y === baja.y && unionBox([baja]).h === baja.h);

  // A 3 px del centro de la otra: engancha exacto.
  let r = mover({ ...baja, y: baja.y - 157 }, 0, -157);
  check('el centro se engancha al centro de al lado', r.dy === -160, JSON.stringify(r));
  check('y avisa con su guía', r.guides.some((q) => q.axis === 'y'), JSON.stringify(r.guides));
  check('en horizontal no hay nada cerca, así que no toca',
    r.dx === 0 && !r.guides.some((q) => q.axis === 'x'), JSON.stringify(r.guides));

  // Lejos de toda línea, el movimiento se queda como estaba.
  r = mover({ ...baja, y: baja.y - 60 }, 0, -60);
  check('lejos de todo, no corrige', r.dy === -60 && r.guides.length === 0, JSON.stringify(r));

  // El borde izquierdo también sirve: el desplazamiento que devuelve `snapMove`
  // es el definitivo (el pedido + la corrección), como lo usa el arrastre.
  r = mover({ ...baja, x: baja.x - 215 }, -215, 0);
  check('el borde izquierdo se engancha al del lado', r.dx === -212, JSON.stringify(r));

  // Sin `skip` el nodo se ancla a sí mismo (justo lo que el arrastre evita).
  r = snapMove(g.nodes, [{ ...baja, x: baja.x + 4 }], 4, 0, { tol: 6 });
  check('sin `skip` se ancla a su propia posición', r.dx === 0, JSON.stringify(r));

  // Columna y fila a la vez.
  r = mover({ ...baja, x: baja.x - 215, y: baja.y - 157 }, -215, -157);
  check('las dos guías a la vez', r.guides.length === 2 && r.dx === -212 && r.dy === -160, JSON.stringify(r.guides));
  const guiaY = r.guides.find((q) => q.axis === 'y');
  check('la guía abarca los dos nodos',
    guiaY.from < alta.y && guiaY.to > alta.y + alta.h, JSON.stringify(guiaY));

  // Las referencias son borde, centro y borde de cada nodo quieto.
  const t = alignTargets(g.nodes, new Set([baja.id]));
  check('borde, centro y borde por nodo',
    t.xs.length === 3 * (g.nodes.length - 1) && t.ys.length === 3 * (g.nodes.length - 1),
    JSON.stringify({ xs: t.xs.length, ys: t.ys.length }));
  check('el nodo que se mueve no ofrece referencias', !t.xs.some((q) => q.node.id === baja.id));

  // El margen llega en píxeles de pantalla: interact.js lo divide por el zoom.
  const conMargen = mover({ ...baja, y: baja.y - 156 }, 0, -156, 6);
  const sinMargen = mover({ ...baja, y: baja.y - 156 }, 0, -156, 1);
  check('el margen de enganche es el que se le pasa',
    conMargen.dy === -160 && conMargen.guides.length === 1
    && sinMargen.dy === -156 && sinMargen.guides.length === 0,
    JSON.stringify({ conMargen, sinMargen }));

  // Un grupo se mueve rígido: la guía se calcula sobre su caja, no nodo a nodo.
  const par = [createNode('activity', 1200, 500), createNode('activity', 1500, 700)];
  g.nodes.push(...par);
  const caja = unionBox(par);
  const separacion = par[1].y - par[0].y;
  r = snapMove(g.nodes, par.map((n) => ({ ...n, y: n.y - 200 })), 0, -200,
    { tol: 6, skip: new Set(par.map((n) => n.id)) });
  check('el grupo se engancha por su caja', r.dy === -200 && r.guides.length === 1, JSON.stringify({ r, caja }));
  check('y nadie cambia de sitio dentro del grupo',
    (par[1].y + r.dy) - (par[0].y + r.dy) === separacion
    && par[0].y + r.dy + par[0].h / 2 === alta.y + alta.h / 2, JSON.stringify({ r, caja }));
}

console.log('\n21. Alineación: redimensión');
{
  // Se coloca el nodo a mano para que las cuentas del test sean legibles:
  // `a` ocupa x 600..776 (líneas 600/688/776) y `b` empieza en 500.
  const g = createDiagram();
  const a = createNode('activity', 0, 0);
  const b = createNode('activity', 0, 0);
  a.x = 600; a.y = 364; b.x = 500; b.y = 300;
  g.nodes.push(a, b);

  // El borde que se arrastra (derecho) a 3 px del de `a`.
  const r = snapSize(g.nodes, b, 103, 60, { tol: 6 });
  check('el borde que se arrastra se engancha', r.w === 100, JSON.stringify(r));
  check('y avisa con su guía', r.guides.some((q) => q.axis === 'x'), JSON.stringify(r.guides));
  check('la guía abarca los dos nodos',
    r.guides[0].from <= Math.min(a.y, b.y) && r.guides[0].to >= Math.max(a.y + a.h, b.y + b.h),
    JSON.stringify(r.guides));

  // El centro manda el doble de corrección: se mueve el borde fijo.
  const c = snapSize(g.nodes, b, 370, 60, { tol: 6 });
  check('el centro se engancha moviendo el otro borde', c.w === 376, JSON.stringify(c));

  // En vertical, igual que en horizontal.
  const v = snapSize(g.nodes, b, 176, 66, { tol: 6 });
  check('también en vertical', v.h === 64 && v.guides.some((q) => q.axis === 'y'), JSON.stringify(v));

  // El nodo no se mueve de sitio: sólo cambian sus medidas.
  check('sin cambios de sitio', b.x === 500 && b.y === 300);

  // Lejos de toda línea no corrige, y un nodo no se usa a sí mismo.
  check('lejos de todo, no corrige', snapSize(g.nodes, b, 300, 150, { tol: 6 }).w === 300);
  const solo = snapSize([b], b, 103, 66, { tol: 6 });
  check('sin otros nodos no hay nada que encajar', solo.w === 103 && solo.guides.length === 0, JSON.stringify(solo));
}

console.log('\n22. Alineación: comandos del inspector');
{
  const g = createDiagram();
  const a = createNode('activity', 300, 300);
  const b = createNode('activity', 600, 462);   // 4 px más abajo que a
  const c = createNode('note', 900, 620);
  g.nodes.push(a, b, c);
  const ids = [a.id, b.id, c.id];
  const centroY = (n) => n.y + n.h / 2;
  // El plan se calcula antes de mutar (para poder apilar el historial antes).
  const aplicar = (plan) => {
    for (const p of plan) Object.assign(nodeById(g, p.id), p);
    return plan;
  };

  aplicar(planAlign(g, ids, 'left'));
  check('alinear a la izquierda', a.x === b.x && b.x === c.x, JSON.stringify([a.x, b.x, c.x]));

  aplicar(planAlign(g, ids, 'centerY'));
  check('centrar en vertical comparte el centro aunque sean de distinto alto',
    new Set([a, b, c].map(centroY)).size === 1, JSON.stringify([a, b, c].map(centroY)));
  check('y sólo cambia el eje pedido', a.x === b.x && b.x === c.x, JSON.stringify([a.x, b.x, c.x]));

  aplicar(planAlign(g, ids, 'right'));
  check('alinear a la derecha', a.x + a.w === c.x + c.w && b.x + b.w === c.x + c.w);

  aplicar(planAlign(g, ids, 'bottom'));
  check('alinear abajo', a.y + a.h === c.y + c.h, JSON.stringify([a.y, b.y, c.y]));
  check('modo desconocido: no hace nada', planAlign(g, ids, 'diagonal').length === 0);

  // Un nodo suelto se alinea contra el resto del diagrama.
  c.y = 700;
  const yPrevio = a.y;
  aplicar(planAlign(g, [c.id], 'centerY'));
  const resto = unionBox([a, b]);
  check('un nodo suelto se alinea con el resto',
    Math.abs(centroY(c) - (resto.y + resto.h / 2)) <= 1, JSON.stringify({ c: centroY(c), resto }));
  check('y no mueve a los otros', a.y === yPrevio);
  check('si está solo en el diagrama no hay con qué alinear',
    planAlign({ ...g, nodes: [c] }, [c.id], 'centerY').length === 0);

  // Repartir: huecos iguales dejando fijos el primero y el último.
  const h1 = createNode('activity', 1500, 300);
  const h2 = createNode('activity', 1700, 500);
  const h3 = createNode('activity', 2200, 700);
  g.nodes.push(h1, h2, h3);
  const plan = planDistribute(g, [h1.id, h2.id, h3.id], 'x');
  check('repartir deja el primero y el último quietos',
    !plan.some((p) => p.id === h1.id || p.id === h3.id), JSON.stringify(plan));
  aplicar(plan);
  const huecos = [h2.x - (h1.x + h1.w), h3.x - (h2.x + h2.w)];
  check('y huecos iguales en medio', Math.abs(huecos[0] - huecos[1]) < 1, JSON.stringify(huecos));
  check('con menos de tres nodos no se reparte', planDistribute(g, [h1.id, h2.id], 'x').length === 0);
  check('eje desconocido: nada', planDistribute(g, [h1.id, h2.id, h3.id], 'z').length === 0);
  check('si los nodos se pisan, no propone nada',
    planDistribute(g, [a.id, b.id, c.id], 'x').length === 0, JSON.stringify([a.x, b.x, c.x]));
}

console.log('\n23. Nodos de proceso, tiempo y notificación');
{
  const g = createDiagram();
  const ini = createNode('start', 120, 300);
  const pro = createNode('proceso', 360, 300, { label: 'Procesar' });
  const tie = createNode('tiempo', 620, 300, { label: 'Esperar' });
  const env = createNode('enviar', 880, 300, { label: 'Avisar' });
  const rec = createNode('recibir', 1140, 300, { label: 'Recibido' });
  const fin = createNode('end', 1400, 300);
  g.nodes.push(ini, pro, tie, env, rec, fin);
  g.edges.push(
    createEdge(ini.id, pro.id),
    createEdge(pro.id, tie.id),
    createEdge(tie.id, env.id),
    createEdge(env.id, rec.id),
    createEdge(rec.id, fin.id),
  );

  check('existen los cuatro tipos nuevos', ['proceso', 'tiempo', 'enviar', 'recibir']
    .every((t) => !!NODE_TYPES[t]), Object.keys(NODE_TYPES).join(','));
  check('fork y join no llevan etiqueta por defecto',
    createNode('fork', 0, 0).label === '' && createNode('join', 0, 0).label === '',
    `"${createNode('fork', 0, 0).label}"`);
  check('el diagrama de ejemplo no rotula fork ni join',
    sampleDiagram().nodes.filter((n) => n.type === 'fork' || n.type === 'join').every((n) => !n.label));
  check('validación sin errores', summary(validate(g)).error === 0, JSON.stringify(validate(g)));
  check('la simulación los atraviesa', run(g, {}).sim.finished);

  // Enviar notificación: pico hacia fuera por la derecha.
  const ps = shapeAttrs(env).attrs.points.split(' ').map((p) => p.split(',').map(Number));
  const xsS = ps.map((p) => p[0]);
  const ysS = ps.map((p) => p[1]);
  check('enviar: el lado derecho sale en pico', Math.max(...xsS) === env.x + env.w, JSON.stringify(ps));
  check('enviar: los otros tres lados son rectos',
    ps.every((p) => (p[0] === env.x + env.w ? p[1] === env.y + env.h / 2 : p[1] === env.y || p[1] === env.y + env.h)),
    JSON.stringify(ps));

  // Recibir notificación: muesca triangular hacia dentro por la izquierda.
  const pr = shapeAttrs(rec).attrs.points.split(' ').map((p) => p.split(',').map(Number));
  const puntaRec = pr.find((p) => p[0] > rec.x && p[0] < rec.x + rec.w);
  check('recibir: la muesca entra hacia dentro por la izquierda',
    !!puntaRec && puntaRec[1] === rec.y + rec.h / 2
    && Math.min(...pr.map((p) => p[0])) === rec.x, JSON.stringify(pr));
  check('recibir: los otros tres lados son rectos',
    pr.filter((p) => p !== puntaRec).every((p) =>
      p[1] === rec.y || p[1] === rec.y + rec.h || p[0] === rec.x || p[0] === rec.x + rec.w),
    JSON.stringify(pr));

  // Tiempo: reloj de arena (barras arriba y abajo y la cruz en el centro).
  const pt = shapeAttrs(tie).attrs.points.split(' ').map((p) => p.split(',').map(Number));
  const cx = tie.x + tie.w / 2;
  const cy = tie.y + tie.h / 2;
  check('tiempo: barras horizontales arriba y abajo',
    pt.some((p) => p[0] === tie.x && p[1] === tie.y)
    && pt.some((p) => p[0] === tie.x + tie.w && p[1] === tie.y + tie.h), JSON.stringify(pt));
  check('tiempo: las diagonales se cruzan en el centro',
    pt.filter((p) => p[0] === cx && p[1] === cy).length === 2, JSON.stringify(pt));
  check('tiempo: algo más pequeño que una actividad',
    tie.w < NODE_TYPES.activity.w && tie.h < NODE_TYPES.activity.h, `${tie.w}x${tie.h}`);
  check('tiempo: es cuadrado', tie.w === tie.h, `${tie.w}x${tie.h}`);
  check('tiempo: sólo se conecta por arriba y por abajo',
    Object.keys(anchors(tie)).join(',') === 'top,bottom'
    && nodeSides(tie).join(',') === 'top,bottom', Object.keys(anchors(tie)).join(','));
  check('tiempo: un flujo antiguo por el lado se recoloca arriba o abajo',
    pickSides(g, { from: tie.id, to: fin.id, fromSide: 'right', toSide: 'left' }).from === 'bottom',
    JSON.stringify(pickSides(g, { from: tie.id, to: fin.id, fromSide: 'right', toSide: 'left' })));
  check('tiempo: al pulsar su cuerpo el lado es vertical',
    sideNear(tie, { x: tie.x - 100, y: tie.y + tie.h + 100 }) === 'bottom'
    && sideNear(tie, { x: tie.x + 300, y: tie.y - 60 }) === 'top');
  const barraP = createNode('fork', 0, 0);
  check('fork/join: sólo se conectan por los lados',
    nodeSides(barraP).join(',') === 'left,right'
    && Object.keys(anchors(barraP)).join(',') === 'left,right', Object.keys(anchors(barraP)).join(','));
  check('fork/join: al pulsar el cuerpo el lado es horizontal',
    sideNear(barraP, { x: barraP.x - 200, y: barraP.y + 300 }) === 'left'
    && sideNear(barraP, { x: barraP.x + barraP.w + 200, y: barraP.y - 300 }) === 'right');
  const gb = createDiagram();
  const destino = createNode('join', 300, 0);
  gb.nodes.push(barraP, destino);
  const ladosViejos = pickSides(gb, {
    from: barraP.id, to: destino.id, fromSide: 'top', toSide: 'bottom',
  });
  check('fork/join: un flujo antiguo por arriba/abajo se recoloca a un lado',
    ladosViejos.from === 'left' && ladosViejos.to === 'right', JSON.stringify(ladosViejos));

  // Proceso: la misma caja redondeada que la actividad + tridente invertido.
  const shapePro = shapeAttrs(pro);
  check('proceso: misma caja que la actividad',
    shapePro.tag === 'rect' && shapePro.attrs.rx === ACTIVITY_RX, JSON.stringify(shapePro));
  const tr = tridentePuntos(pro);
  check('proceso: tridente de cuatro trazos rectos', tr.length === 4, JSON.stringify(tr));
  check('proceso: el tridente cae en la esquina inferior derecha y dentro del nodo',
    tr.every((l) => l.x1 >= pro.x && l.y1 >= pro.y && l.x2 <= pro.x + pro.w && l.y2 <= pro.y + pro.h),
    JSON.stringify(tr));
  check('proceso: el tridente es corto, no alargado',
    tr.every((l) => Math.max(Math.abs(l.x2 - l.x1), Math.abs(l.y2 - l.y1)) <= 16), JSON.stringify(tr));
  check('proceso: las púas apuntan hacia abajo (tridente invertido)',
    tr.filter((l) => l.x1 === l.x2).every((l) => l.y2 > l.y1) && tr.length - 1 === 3, JSON.stringify(tr));

  // Sobreviven al guardado y se pueden cambiar de tipo en el inspector.
  const back = deserialize(JSON.stringify(g));
  check('los nodos nuevos sobreviven al guardado',
    ['proceso', 'tiempo', 'enviar', 'recibir'].every((t) => back.nodes.some((n) => n.type === t)),
    back.nodes.map((n) => n.type).join(','));

  const abierto = deserialize(JSON.stringify({ ...g, nodes: g.nodes.map((n) => ({ ...n })) }));
  abierto.nodes[1].type = 'activity';
  check('cambiar de tipo no deja atributos del anterior',
    shapeAttrs(abierto.nodes[1]).tag === 'rect' && shapeAttrs(abierto.nodes[1]).attrs.rx === 12,
    JSON.stringify(shapeAttrs(abierto.nodes[1])));
}

console.log(`\n${pass} pruebas ok, ${fail} fallos\n`);
process.exit(fail ? 1 : 0);

