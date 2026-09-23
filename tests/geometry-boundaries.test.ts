import { describe, expect, it } from 'vitest';
import { generateBrims } from '../src/core/brim';
import { exportProject } from '../src/core/three-mf';
import { sampleHeights, formatSampleHeight } from '../src/core/first-layer';
import { boundsOf, subtractPolygons, totalArea } from '../src/core/geometry';
import { extrude, sliceMesh } from '../src/core/mesh';
import { DEFAULT_BRIM, type BrimSettings, type Mesh } from '../src/core/types';
import { box, project, rectangle } from './fixtures';

// Check the exported solid through topology and signed volume, independently
// from the polygon generator. Every directed edge must have one opposite mate.
function solidVolume(mesh: Mesh) {
  const edges = new Map<string, number>();
  let volume = 0;
  for (let i=0;i<mesh.triangles.length;i+=3) {
    const ids = mesh.triangles.slice(i,i+3), [a,b,c] = ids.map(n => mesh.vertices.slice(n*3,n*3+3));
    volume += (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0])) / 6;
    for (let j=0;j<3;j++) {
      const key = `${ids[j]},${ids[(j+1)%3]}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  for (const [key,count] of edges) {
    expect(count).toBe(1);
    expect(edges.get(key.split(',').reverse().join(',')), `Unpaired edge ${key}: ${key.split(',').map(n => mesh.vertices.slice(Number(n)*3,Number(n)*3+3).join('/')).join(' → ')}`).toBe(1);
  }
  return volume;
}

describe('geometry boundaries', () => {
  it.each([
    ['diameter',0], ['diameter',101], ['width',0], ['width',51], ['gap',-0.51], ['gap',5.1],
    ['height',0], ['height',1.01], ['height',Infinity], ['height',NaN], ['perimeters',0], ['perimeters',1000], ['perimeters',1.5],
  ] as [keyof BrimSettings, number][])('rejects %s=%s without producing geometry', (key,value) => {
    expect(() => generateBrims(project([box()]), {...DEFAULT_BRIM,[key]:value})).toThrow(/supported range/);
  });

  it.each([0.05,0.2,1])('keeps cuts inside a %s mm first layer and exports the requested thickness', height => {
    const cuts = sampleHeights(height);
    expect(cuts.bottom).toBeGreaterThan(0);
    expect(cuts.bottom).toBeLessThan(cuts.middle);
    expect(cuts.middle).toBeLessThan(cuts.top);
    expect(cuts.top).toBeLessThan(height);
    expect(Number(formatSampleHeight(cuts.bottom))).toBeCloseTo(cuts.bottom,5);
    const result = generateBrims(project([box()]), {...DEFAULT_BRIM,height}).objects[0];
    expect(solidVolume(result.mesh)).toBeCloseTo(result.areaMm2 * height,5);
    expect(Math.max(...result.mesh.vertices.filter((_,i) => i%3 === 2))).toBe(height);
  });

  it('does not create or export brims when every object is disabled', () => {
    const p = project([box(),box(70,20)]), result = generateBrims(p,DEFAULT_BRIM,[]);
    expect(result.objects.every(o => o.mesh.triangles.length === 0)).toBe(true);
    expect(result.warnings.join(' ')).toContain('No printable brim');
    expect(() => exportProject(p,result)).toThrow(/at least one brim/);
  });

  it('keeps modifiers and support volumes out of the footprint, and explains floating objects', () => {
    const p = project([box(),box(70,20)]);
    for (const kind of ['ParameterModifier','SupportEnforcer','SupportBlocker']) p.objects[0].parts.push({kind,name:kind,mesh:box(-100,-100,200,200)});
    for (let i=2;i<p.objects[1].parts[0].mesh.vertices.length;i+=3) p.objects[1].parts[0].mesh.vertices[i]+=1;
    const result = generateBrims(p,DEFAULT_BRIM);
    expect(boundsOf(result.objects[0].footprint)).toEqual({minX:20,minY:20,maxX:40,maxY:40});
    expect(result.objects[1].area).toEqual([]);
    expect(result.objects[1].warnings.join(' ')).toContain('No footprint');
    expect(() => generateBrims(project([p.objects[1].parts[0].mesh]),DEFAULT_BRIM)).toThrow(/No model intersects/);
  });

  it('preserves nested islands and multiple holes in a closed extrusion', () => {
    const rings = [...subtractPolygons([rectangle(0,0,20,20)],[rectangle(2,2,6,6),rectangle(12,12,6,6)]),rectangle(4,4,2,2)];
    const mesh = extrude(rings,0.2), expectedArea = 400 - 36 - 36 + 4;
    expect(solidVolume(mesh)).toBeCloseTo(expectedArea*0.2,6);
    expect(totalArea(sliceMesh(mesh,0.1))).toBeCloseTo(expectedArea,6);
  });

  it.each([0.5,2,8].flatMap(width => [-0.2,0,0.1,1].map(gap => [width,gap])))('keeps brim solids closed at width=%s, gap=%s', (width,gap) => {
      const height = width === 0.5 ? 0.05 : width === 2 ? 0.2 : 1;
      const result = generateBrims(project([box(-30,10,7,13)]), {...DEFAULT_BRIM,width,gap,height}).objects[0];
      expect(result.areaMm2).toBeGreaterThan(0);
      expect(solidVolume(result.mesh)).toBeCloseTo(result.areaMm2*height,4);
      expect(totalArea(sliceMesh(result.mesh,height/2))).toBeCloseTo(result.areaMm2,3);
  });
});
