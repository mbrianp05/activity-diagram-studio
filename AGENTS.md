# AGENTS.md

## Qué es

Editor + simulador de diagramas de actividades UML (decisiones, fork/join, carriles).
Cero dependencias, cero build: HTML + CSS + ES modules nativos servidos tal cual.
UI, comentarios y JSDoc están en **español**; mantén ese idioma en el código.

## Comandos

```bash
npm start          # node server.mjs -> http://localhost:5173 (override con PORT)
node js/selftest.mjs   # único test suite; sale con 1 si hay fallos
```

- No hay linter, formateador, typecheck ni bundler configurado. No los inventes ni añadas dependencias.
- `js/selftest.mjs` **no** está en `package.json` scripts (a propósito o no); ejecútalo con `node` directamente.
- Abre siempre vía servidor. `file://` rompe los ES modules (CORS).
- `selftest.mjs` solo cubre lógica pura (`model`, `validate`, `simulate`). Cambios en render/interact/io se verifican a mano en el navegador.

## Arquitectura

```
index.html      estructura del shell + <defs> SVG (grid, marcadores) + capas #viewport
css/styles.css  tema oscuro; el editor usa variables CSS (--grid, etc.)
server.mjs      servidor estático con protección de path traversal
js/app.js       clase App monolítica: estado, UI, inspector, historial, persistencia, simulación
js/render.js    Renderer: reconstruye las capas SVG; render() completo, refresh() durante arrastre
js/interact.js  Interaction: puntero, arrastre, redimensión, marquesina, paneo, zoom, teclado
js/routing.js   geometría ortogonal de flujos (anchors, pickSides, edgeGeometry, edgePath)
js/model.js     datos puros: NODE_TYPES, create*, consultas, serialize/deserialize
js/validate.js  reglas semánticas -> issues {level: error|warn|info, msg, nodeId?, edgeId?}
js/simulate.js  motor de tokens + evaluador de expresiones propio (sin eval)
js/io.js        export JSON/SVG/PNG
js/selftest.mjs pruebas sin DOM
```

Dependencias: `routing.js` no importa nada del DOM salvo constantes; `model.js` + `validate.js` + `simulate.js` son importables en Node (tests). Mantén esa separación: no introduzcas `document` en model/validate/simulate/routing.

## Flujo de edición (respeta este patrón)

- `app.pushHistory()` **antes** de mutar, luego `app.commit(label)` (render + persist). Olvidar `pushHistory` rompe el undo.
- Durante un arrastre usa `app.refresh()`; sólo `render()` al confirmar.
- El historial son snapshots JSON de `{name, lanes, nodes, edges}` — **excluye `view`**; `restore()` preserva el zoom/pan actual. `serialize()` también quita `view`.
- Persistencia automática en `localStorage` con clave `activity-diagram-studio/v1` (debounced 400 ms en `persistSoon`). `loadInitial()` cae al diagrama de ejemplo si no hay nada.
- `window.app` es la instancia global; útil para depurar en consola.

## Invariantes geométricos

- `decision`, `start`, `end` y `stop` se fuerzan a cuadrado en `createNode`, al cambiar tipo en el inspector y en `deserialize` (migración de archivos antiguos). `start`/`end` se limitan a `DOT_MAX = 28`.
- Lane = banda horizontal. `n.lane` es **explícito**, no se recalcula por posición: al redimensionar, reordenar o borrar carriles usa `shiftLanes` / `swapLanes` / `removeLaneAt` (model.js), que mueven los nodos para que ninguno quede fuera de su banda. `assignLanes` sólo para diagramas nuevos o al arrastrar un nodo.
- La cabecera de carril es una **barra vertical fina de `LANE_HEADER = 40` px** pegada al borde izquierdo, con el nombre del actor girado 90º (`fitLaneName` lo recorta al alto de su banda). Ese ancho es además el margen que `interact.js:snapSpot` no deja pisar. El borde inferior de la barra (`LANE_GRIP = 12` px, `data-lane-resize`) redimensiona el carril y se elimina al exportar. No reintroduzcas la barra ancha con el texto en horizontal.
- Snap a rejilla: `GRID = 8` en `interact.js`, pero el patrón visible en `index.html` es 24/120. Doble clic en `#grid-rect` alterna el snap.

### Las flechas las dibuja el usuario (no hay trazado automático)

- El lado por el que sale y entra una flecha lo elige el usuario con las **bolitas** de los nodos: `edge.fromSide` / `edge.toSide` (`left|right|top|bottom`). El inspector permite cambiarlos a mano.
- El recorrido son los puntos de giro del usuario: `edge.way` (`[{x,y}]`). Sin ellos la flecha es un único corte en L entre las dos bolitas (`linkRoute`); con ellos pasa por ellos (`userRoute`). `orthoPoints`/`findFreeY`/`findFreeX` se han eliminado: **no reintroduzcas un enrutado que esquive nodos**.
- `anchorFor` reparte la posición exacta dentro del lado de forma **conjunta** (entradas y salidas comparten los huecos): centrada si es la única, `(k+0.5)/n` si hay varias, ordenada por la posición del otro extremo para que el reparto sea estable. En círculos (`start`, `end`, `stop`) y rombos (`decision`) hay un único punto por lado.
- Las bolitas se dibujan donde la flecha entra/sale de verdad (`buildPorts` en `render.js`), no en el centro del lado: con varias flechas en un lado se ve un punto por flecha, ya en su posición final.
- Al trazar, la bolita fantasma (`.port-hint`, capa overlay) se calcula con la flecha ficticia ya metida en el diagrama, así que se ve justo donde va a entrar. `targetAt`/`portAt` enganchan a la bolita más cercana con tolerancia de pantalla; no hace falta puntería al píxel.
- La etiqueta de un flujo se coloca con `labelSpot` sobre el tramo más largo, apartada de la línea y en vertical si ese tramo es vertical.

