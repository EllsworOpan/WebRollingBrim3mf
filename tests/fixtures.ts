import { Matrix4 } from 'three';
import { strToU8, zipSync } from 'fflate';
import { extrude } from '../src/core/mesh';
import type { Mesh, Project, Ring } from '../src/core/types';
export const rectangle = (x: number, y: number, w: number, h: number): Ring => [{ x,y }, { x:x+w,y }, { x:x+w,y:y+h }, { x,y:y+h }];
export const box = (x=20,y=20,w=20,h=20,depth=10) => extrude([rectangle(x,y,w,h)],depth);
export function stl(mesh: Mesh, binary = false): ArrayBuffer {
  if (!binary) return strToU8(`solid fixture\n${Array.from({ length:mesh.triangles.length/3 }, (_,i) => `facet normal 0 0 0\nouter loop\n${mesh.triangles.slice(i*3,i*3+3).map(n => `vertex ${mesh.vertices.slice(n*3,n*3+3).join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n')}\nendsolid fixture`).slice().buffer;
  const buffer = new ArrayBuffer(84 + mesh.triangles.length / 3 * 50), view = new DataView(buffer);
  view.setUint32(80, mesh.triangles.length / 3, true);
  for (let i = 0; i < mesh.triangles.length; i++) for (let j = 0; j < 3; j++) view.setFloat32(84 + Math.floor(i / 3) * 50 + 12 + (i % 3 * 3 + j) * 4, mesh.vertices[mesh.triangles[i]*3+j], true);
  return buffer;
}
export function project(meshes: Mesh[]): Project {
  return { name: 'test.stl', warnings: [], objects: meshes.map((mesh,i) => ({ id:`object-${i}`, name:`Model ${i+1}`, resourceId:String(i+1), buildIndex:i, transform:new Matrix4().toArray(), parts:[{ name:`Body ${i+1}`, kind:'ModelPart', mesh }] })) };
}
export function meshXml(mesh: Mesh): string {
  const v = mesh.vertices, t = mesh.triangles;
  return `<mesh><vertices>${Array.from({ length:v.length/3 },(_,i) => `<vertex x="${v[i*3]}" y="${v[i*3+1]}" z="${v[i*3+2]}"/>`).join('')}</vertices><triangles>${Array.from({ length:t.length/3 },(_,i) => `<triangle v1="${t[i*3]}" v2="${t[i*3+1]}" v3="${t[i*3+2]}"/>`).join('')}</triangles></mesh>`;
}
export function archive(resources: string, build: string, config = '<config/>', extra: Record<string,Uint8Array> = {}, unit = 'millimeter'): ArrayBuffer {
  const bytes = zipSync({ '[Content_Types].xml':strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'), '_rels/.rels':strToU8('<Relationships><Relationship Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'), '3D/3dmodel.model':strToU8(`<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="${unit}"><resources>${resources}</resources><build>${build}</build></model>`), 'Metadata/Slic3r_PE_model.config':strToU8(config), ...extra });
  return bytes.slice().buffer;
}
