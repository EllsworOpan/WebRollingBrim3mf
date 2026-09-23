import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { generateBrims } from '../src/core/brim';
import { containsPoint, intersectPolygons, polygonsOf, totalArea } from '../src/core/geometry';
import { extrude, sliceMesh, transformMesh } from '../src/core/mesh';
import { exportProject, importProject } from '../src/core/three-mf';
import { DEFAULT_BRIM, type Mesh, type Rings } from '../src/core/types';
import { archive, box, meshXml, project, rectangle, stl } from './fixtures';

const settings = {...DEFAULT_BRIM,diameter:30,width:5};
const has = (rings: Rings,x: number,y: number) => polygonsOf(rings).some(p => containsPoint({x,y},p));
const resource = (id: number,mesh: Mesh) => `<object id="${id}">${meshXml(mesh)}</object>`;

describe('each imported object is an independent brim job', () => {
  it('treats a multipart STL and a 3MF assembly as one object, but separate 3MF build items as separate jobs', () => {
    const left = box(20,20,40,40,2), right = box(80,20,40,40,2);
    const resources = resource(1,left)+resource(2,right);
    const stlProject = importProject('pieces.stl',stl(extrude([rectangle(20,20,40,40),rectangle(80,20,40,40)],2),true));
    const assembly = importProject('parts.3mf',archive(resources+'<object id="3"><components><component objectid="1"/><component objectid="2"/></components></object>','<item objectid="3"/>'));
    const separate = importProject('objects.3mf',archive(resources,'<item objectid="1"/><item objectid="2"/>'));
    expect(stlProject.objects).toHaveLength(1);
    expect(assembly.objects).toHaveLength(1);
    expect(assembly.objects[0].parts).toHaveLength(2);
    expect(separate.objects).toHaveLength(2);
    const a=generateBrims(stlProject,settings), b=generateBrims(assembly,settings), c=generateBrims(separate,settings);
    expect(a.objects[0].area).toEqual(b.objects[0].area);
    expect(has(a.objects[0].area,70,60)).toBe(true);
    for (let i=0;i<2;i++) {
      const alone = generateBrims({...separate,objects:[separate.objects[i]]},settings);
      expect(c.objects[i]).toEqual(alone.objects[0]);
      expect(has(c.objects[i].area,70,60)).toBe(false);
    }
    const out=importProject('result.3mf',exportProject(separate,c).slice().buffer);
    expect(out.objects).toHaveLength(2);
    expect(out.objects.every(o => o.parts.filter(p=>p.name==='Rolling brim').length===1)).toBe(true);
  });

  it.each([
    {diameter:19.9,width:0.1,gap:-0.2}, {diameter:20,width:0.5,gap:0},
    {diameter:20.1,width:5,gap:1}, {diameter:30,width:5,gap:0.1},
    {diameter:30,width:20,gap:0.1}, {diameter:50,width:20,gap:1},
  ])('ignores object order, selection and neighbours at $diameter/$width/$gap', controls => {
    const p=project([box(30,30),transformMesh(box(70,30),new Matrix4().makeRotationZ(0.17)),box(50,70),box(52,33)]);
    const opts={...DEFAULT_BRIM,...controls}, original=structuredClone(p);
    const all=generateBrims(p,opts), reversed=generateBrims({...p,objects:[...p.objects].reverse()},opts);
    for (let i=0;i<p.objects.length;i++) {
      const alone=generateBrims({...p,objects:[p.objects[i]]},opts);
      const selected=generateBrims(p,opts,[p.objects[i].id]);
      expect(all.objects[i]).toEqual(alone.objects[0]);
      expect(reversed.objects.find(o=>o.id===p.objects[i].id)).toEqual(alone.objects[0]);
      expect(selected.objects[i]).toEqual(alone.objects[0]);
      expect(selected.circleSweep).toEqual(alone.circleSweep);
      expect(selected.objects.filter((_,j)=>i!==j).every(o=>!o.mesh.triangles.length)).toBe(true);
    }
    expect(p).toEqual(original);
  });

  it('preserves overlapping brim meshes and brim/model intersections through export', () => {
    const p=importProject('close.3mf',archive(resource(1,box())+resource(2,box(44,20)),'<item objectid="1"/><item objectid="2"/>'));
    const result=generateBrims(p,settings);
    const overlap=totalArea(intersectPolygons(result.objects[0].area,result.objects[1].area));
    const collision=totalArea(intersectPolygons(result.objects[0].area,result.objects[1].footprint));
    expect(overlap).toBeGreaterThan(100);
    expect(collision).toBeGreaterThan(10);
    const restored=importProject('out.3mf',exportProject(p,result).slice().buffer);
    const brims=restored.objects.map(o=>sliceMesh(o.parts.find(p=>p.name==='Rolling brim')!.mesh,0.1));
    expect(totalArea(intersectPolygons(brims[0],brims[1]))).toBeCloseTo(overlap,3);
    expect(totalArea(intersectPolygons(brims[0],sliceMesh(restored.objects[1].parts[0].mesh,0.1)))).toBeCloseTo(collision,3);
    const corners = (mesh: Mesh) => mesh.triangles.map(n=>mesh.vertices.slice(n*3,n*3+3));
    restored.objects.forEach((o,i)=>expect(corners(o.parts[0].mesh)).toEqual(corners(p.objects[i].parts[0].mesh)));
  });

  it('keeps repeated, scaled and mirrored 3MF instances independent with only one selected', () => {
    const input=archive(resource(1,box(0,0,20,20,4)),
      '<item objectid="1" transform="2 0 0 0 2 0 0 0 3 20 20 0"/>'+
      '<item objectid="1" transform="-2 0 0 0 1 0 0 0 0.5 100 20 0"/>');
    const p=importProject('instances.3mf',input), result=generateBrims(p,settings,['object-1']);
    expect(result.objects[1]).toEqual(generateBrims({...p,objects:[p.objects[1]]},settings).objects[0]);
    const out=importProject('out.3mf',exportProject(p,result).slice().buffer);
    expect(out.objects.map(o=>o.parts.filter(p=>p.name==='Rolling brim').length)).toEqual([0,1]);
    const brim=out.objects[1].parts.find(p=>p.name==='Rolling brim')!.mesh;
    expect(totalArea(sliceMesh(brim,0.1))).toBeCloseTo(result.objects[1].areaMm2,3);
    const z=brim.vertices.filter((_,i)=>i%3===2);
    expect(Math.min(...z)).toBe(0); expect(Math.max(...z)).toBeCloseTo(0.2,6);
  });
});
