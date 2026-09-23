import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateBrims } from '../src/core/brim';
import { boundsOf, classifyRegions, containsPoint, intersectPolygons, polygonsOf, subtractPolygons, totalArea } from '../src/core/geometry';
import { extrude, loadStl, sliceMesh, transformMesh } from '../src/core/mesh';
import { DEFAULT_BRIM } from '../src/core/types';
import { Matrix4 } from 'three';
import { box, project, rectangle } from './fixtures';
const has = (rings: ReturnType<typeof sliceMesh>,x:number,y:number) => polygonsOf(rings).some(p => containsPoint({x,y},p));
const pocket = () => subtractPolygons([rectangle(20,20,40,40)],[rectangle(30,30,20,20),rectangle(38,49,4,12)]);
describe('mesh slicing and solids', () => {
  it('samples a flared base at the layer midpoint, not the bottom or top', () => {
    const mesh = box(0,0,20,20,1);
    for(let i=0;i<mesh.vertices.length;i+=3) if(mesh.vertices[i+2]===1) { mesh.vertices[i] += mesh.vertices[i]===0 ? -1:1; mesh.vertices[i+1] += mesh.vertices[i+1]===0 ? -1:1; }
    const result = generateBrims(project([mesh]),DEFAULT_BRIM).objects[0];
    expect(boundsOf(result.footprint)).toEqual({minX:-0.1,minY:-0.1,maxX:20.1,maxY:20.1});
    expect(result.changeArea).toBeGreaterThan(10);
    expect(result.warnings.join(' ')).toContain('changes shape');
  });
  it('creates a watertight positive-volume solid with a preserved hole', () => {
    const rings = subtractPolygons([rectangle(0,0,20,20)],[rectangle(5,5,10,10)]), mesh = extrude(rings,0.2);
    const edges = new Map<string,number>(); let volume = 0;
    for(let i=0;i<mesh.triangles.length;i+=3) {
      const indices = mesh.triangles.slice(i,i+3); const [a,b,c]=indices.map(n=>mesh.vertices.slice(n*3,n*3+3));
      volume += (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
      for(let j=0;j<3;j++) { const key=[indices[j],indices[(j+1)%3]].sort((a,b)=>a-b).join(','); edges.set(key,(edges.get(key)||0)+1); }
    }
    expect([...edges.values()].every(n=>n===2)).toBe(true); expect(volume).toBeCloseTo(60,5);
    expect(totalArea(sliceMesh(mesh,0.1))).toBeCloseTo(300,3); expect(has(sliceMesh(mesh,0.1),10,10)).toBe(false);
  });
  it('compares a sloping shell with a tiny base offset without changing the brim reference', () => {
    const mesh=box(40,0,20,20,1);
    for(let i=0;i<mesh.vertices.length;i+=3) {
      if(mesh.vertices[i+2]===1) mesh.vertices[i]+=mesh.vertices[i]===40 ? -1 : 1;
      mesh.vertices[i+2]+=0.0018;
    }
    // Another shell is on Z=0, as in a multipart STL. The old 0.001 mm
    // comparison missed the entire second shell, despite its flat base.
    expect(sliceMesh(mesh,0.001)).toEqual([]);
    const result=generateBrims(project([box(0,0),mesh]),DEFAULT_BRIM).objects[1];
    expect(result.bottom.length).toBeGreaterThan(0);
    expect(totalArea(result.top)).toBeGreaterThan(totalArea(result.footprint));
    expect(totalArea(result.footprint)).toBeGreaterThan(totalArea(result.bottom));
    expect(result.footprint).toEqual(sliceMesh(mesh,0.1));
    expect(result.mesh.triangles.length).toBeGreaterThan(0);
  });
  it('does not invent a lower outline for a shell that starts higher within the layer', () => {
    const mesh=box(40,0);
    for(let i=2;i<mesh.vertices.length;i+=3) mesh.vertices[i]+=0.06;
    const result=generateBrims(project([box(0,0),mesh]),DEFAULT_BRIM).objects[1];
    expect(result.bottom).toEqual([]);
    expect(result.top.length).toBeGreaterThan(0);
    expect(result.footprint).toEqual(sliceMesh(mesh,0.1));
  });
  it('rejects broken cross-sections instead of silently closing them', () => {
    const mesh=box(); mesh.triangles.splice(-6); expect(()=>sliceMesh(mesh,0.1)).toThrow(/open|oriented/);
  });
  it('normalizes an STL on the bed and slices the original clearance plate', () => {
    const bytes=readFileSync('examples/clearance-test-plate.stl'); const mesh=loadStl(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    expect(classifyRegions(sliceMesh(mesh,0.1),10).counts).toEqual({outside:1,holes:1,pockets:1});
  });
  it('handles mirrored meshes without losing holes', () => { const mesh=extrude(pocket(),2); expect(totalArea(sliceMesh(transformMesh(mesh,new Matrix4().makeScale(-1,1,1)),0.1))).toBeCloseTo(totalArea(pocket()),2); });
});
describe('rolling-circle geometry retained from the G-code app', () => {
  const mesh=extrude([...pocket(),...subtractPolygons([rectangle(80,20,40,40)],[rectangle(90,30,20,20)])],2);
  it('keeps holes and narrow-entry pockets independent', () => {
    const a=generateBrims(project([mesh]),{...DEFAULT_BRIM,pockets:true}), b=generateBrims(project([mesh]),{...DEFAULT_BRIM,holes:true});
    expect(a.regions).toEqual({outside:1,holes:1,pockets:1});
    expect(has(a.objects[0].area,32,40)).toBe(true); expect(has(a.objects[0].area,92,40)).toBe(false);
    expect(has(b.objects[0].area,32,40)).toBe(false); expect(has(b.objects[0].area,92,40)).toBe(true);
    expect(has(a.objects[0].area,40,56)).toBe(false);
  });
  it('keeps undersized holes empty and width independent from rolling diameter', () => {
    const p=project([extrude(subtractPolygons([rectangle(20,20,40,40)],[rectangle(38,38,4,4)]),2)]);
    const result=generateBrims(p,{...DEFAULT_BRIM,holes:true,pockets:true,width:20,gap:-0.2});
    expect(result.regions.holes).toBe(0); expect(has(result.objects[0].area,40,40)).toBe(false);
    const narrow=generateBrims(p,{...DEFAULT_BRIM,width:2}),wide=generateBrims(p,{...DEFAULT_BRIM,width:7});
    expect(narrow.regions).toEqual(wide.regions); expect(wide.objects[0].areaMm2).toBeGreaterThan(narrow.objects[0].areaMm2);
  });
  it('leaves overlaps unchanged and keeps neighbouring selections independent', () => {
    const p=project([box(20,20),box(44,20)]), result=generateBrims(p,{...DEFAULT_BRIM,diameter:1});
    expect(totalArea(intersectPolygons(result.objects[0].area,result.objects[1].area))).toBeGreaterThan(0);
    expect(result.objects.every(o=>o.areaMm2>0)).toBe(true);
    const selected=generateBrims(p,{...DEFAULT_BRIM,diameter:1},['object-0']);
    expect(selected.objects[1].area).toEqual([]);
    expect(selected.objects[0].area).toEqual(result.objects[0].area);
    expect(totalArea(intersectPolygons(selected.objects[0].area,selected.objects[1].footprint))).toBeGreaterThan(0);
  });
  it('subtracts negative volumes without trimming the outer brim', () => {
    const p=project([box(0,0,40,40)]); p.objects[0].parts.push({name:'Cut',kind:'NegativeVolume',mesh:box(10,10)});
    const result=generateBrims(p,{...DEFAULT_BRIM,holes:true}); expect(has(result.objects[0].footprint,15,15)).toBe(false);
    expect(boundsOf(result.objects[0].area).minX).toBeCloseTo(-5.1,4);
  });
});
