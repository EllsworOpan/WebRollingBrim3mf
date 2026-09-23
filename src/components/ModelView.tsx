import { useEffect, useRef, useState } from 'react';
import * as T from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BrimResult, Mesh, Project } from '../core/types';
function geometry(mesh: Mesh) {
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(mesh.vertices, 3)); g.setIndex(mesh.triangles); g.computeVertexNormals(); return g;
}
export default function ModelView({ project, result, showBrim, fitKey, selected }: { project: Project; result: BrimResult; showBrim: boolean; fitKey: number; selected: string | null }) {
  const canvas = useRef<HTMLCanvasElement>(null), fitRef = useRef<() => void>(() => {}), [error, setError] = useState('');
  useEffect(() => {
    if (!canvas.current) return;
    let renderer: T.WebGLRenderer;
    try { renderer = new T.WebGLRenderer({ canvas: canvas.current, antialias: true }); } catch { setError('3D rendering is unavailable. The footprint preview and 3MF export remain available.'); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor('#10191e');
    const scene = new T.Scene(), camera = new T.PerspectiveCamera(42, 1, 0.01, 200000);
    camera.up.set(0,0,1); const controls = new OrbitControls(camera, canvas.current); controls.enableDamping = true;
    scene.add(new T.HemisphereLight(0xe4f3ff, 0x48555e, 2)); const light = new T.DirectionalLight(0xffffff, 3); light.position.set(80,-100,200); scene.add(light);
    const meshes: T.Mesh[] = [], materials: T.Material[] = [];
    const add = (mesh: Mesh, color: string, faded: boolean) => { if (!mesh.triangles.length) return; const material = new T.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.1, side: T.DoubleSide, transparent: faded, opacity: faded ? 0.25 : 1 }); materials.push(material); const m = new T.Mesh(geometry(mesh), material); meshes.push(m); scene.add(m); };
    for (const object of project.objects) {
      const faded = !!selected && selected !== object.id;
      object.parts.filter(p => p.kind === 'ModelPart').forEach(p => add(p.mesh, '#91a9af', faded));
      if (showBrim) { const brim = result.objects.find(b => b.id === object.id); if (brim) add(brim.mesh, '#ffb454', faded); }
    }
    const bounds = new T.Box3(); meshes.forEach(m => bounds.expandByObject(m));
    const center = bounds.getCenter(new T.Vector3()), size = bounds.getSize(new T.Vector3());
    const span = Math.max(size.x, size.y, size.z, 30);
    camera.near = Math.max(0.1, span / 100); camera.far = span * 100;
    const grid = new T.GridHelper(Math.max(200, Math.ceil(span / 100) * 100), Math.max(20, Math.ceil(span / 10)), '#33434b', '#223039'); grid.rotation.x = Math.PI / 2; grid.position.set(center.x,center.y,-0.02); scene.add(grid);
    fitRef.current = () => { const distance = size.length() / (2 * Math.sin(T.MathUtils.degToRad(42 / 2))) * Math.max(1, 1 / camera.aspect) + 20; controls.target.copy(center); camera.position.copy(center).addScaledVector(new T.Vector3(0.5,-0.7,0.65).normalize(), distance); controls.update(); };
    const resize = () => { const c = canvas.current; if (!c) return; renderer.setSize(c.clientWidth,c.clientHeight,false); camera.aspect = c.clientWidth / Math.max(c.clientHeight,1); camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(canvas.current); resize(); fitRef.current();
    renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene,camera); });
    return () => { observer.disconnect(); renderer.setAnimationLoop(null); meshes.forEach(m => m.geometry.dispose()); materials.forEach(m => m.dispose()); grid.geometry.dispose(); (Array.isArray(grid.material) ? grid.material : [grid.material]).forEach(m => m.dispose()); controls.dispose(); renderer.dispose(); };
  }, [project, result, showBrim, selected]);
  useEffect(() => fitRef.current(), [fitKey]);
  return <div className="mesh-view"><canvas ref={canvas} aria-label="3D models with rolling brim parts"/>{error && <div className="viewer-error"><p>{error}</p></div>}<div className="view-instructions">Drag to orbit <span>·</span> Right-drag to pan <span>·</span> Scroll to zoom</div></div>;
}
