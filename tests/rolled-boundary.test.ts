import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { footprint, generateBrims } from '../src/core/brim';
import { boundsOf, containsPoint, polygonsOf, subtractPolygons, totalArea, unionPolygons } from '../src/core/geometry';
import { extrude, sliceMesh } from '../src/core/mesh';
import { exportProject, importProject } from '../src/core/three-mf';
import { DEFAULT_BRIM, type Mesh, type Rings } from '../src/core/types';
import { box, project, rectangle } from './fixtures';

const has = (rings: Rings, x: number, y: number) => polygonsOf(rings).some(p => containsPoint({x,y}, p));
const combined = (result: ReturnType<typeof generateBrims>) => unionPolygons(result.objects.flatMap(o => o.area));
const paired = () => project([extrude([rectangle(20,20,40,40),rectangle(80,20,40,40)],2)]);
const settings = { ...DEFAULT_BRIM, diameter:30, width:5 };
function expectClosed(mesh: Mesh) {
  const edges = new Map<string,number>();
  for (let i=0;i<mesh.triangles.length;i+=3) for (let j=0;j<3;j++) {
    const a=mesh.triangles[i+j], b=mesh.triangles[i+(j+1)%3], key=`${a},${b}`;
    edges.set(key,(edges.get(key) || 0)+1);
  }
  for (const [key,count] of edges) {
    expect(count).toBe(1);
    expect(edges.get(key.split(',').reverse().join(',')),key).toBe(1);
  }
  let volume=0;
  for (let i=0;i<mesh.triangles.length;i+=3) {
    const [a,b,c]=mesh.triangles.slice(i,i+3).map(n=>mesh.vertices.slice(n*3,n*3+3));
    volume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
  }
  return volume;
}

