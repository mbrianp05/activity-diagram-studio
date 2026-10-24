/**
 * Interacción del lienzo: selección, arrastre, creación de nodos, conexión de
 * flujos, trazado manual de su trayectoria, redimensión, marquesina, paneo,
 * zoom y atajos de teclado.
 */
import {
  NODE_TYPES,
  createNode,
  createEdge,
  addEdge,
  removeNode,
  removeEdge,
  nodeAt,
  edgeAt,
  shiftLanes,
  inEdges,
  outEdges,
  nodeById,
  edgeById,
  readWay,
  cloneDiagram,
  dotMax,
  resizeTo,
  isVerticalLanes,
  laneCoord,
} from "./model.js";
import {
  edgeGeometry,
  edgePath,
  anchors,
  anchorFor,
  sideNormal,
  sideNear,
  userRouteTip,
  guidePoint,
  guideAxis,
  exitGuide,
  wallLimit,
  avoidNodes,
  nearestOnPolyline,
} from "./routing.js";
import { LANE_HEADER } from "./render.js";
import {
  snapMove,
  snapSize,
  unionBox,
  alignTargets,
  nearestLine,
} from "./align.js";

const NS = "http://www.w3.org/2000/svg";
const GRID = 8;
/**
 * Distancia (en píxeles de pantalla) a la que un nodo se engancha a la línea de
 * otro: es lo que decide si dos elementos quedan «en la misma línea». Es
 * generosa a propósito, pero independiente del zoom.
 */
const GUIDE_PX = 6;
/**
 * Ventana (ms) durante la que las pulsaciones seguidas de las flechas cuentan
 * como un único movimiento: así una ráfaga se deshace de golpe y no llena el
 * historial con un paso por cada repetición de tecla.
 */
const NUDGE_GROUP = 700;

function svgEl(name, attrs = {}) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

export class Interaction {
  constructor(app) {
    this.app = app;
    this.svg = app.svg;
    this.overlay = app.svg.querySelector("#layer-overlay");
    this.drag = null;
    this.spaceDown = false;
    this.tempEdge = null;
    this.marquee = null;
    this.resizeHandle = null;
    this.connectMode = null;
    this.insertPreview = null;
    /** Trayectoria en curso: {from, way[], axis, tip, hover} */
    this.route = null;
    /** Flujo cuyos puntos de control se muestran (herramienta de ruta). */
    this.routeEdge = null;
    this.routeLayer = null;
    this.routeKey = null;
    /** Capa de las guías de alineación que aparecen al encajar un nodo. */
    this.guideLayer = null;
    this.hoverAt = null;
    this.pointer = null;
    /** Última ráfaga de flechas: ids movidos y momento del último paso. */
    this.nudgeIds = "";
    this.nudgeAt = 0;
    this.bind();
  }

  /* --------------------------- coordenadas --------------------------- */

  toWorld(clientX, clientY) {
    const r = this.svg.getBoundingClientRect();
    const v = this.app.diagram.view;
    return {
      x: (clientX - r.left - v.x) / v.k,
      y: (clientY - r.top - v.y) / v.k,
    };
  }

  /** Punto del mundo bajo el puntero (sólo si está sobre el lienzo). */
  pointerWorld() {
    if (!this.pointer || !this.pointer.inside) return null;
    return this.toWorld(this.pointer.x, this.pointer.y);
  }

  /** Centro visible del lienzo: donde se pega si el puntero está fuera. */
  viewCenter() {
    const r = this.svg.getBoundingClientRect();
    const v = this.app.diagram.view;
    return { x: (r.width / 2 - v.x) / v.k, y: (r.height / 2 - v.y) / v.k };
  }

  get snap() {
    return this.app.snapToGrid;
  }

  snapPoint(p, free) {
    if (free || !this.snap) return p;
    return {
      x: Math.round(p.x / GRID) * GRID,
      y: Math.round(p.y / GRID) * GRID,
    };
  }

  /* ------------------------------ eventos ---------------------------- */

