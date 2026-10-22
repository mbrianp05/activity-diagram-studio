# Activity Diagram Studio

Editor y simulador de **diagramas de actividades UML** que funciona directamente en el navegador. Permite dibujar flujos de trabajo con decisiones, ramas paralelas (fork/join), carriles de actor y notificaciones, validar la coherencia del diagrama y ejecutarlo paso a paso con un simulador de tokens.

Pensado para modelar y comprobar procesos sin instalar nada: es HTML + CSS + ES modules nativos, **sin dependencias, sin build y sin framework**.

## Qué puedes hacer

- **Dibujar** nodos de inicio, fin, punto muerto, acción, proceso, tiempo, envío/recepción, decisión, fork/join, nota y objeto.
- **Organizar por carriles** (calles horizontales) para representar actores o responsables.
- **Conectar nodos** eligiendo por qué lado sale y entra cada flecha, con puntos de giro manuales.
- **Validar** el diagrama: un solo inicio, fines sin salida, fork con ≥2 salidas, join con ≥2 entradas, etc.
- **Simular** el flujo paso a paso, incluyendo decisiones con condiciones, ramas paralelas y bloqueos.
- **Guardar y abrir** diagramas en JSON, con autoguardado en `localStorage`.
- **Exportar** a SVG, PNG o WEBP.
- Deshacer/rehacer, copiar/pegar, zoom y paneo.

## Cómo iniciarla

Requisitos: **Node.js 18 o superior** (solo para el servidor estático; la app no usa dependencias).

```bash
npm start
```

Después abre <http://localhost:5173> en el navegador.

Para usar otro puerto:

```bash
# PowerShell
$env:PORT=3000; npm start

# bash
PORT=3000 npm start
```

> Abre siempre la app a través del servidor. Si abres `index.html` con `file://`, los ES modules se bloquean por CORS y la aplicación no arranca.

## Uso rápido

1. Elige una herramienta en la barra lateral izquierda (o usa sus atajos) y haz clic en el lienzo para crear un nodo.
2. Añade carriles con **+** y arrastra los nodos a la banda del actor correspondiente.
3. Usa **Conectar (C)** para unir dos nodos; haz clic derecho durante el trazado para fijar un punto de giro.
4. Selecciona un nodo o una flecha para editarlo en el inspector (texto, tipo, lado de conexión, condición de una decisión…).
5. Pulsa **Validar** para revisar errores y **Simular** para ejecutar el flujo.

El diagrama se autoguarda en el navegador. **Guardar** descarga un `.json` y **Exportar** genera un SVG o PNG listo para compartir.

## Atajos principales

| Acción | Atajo |
| --- | --- |
| Seleccionar / mover | `V` |
| Inicio / Fin / Punto muerto | `S` / `E` / `P` |
| Acción / Decisión | `A` / `D` |
| Fork / Join | `F` / `J` |
| Nota / Objeto | `N` / `O` |
| Conectar / Eliminar | `C` / `X` |
| Borrar selección | `Supr` o `Retroceso` |
| Deshacer / Rehacer | `Ctrl+Z` / `Ctrl+Shift+Z` o `Ctrl+Y` |
| Copiar / Pegar / Cortar | `Ctrl+C` / `Ctrl+V` / `Ctrl+X` |
| Duplicar / Guardar | `Ctrl+D` / `Ctrl+S` |
| Seleccionar todo | `Ctrl+A` |
| Paneo | `Espacio` o botón derecho |
| Zoom | `+` / `-` / `0` |

## Tests

La lógica pura (modelo, validación y simulación) tiene una suite sin DOM:

```bash
node js/selftest.mjs
```

Sale con código `1` si hay fallos. Los cambios de render, interacción o exportación se comprueban a mano en el navegador.

## Estructura del proyecto

```
index.html      shell de la app y capas SVG
css/styles.css  tema oscuro
server.mjs      servidor estático (PORT, por defecto 5173)
js/app.js       estado, UI, inspector, historial, persistencia y simulación
js/render.js    reconstrucción de las capas SVG
js/interact.js  puntero, arrastre, marquesina, paneo, zoom y teclado
js/routing.js   geometría de las flechas
js/model.js     modelo de datos puro
js/validate.js  reglas semánticas del diagrama
js/simulate.js  motor de simulación
js/io.js        exportación JSON / SVG / PNG
js/selftest.mjs pruebas sin DOM
```
