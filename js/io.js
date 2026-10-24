/**
 * Exportación: descarga de archivos, SVG autónomo y rasterizado a PNG/WEBP.
 */
import { bounds, isVerticalLanes } from './model.js';

const NS = 'http://www.w3.org/2000/svg';

export function download(filename, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const STYLE = `
  .bg { fill: #101012; }
  .node-shape { fill: #17171a; stroke: #6f6f78; stroke-width: 1.4; }
  .node.type-start .node-shape, .node.type-end .node-shape { fill: #8d8d96; stroke: none; }
  .node.type-decision .node-shape { fill: #1a1a1e; stroke: #9a9aa3; }
  .node.type-fork .node-shape, .node.type-join .node-shape { fill: #0f0f11; stroke: #9a9aa3; }
  .node.type-note .node-shape { fill: #131316; stroke: #5e5e66; }
  .node.type-stop .node-shape { fill: #101013; stroke: #8d8d96; stroke-width: 1.6; }
  .node.type-tiempo .node-shape { fill: #131316; stroke: #9a9aa3; }
  .node-slash { stroke: #9a9aa3; stroke-linecap: butt; }
  .node-deco-line { stroke: #6f6f78; }
  .node-dot { fill: #8d8d96; stroke: none; }
  .node-ring { fill: none; stroke: #6f6f78; stroke-width: 1.4; }
  .node-label { fill: #ecedf0; font: 13px "Segoe UI", Inter, system-ui, sans-serif; text-anchor: middle; dominant-baseline: middle; }
  .node-sub { fill: #63636b; font: 10.5px "Segoe UI", Inter, system-ui, sans-serif; text-anchor: middle; dominant-baseline: middle; }
  .edge { fill: none; stroke: #6b6b74; stroke-width: 1.6; stroke-linejoin: miter; stroke-miterlimit: 6; }
  .edge-label { fill: #8d8d96; font: 11.5px "Segoe UI", Inter, system-ui, sans-serif; text-anchor: middle; dominant-baseline: middle; }
  .edge-label-bracket { fill: none; stroke: #63636b; stroke-width: 1.1; }
  .lane-band { fill: #ffffff; fill-opacity: .014; stroke: #26262a; stroke-width: 1; }
  .lane-band.alt { fill-opacity: .03; }
  .lane-head { fill: #0e0e10; stroke: #26262a; }
  .lane-title { fill: #8d8d96; font: 600 12px "Segoe UI", Inter, system-ui, sans-serif; text-anchor: middle; dominant-baseline: middle; }
`;

const MARKER = `
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 10 5 0 10z" fill="#6b6b74" />
    </marker>
    <marker id="arrow-selected" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 10 5 0 10z" fill="#f4f4f6" />
    </marker>
    <marker id="arrow-temp" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 10 5 0 10z" fill="#63636b" />
    </marker>
  </defs>`;

/** Genera un SVG autónomo con estilos embebidos y sin elementos de edición. */
export function exportSvg(svg, diagram, { forPng = false, padding = 40 } = {}) {
  const b = bounds(diagram);
  const vertical = isVerticalLanes(diagram);
  // Los carriles se extienden a lo largo de su eje: alto total en horizontal y
  // ancho total en vertical. El recorte del SVG tiene que cubrirlos.
  const laneSpan = diagram.lanes.reduce((s, l) => s + l.height, 0);
  const minX = Math.min(b.x, 0) - padding;
  const minY = Math.min(b.y, 0) - padding;
  const right = vertical && diagram.lanes.length ? Math.max(b.x + b.w, laneSpan) : b.x + b.w;
  const bottom = !vertical && diagram.lanes.length ? Math.max(b.y + b.h, laneSpan) : b.y + b.h;
  const width = Math.max(400, Math.max(right, 400) - minX + padding);
  const height = Math.max(300, Math.max(bottom, 300) - minY + padding);

  const clone = svg.querySelector('#viewport').cloneNode(true);
  clone.querySelectorAll('.handle, .temp-edge, .insert-preview, .route-points, .port-hints, [data-resize], [data-lane-resize], .edge-hit, .node-hit')
    .forEach((n) => n.remove());
  clone.querySelectorAll('.node.selected .node-shape').forEach((n) => {
    n.setAttribute('stroke', '#6f6f78');
  });
  clone.querySelectorAll('.edge.selected').forEach((n) => n.setAttribute('stroke', '#6b6b74'));
  clone.setAttribute('transform', '');

  const out = document.createElementNS(NS, 'svg');
  out.setAttribute('xmlns', NS);
  out.setAttribute('width', String(Math.round(width)));
  out.setAttribute('height', String(Math.round(height)));
  out.setAttribute('viewBox', `${Math.round(minX)} ${Math.round(minY)} ${Math.round(width)} ${Math.round(height)}`);
  out.setAttribute('font-family', 'Segoe UI, Inter, system-ui, sans-serif');

  const style = document.createElementNS(NS, 'style');
  style.textContent = STYLE;
  out.appendChild(style);
  if (!forPng) out.insertAdjacentHTML('afterbegin', '');

  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('x', minX);
  bg.setAttribute('y', minY);
  bg.setAttribute('width', String(Math.round(width)));
  bg.setAttribute('height', String(Math.round(height)));
  bg.setAttribute('class', 'bg');
  out.appendChild(bg);
  out.insertAdjacentHTML('beforeend', MARKER);
  out.appendChild(clone);

  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(out)}`;
}

/**
 * Rasteriza el SVG a un canvas opaco (mismo fondo que el tema) con un factor de
 * escala. Sirve tanto para PNG como para WEBP.
 */
async function rasterize(svgText, scale = 2) {
  const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('No se pudo rasterizar el SVG'));
      img.src = url;
    });
    const w = Math.max(1, Math.round((img.width || 800) * scale));
    const h = Math.max(1, Math.round((img.height || 600) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#101012';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** `canvas.toBlob` como promesa; devuelve null si el navegador no puede codificar. */
function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function exportPng(svgText, filename, scale = 2) {
  try {
    const canvas = await rasterize(svgText, scale);
    const png = await canvasToBlob(canvas, 'image/png');
    if (!png) return false;
    download(filename, png, 'image/png');
    return true;
  } catch {
    return false;
  }
}

/**
 * Exporta a WEBP. Si el navegador no sabe codificar WEBP, `toBlob` devuelve un
 * PNG: en ese caso se descarga como `.png` y se avisa con `fallback`.
 */
export async function exportWebp(svgText, filename, scale = 2, quality = 0.95) {
  try {
    const canvas = await rasterize(svgText, scale);
    const blob = await canvasToBlob(canvas, 'image/webp', quality);
    if (!blob) return { ok: false, fallback: false };
    const isWebp = blob.type === 'image/webp';
    download(isWebp ? filename : filename.replace(/\.webp$/i, '.png'), blob, isWebp ? 'image/webp' : 'image/png');
    return { ok: true, fallback: !isWebp };
  } catch {
    return { ok: false, fallback: false };
  }
}
