import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { exportProject, importProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { boundsOf } from '../src/core/geometry';
import { DEFAULT_BRIM, type ObjectBrim } from '../src/core/types';
import { formats, transforms, transformedFixture, serializedParts, type Faces } from './transformed-fixtures';

const pointKey = (p:number[]) => p.map(v => Math.round(v*1000)).join(',');
function expectBrim(faces:Faces, result:ObjectBrim, height:number) {
  const expected = new Set(Array.from({length:result.mesh.vertices.length/3},(_,i) => pointKey(result.mesh.vertices.slice(i*3,i*3+3))));
  expect(new Set(faces.flatMap(f => f.map(pointKey)))).toEqual(expected);
  const points = faces.flat();
  expect(Math.min(...points.map(p => p[2]))).toBeCloseTo(0,5);
  expect(Math.max(...points.map(p => p[2]))).toBeCloseTo(height,5);
  let volume = 0;
  const edges = new Map<string,number>();
  for (const [a,b,c] of faces) {
    volume += (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
    for (const [p,q] of [[a,b],[b,c],[c,a]]) { const key = [pointKey(p),pointKey(q)].sort().join('|'); edges.set(key,(edges.get(key) || 0)+1); }
  }
  expect(Math.abs(volume)).toBeCloseTo(result.areaMm2*height,3);
  expect(new Set(edges.values())).toEqual(new Set([2]));
}

for (const format of formats) describe(`${format} transformed instances`, () => {
  it.each(transforms.flatMap(c => [0.2,0.3].map(height => ({...c,height}))))('handles a single $name object at $height mm', test => {
    const input = transformedFixture(format,[test]), p = importProject('transformed.3mf',input.slice().buffer);
    const result = generateBrims(p,{...DEFAULT_BRIM,height:test.height});
    const [minX,minY,maxX,maxY] = test.bounds(test.height/2), actual = boundsOf(result.objects[0].footprint);
    // Footprints use a 0.001 mm integer grid; half-grid rounding is expected.
    for (const [key,value] of Object.entries({minX,minY,maxX,maxY})) expect(Math.abs(actual[key as keyof typeof actual]-value)).toBeLessThanOrEqual(0.000501);
    const output = serializedParts(exportProject(p,result),format)[0];
    expect(output.body).toEqual(serializedParts(input,format)[0].body);
    expectBrim(output.brim,result.objects[0],test.height);
  });

  it.each([0.2,0.3])('gives shared meshes independent brims at %s mm and preserves the source between exports', height => {
    const input = transformedFixture(format), p = importProject('shared.3mf',input.slice().buffer), pristine = structuredClone(p);
    const source = serializedParts(input,format);
    for (const selected of [p.objects.map(o => o.id),p.objects.filter((_,i) => i%2 === 0).map(o => o.id),[p.objects[5].id]]) {
      const result = generateBrims(p,{...DEFAULT_BRIM,height},selected), bytes = exportProject(p,result), exported = serializedParts(bytes,format);
      expect(exported).toHaveLength(transforms.length);
      exported.forEach((o,i) => {
        expect(o.body).toEqual(source[i].body);
        if (selected.includes(p.objects[i].id)) expectBrim(o.brim,result.objects[i],height);
        else expect(o.brim).toEqual([]);
      });
      expect(p).toEqual(pristine);
      expect(unzipSync(exportProject(p,result))).toEqual(unzipSync(bytes));
    }
  });
});
