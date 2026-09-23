import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { importProject, exportProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { boundsOf, totalArea } from '../src/core/geometry';
import { sliceMesh } from '../src/core/mesh';
import { DEFAULT_BRIM, type Mesh } from '../src/core/types';
import { box } from './fixtures';

function obj(meshes: Mesh[]) {
  let offset=0;
  return meshes.map((m,j) => {
    const vertices=Array.from({length:m.vertices.length/3},(_,i)=>`v ${m.vertices.slice(i*3,i*3+3).join(' ')}`).join('\n');
    const faces=Array.from({length:m.triangles.length/3},(_,i)=>`g face-${i}\nf ${m.triangles.slice(i*3,i*3+3).map(n=>n+offset+1).join(' ')}`).join('\n');
    offset+=m.vertices.length/3;
    return `o Body ${j+1}\n${vertices}\n${faces}`;
  }).join('\n');
}
const load=(text:string) => importProject('example.obj',strToU8(text).slice().buffer);
function closedVolume(mesh: Mesh) {
  const edges=new Map<string,number>(); let volume=0;
  for(let i=0;i<mesh.triangles.length;i+=3) {
    const ids=mesh.triangles.slice(i,i+3), [a,b,c]=ids.map(n=>mesh.vertices.slice(n*3,n*3+3));
    volume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
    for(let j=0;j<3;j++) { const key=[ids[j],ids[(j+1)%3]].sort((a,b)=>a-b).join(','); edges.set(key,(edges.get(key)||0)+1); }
  }
  expect([...edges.values()].every(n=>n===2)).toBe(true);
  return volume;
}
describe('OBJ import', () => {
  it('preserves named objects, shared indices and face groups through independent brim exports', () => {
    const p=load(obj([box(),box(70,20)]));
    expect(p.objects.map(o=>o.name)).toEqual(['Body 1','Body 2']);
    for(const o of p.objects) { expect(o.parts[0].mesh.vertices).toHaveLength(24); expect(closedVolume(o.parts[0].mesh)).toBeCloseTo(4000,5); }
    const result=generateBrims(p,DEFAULT_BRIM), bytes=exportProject(p,result);
    const config=strFromU8(unzipSync(bytes)['Metadata/Slic3r_PE_model.config']);
    expect(config.match(/value="Rolling brim"/g)).toHaveLength(2);
    expect(config.match(/key="elefant_foot_compensation" value="0"/g)).toHaveLength(2);
    const round=importProject('round.3mf',bytes.slice().buffer);
    expect(round.objects.map(o=>boundsOf(sliceMesh(o.parts[0].mesh,0.1)).minX)).toEqual([20,70]);
    expect(generateBrims(p,DEFAULT_BRIM,['object-0']).objects[1].area).toEqual([]);
  });
  it('accepts negative indices, UV/normal references, comments and continued faces without loading materials', () => {
    const mesh=box(), text=obj([mesh]).replace(/^f (.+)$/gm,(_,face:string)=>`f ${face.split(' ').map((v,i)=>`${Number(v)-9}${i===0?'/1/1':i===1?'//1':'/1'}`).join(' \\\n')} # face`);
    const p=load(`mtllib missing-local-file.mtl\nvt 0 0\nvn 0 0 1\nusemtl material\ns 1\n${text}`);
    expect(closedVolume(p.objects[0].parts[0].mesh)).toBeCloseTo(4000,5);
  });
  it('triangulates concave n-gon caps and quads without filling notches or reversing faces', () => {
    const xy=[[0,0],[3,0],[3,1],[1,1],[1,3],[0,3]];
    const vertices=[0,1].flatMap(z=>xy.map(([x,y])=>`v ${x} ${y} ${z}`)).join('\n');
    const sides=xy.map((_,i)=>`f ${i+1} ${(i+1)%6+1} ${(i+1)%6+7} ${i+7}`).join('\n');
    const p=load(`${vertices}\nf 6 5 4 3 2 1\nf 7 8 9 10 11 12\n${sides}`), mesh=p.objects[0].parts[0].mesh;
    expect(closedVolume(mesh)).toBeCloseTo(5,6);
    expect(totalArea(sliceMesh(mesh,0.1))).toBe(5);
    expect(mesh.triangles).toHaveLength(20*3);
  });
  it('grounds the whole scene using referenced geometry and preserves relative Z offsets', () => {
    const a=box(), b=box(70,20);
    for(let i=2;i<a.vertices.length;i+=3) { a.vertices[i]+=5; b.vertices[i]+=7; }
    const p=load(`v 0 0 -100\n${obj([a,b]).replace(/^f (.+)$/gm,(_,s:string)=>`f ${s.split(' ').map(n=>Number(n)+1).join(' ')}`)}`);
    expect(p.objects.map(o=>Math.min(...o.parts[0].mesh.vertices.filter((_,i)=>i%3===2)))).toEqual([0,2]);
  });
  it('treats group-only models as one print object', () => {
    const p=load(obj([box()]).replace(/^o .+\n/m,''));
    expect(p.objects).toHaveLength(1); expect(p.objects[0].name).toBe('example');
  });
  it.each(['v NaN 0 0','v 0 0 0\nf 0 1 1','v 0 0 0\nf 1 2 3','v 0 0 0\nf 1 1','v 0 0 0\np 1','surf 0 1 0 1 1 2 3 4'])('rejects unusable geometry: %s', text => {
    expect(()=>load(text)).toThrow(/OBJ/);
  });
});
