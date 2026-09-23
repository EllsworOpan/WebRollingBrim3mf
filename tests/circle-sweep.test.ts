import { describe, expect, it } from 'vitest';
import { generateBrims } from '../src/core/brim';
import { boundsOf, containsPoint, polygonsOf, subtractPolygons, totalArea, intersectPolygons } from '../src/core/geometry';
import { extrude } from '../src/core/mesh';
import { DEFAULT_BRIM, type Rings } from '../src/core/types';
import { box, project, rectangle } from './fixtures';

const has = (rings: Rings,x: number,y: number) => polygonsOf(rings).some(p => containsPoint({x,y},p));
describe('full rolling-circle sweep preview', () => {
  it('shows a diameter-wide sweep independently of the actual brim width', () => {
    const p = project([box()]), narrow = generateBrims(p,{...DEFAULT_BRIM,width:2});
    expect(boundsOf(narrow.circleSweep)).toEqual({minX:9.9,minY:9.9,maxX:50.1,maxY:50.1});
    expect(has(narrow.circleSweep,10.5,30)).toBe(true);
    expect(has(narrow.objects[0].area,10.5,30)).toBe(false);
    expect(has(narrow.circleSweep,21,30)).toBe(false);
    const wide = generateBrims(p,{...DEFAULT_BRIM,width:15});
    expect(wide.circleSweep).toEqual(narrow.circleSweep);
    expect(wide.objects[0].areaMm2).toBeGreaterThan(narrow.objects[0].areaMm2);
  });
  it('follows hole and pocket toggles and keeps tight entrances clear', () => {
    const pocket = subtractPolygons([rectangle(20,20,40,40)],[rectangle(30,30,20,20),rectangle(38,49,4,12)]);
    const hole = subtractPolygons([rectangle(80,20,40,40)],[rectangle(90,30,20,20)]);
    const p = project([extrude([...pocket,...hole],2)]);
    const outside = generateBrims(p,DEFAULT_BRIM), pockets = generateBrims(p,{...DEFAULT_BRIM,pockets:true}), holes = generateBrims(p,{...DEFAULT_BRIM,holes:true});
    expect(has(outside.circleSweep,32,40)).toBe(false); expect(has(outside.circleSweep,92,40)).toBe(false);
    expect(has(pockets.circleSweep,32,40)).toBe(true); expect(has(pockets.circleSweep,92,40)).toBe(false);
    expect(has(holes.circleSweep,32,40)).toBe(false); expect(has(holes.circleSweep,92,40)).toBe(true);
    expect(has(pockets.circleSweep,40,56)).toBe(false);
  });
  it('respects object selection, neighbours, and bed edges', () => {
    const p = project([box(),box(44,20)]); p.bed = rectangle(15,15,70,50);
    const result = generateBrims(p,DEFAULT_BRIM,['object-0']);
    expect(boundsOf(result.circleSweep).minX).toBe(15);
    expect(boundsOf(result.circleSweep).minY).toBe(15);
    expect(has(result.circleSweep,42,30)).toBe(false);
    expect(has(result.circleSweep,70,30)).toBe(false);
    expect(totalArea(intersectPolygons(result.circleSweep,result.objects[1].footprint))).toBe(0);
    expect(generateBrims(p,DEFAULT_BRIM,[]).circleSweep).toEqual([]);
  });
});