### Copiar y pegar

- `Ctrl+C` guarda el grupo en `app.clipboard` (`copyGroup`): los nodos seleccionados y los flujos que los unen.
- `Ctrl+V` pega bajo el puntero (`interaction.pointerWorld()`, o el centro visible si el ratón está fuera) y, si ahí pisa algo, busca el hueco libre más cercano (`freeSpot`) antes de insertar. `Ctrl+X` corta. Todo con ids nuevos (`pasteGroup`).

## Render / DOM

- No reordenes las capas dentro de `#viewport`: `#layer-lanes`, `#layer-edges`, `#layer-nodes`, `#layer-overlay`.
- El render se reconstruye con `textContent = ''` + `createElementNS`; no hay templating ni frameworks.
- La interacción se une al SVG por atributos `data-*`: `data-id`, `data-edge`, `data-resize`, `data-handle`, `data-lane-title`, `data-lane-resize`, `data-edge-label`, `data-route-point`. Cualquier elemento interactivo nuevo necesita su `data-*` en `render.js` y su rama en `interact.js:onPointerDown`.
- `interact.js` reexporta símbolos al final (línea ~511) sólo por compatibilidad; no añadas imports desde ahí.
- El overlay puede mostrar un fantasma de inserción (`.insert-preview`), la arista temporal (`edgeGeometry` con un flujo ficticio), las bolitas fantasma del trazado (`.port-hints`) y los puntos de giro editables (`.route-points`). Todo eso se borra al cancelar el gesto; nada de eso debe exportarse.
- Al conectar se vuelve a `select` y la flecha queda marcada. La herramienta `route` (editar el recorrido de una flecha existente) no está en la paleta: se entra desde el botón del inspector.
- La barra lateral izquierda lleva herramientas, carriles **e inspector** (`.inspector` va dentro de `.palette`): el grid es de dos columnas.

## Exportación

- `io.js` tiene un bloque `STYLE` **duplicado** a mano con los estilos de `css/styles.css`. Una clase nueva usada en el SVG debe añadirse en ambos sitios o desaparecerá al exportar.
- `exportSvg` clona `#viewport` y elimina `.handle`, `.temp-edge`, `.edge-hit`, `.node-hit`, `.route-points`, `.port-hints`, `[data-resize]`: si creas elementos de edición con otra clase, añádela a esa lista de limpieza.
- El SVG exportado no puede usar `var(--...)`; `io.js` usa hex fijos.

## Atajos (definidos en `interact.js:onKeyDown`)

Herramientas: `V` seleccionar, `S` inicio, `E` fin, `P` punto muerto, `A` acción, `D` decisión, `F` fork, `J` join, `N` nota, `O` objeto, `C` conectar, `X` eliminar.
Otros: `Supr`/`Backspace` borrar, `Esc` cancelar, `Enter` cerrar el trazado en curso, `Espacio`/botón derecho = panear, `+`/`-`/`0` zoom, `Ctrl+Z`/`Ctrl+Shift+Z`/`Ctrl+Y` deshacer/rehacer, `Ctrl+A` seleccionar todo, `Ctrl+C`/`Ctrl+V`/`Ctrl+X` copiar/pegar/cortar, `Ctrl+D` duplicar, `Ctrl+S` guardar, `Ctrl`+clic multiselección.
El handler es global: respeta el guard `typing` (INPUT/TEXTAREA/SELECT) o romperás la escritura en el inspector.

## Reglas de dominio que valida `validate.js`

- Tipos de nodo: `start`, `end`, `stop` (punto muerto), `activity`, `proceso`, `tiempo`, `enviar`, `recibir`, `objeto`, `decision`, `fork`, `join`, `note`. El **estado de un `objeto`** se guarda en `node.note` y se pinta entre `<< >>`; no añadas un campo nuevo.
- Un único nodo `start` (sin entradas, con salida); `end` y `stop` sin salida; `fork` ≥2 salidas; `join` ≥2 entradas.
- `stop` se dibuja como un círculo con una diagonal de izquierda a derecha (`g.__slash` en `render.js`): del mismo grosor que el círculo y de un borde al otro, sin holgura por medio. En el simulador termina el flujo como un `end`.
- Figuras: `render.js:shapeAttrs(node)` es la **única** fuente de la forma de un nodo (elemento + atributos); la usan el nodo del diagrama y el fantasma de inserción de `interact.js:updateInsertPreview`. `romboPoints` (decisión), `relojPoints` (tiempo, reloj de arena), `enviarPoints` (pico hacia fuera por la derecha), `recibirPoints` (muesca hacia dentro por la izquierda) y `tridentePuntos` (tridente recto del proceso, esquina inferior derecha). `updateNode` reconstruye la figura cuando cambia el **tipo**, no sólo cuando cambia el elemento, para no dejar atributos del anterior.
- `startSim()` aborta si hay issues con `level === 'error'`.
- Las ramas de una `decision` **no** se autoetiquetan: la etiqueta la escribe el usuario (doble clic en la flecha o inspector) y la condición es lo que decide el simulador.
- El simulador pide elección (`status === 'choice'`) cuando una decisión tiene varias salidas sin condición; `join` cuenta tokens y detecta bloqueos.
