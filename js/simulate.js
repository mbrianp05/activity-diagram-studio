/**
 * Simulador de flujo de control con semántica de nodos de Activities.
 *
 * Reglas:
 *  - start / activity / note: consumen 1 token y lo emiten por cada salida.
 *  - decision: consume 1 token y toma las salidas cuya condición sea verdadera
 *    (o la única salida no etiquetada).
 *  - barra de paralelo: su papel lo deciden las flechas (`barRole`), no el tipo
 *    guardado. Con 2+ entradas sincroniza (join); con 2+ salidas reparte
 *    (fork); con ambas cosas hace las dos.
 */
import { barRole } from './model.js';

/** ¿El nodo es una barra de paralelo? */
const isBar = (n) => n && (n.type === 'fork' || n.type === 'join');

export function createSim(d) {
  return {
    queue: [],
    tokens: new Map(),      // nodeId -> nº de tokens
    arrivals: new Map(),    // joinId -> Set(edgeId)
    activeEdges: new Set(),
    log: [],
    status: 'ready',
    vars: {},
    history: [],
    finished: false,
    deadlocked: false,
  };
}

const add = (map, k, v = 1) => map.set(k, (map.get(k) || 0) + v);
const del = (map, k, v = 1) => {
  const n = (map.get(k) || 0) - v;
  if (n <= 0) map.delete(k); else map.set(k, n);
};

/* ------------------------------ Expresiones ------------------------------ */

const OPS = {
  '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b,
  '<=': (a, b) => a <= b, '==': (a, b) => a === b, '!=': (a, b) => a !== b,
};

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if ('><=!'.includes(c)) {
      const two = src.slice(i, i + 2);
      if (OPS[two]) { out.push({ t: 'op', v: two }); i += 2; continue; }
      if (c === '>' || c === '<') { out.push({ t: 'op', v: c }); i += 1; continue; }
      if (c === '!' && src[i + 1] === '=') { out.push({ t: 'op', v: '!=' }); i += 2; continue; }
      if (c === '=') { out.push({ t: 'op', v: '==' }); i += 1; continue; }
    }
    if (c === '&' && src[i + 1] === '&') { out.push({ t: 'and' }); i += 2; continue; }
    if (c === '|' && src[i + 1] === '|') { out.push({ t: 'or' }); i += 2; continue; }
    if (c === '(' || c === ')') { out.push({ t: c }); i += 1; continue; }
    const m = /^[0-9]+(\.[0-9]+)?|^\.[0-9]+/.exec(src.slice(i));
    if (m) { out.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    throw new Error(`Carácter inesperado: «${c}»`);
  }
  return out;
}

/** Evalúa expresiones como: stock > 0, nivel >= 3 && urgente, etc. */
export function evaluate(expr, vars) {
  const text = String(expr || '').trim();
  if (!text) return true;
  const toks = tokenize(text);
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => { if (peek()?.t === t) { p += 1; return true; } return false; };

  const primary = () => {
    if (eat('(')) { const v = orExpr(); eat(')'); return v; }
    const t = toks[p];
    if (!t) throw new Error('Expresión incompleta');
    p += 1;
    if (t.t === 'num') return t.v;
    if (t.t === 'id') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      const v = vars[t.v];
      return typeof v === 'boolean' ? v : (v === undefined ? 0 : Number(v));
    }
    throw new Error(`Valor no válido: ${t.v}`);
  };
  const cmpExpr = () => {
    let left = primary();
    while (peek()?.t === 'op') {
      const op = toks[p].v; p += 1;
      const right = primary();
      left = OPS[op](Number(left), Number(right));
    }
    return left;
  };
  const andExpr = () => { let v = cmpExpr(); while (eat('and')) { const r = cmpExpr(); v = Boolean(v) && Boolean(r); } return v; };
  const orExpr = () => { let v = andExpr(); while (eat('or')) { const r = andExpr(); v = Boolean(v) || Boolean(r); } return v; };

  const result = orExpr();
  if (p < toks.length) throw new Error('Expresión incompleta');
  return Boolean(result);
}

