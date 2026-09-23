import { Matrix4, Vector3, ShapeUtils, Vector2 } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { polygonsOf, signedArea, unionPolygons } from './geometry';
import type { Mesh, Point, Rings } from './types';

export function transformMesh(mesh: Mesh, matrix: Matrix4): Mesh {
  const vertices: number[] = [], p = new Vector3();
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    p.fromArray(mesh.vertices, i).applyMatrix4(matrix);
    if (![p.x,p.y,p.z].every(n => Number.isFinite(n) && Math.abs(n) <= 1e6)) throw new Error('A placement transform produces invalid or excessively large coordinates.');
    vertices.push(p.x, p.y, p.z);
  }
  const triangles = [...mesh.triangles];
  if (matrix.determinant() < 0) for (let i = 0; i < triangles.length; i += 3) [triangles[i + 1], triangles[i + 2]] = [triangles[i + 2], triangles[i + 1]];
  return { vertices, triangles };
}

export function loadStl(bytes: ArrayBuffer): Mesh {
  if (bytes.byteLength < 84) throw new Error('The STL is empty or truncated.');
  const count = new DataView(bytes).getUint32(80, true), expected = 84 + count * 50;
  const prefix = new TextDecoder().decode(new Uint8Array(bytes, 0, 9));
  let asciiFaces: number | undefined;
  // Match the loader's binary/ASCII detection, including binary headers which
  // start with "solid". Validate before it allocates from the declared count.
  if (expected === bytes.byteLength || !/^.{0,4}solid/s.test(prefix)) {
    if (count > 2_000_000) throw new Error('This STL exceeds the two-million-triangle browser limit.');
    if (expected !== bytes.byteLength) throw new Error('The binary STL is truncated or its length does not match its triangle count.');
  } else {
    // The display loader tolerates incomplete ASCII solids/facets by skipping
    // them. That is unsafe for an export tool: do not silently lose geometry.
    const text = new TextDecoder().decode(bytes);
    let open = false, solids = 0;
    const body = text.replace(/^\s*(solid|endsolid)\b[^\r\n]*/gm, (_, command: string) => {
      if ((command === 'solid') === open) throw new Error('The ASCII STL has incomplete solid boundaries.');
      open = command === 'solid';
      if (open) solids++;
      return '';
    });
    if (open || !solids) throw new Error('The ASCII STL is truncated or has no complete solids.');
    const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
    const vector = `${number}\\s+${number}\\s+${number}`;
    const facet = new RegExp(`\\bfacet\\s+normal\\s+${vector}\\s+outer\\s+loop(?:\\s+vertex\\s+${vector}){3}\\s+endloop\\s+endfacet\\b`, 'g');
    let faceCount = 0;
    const leftover = body.replace(facet, () => {
      if (++faceCount > 2_000_000) throw new Error('This STL exceeds the two-million-triangle browser limit.');
      return '';
    });
    if (leftover.trim() || !faceCount) throw new Error('The ASCII STL contains an incomplete or invalid triangle.');
    asciiFaces = faceCount;
  }
  const geometry = new STLLoader().parse(bytes);
  const values = geometry.getAttribute('position').array;
  if (!values.length || values.length % 9) throw new Error('The STL contains no usable triangles.');
  if (asciiFaces !== undefined && values.length / 9 !== asciiFaces) throw new Error('The ASCII STL contains triangles outside a complete solid.');
  if (values.length / 9 > 2_000_000) throw new Error('This model exceeds the two-million-triangle browser limit.');
  // STL stores independent triangle corners; 3MF stores shared vertex indices.
  // Weld exact positions only: rounding or a distance tolerance can close real
  // gaps or collapse small features. Retain face positions and winding.
  const vertices: number[] = [], triangles: number[] = [], indices = new Map<string, number>();
  for (let i = 0; i < values.length; i += 3) {
    const x = values[i], y = values[i + 1], z = values[i + 2];
    if (![x,y,z].every(n => Number.isFinite(n) && Math.abs(n) <= 1e6)) {
      geometry.dispose();
      throw new Error('The STL contains invalid or excessively large coordinates.');
    }
    const key = `${x},${y},${z}`;
    let index = indices.get(key);
    if (index === undefined) {
      index = vertices.length / 3;
      indices.set(key, index); vertices.push(x,y,z);
    }
    triangles.push(index);
  }
  geometry.dispose();
  const faces: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i], b = triangles[i+1], c = triangles[i+2];
    // Match the slicer's STL cleanup for collapsed corners. Collinear faces
    // with three distinct vertices can still connect neighbouring mesh edges.
    if (a === b || b === c || c === a) continue;
    faces.push(a,b,c);
  }
  if (!faces.length) throw new Error('The STL contains no nondegenerate triangles.');
  const mesh = splitTouchingShells({ vertices, triangles: faces });
  let minZ = Infinity;
  for (let i = 2; i < mesh.vertices.length; i += 3) minZ = Math.min(minZ, mesh.vertices[i]);
  for (let i = 2; i < mesh.vertices.length; i += 3) mesh.vertices[i] -= minZ;
  return mesh;
}

