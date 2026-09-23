import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrimResult, Point, Rings } from '../core/types';
const path = (rings: Rings) => rings.map(r => r.length ? `M${r.map(p => `${p.x},${p.y}`).join('L')}Z` : '').join('');
interface Props { result: BrimResult; bed: Point[]; showBrim: boolean; compare: boolean; probe: boolean; fitKey: number; selected: string | null }
export default function FirstLayerView({ result, bed, showBrim, compare, probe, fitKey, selected }: Props) {
  const svg = useRef<SVGSVGElement>(null), drag = useRef<{ x: number; y: number; box: typeof view } | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, w: 200, h: 200 }), [cursor, setCursor] = useState<Point | null>(null);
  const viewRef = useRef(view); viewRef.current = view;
  const boundsRef = useRef(result.bounds); boundsRef.current = { ...result.bounds };
  if (probe) for (const ring of result.circleSweep) for (const p of ring) {
    const b = boundsRef.current;
    b.minX = Math.min(b.minX,p.x); b.maxX = Math.max(b.maxX,p.x);
    b.minY = Math.min(b.minY,p.y); b.maxY = Math.max(b.maxY,p.y);
  }
  const fit = useCallback(() => {
    const rect = svg.current?.getBoundingClientRect(); if (!rect) return;
    const b = boundsRef.current, aspect = rect.width / Math.max(rect.height, 1);
    let w = b.maxX - b.minX + 25, h = b.maxY - b.minY + 25;
    if (w / h < aspect) w = h * aspect; else h = w / aspect;
    setView({ x: (b.minX + b.maxX - w) / 2, y: -(b.minY + b.maxY + h) / 2, w, h });
  }, []);
  useEffect(fit, [fit, fitKey, probe]);
  useEffect(() => {
    const element = svg.current; if (!element) return;
    const observer = new ResizeObserver(fit); observer.observe(element);
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); const rect = element.getBoundingClientRect(), box = viewRef.current;
      const factor = Math.exp(Math.max(-0.4, Math.min(0.4, event.deltaY * 0.001)));
      const w = Math.max(2, Math.min(10000, box.w * factor)), h = w / box.w * box.h;
      setView({ x: box.x + (box.w - w) * (event.clientX - rect.left) / rect.width, y: box.y + (box.h - h) * (event.clientY - rect.top) / rect.height, w, h });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, [fit]);
  return <div className="layer-view"><svg ref={svg} role="img" aria-label="Mesh cross-sections and generated rolling brim" viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} onDoubleClick={fit}
    onPointerDown={e => { if (e.button === 0) { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, box: view }; } }}
    onPointerUp={e => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
    onPointerCancel={() => { drag.current = null; }} onPointerLeave={() => setCursor(null)}
    onPointerMove={e => { const rect = e.currentTarget.getBoundingClientRect(); if (drag.current) { const d = drag.current; setView({ ...d.box, x: d.box.x - (e.clientX - d.x) / rect.width * d.box.w, y: d.box.y - (e.clientY - d.y) / rect.height * d.box.h }); } setCursor({ x: view.x + (e.clientX - rect.left) / rect.width * view.w, y: -(view.y + (e.clientY - rect.top) / rect.height * view.h) }); }}>
    <defs><pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="#304149" strokeWidth=".12"/></pattern></defs>
    <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="url(#grid)"/>
    <g transform="scale(1,-1)"><path d={path([bed])} fill="none" stroke="#52616b" strokeWidth=".3"/>
      {probe && <path aria-label="Full rolling-circle sweep" d={path(result.circleSweep)} fill="#54d7c0" fillOpacity=".22" fillRule="evenodd"/>}
      {/* Independent brims may overlap other models. Draw all brims first so
          their object order cannot hide a footprint or comparison outline. */}
      {showBrim && result.objects.map(object => <g key={object.id} opacity={selected && selected !== object.id ? 0.3 : 1}>
        <path d={path(object.area)} fill="#ffb454" fillOpacity=".8" fillRule="evenodd" stroke="#ffd18f" strokeWidth=".06"/>
      </g>)}
      {result.objects.map(object => <g key={object.id} opacity={selected && selected !== object.id ? 0.3 : 1}>
        <path d={path(object.footprint)} fill="#91a9af" fillRule="evenodd" stroke="#ccdcdf" strokeWidth=".08"/>
      </g>)}
      {compare && result.objects.map(object => <g key={object.id} opacity={selected && selected !== object.id ? 0.3 : 1}>
        <path d={path(object.bottom)} fill="none" stroke="#7ad5ff" strokeWidth="3" vectorEffect="non-scaling-stroke"/><path d={path(object.top)} fill="none" stroke="#ec9de2" strokeWidth="2" strokeDasharray="5 5" vectorEffect="non-scaling-stroke"/>
      </g>)}
      {probe && <path d={path(result.circleSweep)} fill="none" stroke="#75e6d1" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/>}
      {probe && cursor && <circle cx={cursor.x} cy={cursor.y} r={result.settings.diameter / 2} fill="#54d7c01c" stroke="#75e6d1" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/>}
    </g></svg><div className="view-instructions">Drag to pan <span>·</span> Scroll to zoom <span>·</span> Double-click to fit</div>
    {probe && <div className="probe-note circle-sweep-note"><i className="swatch circle-sweep-swatch"/>Full circle sweep <strong>Ø {result.settings.diameter} mm</strong><span>Preview only</span></div>}
    <div className="scale-readout">{cursor ? `X ${cursor.x.toFixed(1)} · Y ${cursor.y.toFixed(1)} mm` : 'ORTHOGRAPHIC · XY'}</div>
  </div>;
}
