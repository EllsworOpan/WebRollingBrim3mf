import { Matrix4, ShapeUtils, Vector2 } from 'three';
import { compactMesh } from './mesh';
import type { Mesh, Project } from './types';

/** Geometry-only Wavefront OBJ import. Position indices are shared independently
 * of UV/normal indices. Object records define printable objects; face groups and
 * materials must not split a closed surface into separate, open print objects.
 */
export function importObj(name: string, bytes: ArrayBuffer): Project {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\\\r?\n/g, ' ');
  const vertices: number[] = [], objects: { name: string; triangles: number[] }[] = [];
  let current = { name: name.replace(/\.obj$/i, ''), triangles: [] as number[] }, count = 0;
  objects.push(current);
  const fail = (line: number, message: string): never => { throw new Error(`OBJ line ${line}: ${message}`); };
  for (const [lineIndex, raw] of text.split(/\r?\n/).entries()) {
    const line = lineIndex + 1, content = raw.split('#', 1)[0].trim();
    if (!content) continue;
    const [command, ...fields] = content.split(/\s+/);
    if (command === 'v') {
      const xyz = fields.slice(0,3).map(Number);
      if (xyz.length !== 3 || xyz.some(n => !Number.isFinite(n) || Math.abs(n) > 1e6)) fail(line,'Invalid or excessively large vertex coordinates.');
      if (vertices.length / 3 >= 6_000_000) fail(line,'The model exceeds the browser vertex limit.');
      vertices.push(...xyz);
    } else if (command === 'o') {
      const objectName = fields.join(' ') || `Object ${objects.length + 1}`;
      if (!current.triangles.length) current.name = objectName;
      else { current = { name: objectName, triangles: [] }; objects.push(current); }
    } else if (command === 'f') {
      const face = fields.map(corner => {
        const indices = corner.split('/');
        if (indices.length > 3 || !/^[+-]?\d+$/.test(indices[0]) || indices.slice(1).some(s => s !== '' && !/^[+-]?\d+$/.test(s))) fail(line,'Invalid face vertex reference.');
        const value = Number(indices[0]), index = value > 0 ? value - 1 : vertices.length / 3 + value;
        if (value === 0 || !Number.isSafeInteger(index) || index < 0 || index >= vertices.length / 3) fail(line,'A face references a missing vertex.');
        return index;
      });
      if (face.length > 3 && face[0] === face[face.length - 1]) face.pop();
      if (face.length < 3 || face.length > 10000) fail(line,'A polygon must have between 3 and 10,000 corners.');
      count += face.length - 2;
      if (count > 2_000_000) fail(line,'The model exceeds the two-million-triangle browser limit.');
      if (face.length === 3) current.triangles.push(...face);
      else {
        // Project onto the dominant plane, then triangulate concave polygons.
        // A triangle fan would incorrectly fill notches in an OBJ n-gon.
        const normal = [0,0,0];
        for (let i=0;i<face.length;i++) {
          const a=face[i]*3, b=face[(i+1)%face.length]*3;
          normal[0]+=(vertices[a+1]-vertices[b+1])*(vertices[a+2]+vertices[b+2]);
          normal[1]+=(vertices[a+2]-vertices[b+2])*(vertices[a]+vertices[b]);
          normal[2]+=(vertices[a]-vertices[b])*(vertices[a+1]+vertices[b+1]);
        }
        const axis = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
        if (normal[axis] === 0) fail(line,'A polygon has no usable surface. Triangulate it in your modelling app.');
        const points = face.map(i => new Vector2(vertices[i*3+(axis+1)%3], vertices[i*3+(axis+2)%3]));
        const triangles = ShapeUtils.triangulateShape(points, []);
        if (triangles.length !== face.length - 2) fail(line,'A polygon could not be triangulated completely. Triangulate it in your modelling app.');
        for (const triangle of triangles) {
          let [a,b,c] = triangle;
          const cross=(points[b].x-points[a].x)*(points[c].y-points[a].y)-(points[b].y-points[a].y)*(points[c].x-points[a].x);
          if (cross * normal[axis] < 0) [b,c] = [c,b];
          current.triangles.push(face[a],face[b],face[c]);
        }
      }
    } else if (!['g','s','vt','vn','mtllib','usemtl','usemap','l','p'].includes(command)) {
      fail(line,`Unsupported ${command} record. Export a polygon mesh OBJ from your modelling app.`);
    }
  }
  const meshes: { name: string; mesh: Mesh }[] = objects.filter(o => o.triangles.length).map(o => ({name:o.name,mesh:compactMesh({vertices,triangles:o.triangles})}));
  if (!meshes.length) throw new Error('The OBJ contains no polygon faces to print. Export a polygon mesh, rather than curves or points.');
  // One translation preserves the arrangement, including intentional Z offsets.
  let minZ = Infinity;
  for (const {mesh} of meshes) for (let i=2;i<mesh.vertices.length;i+=3) minZ=Math.min(minZ,mesh.vertices[i]);
  for (const {mesh} of meshes) for (let i=2;i<mesh.vertices.length;i+=3) mesh.vertices[i]-=minZ;
  return {
    name, bed: [], warnings: ['OBJ units are assumed to be millimetres and Z is the vertical axis. The whole scene was placed on Z=0, preserving relative placement. Named objects stay separate; face groups remain within their object. Materials, textures, lines and points are not imported.'],
    objects: meshes.map(({name:objectName,mesh},i) => ({id:`object-${i}`,name:objectName,resourceId:String(i+1),buildIndex:i,transform:new Matrix4().toArray(),parts:[{name:objectName,kind:'ModelPart',mesh}]})),
  };
}
