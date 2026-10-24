/**
 * Validación semántica del diagrama: comprueba las reglas de los gateways
 * de decisión y de los nodos de control de paralelo (fork / join).
 */
import { NODE_TYPES, outEdges, inEdges, nodeById, barRole } from './model.js';

export function validate(d) {
  const issues = [];
  const push = (level, msg, ref) => issues.push({ level, msg, ...ref });
  const label = (id) => nodeById(d, id)?.label ?? '¿?';

  const starts = d.nodes.filter((n) => n.type === 'start');
  const ends = d.nodes.filter((n) => n.type === 'end');

  if (!d.nodes.length) {
    push('info', 'El diagrama está vacío. Añade nodos desde la paleta.');
    return issues;
  }
  if (!starts.length) push('error', 'Falta un nodo de inicio.', { nodeId: d.nodes[0].id });
  if (starts.length > 1) {
    push('error', `Hay ${starts.length} nodos de inicio; debe haber uno solo.`, { nodeId: starts[1].id });
  }
  if (!ends.length) push('warn', 'No hay nodos de fin: la actividad nunca termina.', { nodeId: d.nodes[0].id });

  for (const n of d.nodes) {
    const outs = outEdges(d, n.id);
    const ins = inEdges(d, n.id);
    const name = `«${n.label}»`;

    switch (n.type) {
      case 'start':
        if (ins.length) push('error', `${name}: un nodo inicial no puede tener flujos de entrada.`, { nodeId: n.id });
        if (!outs.length) push('error', `${name}: el inicio no tiene salida.`, { nodeId: n.id });
        if (outs.length > 1) push('info', `${name}: con varias salidas se necesita un nodo de paralelo (fork).`, { nodeId: n.id });
        break;
      case 'end':
        if (!ins.length) push('error', `${name}: un nodo final necesita al menos una entrada.`, { nodeId: n.id });
        if (outs.length) push('error', `${name}: un nodo final no puede tener salida.`, { nodeId: n.id });
        break;
      case 'stop':
        if (!ins.length) push('error', `${name}: un punto muerto necesita al menos una entrada.`, { nodeId: n.id });
        if (outs.length) push('error', `${name}: un punto muerto no puede tener salida: el flujo se detiene aquí.`, { nodeId: n.id });
        break;
      case 'fork':
      case 'join': {
        // El tipo guardado es sólo una pista: lo que manda son las flechas. Una
        // barra con 2+ entradas es un join, con 2+ salidas es un fork, y con
        // ambas cosas es una barra combinada perfectamente válida.
        const role = barRole(d, n.id);
        if (role === 'none') {
          push('error',
            `${name}: una barra de paralelo necesita 2 o más entradas (join) o 2 o más salidas (fork); ahora tiene ${ins.length} entrada(s) y ${outs.length} salida(s).`,
            { nodeId: n.id });
        } else if (role === 'both') {
          push('info', `${name}: la barra sincroniza ${ins.length} entradas y reparte ${outs.length} salidas (join + fork).`, { nodeId: n.id });
        }
        break;
      }
      case 'decision': {
        if (!outs.length) push('error', `${name}: la decisión no tiene salidas.`, { nodeId: n.id });
        if (ins.length > 1) push('error', `${name}: una decisión no puede recibir más de un flujo (tiene ${ins.length}).`, { nodeId: n.id });
        if (outs.length > 1) {
          const sinEtiqueta = outs.filter((e) => !e.label.trim() && !e.condition.trim());
          if (sinEtiqueta.length) {
            push('warn', `${name}: ${sinEtiqueta.length} de ${outs.length} salidas sin etiqueta (ponle un texto o una condición). Etiquétalas para distinguir las ramas.`, { nodeId: n.id });
          }
        }
        if (!ins.length) push('warn', `${name}: la decisión no es alcanzable.`, { nodeId: n.id });
        break;
      }
      case 'objeto':
        // Los objetos son anotaciones semánticas: da igual que reciban flechas
        // o que salgan de ellos, así que no se validan sus conexiones.
        break;
      case 'note':
        if (ins.length || outs.length) push('info', `${name}: las notas no ejecutan flujo; sus flechas son sólo informativas.`, { nodeId: n.id });
        break;
      default:
        if (!ins.length && n.type !== 'start') {
          push('warn', `${name}: nodo sin entradas, no se puede alcanzar.`, { nodeId: n.id });
        }
        if (!outs.length) push('warn', `${name}: nodo sin salida; falta un nodo Fin.`, { nodeId: n.id });
    }
  }

  // Bifurcaciones que en realidad son uniones
  for (const n of d.nodes) {
    if (n.type !== 'join') continue;
    const ins = inEdges(d, n.id);
    if (ins.length < 2) continue;
    const sources = new Set(ins.map((e) => e.from));
    if (sources.size === 1) {
      const src = [...sources][0];
      const srcNode = nodeById(d, src);
      if (srcNode && (srcNode.type === 'fork' || srcNode.type === 'join')) {
        push('info', `${n.label} y «${srcNode.label}» hacen el mismo trabajo: considera borrar «${n.label}».`, { nodeId: n.id });
      }
    }
  }

  // Nodos inalcanzables desde el inicio (los objetos no entran: son semánticos)
  const reachable = reachableFromStart(d);
  for (const n of d.nodes) {
    if (!reachable.has(n.id) && n.type !== 'note' && n.type !== 'objeto') {
      push('info', `«${n.label}» no es alcanzable desde el inicio.`, { nodeId: n.id });
    }
  }

  const order = { error: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => order[a.level] - order[b.level]);
}

export function reachableFromStart(d) {
  const seen = new Set();
  const stack = d.nodes.filter((n) => n.type === 'start').map((n) => n.id);
  if (!stack.length) {
    // Sin inicio explícito, alcanzamos desde las raíces (nodos sin entradas).
    for (const n of d.nodes) if (!inEdges(d, n.id).length) stack.push(n.id);
  }
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of outEdges(d, id)) stack.push(e.to);
  }
  return seen;
}

export function summary(issues) {
  return {
    error: issues.filter((i) => i.level === 'error').length,
    warn: issues.filter((i) => i.level === 'warn').length,
    info: issues.filter((i) => i.level === 'info').length,
  };
}

export function typeLabel(type) { return NODE_TYPES[type]?.label ?? type; }
