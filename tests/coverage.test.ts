import { describe, expect, it } from 'vitest';
import { generateBrims } from '../src/core/brim';
import { boundsOf, intersectPolygons, subtractPolygons, totalArea } from '../src/core/geometry';
import { extrude } from '../src/core/mesh';
import { DEFAULT_BRIM } from '../src/core/types';
import { box, project, rectangle } from './fixtures';

describe('first-layer footprints without adjacent brim', () => {
  const enclosure = subtractPolygons([rectangle(20,20,80,80)],[rectangle(30,30,60,60)]);
  const island = rectangle(55,55,10,10);
  it.each([-0.5,0,0.1,0.3,5])('accounts for separation gap=%s without falsely marking a brimmed footprint', gap => {
    const result = generateBrims(project([box()]),{...DEFAULT_BRIM,gap});
    expect(result.objects[0].uncovered).toEqual([]);
  });

  it('checks disconnected footprints within one object, including islands enclosed by another shell', () => {
    const p = project([extrude([...enclosure,island],2)]);
    const outside = generateBrims(p,DEFAULT_BRIM);
    const pockets = generateBrims(p,{...DEFAULT_BRIM,pockets:true});
    const holes = generateBrims(p,{...DEFAULT_BRIM,holes:true});
    expect(outside.objects[0].uncovered).toHaveLength(1);
    expect(boundsOf([outside.objects[0].uncovered[0].outer])).toEqual({minX:55,minY:55,maxX:65,maxY:65});
    expect(pockets.objects[0].uncovered).toEqual(outside.objects[0].uncovered);
    expect(holes.objects[0].uncovered).toEqual([]);
  });

  it('checks the actual brim after bed clipping, not the sweep or planned outline', () => {
    const p = project([extrude([rectangle(20,20,20,20),rectangle(80,20,20,20)],2)]);
    p.bed = rectangle(15,15,40,40);
    const result = generateBrims(p,DEFAULT_BRIM).objects[0];
    expect(result.areaMm2).toBeGreaterThan(0);
    expect(result.uncovered).toHaveLength(1);
    expect(boundsOf([result.uncovered[0].outer])).toEqual({minX:80,minY:20,maxX:100,maxY:40});
  });

  it('counts adjacency along part of the boundary without requiring a full surrounding brim', () => {
    const p = project([box()]); p.bed = rectangle(40,20,10,20);
    const result = generateBrims(p,DEFAULT_BRIM).objects[0];
    expect(boundsOf(result.area).minX).toBeGreaterThan(40);
    expect(result.areaMm2).toBeGreaterThan(0);
    expect(result.uncovered).toEqual([]);
  });

  it('keeps unchecked objects uncovered even when another object’s brim overlaps them', () => {
    const p = project([box(),box(44,20)]), result = generateBrims(p,DEFAULT_BRIM,['object-1']);
    expect(totalArea(intersectPolygons(result.objects[0].footprint,result.objects[1].area))).toBeGreaterThan(10);
    expect(result.objects[0].uncovered).toHaveLength(1);
    expect(result.objects[1].uncovered).toEqual([]);
    expect(generateBrims(p,DEFAULT_BRIM).objects.every(o=>o.uncovered.length===0)).toBe(true);
  });

  it('retains holes in uncovered polygons and does not invent footprints for floating objects', () => {
    const p = project([extrude(enclosure,2),box(120,20)]);
    for (let i=2;i<p.objects[1].parts[0].mesh.vertices.length;i+=3) p.objects[1].parts[0].mesh.vertices[i]+=1;
    const result = generateBrims(p,DEFAULT_BRIM,[]);
    expect(result.objects[0].uncovered).toHaveLength(1);
    const uncovered = result.objects[0].uncovered[0];
    expect(uncovered.holes).toHaveLength(1);
    expect(totalArea([uncovered.outer,...uncovered.holes])).toBe(80*80-60*60);
    expect(result.objects[1].uncovered).toEqual([]);
  });
});
