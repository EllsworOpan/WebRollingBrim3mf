import { describe, expect, it } from 'vitest';
import { generateBrims } from '../src/core/brim';
import { subtractPolygons } from '../src/core/geometry';
import { maximizeDiameter } from '../src/core/maximize-diameter';
import { extrude } from '../src/core/mesh';
import { DEFAULT_BRIM, MAX_DIAMETER, MIN_DIAMETER, type DiameterProgress } from '../src/core/types';
import { box, project, rectangle } from './fixtures';

const island = rectangle(55,55,10,10);
const enclosure = subtractPolygons([rectangle(20,20,80,80)],[rectangle(30,30,60,60)]);
const pocket = (entry = 4) => subtractPolygons([rectangle(20,20,80,80)],[rectangle(30,30,60,60),rectangle(60-entry/2,89,entry,12)]);
const solve = (...args: Parameters<typeof maximizeDiameter>) => {
  const search = maximizeDiameter(...args), progress: DiameterProgress[] = [];
  let step = search.next();
  while (!step.done) { progress.push(step.value); step = search.next(); }
  return { outcome: step.value, progress };
};

describe('maximize rolling diameter', () => {
  it.each([false,true])('respects enclosed holes and leaves inputs unchanged (holes=%s)', holes => {
    const p = project([extrude([...enclosure,island],2)]), settings = {...DEFAULT_BRIM,holes};
    const original = structuredClone({p,settings});
    const {outcome,progress} = solve(p,settings);
    expect({p,settings}).toEqual(original);
    expect(progress[0].diameter).toBe(MIN_DIAMETER);
    if (!holes) {
      expect(outcome).toEqual({status:'no-solution',uncovered:1});
      expect(progress).toHaveLength(1);
    } else {
      expect(outcome.status).toBe('found');
      if (outcome.status !== 'found') throw new Error('Expected a solution');
      expect(outcome.atLimit).toBe(false);
      expect(outcome.result.settings.diameter).toBeCloseTo(29.28,2);
      expect(outcome.result.objects[0].uncovered).toEqual([]);
      expect(generateBrims(p,{...settings,diameter:29.29}).objects[0].uncovered).toHaveLength(1);
    }
  });

  it.each([false,true].flatMap(holes => [false,true].map(pockets => ({holes,pockets}))))('honors independent pocket access (holes=$holes, pockets=$pockets)', toggles => {
    const p = project([extrude([...pocket(),island],2)]), settings = {...DEFAULT_BRIM,...toggles};
    const {outcome,progress} = solve(p,settings);
    if (outcome.status !== 'found') throw new Error('Expected a solution');
    const diameter = outcome.result.settings.diameter;
    expect(diameter).toBe(toggles.pockets ? 29.28 : 3.99);
    expect(outcome.result.settings).toEqual({...settings,diameter});
    expect(outcome.result.objects.every(o=>!o.uncovered.length)).toBe(true);
    expect(generateBrims(p,{...settings,diameter:diameter+0.01}).objects[0].uncovered.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toMatchObject({diameter,stage:'verifying'});
    expect(progress.at(-1)!.checks).toBeLessThanOrEqual(16);
  });

  it('can find a solution below 0.1 mm', () => {
    const p = project([extrude([...pocket(0.08),island],2)]);
    const {outcome} = solve(p,DEFAULT_BRIM);
    if (outcome.status !== 'found') throw new Error('Expected a solution');
    expect(outcome.result.settings.diameter).toBeGreaterThanOrEqual(MIN_DIAMETER);
    expect(outcome.result.settings.diameter).toBeLessThan(0.1);
    expect(outcome.result.objects[0].uncovered).toEqual([]);
  });

  it('reports the cap and ignores unchecked objects that cannot be covered', () => {
    const p = project([extrude([...enclosure,island],2),box(150,20)]);
    const {outcome,progress} = solve(p,DEFAULT_BRIM,['object-1']);
    if (outcome.status !== 'found') throw new Error('Expected a solution');
    expect(outcome.atLimit).toBe(true);
    expect(outcome.result.settings.diameter).toBe(MAX_DIAMETER);
    expect(outcome.result.objects[0].area).toEqual([]);
    expect(outcome.result.objects.every(o=>!o.uncovered.length)).toBe(true);
    expect(progress.at(-1)!.checks).toBe(2);
  });

  it.each([[-0.2,0.5],[0,5],[1,20]])('verifies the actual brim with gap=%s and width=%s', (gap,width) => {
    const p = project([extrude([...pocket(),island],2)]), settings = {...DEFAULT_BRIM,gap,width};
    const {outcome} = solve(p,settings);
    if (outcome.status !== 'found') throw new Error('Expected a solution');
    const expected = generateBrims(p,outcome.result.settings);
    expect(outcome.result.objects).toEqual(expected.objects);
    expect(outcome.result.objects[0].uncovered).toEqual([]);
  });

  it('does not claim success without enabled first-layer footprints', () => {
    expect(solve(project([box()]),DEFAULT_BRIM,[]).outcome).toEqual({status:'no-footprints'});
    const floating = box();
    for (let i=2;i<floating.vertices.length;i+=3) floating.vertices[i]+=1;
    expect(solve(project([floating]),DEFAULT_BRIM).outcome).toEqual({status:'no-footprints'});
  });

  it('shares the supported diameter limits with regular generation', () => {
    const p = project([box()]);
    expect(generateBrims(p,{...DEFAULT_BRIM,diameter:MIN_DIAMETER}).objects[0].uncovered).toEqual([]);
    for (const diameter of [0,MIN_DIAMETER-0.001,MAX_DIAMETER+0.01,NaN]) {
      expect(()=>solve(p,{...DEFAULT_BRIM,diameter})).toThrow('supported range');
      expect(()=>generateBrims(p,{...DEFAULT_BRIM,diameter})).toThrow('supported range');
    }
  });
});