/* ------------------------------- Motor --------------------------------- */

export function start(d, sim) {
  sim.queue = [];
  sim.tokens = new Map();
  sim.arrivals = new Map();
  sim.activeEdges = new Set();
  sim.log = [];
  sim.history = [];
  sim.finished = false;
  sim.deadlocked = false;
  const starts = d.nodes.filter((n) => n.type === 'start');
  if (!starts.length) {
    sim.status = 'error';
    sim.log.push('No hay nodo de inicio.');
    return sim;
  }
  for (const s of starts) {
    add(sim.tokens, s.id);
    sim.queue.push(s.id);
  }
  sim.status = 'running';
  return sim;
}

function enqueue(sim, id) {
  if (!sim.queue.includes(id)) sim.queue.push(id);
}

function emit(d, sim, fromId, edges) {
  for (const e of edges) {
    sim.activeEdges.add(e.id);
    const to = e.to;
    const target = d.nodes.find((n) => n.id === to);
    const papel = isBar(target) ? barRole(d, target.id) : null;
    // Una barra con 2+ entradas espera una llegada por cada una, aunque su tipo
    // guardado sea fork (barra combinada join + fork).
    if (target && (papel === 'join' || papel === 'both')) {
      if (!sim.arrivals.has(to)) sim.arrivals.set(to, new Set());
      sim.arrivals.get(to).add(e.id);
    } else {
      add(sim.tokens, to);
    }
    enqueue(sim, to);
  }
  void fromId;
}

function joinProgress(d, sim, joinId) {
  const ins = d.edges.filter((e) => e.to === joinId);
  const got = sim.arrivals.get(joinId) || new Set();
  return { have: got.size, need: ins.length };
}

/**
 * Ejecuta un paso. Devuelve el estado resultante (muta `sim`).
 * status: 'running' | 'choice' | 'finished' | 'deadlock' | 'error'
 */