  bind() {
    this.svg.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    window.addEventListener("pointermove", (e) => this.onPointerMove(e));
    window.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.svg.addEventListener("wheel", (e) => this.onWheel(e), {
      passive: false,
    });
    this.svg.addEventListener("dblclick", (e) => this.onDblClick(e));
    this.svg.addEventListener("pointerleave", () => this.clearInsertPreview());
    this.svg.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") {
        this.spaceDown = false;
        this.svg.style.cursor = "";
      }
    });
  }

  onPointerDown(e) {
    // El fantasma de inserción no debe quedarse congelado durante el gesto.
    this.clearInsertPreview();
    // Cualquier gesto con el ratón cierra la ráfaga de flechas en curso: el
    // siguiente desplazamiento con teclado será un paso de deshacer aparte.
    this.nudgeIds = "";
    const target = e.target;
    const puntoCtrl = target?.dataset?.routePoint;
    const esCtrl = puntoCtrl !== undefined && this.app.tool === "route";

    // Botón derecho durante el trazado: nuevo punto de control (cambia el giro).
    if (e.button === 2 && this.route) {
      e.preventDefault();
      this.addRoutePoint();
      return;
    }
    // Botón derecho sobre un punto de control: lo quita.
    if (e.button === 2 && esCtrl) {
      e.preventDefault();
      this.removeRoutePoint(Number(puntoCtrl));
      return;
    }
    if (e.button === 1 || e.button === 2 || this.spaceDown) {
      // Botón central o derecho: desplazar el lienzo en horizontal y vertical.
      e.preventDefault();
      this.beginPan(e, this.spaceDown);
      return;
    }
    if (e.button !== 0) return;
    this.svg.focus({ preventScroll: true });
    const w = this.toWorld(e.clientX, e.clientY);

    // Continuación del trazado: clic en el destino lo cierra, clic en el vacío
    // añade otro punto de control.
    if (this.route) {
      const destino = this.targetAt(w, 30);
      if (destino && destino.node.id !== this.route.from) {
        this.finishRoute(
          destino.node.id,
          destino.side || sideNear(destino.node, w),
        );
      } else {
        this.addRoutePoint();
      }
      return;
    }
    // Punto de control de una trayectoria: se arrastra para recolocarlo.
    if (esCtrl) {
      this.beginRoutePoint(e, w, Number(puntoCtrl));
      return;
    }
    // Herramienta de trayectoria: clic sobre la flecha para fijar un giro (si
    // no hay flecha debajo, el clic selecciona el nodo como cualquier otro).
    if (this.app.tool === "route") {
      const nodo = target.closest?.(".node");
      if (nodo && !this.nearEdge(w))
        this.app.select({ type: "node", id: nodo.dataset.id });
      else this.insertRoutePoint(w);
      return;
    }
    // Punto de redimensión
    if (target.dataset && target.dataset.resize) {
      this.beginResize(e, w);
      return;
    }
    // Punto de conexión
    if (target.dataset && target.dataset.handle) {
      this.beginConnectDrag(
        e,
        w,
        target.dataset.nodeId || this.nodeIdFrom(target),
        target.dataset.handle,
      );
      return;
    }
    // Clic cerca de una bolita (sin tener que tocarla): la flecha sale por ese
    // lado. Sólo con las herramientas que conectan o seleccionan, para no
    // quitarle el arrastre al resto de gestos.
    if (this.app.tool === "select" || this.app.tool === "connect") {
      const cerca = this.portAt(w, 12);
      if (cerca) {
        this.app.select({ type: "node", id: cerca.node.id });
        this.beginConnectDrag(e, w, cerca.node.id, cerca.side);
        return;
      }
    }
    // Cabecera de carril
    if (target.dataset && target.dataset.laneTitle !== undefined) {
      this.app.editLaneName(Number(target.dataset.laneTitle));
      return;
    }
    if (target.dataset && target.dataset.laneResize !== undefined) {
      this.beginLaneResize(e, w, Number(target.dataset.laneResize));
      return;
    }
    // Etiqueta de flujo: un clic sólo selecciona (el doble clic la edita).
    if (target.dataset && target.dataset.edgeLabel) {
      const ref = { type: "edge", id: target.dataset.edgeLabel };
      if (e.ctrlKey || e.metaKey || e.shiftKey) this.app.toggleSelect(ref);
      else this.app.select(ref);
      return;
    }
    // Flujo
    if (target.dataset && target.dataset.edge) {
      const edgeId = target.dataset.edge;
      if (this.app.tool === "delete") {
        this.app.deleteSelection({ type: "edge", id: edgeId });
        return;
      }
      const ref = { type: "edge", id: edgeId };
      if (e.ctrlKey || e.metaKey) this.app.toggleSelect(ref);
      else this.app.select(ref);
      return;
    }
    // Nodo
    const nodeEl = target.closest(".node");
    if (nodeEl) {
      const id = nodeEl.dataset.id;
      this.onNodeDown(e, id, w);
      return;
    }

    // Fondo
    this.onBackgroundDown(e, w);
  }

  nodeIdFrom(target) {
    const g = target.closest(".node");
    return g ? g.dataset.id : null;
  }

  onNodeDown(e, id, w) {
    const node = nodeById(this.app.diagram, id);
    if (!node) return;
    const tool = this.app.tool;

    if (tool === "delete") {
      this.app.deleteSelection({ type: "node", id });
      return;
    }

    if (tool === "connect") {
      this.app.select({ type: "node", id });
      this.beginConnectDrag(e, w, id, "auto");
      return;
    }

    if (NODE_TYPES[tool] && tool !== "select") {
      this.placeNode(tool, w);
      return;
    }

    // Selección / arrastre
    const sel = this.app.state.selected;
    const already = this.app.isSelected({ type: "node", id });
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      // Ctrl (o Shift) añade o quita nodos de la selección.
      this.app.toggleSelect({ type: "node", id });
    } else if (!already) {
      this.app.select({ type: "node", id });
    }
    const ids = this.app.state.selected
      .filter((s) => s.type === "node")
      .map((s) => s.id);
    if (!ids.includes(id)) return;
    const items = ids.map((i) => {
      const n = nodeById(this.app.diagram, i);
      return { id: i, x0: n.x, y0: n.y, w: n.w, h: n.h };
    });
    this.clearAlignGuides();
    this.drag = {
      kind: "nodes",
      start: w,
      moved: false,
      free: e.altKey,
      items,
      // Caja del grupo en su sitio de partida: el ajuste a rejilla se calcula
      // sobre ella, para que el grupo se mueva rígido y no se descuadre. Hay que
      // pasar rectángulos con `x`/`y`: los `items` guardan el origen como
      // `x0`/`y0` para que el arrastre no acumule errores.
      box: unionBox(
        items.map((it) => ({ x: it.x0, y: it.y0, w: it.w, h: it.h })),
      ),
    };
  }

  onBackgroundDown(e, w) {
    const tool = this.app.tool;
    if (tool === "delete") {
      // Con la goma, acertar cerca de una flecha fina también la borra.
      const nearDel = this.nearEdge(w);
      if (nearDel) this.app.deleteSelection({ type: "edge", id: nearDel.id });
      else this.app.clearSelection();
      return;
    }
    if (tool === "connect") {
      this.app.clearSelection();
      this.connectMode = null;
      return;
    }
    if (NODE_TYPES[tool]) {
      this.placeNode(tool, w);
      return;
    }
    // Clic que falla el trazo por poco: si hay una flecha cerca (tolerancia
    // compensada por zoom) se selecciona en vez de limpiar o enmarcar.
    const near = this.nearEdge(w);
    if (near) {
      const ref = { type: "edge", id: near.id };
      if (e.ctrlKey || e.metaKey || e.shiftKey) this.app.toggleSelect(ref);
      else this.app.select(ref);
      return;
    }
    if (!e.shiftKey) this.app.clearSelection();
    this.marquee = {
      x0: w.x,
      y0: w.y,
      x: w.x,
      y: w.y,
      base: e.shiftKey ? [...this.app.state.selected] : [],
    };
    this.drawMarquee();
  }

  /** Flecha más cercana al punto, con tolerancia de ~12 px de pantalla. */
  nearEdge(w) {
    const k = this.app.diagram.view.k || 1;
    return edgeAt(this.app.diagram, w.x, w.y, Math.max(8, 12 / k));
  }

  /**
   * Punto final de un nodo nuevo: se deduce de dónde se ha puesto el puntero y
   * luego se ajusta a rejilla y a las líneas de los nodos que ya hay, de forma
   * que al colocarlo al lado de otro quede de verdad en la misma fila o columna
   * en vez de a un píxel de otro.
   * @returns {{x:number, y:number}} esquina superior izquierda
   */
  snapSpot(type, wx, wy) {
    const t = NODE_TYPES[type];
    const cuadrado =
      type === "decision" ||
      type === "start" ||
      type === "end" ||
      type === "stop";
    const w = cuadrado ? Math.max(t.w, t.h) : t.w;
    const h = cuadrado ? Math.max(t.w, t.h) : t.h;
    let x = Math.round(wx - w / 2);
    let y = Math.round(wy - h / 2);
    // El margen de la cabecera del carril se reserva en el eje de las bandas:
    // a la izquierda si son horizontales y arriba si son verticales.
    if (isVerticalLanes(this.app.diagram)) {
      if (y < LANE_HEADER + h / 2) y = LANE_HEADER + 4;
    } else if (x < LANE_HEADER + w / 2) x = LANE_HEADER + 4;
    if (this.snap) {
      x = Math.round(x / GRID) * GRID;
      y = Math.round(y / GRID) * GRID;
    }
    const res = snapMove(this.app.diagram.nodes, [{ x, y, w, h }], 0, 0, {
      tol: GUIDE_PX / (this.app.diagram.view.k || 1),
    });
    return { x: Math.round(x + res.dx), y: Math.round(y + res.dy) };
  }

  placeNode(type, w) {
    const d = this.app.diagram;
    const spot = this.snapSpot(type, w.x, w.y);
    this.app.pushHistory("Crear nodo");
    const node = createNode(type, w.x, w.y);
    node.x = spot.x;
    node.y = spot.y;
    node.lane = d.lanes.length ? laneOf(d, node) : null;
    d.nodes.push(node);
    // Tras insertar se vuelve a la herramienta de selección: encadenar varios
    // nodos se hace con arrastrar y soltar, no con pulsar la tecla cada vez.
    this.app.setTool("select");
    this.app.select({ type: "node", id: node.id });
    this.app.commit("Nodo creado");
    // Las acciones y las decisiones se nombran nada más aparecer: sin texto no
    // dicen nada, así que se pide el nombre en el acto.
    if (type === "activity" || type === "decision")
      this.app.editNodeLabel(node.id);
    return node;
  }

  /* --------------------------- arrastre/gestos ------------------------ */

  beginPan(e, useLast = false) {
    const v = this.app.diagram.view;
    const src = useLast && this.last ? this.last : e;
    this.drag = { kind: "pan", x0: src.x, y0: src.y, vx: v.x, vy: v.y };
    this.svg.style.cursor = "grabbing";
  }

  beginResize(e, w) {
    const sel = this.app.state.selected.find((s) => s.type === "node");
    if (!sel) return;
    const n = nodeById(this.app.diagram, sel.id);
    this.app.pushHistory("Redimensionar");
    this.drag = {
      kind: "resize",
      node: n,
      w0: n.w,
      h0: n.h,
      start: w,
      moved: false,
    };
  }

  beginLaneResize(e, w, index) {
    const lane = this.app.diagram.lanes[index];
    if (!lane) return;
    this.app.pushHistory("Redimensionar carril");
    this.drag = {
      kind: "lane",
      lane,
      index,
      h0: lane.height,
      start: w,
      moved: false,
    };
  }

  beginConnectDrag(e, w, nodeId, side) {
    const node = nodeById(this.app.diagram, nodeId);
    if (!node) return;
    const other = this.app.state.selected.find(
      (s) => s.type === "node" && s.id !== nodeId,
    );
    if (other && this.app.tool === "connect") {
      // Dos nodos ya seleccionados y clic sobre otro: conexión directa, con
      // la bolita de cada lado más cercana al puntero.
      this.app.addConnection(
        other.id,
        nodeId,
        [],
        sideNear(nodeById(this.app.diagram, other.id), w),
        sideNear(node, w),
      );
      return;
    }
    // La bolita por la que sale la flecha es la que se ha pulsado; si el clic
    // ha caído en el cuerpo del nodo, se usa el lado que mira al puntero.
    this.startRoute(nodeId, side && side !== "auto" ? side : sideNear(node, w));
    this.drag = { kind: "connect", from: nodeId, moved: false };
  }

  /* --------------------------- trayectoria --------------------------- */

  /** Arranca el trazado de un flujo desde `from`, saliendo por `side`. */
  startRoute(from, side) {
    this.route = {
      from,
      fromSide: side,
      toSide: "left",
      way: [],
      axis: null,
      tip: null,
      hover: null,
    };
    this.tempEdge = svgEl("path", {
      class: "temp-edge",
      "marker-end": "url(#arrow-temp)",
    });
    this.overlay.appendChild(this.tempEdge);
    this.app.select({ type: "node", id: from });
    this.drawRouteHandles();
  }

  /**
   * Destino de la flecha bajo el puntero: primero la bolita más cercana (con
   * tolerancia de pantalla, para no tener que apuntar al píxel) y, si no hay
   * ninguna a tiro, el nodo que hay debajo. Devuelve también la bolita activa
   * para poder resaltarla.
   * @returns {node, side, p, exact}|null
   */
  /** Bolita de conexión más cercana al punto, de cualquier nodo. */
  portAt(w, tolPantalla = 14) {
    const d = this.app.diagram;
    const k = d.view.k || 1;
    const tol = Math.max(12, tolPantalla / k);
    let mejor = null;
    for (const n of d.nodes) {
      if (
        w.x < n.x - tol ||
        w.x > n.x + n.w + tol ||
        w.y < n.y - tol ||
        w.y > n.y + n.h + tol
      )
        continue;
      for (const p of this.app.renderer.portsOf(n)) {
        const dist = Math.hypot(p.x - w.x, p.y - w.y);
        if (dist <= tol && (!mejor || dist < mejor.dist))
          mejor = { node: n, side: p.side, p, dist };
      }
    }
    return mejor;
  }

  /**
   * Destino de la flecha bajo el puntero: la bolita más cercana (no hace falta
   * apuntarla) y, si no hay ninguna a tiro, el nodo que hay debajo. El lado lo
   * da la bolita; si el puntero está en el cuerpo, el lado más cercano.
   */
  targetAt(w, tolPantalla = 26) {
    const bolita = this.portAt(w, tolPantalla);
    if (bolita) return bolita;
    const nodo = nodeAt(this.app.diagram, w.x, w.y);
    return nodo ? { node: nodo, side: null, p: null, dist: 0 } : null;
  }

  /** Bolita fantasma: por dónde sale o entra la flecha, ya en su posición final. */
  drawHint(kind, p) {
    if (!this.hintLayer) {
      this.hintLayer = svgEl("g", { class: "port-hints" });
      this.overlay.appendChild(this.hintLayer);
    }
    const prev = this.hintLayer.querySelector(`.port-hint.${kind}`);
    if (!p) {
      prev?.remove();
      return;
    }
    const r = 6.5 / (this.app.diagram.view.k || 1);
    if (prev) {
      prev.setAttribute("cx", p.x);
      prev.setAttribute("cy", p.y);
      prev.setAttribute("r", r);
      return;
    }
    this.hintLayer.appendChild(
      svgEl("circle", {
        class: `port-hint ${kind}`,
        cx: p.x,
        cy: p.y,
        r,
      }),
    );
  }

  clearPortHints() {
    if (this.hintLayer) this.hintLayer.textContent = "";
  }

  /**
   * Sigue al puntero. El trazo temporal usa la geometría real del flujo (con sus
   * puntos de giro y la bolita de destino) para que lo que se ve sea
   * exactamente lo que se dibuja.
   */
  updateRoute(e) {
    const r = this.route;
    if (!r) return;
    const w = this.toWorld(e.clientX, e.clientY);
    const t = this.targetAt(w, 26);
    r.hover = t && t.node.id !== r.from ? t.node : null;
    r.toSide = r.hover ? t.side || sideNear(r.hover, w) : "left";
    this.drawTempEdge(w);
  }

  /**
   * Engancha el punto guía a las líneas de los nodos (borde o centro) en el eje
   * en el que se mueve el tramo y dibuja la guía para que se vea con qué se va a
   * alinear el próximo punto de giro. El tramo nace del último punto de giro
   * fijado (`base`), no del nodo de origen.
   */
  snapGuide(base, cursor, axis) {
    const refs = alignTargets(this.app.diagram.nodes);
    const tol = GUIDE_PX / (this.app.diagram.view.k || 1);
    const enX = axis === "x";
    const hit = nearestLine(
      enX ? cursor.x : cursor.y,
      enX ? refs.xs : refs.ys,
      tol,
    );
    const out = { x: cursor.x, y: cursor.y };
    if (!hit) {
      this.clearAlignGuides();
      return out;
    }
    if (enX) out.x = hit.v;
    else out.y = hit.v;
    this.drawAlignGuides([this.guideLine(axis, hit, base, out)]);
    return out;
  }

  /** Línea de guía que corresponde a una coordenada enganchada a un nodo. */
  guideLine(axis, hit, base, tip) {
    const pad = 16;
    const n = hit.node;
    if (axis === "x") {
      const y1 = Math.min(base.y, tip.y, n ? n.y : tip.y);
      const y2 = Math.max(base.y, tip.y, n ? n.y + n.h : tip.y);
      return { axis, value: hit.v, from: y1 - pad, to: y2 + pad };
    }
    const x1 = Math.min(base.x, tip.x, n ? n.x : tip.x);
    const x2 = Math.max(base.x, tip.x, n ? n.x + n.w : tip.x);
    return { axis, value: hit.v, from: x1 - pad, to: x2 + pad };
  }

  /** Engancha un punto de giro a las líneas de los nodos en los dos ejes. */
  snapRoutePoint(p) {
    const refs = alignTargets(this.app.diagram.nodes);
    const tol = GUIDE_PX / (this.app.diagram.view.k || 1);
    const hx = nearestLine(p.x, refs.xs, tol);
    const hy = nearestLine(p.y, refs.ys, tol);
    const out = { x: hx ? hx.v : p.x, y: hy ? hy.v : p.y };
    const guias = [];
    if (hx) guias.push(this.guideLine("x", hx, out, out));
    if (hy) guias.push(this.guideLine("y", hy, out, out));
    this.drawAlignGuides(guias);
    return out;
  }

  /** Fija el punto guiado actual: a partir de aquí el trazo cambia de dirección. */
  addRoutePoint() {
    const r = this.route;
    if (!r || !r.tip) return;
    const p = avoidNodes(r.tip, this.app.diagram.nodes);
    const last = r.way[r.way.length - 1];
    if (last && Math.abs(last.x - p.x) < 1 && Math.abs(last.y - p.y) < 1)
      return;
    // Se guarda tal cual: el punto ya viene enganchado a rejilla o a las líneas
    // de los nodos, y redondearlo otra vez rompería esa alineación.
    r.way.push({ x: p.x, y: p.y });
    // El giro queda fijado: el siguiente tramo vuelve a orientarse según el
    // cursor en vez de arrastrar el eje anterior.
    r.axis = null;
    this.drawRouteHandles();
    if (this.last) this.drawTempEdge();
  }

  /** Cierra el flujo sobre `nodeId`, entrando por `side`. */
  finishRoute(nodeId, side) {
    const r = this.route;
    if (!r) return;
    this.cancelRoute();
    this.app.addConnection(r.from, nodeId, r.way, r.fromSide, side || r.toSide);
  }

  cancelRoute() {
    if (!this.route && !this.tempEdge) return;
    this.route = null;
    this.clearTempEdge();
    this.clearPortHints();
    this.clearAlignGuides();
    this.drawRouteHandles();
  }

  /* --------------------- puntos de control de una flecha ---------------- */

  /** Inserta un punto de giro donde se ha clicado sobre la flecha. */
  insertRoutePoint(w) {
    const edge = this.nearEdge(w);
    if (!edge) {
      this.app.clearSelection();
      return;
    }
    const geo = edgeGeometry(this.app.diagram, edge);
    const p = nearestOnPolyline(geo?.pts || [], w.x, w.y);
    if (!p) return;
    this.app.pushHistory();
    const antes = (edge.way || []).length;
    const snapped = this.snapPoint(p, false);
    edge.way = readWay(edge.way);
    edge.way.push({ x: Math.round(snapped.x), y: Math.round(snapped.y) });
    edge.way = readWay(edge.way).map((q) =>
      avoidNodes(q, this.app.diagram.nodes),
    );
    this.app.select({ type: "edge", id: edge.id });
    this.routeEdge = edge.id;
    this.app.commit("Punto de trayectoria");
    if (!antes) {
      this.app.toast(
        "Trayectoria manual: los puntos indicados mandan sobre el trazado automático. Clic derecho sobre un punto para quitarlo.",
      );
    }
  }

  beginRoutePoint(e, w, index) {
    const edge = edgeById(this.app.diagram, this.routeEdge);
    if (!edge) return;
    this.app.select({ type: "edge", id: edge.id });
    this.app.pushHistory("Trayectoria");
    this.drag = {
      kind: "routepoint",
      edgeId: edge.id,
      index,
      start: w,
      moved: false,
      x0: edge.way[index].x,
      y0: edge.way[index].y,
    };
  }

  removeRoutePoint(index) {
    const edge = edgeById(this.app.diagram, this.routeEdge);
    if (!edge || !Array.isArray(edge.way) || !edge.way.length) return;
    this.app.pushHistory();
    edge.way.splice(index, 1);
    this.app.commit("Quitar punto de trayectoria");
  }

  /**
   * Puntos de control visibles: los del flujo en edición (herramienta ruta) o
   * los que ya se han fijado mientras se traza una flecha nueva.
   */
  drawRouteHandles() {
    const pendiente = this.route ? this.route.way : null;
    let edge = null;
    if (!pendiente && this.routeEdge)
      edge = edgeById(this.app.diagram, this.routeEdge);
    const pts =
      pendiente || (edge && Array.isArray(edge.way) ? edge.way : null) || [];
    const id = pendiente ? "pendiente" : edge?.id || "";
    const key = `${id}:${pts.length}`;
    if (!this.routeLayer) {
      this.routeLayer = svgEl("g", { class: "route-points" });
      this.overlay.appendChild(this.routeLayer);
    }
    if (key === this.routeKey) {
      this.routeLayer.querySelectorAll("circle").forEach((c, i) => {
        if (pts[i]) {
          c.setAttribute("cx", pts[i].x);
          c.setAttribute("cy", pts[i].y);
        }
      });
      return;
    }
    this.routeKey = key;
    this.routeLayer.textContent = "";
    if (!pts.length) return;
    const r = 5 / (this.app.diagram.view.k || 1);
    pts.forEach((p, i) => {
      const c = svgEl("circle", {
        class: `route-point${pendiente ? " pending" : ""}`,
        cx: p.x,
        cy: p.y,
        r,
        "data-route-point": i,
        "data-edge": id,
      });
      this.routeLayer.appendChild(c);
    });
  }

  onPointerMove(e) {
    this.last = { x: e.clientX, y: e.clientY };
    this.pointer = {
      x: e.clientX,
      y: e.clientY,
      inside: !!e.target?.closest?.("#canvas"),
    };
    // Trazado en curso (incluido el arrastre con el botón pulsado): manda sobre
    // el resto de gestos.
    if (this.route && (!this.drag || this.drag.kind === "connect")) {
      this.updateRoute(e);
      return;
    }
    if (this.marquee && !this.drag) {
      const w = this.toWorld(e.clientX, e.clientY);
      this.marquee.x = w.x;
      this.marquee.y = w.y;
      this.drawMarquee();
      return;
    }
    const d = this.drag;
    if (!d) {
      this.updateInsertPreview(e);
      this.updateRouteHover();
      return;
    }
    const w = this.toWorld(e.clientX, e.clientY);

    if (d.kind === "pan") {
      const v = this.app.diagram.view;
      v.x = d.vx + (e.clientX - d.x0);
      v.y = d.vy + (e.clientY - d.y0);
      this.app.applyView();
      return;
    }

    if (d.kind === "nodes") {
      const dx = w.x - d.start.x;
      const dy = w.y - d.start.y;
      const k = this.app.diagram.view.k || 1;
      if (!d.moved && Math.hypot(dx, dy) * k < 3) return;
      // El historial entra en el instante en que el nodo se mueve de sitio (y
      // antes de tocarlo): un clic que no mueve nada no llena la pila, y mover
      // un nodo se puede deshacer como cualquier otra edición.
      if (!d.moved) this.app.pushHistory("Mover nodos");
      d.moved = true;
      let ox = dx;
      let oy = dy;
      if (d.free) {
        // Alt: ni rejilla ni guías, cada nodo va donde lo suelta el puntero.
        this.clearAlignGuides();
      } else {
        if (this.snap) {
          // Rejilla: se snapa el origen de la caja del grupo (no el
          // desplazamiento), así el grupo se mantiene rígido y además todos los
          // nodos acaban cayendo sobre la rejilla global.
          ox = Math.round((d.box.x + ox) / GRID) * GRID - d.box.x;
          oy = Math.round((d.box.y + oy) / GRID) * GRID - d.box.y;
        }
        // Guías de alineación: si un borde o el centro del grupo queda a tiro de
        // la línea de otro nodo, se corrige para que coincidan de verdad.
        const res = snapMove(
          this.app.diagram.nodes,
          d.items.map((it) => ({
            x: it.x0 + ox,
            y: it.y0 + oy,
            w: it.w,
            h: it.h,
          })),
          ox,
          oy,
          { tol: GUIDE_PX / k, skip: new Set(d.items.map((it) => it.id)) },
        );
        ox = res.dx;
        oy = res.dy;
        this.drawAlignGuides(res.guides);
      }
      for (const it of d.items) {
        const n = nodeById(this.app.diagram, it.id);
        n.x = Math.round(it.x0 + ox);
        n.y = Math.round(it.y0 + oy);
      }
      if (this.app.diagram.lanes.length) {
        // Sólo cambia de carril el nodo que se está arrastrando.
        for (const it of d.items) {
          const n = nodeById(this.app.diagram, it.id);
          n.lane = laneOf(this.app.diagram, n);
        }
      }
      this.app.refresh();
      return;
    }

    if (d.kind === "resize") {
      const t = NODE_TYPES[d.node.type];
      const cuadrado =
        d.node.type === "decision" ||
        d.node.type === "tiempo" ||
        d.node.type === "start" ||
        d.node.type === "end" ||
        d.node.type === "stop";
      let nw = d.free
        ? d.w0 + (w.x - d.start.x)
        : Math.round((d.w0 + (w.x - d.start.x)) / GRID) * GRID;
      let nh = d.free
        ? d.h0 + (w.y - d.start.y)
        : Math.round((d.h0 + (w.y - d.start.y)) / GRID) * GRID;
      if (d.free) {
        this.clearAlignGuides();
      } else {
        // El borde que se arrastra se engancha a las líneas de los demás nodos,
        // así dos cajas acaban con la misma medida. Los cuadrados sólo se
        // ajustan en horizontal: la altura es la que tenga que salir.
        const res = snapSize(this.app.diagram.nodes, d.node, nw, nh, {
          tol: GUIDE_PX / (this.app.diagram.view.k || 1),
        });
        nw = res.w;
        nh = cuadrado ? res.w : res.h;
        this.drawAlignGuides(res.guides);
      }
      if (cuadrado) {
        // Decisión y tiempo: cuadrados. Inicio/fin/punto muerto: círculos (los
        // pequeños, los dos últimos, con tope en su DOT_MAX, que en el punto
        // muerto es 1.5 veces mayor).
        const base = Math.max(t.minW, t.minH, nw, nh);
        const s =
          d.node.type === "decision" || d.node.type === "tiempo"
            ? base
            : Math.min(dotMax(d.node.type), base);
        d.node.w = s;
        d.node.h = s;
      } else {
        // El tamaño respeta la orientación y el tipo: la barra de paralelismo
        // sólo se estira por su largo (su grosor no cambia) y el resto de nodos
        // no baja de sus medidas mínimas.
        const size = resizeTo(d.node, nw, nh);
        d.node.w = size.w;
        d.node.h = size.h;
      }      this.app.refresh();
      return;
    }

    if (d.kind === "lane") {
      const vertical = isVerticalLanes(this.app.diagram);
      const avance = vertical ? w.x - d.start.x : w.y - d.start.y;
      const next = Math.max(80, Math.round((d.h0 + avance) / 4) * 4);
      const delta = next - d.lane.height;
      if (delta) {
        d.moved = true;
        d.lane.height = next;
        // Los nodos siguen en su carril: los posteriores se desplazan con la banda.
        shiftLanes(this.app.diagram, d.index, delta);
      }
      this.app.refresh();
      return;
    }

    if (d.kind === "routepoint") {
      const edge = edgeById(this.app.diagram, d.edgeId);
      if (!edge || !edge.way[d.index]) return;
      d.moved = true;
      const step = this.snapPoint(w, e.altKey);
      // El punto de giro se engancha a las líneas de los nodos igual que un nodo
      // al arrastrarse: así el tramo queda a escuadra con los bordes y centros.
      // Alt lo deja libre (ni rejilla ni guías).
      if (e.altKey) this.clearAlignGuides();
      else Object.assign(step, this.snapRoutePoint(step));
      edge.way[d.index] = avoidNodes(
        { x: step.x, y: step.y },
        this.app.diagram.nodes,
      );
      this.app.refresh();
    }
  }

  /** Con la herramienta de ruta, muestra los puntos de la flecha que hay debajo. */
  updateRouteHover() {
    if (this.app.tool !== "route") {
      this.setRouteEdge(null);
      return;
    }
    if (this.pointer && !this.pointer.inside) return;
    const w = this.toWorld(this.last.x, this.last.y);
    // Recalcular la geometría de todas las flechas en cada movimiento es caro:
    // sólo se busca cuando el puntero se ha desplazado de verdad.
    if (
      this.hoverAt &&
      Math.hypot(w.x - this.hoverAt.x, w.y - this.hoverAt.y) *
        (this.app.diagram.view.k || 1) <
        4
    )
      return;
    this.hoverAt = w;
    const near = this.nearEdge(w);
    this.setRouteEdge(near ? near.id : null);
  }

  /** Fija la flecha cuyos puntos de control se muestran (o `null` para ocultarlos). */
  setRouteEdge(id) {
    if (this.routeEdge === id) return;
    this.routeEdge = id;
    this.drawRouteHandles();
  }

  /* ---------------------------- guías de alineación ---------------------- */

  /**
   * Dibuja las líneas en las que el grupo acaba de encajar: si una no aparece,
   * el nodo no está alineado con nada. Sólo vive durante el arrastre.
   */
  drawAlignGuides(guides) {
    if (!guides || !guides.length) {
      this.clearAlignGuides();
      return;
    }
    if (!this.guideLayer) {
      this.guideLayer = svgEl("g", { class: "align-guides" });
      this.overlay.appendChild(this.guideLayer);
    }
    this.guideLayer.textContent = "";
    for (const g of guides) {
      const attrs =
        g.axis === "x"
          ? { x1: g.value, y1: g.from, x2: g.value, y2: g.to }
          : { x1: g.from, y1: g.value, x2: g.to, y2: g.value };
      this.guideLayer.appendChild(
        svgEl("line", { class: "align-guide", ...attrs }),
      );
    }
  }

  clearAlignGuides() {
    if (!this.guideLayer) return;
    this.guideLayer.remove();
    this.guideLayer = null;
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    this.clearAlignGuides();
    if (this.svg.style.cursor === "grabbing") this.svg.style.cursor = "";

    if (!d) {
      if (this.marquee) {
        this.finishMarquee();
      }
      return;
    }

    if (d.kind === "connect") {
      // Soltar engancha a la bolita más cercana (tolerancia amplia: al soltar
      // no hace falta apuntar al píxel). Si no hay ninguna a tiro, la trayectoria
      // sigue pegada al cursor esperando el siguiente clic.
      const w = this.toWorld(e.clientX, e.clientY);
      const t = this.targetAt(w, 30);
      if (t && t.node.id !== d.from)
        this.finishRoute(t.node.id, t.side || sideNear(t.node, w));

      return;
    }

    if (d.kind === "routepoint" && d.moved) {
      this.app.commit("Mover punto de trayectoria");
      return;
    }

    if (d.kind === "nodes" && d.moved) {
      this.app.commit("Mover nodos");
      return;
    }
    if (d.kind === "resize" && d.moved) {
      this.app.commit("Redimensionar");
      return;
    }
    if (d.kind === "lane" && d.moved) {
      this.app.commit("Redimensionar carril");
      return;
    }
    if (d.marquee) this.finishMarquee();
  }

  /* ------------------------------ dibujo ------------------------------ */

  drawTempEdge(w = null) {
    if (!this.route || !this.tempEdge) return;
    const r = this.route;
    const d = this.app.diagram;
    const destino = r.hover;
    const fake = createEdge(r.from, destino ? destino.id : r.from, {
      fromSide: r.fromSide,
      toSide: destino ? r.toSide : "left",
      way: r.way.map((p) => ({ ...p })),
    });
    const tmp = { ...d, edges: [...d.edges, fake] };
    const geo = edgeGeometry(tmp, fake);
    if (!geo) return;
    // Bolitas fantasma: se calculan con la flecha ya metida, así que se ven
    // justo en el punto por el que la flecha va a entrar o salir.
    this.drawHint("salida", anchorFor(tmp, fake, geo.sides.from, true));
    this.drawHint(
      "entrada",
      destino ? anchorFor(tmp, fake, geo.sides.to, false) : null,
    );
    if (destino) {
      // Con destino encima: la geometría definitiva, tal cual quedará. Ya no hay
      // punto guía que enganchar, así que la guía desaparece.
      this.clearAlignGuides();
      this.tempEdge.setAttribute("d", edgePath(geo));
      return;
    }
    // Todavía no hay destino: del ancla de salida hasta el punto que guía el cursor.
    const ancla = anchorFor(tmp, fake, geo.sides.from, true);
    if (!ancla) return;
    const n0 = sideNormal(geo.sides.from);
    const p0 = { x: ancla.x + n0.x * 1.5, y: ancla.y + n0.y * 1.5 };
    const raw = w || (this.last
      ? this.toWorld(this.last.x, this.last.y)
      : { x: r.tip?.x ?? p0.x, y: r.tip?.y ?? p0.y });
    // La guía se calcula desde el último punto de giro ya fijado (o desde el
    // ancla de salida si no hay ninguno): el tramo nuevo nace ahí, no en el
    // nodo de origen.
    const base = r.way.length ? r.way[r.way.length - 1] : p0;
    // El primer tramo sale perpendicular al lado del nodo; a partir de ahí el
    // cursor manda en el eje elegido (cada giro lo fija el usuario con un clic).
    const axis = guideAxis(base, raw, r.axis);
    r.axis = axis;
    // El punto que se fija al clicar se engancha a los bordes y centros de los
    // nodos, y la guía se dibuja para que se vea con qué se está alineando.
    const cursor = this.snapGuide(base, raw, axis);
    const tip = r.way.length
      ? guidePoint(base, cursor, axis)
      : exitGuide(p0, n0, axis, cursor);
    // La flecha no atraviesa nodos: la punta se detiene contra su cara. El nodo
    // de origen también cuenta (con margen 0, porque la salida nace a 1,5 px
    // del lado): así el trazo no puede volver a cruzarlo al girar.
    const origen = this.app.diagram.nodes.find((n) => n.id === r.from);
    let pts = userRouteTip(p0, n0, r.way, tip);
    pts = wallLimit(
      pts,
      this.app.diagram.nodes.filter((n) => n.id !== r.from),
    );
    if (origen) pts = wallLimit(pts, [origen], 0);
    r.tip = pts[pts.length - 1];
    this.tempEdge.setAttribute(
      "d",
      edgePath({ p1: p0, p2: r.tip, pts, mid: r.tip }),
    );
  }

  clearTempEdge() {
    if (this.tempEdge) {
      this.tempEdge.remove();
      this.tempEdge = null;
    }
  }

  /* -------- vista previa de inserción (fantasma que sigue al ratón) -------- */

  /** Silueta del nodo que se colocaría con la herramienta activa. */
  updateInsertPreview(e) {
    const tool = this.app.tool;
    const t = NODE_TYPES[tool];
    if (!t || !e.target?.closest?.("#canvas")) {
      this.clearInsertPreview();
      return;
    }
    // El fantasma va exactamente donde caería el nodo: mismo ajuste a rejilla
    // y mismas guías de alineación que al colocarlo.
    const w = this.toWorld(e.clientX, e.clientY);
    const { x, y } = this.snapSpot(tool, w.x, w.y);
    if (!this.insertPreview || this.insertPreview.tool !== tool) {
      this.clearInsertPreview();
      const g = svgEl("g", { class: "insert-preview" });
      let shape;
      if (tool === "start" || tool === "end" || tool === "stop") {
        shape = svgEl("circle", {
          cx: 0,
          cy: 0,
          r: Math.min(t.w, t.h) / 2,
          class: "ghost",
        });
      } else if (tool === "decision") {
        shape = svgEl("polygon", { class: "ghost" });
      } else {
        shape = svgEl("rect", {
          class: "ghost",
          rx: tool === "activity" ? 12 : 0,
        });
      }
      g.appendChild(shape);
      this.overlay.appendChild(g);
      this.insertPreview = { g, shape, tool };
    }
    const p = this.insertPreview;
    if (tool === "start" || tool === "end" || tool === "stop") {
      p.shape.setAttribute("cx", x + t.w / 2);
      p.shape.setAttribute("cy", y + t.h / 2);
    } else if (tool === "decision") {
      const s = Math.max(t.w, t.h);
      p.shape.setAttribute(
        "points",
        `${x + s / 2},${y} ${x + s},${y + s / 2} ${x + s / 2},${y + s} ${x},${y + s / 2}`,
      );
    } else {
      p.shape.setAttribute("x", x);
      p.shape.setAttribute("y", y);
      p.shape.setAttribute("width", t.w);
      p.shape.setAttribute("height", t.h);
    }
  }

  clearInsertPreview() {
    if (this.insertPreview) {
      this.insertPreview.g.remove();
      this.insertPreview = null;
    }
  }

  drawMarquee() {
    if (!this.marquee) return;
    if (!this.marqueeRect) {
      this.marqueeRect = svgEl("rect", {
        fill: "rgba(255,255,255,.06)",
        stroke: "#8d8d96",
        "stroke-width": 1,
        "stroke-dasharray": "4 3",
      });
      this.overlay.appendChild(this.marqueeRect);
    }
    const m = this.marquee;
    const x = Math.min(m.x0, m.x),
      y = Math.min(m.y0, m.y);
    this.marqueeRect.setAttribute("x", x);
    this.marqueeRect.setAttribute("y", y);
    this.marqueeRect.setAttribute("width", Math.abs(m.x - m.x0));
    this.marqueeRect.setAttribute("height", Math.abs(m.y - m.y0));
  }

  finishMarquee() {
    const m = this.marquee;
    this.marquee = null;
    if (this.marqueeRect) {
      this.marqueeRect.remove();
      this.marqueeRect = null;
    }
    if (!m) return;
    const x1 = Math.min(m.x0, m.x),
      x2 = Math.max(m.x0, m.x);
    const y1 = Math.min(m.y0, m.y),
      y2 = Math.max(m.y0, m.y);
    if (x2 - x1 < 4 && y2 - y1 < 4) return;
    const picked = this.app.diagram.nodes.filter(
      (n) => n.x + n.w > x1 && n.x < x2 && n.y + n.h > y1 && n.y < y2,
    );
    for (const n of picked) {
      if (!this.app.isSelected({ type: "node", id: n.id }))
        m.base.push({ type: "node", id: n.id });
    }
    this.app.setSelection(m.base);
  }

  /** Dibuja el tirador de redimensión del nodo seleccionado. */
  drawResizeHandle() {
    if (this.resizeHandle) {
      this.resizeHandle.remove();
      this.resizeHandle = null;
    }
    if (this.app.tool !== "select") return;
    const sel = this.app.state.selected.filter((s) => s.type === "node");
    if (sel.length !== 1) return;
    const n = nodeById(this.app.diagram, sel[0].id);
    if (!n) return;
    const size = 9 / this.app.diagram.view.k;
    this.resizeHandle = svgEl("rect", {
      x: n.x + n.w - size / 2,
      y: n.y + n.h - size / 2,
      width: size,
      height: size,
      fill: "#f4f4f6",
      stroke: "#0b0b0c",
      "stroke-width": 1,
      rx: 1,
      "data-resize": "1",
      style: "cursor: nwse-resize",
    });
    this.overlay.appendChild(this.resizeHandle);
  }

  /* ------------------------------ zoom -------------------------------- */

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // 0.0025 => ~1.28x por muesca: suave, sin saltos.
      const factor = Math.exp(-e.deltaY * 0.0025);
      this.app.zoomAt(e.clientX, e.clientY, factor);
    } else {
      const v = this.app.diagram.view;
      v.x -= e.deltaX;
      v.y -= e.deltaY;
      this.app.applyView();
    }
  }

  zoomBy(factor) {
    const r = this.svg.getBoundingClientRect();
    this.app.zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }

  /* ---------------------------- doble clic ---------------------------- */

  async onDblClick(e) {
    const edgeLabel = e.target.dataset?.edgeLabel;
    // Doble clic en el texto de la flecha: sólo la etiqueta, como en los nodos.
    if (edgeLabel) {
      await this.app.editEdgeLabel(edgeLabel);
      return;
    }
    // Doble clic sobre la línea (o cerca de ella): selecciona y edita sólo la
    // etiqueta en un único diálogo. En las ramas de una decisión esto cambia el
    // texto de la rama; la condición se edita en el inspector.
    let edgeId =
      e.target.dataset?.edge ?? e.target.closest?.(".edge")?.dataset?.edge;
    edgeId ||= this.nearEdge(this.toWorld(e.clientX, e.clientY))?.id;
    if (edgeId) {
      this.app.select({ type: "edge", id: edgeId });
      await this.app.editEdgeLabel(edgeId);
      return;
    }
    const laneTitle = e.target.dataset?.laneTitle;
    if (laneTitle !== undefined) {
      this.app.editLaneName(Number(laneTitle));
      return;
    }
    const nodeEl = e.target.closest(".node");
    if (nodeEl) {
      const id = nodeEl.dataset.id;
      this.app.select({ type: "node", id });
      await this.app.editNodeLabel(id);
    }
  }

  /* ----------------------------- teclado ------------------------------ */

  /**
   * Desplaza los nodos seleccionados con las flechas del teclado. Respeta el
   * carril igual que el arrastre y agrupa las pulsaciones seguidas en un solo
   * paso de deshacer.
   * @param {number} dx desplazamiento horizontal en unidades del mundo.
   * @param {number} dy desplazamiento vertical en unidades del mundo.
   * @returns {boolean} `true` si se ha movido algún nodo.
   */
  nudgeSelection(dx, dy) {
    const ids = this.app.selectedNodeIds();
    if (!ids.length) return false;
    const clave = ids.join(",");
    const ahora = Date.now();
    const rafaga =
      clave === this.nudgeIds && ahora - this.nudgeAt < NUDGE_GROUP;
    // El historial va antes de mutar, como en el resto de operaciones. Sólo al
    // empezar la ráfaga: las repeticiones se acumulan en el mismo paso.
    if (!rafaga) this.app.pushHistory("Mover nodos");
    this.nudgeIds = clave;
    this.nudgeAt = ahora;
    for (const id of ids) {
      const n = nodeById(this.app.diagram, id);
      if (!n) continue;
      n.x += dx;
      n.y += dy;
      if (this.app.diagram.lanes.length)
        n.lane = laneOf(this.app.diagram, n);
    }
    this.app.commit("Mover nodos");
    return true;
  }

  onKeyDown(e) {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(
      document.activeElement?.tagName,
    );
    const mod = e.ctrlKey || e.metaKey;

    if (e.code === "Space" && !typing) {
      this.spaceDown = true;
      this.svg.style.cursor = "grab";
      if (!this.drag) this.beginPan(e);
      e.preventDefault();
      return;
    }

    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      this.nudgeIds = "";
      e.shiftKey ? this.app.redo() : this.app.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.nudgeIds = "";
      this.app.redo();
      return;
    }
    if (typing) return;

    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      this.app.selectAll();
      return;
    }
    if (mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      this.app.copySelection();
      return;
    }
    if (mod && e.key.toLowerCase() === "v") {
      e.preventDefault();
      this.app.pasteSelection();
      return;
    }
    if (mod && e.key.toLowerCase() === "x") {
      e.preventDefault();
      this.app.copySelection();
      this.app.deleteSelected();
      return;
    }
    if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      this.app.duplicateSelection();
      return;
    }
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      this.app.saveFile();
      return;
    }
    if (mod) return;

    switch (e.key) {
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        // Sin modificadores: 1 px por pulsación (ajuste fino); con Shift, una
        // celda de la rejilla. Ctrl/Cmd ya se ha descartado arriba.
        const paso = e.shiftKey ? GRID : 1;
        const movido = this.nudgeSelection(
          e.key === "ArrowLeft" ? -paso : e.key === "ArrowRight" ? paso : 0,
          e.key === "ArrowUp" ? -paso : e.key === "ArrowDown" ? paso : 0,
        );
        if (movido) e.preventDefault();
        break;
      }
      case "Delete":
      case "Backspace":
        e.preventDefault();
        for (const s of [...this.app.state.selected])
          this.app.deleteSelection(s);
        break;
      case "Escape":
        this.cancelRoute();
        this.app.clearSelection();
        this.app.setTool("select");
        break;
      case "Enter":
        // Cierra el trazado en curso si el puntero está sobre un nodo destino.
        if (
          this.route &&
          this.route.hover &&
          this.route.hover.id !== this.route.from
        ) {
          e.preventDefault();
          this.finishRoute(this.route.hover.id);
        }
        break;
      case "=":
      case "+":
        this.zoomBy(1.15);
        break;
      case "-":
      case "_":
        this.zoomBy(1 / 1.15);
        break;
      case "0":
        this.app.zoomFit();
        break;
      default: {
        // R: gira 90° el nodo seleccionado (sólo los orientables: fork, join
        // y tiempo).
        if (e.key.toLowerCase() === "r") {
          this.app.rotateNodes();
          e.preventDefault();
          break;
        }
        const map = {
          v: "select",
          s: "start",
          e: "end",
          p: "stop",
          a: "activity",
          d: "decision",
          f: "fork",
          j: "join",
          n: "note",
          o: "objeto",
          c: "connect",
          x: "delete",
        };
        const tool = map[e.key.toLowerCase()];
        if (tool) {
          this.app.setTool(tool);
          e.preventDefault();
        }
      }
    }
  }
}

/** Nombre legible de una bolita, para los mensajes de la barra de estado. */
function labelSide(side) {
  return (
    {
      left: "la izquierda",
      right: "la derecha",
      top: "arriba",
      bottom: "abajo",
    }[side] || side
  );
}

function laneOf(d, node) {
  let acc = 0;
  const centro = laneCoord(d, node);
  for (let i = 0; i < d.lanes.length; i += 1) {
    acc += d.lanes[i].height;
    if (centro < acc) return i;
  }
  return d.lanes.length - 1;
}

export {
  laneOf,
  addEdge,
  removeNode,
  removeEdge,
  inEdges,
  outEdges,
  cloneDiagram,
  edgeGeometry,
  nodeAt,
  edgeAt,
};