describe('brim measured from the rolled boundary', () => {
  const layouts = [
    [[40,40,0],[80,40,0],[60,80,0]],
    [[40,40,0.2],[80,40,-0.35],[120,40,0.12],[80,80,0.5]],
    [[40,40,0],[80,40,0],[120,40,0],[40,80,0],[80,80,0],[120,80,0]],
  ];
  const edgeCases = layouts.flatMap((layout,i) => [
    [19.9,0.1,-0.2],[20,0.1,-0.2],[20,20,0.1],[20.1,20,1],[30,0.1,-0.2],[50,20,1],
  ].map(([diameter,width,gap]) => ({name:`layout ${i}: ${diameter}/${width}/${gap}`,layout,diameter,width,gap})));
  it.each(edgeCases)('keeps grouped pieces closed near clearance and width limits ($name)', ({layout,diameter,width,gap}) => {
    const rings = layout.map(([x,y,a]) => rectangle(-10,-10,20,20).map(p => ({x:x+p.x*Math.cos(a)-p.y*Math.sin(a),y:y+p.x*Math.sin(a)+p.y*Math.cos(a)})));
    const result = generateBrims(project([extrude(rings,2)]),{...DEFAULT_BRIM,diameter,width,gap});
    const object = result.objects[0];
    expect(object.areaMm2).toBeGreaterThan(0);
    // Check the actual solid volume. Re-slicing would run polygon rounding
    // and simplification again, obscuring the accuracy of a very thin band.
    expect(expectClosed(object.mesh)).toBeCloseTo(object.areaMm2*DEFAULT_BRIM.height,5);
  });

  it.each([-0.2,0,0.1,1])('follows the analytic 30 mm circle across a 20 mm gap with gap=%s', gap => {
    const result = generateBrims(paired(),{...settings,gap}), area = combined(result);
    // A radius-15 circle touches the upper corners (60,60) and (80,60).
    // Its lower arc is the rolled boundary. Measure width along arc normals,
    // independently of Clipper offsets or distances to the original models.
    const centerY = 60 + Math.sqrt(15**2 - 10**2);
    for (const angle of [-35,-20,0,20,35]) for (const distance of [-0.25,0.25,2.5,4.75,5.25]) {
      const radius = 15-gap-distance, radians = angle*Math.PI/180;
      expect(has(area,70+radius*Math.sin(radians),centerY-radius*Math.cos(radians)), `angle=${angle}, distance=${distance}`).toBe(distance>0 && distance<5);
    }
    expect(has(area,70,40)).toBe(false); // Deep in the impassable slot.
    expect(polygonsOf(area)).toHaveLength(1); // One continuous connecting band.
    for (const object of result.objects) {
      expect(object.areaMm2).toBeGreaterThan(0);
      expectClosed(object.mesh);
      expect(totalArea(sliceMesh(object.mesh,0.1))).toBeCloseTo(object.areaMm2,3);
    }
  });

  it.each([13,19,25.5,30])('connects the test plate pieces only within one object at diameter=%s', diameter => {
    const input = importProject('plate.stl',new Uint8Array(readFileSync('examples/clearance-test-plate.stl')).buffer);
    const pieces = polygonsOf(footprint(input.objects[0],0.1));
    expect(pieces).toHaveLength(4);
    const split = project(pieces.map(p => extrude([p.outer,...p.holes],2)));
    const single = generateBrims(input,{...settings,diameter}), separate = generateBrims(split,{...settings,diameter});
    const a = combined(single), b = combined(separate);
    expect(polygonsOf(a)).toHaveLength(diameter<20 ? 4 : 1);
    expect(polygonsOf(b)).toHaveLength(4);
    expect(has(a,70,120)).toBe(diameter>20);
    expect(has(a,61,100)).toBe(diameter<20);
    expect(has(b,70,120)).toBe(false);
    expect(has(b,61,100)).toBe(true);
    for (const object of separate.objects) expectClosed(object.mesh);
    const restored = importProject('brim.3mf',exportProject(split,separate).slice().buffer);
    expect(restored.objects).toHaveLength(4);
    restored.objects.forEach((o,i) => {
      const brim = o.parts.find(p => p.name==='Rolling brim');
      expect(brim).toBeDefined();
      expect(totalArea(sliceMesh(brim!.mesh,0.1))).toBeCloseTo(separate.objects[i].areaMm2,3);
    });
  });

  it('uses the same rolled boundary for the full-circle sweep, independently of brim width', () => {
    const p = paired(), narrow = generateBrims(p,settings), wide = generateBrims(p,{...settings,width:30});
    expect(narrow.circleSweep).toEqual(wide.circleSweep);
    const full = combined(wide);
    expect(totalArea(subtractPolygons(full,wide.circleSweep))+totalArea(subtractPolygons(wide.circleSweep,full))).toBeLessThan(0.01);
    expect(has(narrow.circleSweep,70,60)).toBe(true);
    expect(has(narrow.circleSweep,70,40)).toBe(false);
  });

  it.each([0,1])('generates selected objects exactly as standalone objects (selected=%s)', index => {
    const p = project([box(20,20,40,40,2),box(80,20,40,40,2)]), result = generateBrims(p,settings,[`object-${index}`]);
    const standalone = generateBrims({...p,objects:[p.objects[index]]},settings);
    expect(result.objects[1-index].area).toEqual([]);
    expect(result.objects[index]).toEqual(standalone.objects[0]);
    expect(result.circleSweep).toEqual(standalone.circleSweep);
    expect(has(result.objects[index].area,index===0 ? 121 : 19,40)).toBe(false);
    expectClosed(result.objects[index].mesh);
    expect(generateBrims(p,settings,[]).circleSweep).toEqual([]);
  });

  it('clips the finished connecting band at the bed without adding a brim along the bed edge', () => {
    const p = paired(); p.bed = rectangle(10,10,130,49);
    const result = generateBrims(p,settings), area = combined(result);
    expect(has(area,70,58)).toBe(true);
    expect(boundsOf(area).maxY).toBe(59);
    expect(has(area,70,40)).toBe(false);
    expect(result.objects.some(o => o.warnings.join(' ').includes('clipped'))).toBe(true);
    result.objects.forEach(o => expectClosed(o.mesh));
  });

  it('does not turn the finite calculation frame into a brim at maximum width and gap', () => {
    const result = generateBrims(project([box()]),{...DEFAULT_BRIM,diameter:0.5,width:50,gap:5});
    const area = combined(result);
    expect(polygonsOf(area)).toHaveLength(1);
    expect(boundsOf(area)).toEqual({minX:-35,minY:-35,maxX:95,maxY:95});
    expect(has(area,-30,-30)).toBe(false); // Outside the round corner, inside its bounding box.
  });
});