/** An STL can have closed shells meeting on an identical edge. A global weld
 * gives that edge four incident faces, which is invalid 3MF topology. Recover
 * shells through unambiguous edges and keep their coincident vertices separate.
 * This does not move vertices, fill holes, or repair genuinely open surfaces.
 */
function splitTouchingShells(mesh: Mesh): Mesh {
  const t=mesh.triangles, vertexCount=mesh.vertices.length/3;
  const key=(a: number,b: number) => Math.min(a,b)*vertexCount+Math.max(a,b);
  // First corner >=0; exactly two faces encoded as -(first corner+1); >2 as NaN.
  const edges=new Map<number,number>();
  let ambiguous=false;
  for(let i=0;i<t.length;i+=3) for(let j=0;j<3;j++) {
    const k=key(t[i+j],t[i+(j+1)%3]), prior=edges.get(k);
    if(prior === undefined) edges.set(k,i+j);
    else if(prior >= 0) edges.set(k,-prior-1);
    else { edges.set(k,NaN); ambiguous=true; }
  }
  if(!ambiguous) return compactMesh(mesh);
  const parents=Int32Array.from({length:t.length/3},(_,i)=>i);
  const find=(n: number): number => {
    while(parents[n] !== n) { parents[n]=parents[parents[n]]; n=parents[n]; }
    return n;
  };
  for(let i=0;i<t.length;i+=3) for(let j=0;j<3;j++) {
    const first=edges.get(key(t[i+j],t[i+(j+1)%3]))!;
    if(first < 0) parents[find(i/3)]=find(Math.floor((-first-1)/3));
  }
  const vertices: number[]=[], triangles: number[]=[], indices=new Map<number,number>();
  for(let i=0;i<t.length;i++) {
    const k=t[i]*parents.length+find(Math.floor(i/3));
    let next=indices.get(k);
    if(next === undefined) { next=vertices.length/3; indices.set(k,next); vertices.push(...mesh.vertices.slice(t[i]*3,t[i]*3+3)); }
    triangles.push(next);
  }
  return {vertices,triangles};
}

export function compactMesh(mesh: Mesh): Mesh {
  const map = new Map<number, number>(), vertices: number[] = [];
  const triangles = mesh.triangles.map(index => {
    let next = map.get(index);
    if (next === undefined) { next = vertices.length / 3; map.set(index,next); vertices.push(...mesh.vertices.slice(index*3,index*3+3)); }
    return next;
  });
  return { vertices, triangles };
}

/** Half-open plane intersections: horizontal faces contribute no segments.
 * Edge direction follows the oriented surface, retaining holes and nested islands.
 * Do not silently close broken contours: an open mesh needs repair in the slicer.
 */
export function sliceMesh(mesh: Mesh, z: number): Rings {
  const segments: { a: Point; b: Point; ak: string; bk: string }[] = [];
  const key = (p: Point) => `${Math.round(p.x * 100000)},${Math.round(p.y * 100000)}`;
  const v = mesh.vertices, t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const indices = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
    const points: Point[] = [];
    for (let j = 0; j < 3; j++) {
      const a = indices[j], b = indices[(j + 1) % 3];
      if ((v[a + 2] < z) === (v[b + 2] < z)) continue;
      const f = (z - v[a + 2]) / (v[b + 2] - v[a + 2]);
      points.push({ x: v[a] + (v[b] - v[a]) * f, y: v[a + 1] + (v[b + 1] - v[a + 1]) * f });
    }
    if (points.length !== 2 || key(points[0]) === key(points[1])) continue;
    const [a, b, c] = indices;
    const nx = (v[b + 1] - v[a + 1]) * (v[c + 2] - v[a + 2]) - (v[b + 2] - v[a + 2]) * (v[c + 1] - v[a + 1]);
    const ny = (v[b + 2] - v[a + 2]) * (v[c] - v[a]) - (v[b] - v[a]) * (v[c + 2] - v[a + 2]);
    if ((points[1].x - points[0].x) * -ny + (points[1].y - points[0].y) * nx < 0) points.reverse();
    segments.push({ a: points[0], b: points[1], ak: key(points[0]), bk: key(points[1]) });
  }
  const starts = new Map<string, number[]>();
  segments.forEach((s, i) => starts.set(s.ak, [...(starts.get(s.ak) || []), i]));
  const used = new Set<number>(), rings: Rings = [];
  for (let i = 0; i < segments.length; i++) {
    if (used.has(i)) continue;
    const ring: Point[] = [], start = segments[i].ak;
    let cursor = i;
    while (!used.has(cursor)) {
      const s = segments[cursor]; used.add(cursor); ring.push(s.a);
      if (s.bk === start) break;
      const next = starts.get(s.bk)?.find(k => !used.has(k));
      if (next === undefined) throw new Error(`An open or inconsistently oriented contour was found at Z=${z.toFixed(3)} mm. Repair this model in PrusaSlicer and export it again.`);
      cursor = next;
    }
    if (ring.length >= 3 && Math.abs(signedArea(ring)) > 1e-6) rings.push(ring);
  }
  // A wholly inward STL is common; keep holes relative to its dominant shell.
  const dominant = [...rings].sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)))[0];
  if (dominant && signedArea(dominant) < 0) rings.forEach(r => r.reverse());
  return unionPolygons(rings);
}

