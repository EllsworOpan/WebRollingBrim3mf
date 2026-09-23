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
    expect(boundsOf(narrow.circleSweep)).toEqual({minX:10,minY:10,maxX:50,maxY:50});
    expect(has(narrow.circleSweep,10.5,30)).toBe(true);
    expect(has(narrow.objects[0].area,10.5,30)).toBe(false);
    expect(has(narrow.circleSweep,21,30)).toBe(false);
    const wide = generateBrims(p,{...DEFAULT_BRIM,width:15});
    expect(wide.circleSweep).toEqual(narrow.circleSweep);
    expect(wide.objects[0].areaMm2).toBeGreaterThan(narrow.objects[0].areaMm2);
  });
  it.each([-0.5,0,0.3,5])('keeps the circle against the model while shifting a constant-width brim by gap=%s', gap => {
    const p = project([box()]), baseline = generateBrims(p,{...DEFAULT_BRIM,gap:0});
    const result = generateBrims(p,{...DEFAULT_BRIM,gap});
    expect(result.circleSweep).toEqual(baseline.circleSweep);
    expect(result.regions).toEqual(baseline.regions);
    // The right wall is X=40. Sweep starts at the wall; only the brim moves.
    expect(has(result.circleSweep,40.05,30)).toBe(true);
    expect(has(result.circleSweep,39.95,30)).toBe(false);
    const area = result.objects[0].area, inner = 40+gap, outer = inner+DEFAULT_BRIM.width;
    expect(has(area,inner-0.05,30)).toBe(false);
    expect(has(area,inner+0.05,30)).toBe(true);
    expect(has(area,outer-0.05,30)).toBe(true);
    expect(has(area,outer+0.05,30)).toBe(false);
    expect(boundsOf(area).maxX).toBeCloseTo(outer,3);
  });
  it.each([false,true].flatMap(holes=>[false,true].map(pockets=>({holes,pockets}))))('keeps hole/pocket access and the sweep fixed across gaps (holes=$holes, pockets=$pockets)', toggles => {
    const pocket = subtractPolygons([rectangle(20,20,40,40)],[rectangle(30,30,20,20),rectangle(38,49,4,12)]);
    const hole = subtractPolygons([rectangle(80,20,40,40)],[rectangle(90,30,20,20)]);
    const p = project([extrude([...pocket,...hole],2),box(125,20)]);
    const settings = {...DEFAULT_BRIM,...toggles,gap:0};
    const baseline = generateBrims(p,settings,['object-0']);
    expect(baseline.regions).toEqual({outside:2,holes:1,pockets:1});
    expect(boundsOf(baseline.circleSweep).minX).toBe(10);
    expect(has(baseline.circleSweep,32,40)).toBe(toggles.pockets);
    expect(has(baseline.circleSweep,92,40)).toBe(toggles.holes);
    expect(has(baseline.circleSweep,40,56)).toBe(false);
    for (const gap of [-0.5,0.3,5]) {
      const result = generateBrims(p,{...settings,gap},['object-0']);
      expect(result.circleSweep).toEqual(baseline.circleSweep);
      expect(result.regions).toEqual(baseline.regions);
      expect(result.objects[1].area).toEqual([]);
    }
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
  it('respects object selection while ignoring neighbours', () => {
    const p = project([box(),box(44,20)]);
    const result = generateBrims(p,DEFAULT_BRIM,['object-0']);
    expect(boundsOf(result.circleSweep).minX).toBe(10);
    expect(boundsOf(result.circleSweep).minY).toBe(10);
    expect(has(result.circleSweep,42,30)).toBe(true);
    expect(has(result.circleSweep,70,30)).toBe(false);
    expect(totalArea(intersectPolygons(result.circleSweep,result.objects[1].footprint))).toBeGreaterThan(0);
    expect(result.circleSweep).toEqual(generateBrims({...p,objects:[p.objects[0]]},DEFAULT_BRIM).circleSweep);
    expect(generateBrims(p,DEFAULT_BRIM,[]).circleSweep).toEqual([]);
  });
});