export function step(d, sim, choice = null) {
  if (sim.finished || sim.deadlocked) return sim;
  sim.status = 'running';
  sim.pending = null;

  let guard = 0;
  while (sim.queue.length && guard < 500) {
    guard += 1;
    const id = sim.queue.shift();
    const node = d.nodes.find((n) => n.id === id);
    if (!node) continue;

    const bar = isBar(node);
    const papel = bar ? barRole(d, node.id) : null;

    // Join (o barra combinada): sólo avanza cuando llegó un token por cada entrada.
    if (bar && (papel === 'join' || papel === 'both')) {
      const { have, need } = joinProgress(d, sim, id);
      if (have < need) { enqueue(sim, id); continue; }
      sim.arrivals.delete(id);
      const outs = d.edges.filter((e) => e.from === id);
      emit(d, sim, id, outs);
      sim.log.push({ type: 'join', node: node.label, text: `Join «${node.label}»: sincronizadas ${have} ramas → continúa.` });
      if (outs.length >= 2) {
        sim.log.push({ type: 'fork', node: node.label, text: `Fork «${node.label}»: ${outs.length} ramas en paralelo.` });
      }
      markActive(sim, node);
      return sim;
    }

    const count = sim.tokens.get(id) || 0;
    if (count <= 0) continue;
    del(sim.tokens, id);
    markActive(sim, node);

    const outs = d.edges.filter((e) => e.from === id);

    if (node.type === 'end') {
      sim.log.push({ type: 'end', node: node.label, text: `Fin «${node.label}»: flujo terminado.` });
      sim.finished = true;
      sim.status = 'finished';
      return sim;
    }

    if (node.type === 'stop') {
      sim.log.push({ type: 'stop', node: node.label, text: `Punto muerto «${node.label}»: el flujo se detiene aquí.` });
      sim.finished = true;
      sim.status = 'finished';
      return sim;
    }

    if (node.type === 'decision') {
      const withCond = outs.filter((e) => e.condition.trim());
      let chosen;
      if (choice) {
        chosen = outs.filter((e) => e.id === choice);
      } else if (withCond.length) {
        const ok = [];
        for (const e of withCond) {
          let val;
          try { val = evaluate(e.condition, sim.vars); } catch (err) { val = false; sim.log.push({ type: 'warn', node: node.label, text: `Condición inválida «${e.condition}»: ${err.message}` }); }
          if (val) ok.push(e);
        }
        chosen = ok.length ? ok : [];
        if (!ok.length) {
          sim.log.push({ type: 'warn', node: node.label, text: `Ninguna condición de «${node.label}» es verdadera; flujo detenido.` });
          sim.deadlocked = true;
          sim.status = 'deadlock';
          return sim;
        }
      } else if (outs.length === 1) {
        chosen = outs;
      } else {
        chosen = null;
      }

      if (!chosen) {
        // Requiere decisión del usuario: se devuelve el nodo a la cola.
        sim.tokens.set(id, count);
        enqueue(sim, id);
        sim.status = 'choice';
        sim.pending = { node: id, options: outs.map((e) => e.id) };
        sim.log.push({ type: 'choice', node: node.label, text: `«${node.label}» necesita elegir una de sus ${outs.length} salidas.` });
        return sim;
      }
      emit(d, sim, id, chosen);
      sim.log.push({ type: 'decision', node: node.label, text: `Decisión «${node.label}» → ${chosen.map((e) => e.label || e.condition || 'salida').join(' | ')}` });
      return sim;
    }

    if (bar) {
      if (outs.length < 2) {
        sim.log.push({ type: 'warn', node: node.label, text: `«${node.label}» es una barra de paralelo con ${outs.length} salida(s): no paraleliza.` });
      }
      emit(d, sim, id, outs);
      sim.log.push({ type: 'fork', node: node.label, text: `Fork «${node.label}»: ${outs.length} ramas en paralelo.` });
      return sim;
    }

    // Actividad / objeto / nota / inicio
    emit(d, sim, id, outs);
    const kind = node.type === 'start' ? 'Inicio'
      : node.type === 'objeto' ? 'Objeto'
        : node.type === 'note' ? 'Nota' : 'Actividad';
    sim.log.push({ type: 'activity', node: node.label, text: `${kind} «${node.label}» completada.` });
    return sim;
  }

  // Cola vacía: si alguna barra de sincronización sigue esperando ramas, hay
  // bloqueo. El papel se decide por las flechas, no por el tipo guardado.
  const waiting = d.nodes.filter((n) => {
    if (!isBar(n)) return false;
    const papel = barRole(d, n.id);
    if (papel !== 'join' && papel !== 'both') return false;
    const need = d.edges.filter((e) => e.to === n.id).length;
    return (sim.arrivals.get(n.id)?.size || 0) < need;
  });
  if (waiting.length) {
    sim.status = 'deadlock';
    sim.deadlocked = true;
    const w = waiting[0];
    const { have, need } = joinProgress(d, sim, w.id);
    sim.log.push({ type: 'warn', node: w.label, text: `Bloqueo: el join «${w.label}» espera ${need - have} rama(s) que nunca llegan.` });
  } else {
    sim.status = 'finished';
    sim.finished = true;
    sim.log.push({ type: 'end', node: '', text: 'No quedan flujos activos.' });
  }
  return sim;
}

function markActive(sim, node) {
  sim.lastNode = node.id;
  sim.activeNodes = sim.activeNodes || new Set();
  sim.activeNodes.add(node.id);
  if (sim.activeNodes.size > 2) {
    const it = sim.activeNodes.values().next();
    sim.activeNodes.delete(it.value);
  }
}

/** Estado listo para el renderer. */
export function simView(sim) {
  return {
    tokens: new Set(sim.tokens.keys()),
    activeEdges: sim.activeEdges,
    activeNodes: sim.activeNodes || new Set(),
  };
}

export function cloneSim(sim) {
  return {
    ...sim,
    queue: [...sim.queue],
    tokens: new Map(sim.tokens),
    arrivals: new Map([...sim.arrivals].map(([k, v]) => [k, new Set(v)])),
    activeEdges: new Set(sim.activeEdges),
    activeNodes: new Set(sim.activeNodes || []),
    log: [...sim.log],
  };
}