/** Indexed watertight extrusion, including inner walls. No mesh booleans needed. */
export function extrude(rings: Rings, height: number): Mesh {
  const vertices: number[] = [], triangles: number[] = [];
  for (const polygon of polygonsOf(rings)) {
    const contours = [polygon.outer, ...polygon.holes];
    const points = contours.flat(), base = vertices.length / 3, n = points.length;
    points.forEach(p => vertices.push(p.x, p.y, 0));
    points.forEach(p => vertices.push(p.x, p.y, height));
    const faces = conformingCaps(contours, ShapeUtils.triangulateShape(polygon.outer.map(p => new Vector2(p.x, p.y)), polygon.holes.map(r => r.map(p => new Vector2(p.x, p.y)))));
    for (const face of faces) {
      let [a, b, c] = face;
      if ((points[b].x - points[a].x) * (points[c].y - points[a].y) - (points[b].y - points[a].y) * (points[c].x - points[a].x) < 0) [b, c] = [c, b];
      triangles.push(base + a, base + c, base + b, base + a + n, base + b + n, base + c + n);
    }
    let offset = 0;
    for (const ring of contours) {
      for (let i = 0; i < ring.length; i++) {
        const a = base + offset + i, b = base + offset + (i + 1) % ring.length;
        triangles.push(a, b, b + n, a, b + n, a + n);
      }
      offset += ring.length;
    }
  }
  return { vertices, triangles };
}

/** Earcut can omit a collinear point where it bridges a hole to the outside.
 * Its triangles cover the right area, but a long edge can then meet two shorter
 * edges (a T-junction). Split those edges at the existing contour vertices so
 * the caps and walls share the same indexed topology, without moving points.
 */
function conformingCaps(contours: Rings, input: number[][]): number[][] {
  const points = contours.flat(), n = points.length;
  const key = (a: number, b: number) => Math.min(a,b)*n + Math.max(a,b);
  const boundary = new Map<number, number>();
  let offset = 0;
  for (const ring of contours) {
    for (let i=0;i<ring.length;i++) {
      const a = offset+i, b = offset+(i+1)%ring.length;
      boundary.set(key(a,b), a < b ? 1 : -1);
    }
    offset += ring.length;
  }
  const faces = input.map(([a,b,c]) => {
    const cross = (points[b].x-points[a].x)*(points[c].y-points[a].y)-(points[b].y-points[a].y)*(points[c].x-points[a].x);
    return cross < 0 ? [a,c,b] : [a,b,c];
  });
  const edgeCounts = (triangles: number[][]) => {
    const edges = new Map<number, {count: number; direction: number}>();
    for (const face of triangles) for (let i=0;i<3;i++) {
      const a=face[i], b=face[(i+1)%3], k=key(a,b), edge=edges.get(k) || {count:0,direction:0};
      edge.count++; edge.direction += a < b ? 1 : -1; edges.set(k,edge);
    }
    return edges;
  };
  const splits = new Map<number, number[]>();
  for (const [k,edge] of edgeCounts(faces)) {
    if (edge.count !== 1 || boundary.has(k)) continue;
    const a = Math.floor(k/n), b = k%n, dx=points[b].x-points[a].x, dy=points[b].y-points[a].y;
    const length2=dx*dx+dy*dy;
    const between = points.map((p,i) => ({i,t:((p.x-points[a].x)*dx+(p.y-points[a].y)*dy)/length2}))
      .filter(({i,t}) => i !== a && i !== b && t > 0 && t < 1 && Math.abs(dx*(points[i].y-points[a].y)-dy*(points[i].x-points[a].x)) <= 1e-9*Math.sqrt(length2))
      .sort((a,b) => a.t-b.t).map(p => p.i);
    if (between.length) splits.set(k,between);
  }
  const result: number[][] = [], pending = [...faces];
  while (pending.length) {
    const face = pending.pop()!;
    const side = face.findIndex((a,i) => splits.has(key(a,face[(i+1)%3])));
    if (side === -1) { result.push(face); continue; }
    const a=face[side], b=face[(side+1)%3], c=face[(side+2)%3], between=splits.get(key(a,b))!;
    const chain=[a,...(a < b ? between : [...between].reverse()),b];
    for (let i=1;i<chain.length;i++) pending.push([chain[i-1],chain[i],c]);
  }
  const edges = edgeCounts(result);
  if ([...boundary.keys()].some(k => !edges.has(k)) || [...edges].some(([k,e]) => boundary.has(k) ? e.count !== 1 || e.direction !== boundary.get(k) : e.count !== 2 || e.direction !== 0)) {
    throw new Error('Could not create a closed brim mesh for this outline. Try a different gap or width.');
  }
  return result;
}
