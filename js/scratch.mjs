/**
 * Diagnóstico final: repliega la geometria de drawTempEdge y de edgeGeometry.
 */
import { anchors, sideNormal, userRouteTip, guidePoint, guideAxis, exitGuide, wallLimit, edgeGeometry } from './routing.js';
import { createEdge } from './model.js';

function geoDelOrigen(origen, fromSide, way, cursor, obstacles = []) {
  const n0 = sideNormal(fromSide);
  const ancla = anchors(origen)[fromSide];
  const p0 = { x: ancla.x + n0.x * 1.5, y: ancla.y + n0.y * 1.5 };
  const baseP = way.length ? way[way.length - 1] : p0;
  const axis = guideAxis(baseP, cursor, null);
  const tip = way.length ? guidePoint(baseP, cursor, axis) : exitGuide(p0, n0, axis, cursor);
  let pts = userRouteTip(p0, n0, way, tip);
  pts = wallLimit(pts, obstacles.filter((n) => n.id !== origen.id));
  const pts2 = wallLimit(pts, [origen], 0);
  return { p0, tip, pts, pts2 };
}

function cruza(pts, r) {
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    if (x2 > r.x && x1 < r.x + r.w && y2 > r.y && y1 < r.y + r.h) return true;
  }
  return false;
}

function dentro(r, p, margen = 0) {
  return p.x > r.x + margen && p.x < r.x + r.w - margen && p.y > r.y + margen && p.y < r.y + r.h - margen;
}

function act(id, x, y, w, h) { return { id, type: 'activity', x, y, w, h, label: '', note: '' }; }

function report(label, origen, fromSide, way, cursor, obstacles = []) {
  const g = geoDelOrigen(origen, fromSide, way, cursor, obstacles);
  const final = g.pts2;
  const ultimo = final[final.length - 1];
  const cruzado = obstacles.some((n) => cruza(final, n));
  const dentroO = dentro(origen, ultimo, 0);
  const ortogonal = final.every((p, i) => i === 0 || p.x === final[i - 1].x || p.y === final[i - 1].y);
  const ok = final.length >= 2 && !cruzado && !dentroO && ortogonal;
  console.log(`${ok ? 'OK  ' : 'BAD '}${label}`);
  if (!ok) console.log(`     pts=${JSON.stringify(final)} tip=${JSON.stringify(g.tip)} cruzado=${cruzado} dentroOrigen=${dentroO}`);
}

const origenes = [
  act('o1', 300, 200, 176, 64),
  act('o2', 300, 100, 176, 64),
  act('o3', 300, 300, 176, 64),
];
for (const O of origenes) {
  for (const fromSide of ['right', 'left', 'top', 'bottom']) {
    report(`recto: ${O.id} sale ${fromSide}`, O, fromSide, [], { x: O.x + 400, y: O.y + 32 });
    report(`cursor detrás del origen: ${O.id} sale ${fromSide}`, O, fromSide, [], { x: O.x - 100, y: O.y + 32 });
    report(`cursor al otro lado: ${O.id} sale ${fromSide}`, O, fromSide, [], { x: O.x - 400, y: O.y + 32 });
    report(`way=[giro]`, O, fromSide, [{ x: O.x + 300, y: O.y + 32 }], { x: O.x + 380, y: O.y + 100 });
    report(`way=[giro + vuelta]`, O, fromSide, [{ x: O.x + 300, y: O.y + 32 }, { x: O.x - 100, y: O.y + 32 }], { x: O.x + 380, y: O.y + 100 });
  }
}
{
  const O = act('o1', 300, 200, 176, 64);
  report('con obstáculo en el medio', O, 'right', [], { x: 900, y: 232 }, [act('m', 600, 200, 176, 64)]);
}
{
  const O = act('o1', 300, 200, 176, 64);
  report('con obstáculo y way', O, 'right', [{ x: 800, y: 232 }], { x: 850, y: 232 }, [act('m', 600, 200, 176, 64)]);
}
{
  const O = act('o1', 300, 200, 176, 64);
  report('origen solito, cursor al oeste', O, 'right', [], { x: 100, y: 232 });
}

console.log('\n--- escenario del usuario: salida abajo, destino arriba y a la derecha ---');
const O = act('o', 300, 200, 176, 64);
const D = act('d', 400, 40, 176, 64);
report('salida abajo -> cursor arriba-derecha (auto)', O, 'bottom', [], { x: 476, y: 40 });
report('salida abajo -> cursor arriba-derecha con way', O, 'bottom', [{ x: 388, y: 330 }, { x: 388, y: 100 }], { x: 476, y: 40 });
report('salida abajo -> destino encima (hover)', O, 'bottom', [], { x: 476, y: 40 }, [D]);

console.log('\n--- edgeGeometry final con way que cruzaba el origen ---');
const g = { nodes: [O, D], edges: [] };
const e = createEdge(O.id, D.id, { fromSide: 'bottom', toSide: 'top', way: [{ x: 388, y: 330 }, { x: 388, y: 100 }] });
g.edges.push(e);
const geo = edgeGeometry(g, e);
console.log('geo.pts =', JSON.stringify(geo && geo.pts));
console.log('cruza origen:', cruza(geo.pts, O), ' cruza destino:', cruza(geo.pts, D));
