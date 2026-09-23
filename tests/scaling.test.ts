import { describe, expect, it } from 'vitest';
import { importProject, exportProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { boundsOf } from '../src/core/geometry';
import { modelSnapshot } from './painted-fixtures';
import { scaledCases, scaledProject, worldPoint } from './scaled-fixtures';

describe('scaled 3MF model placement and brim dimensions', () => {
  it.each(scaledCases.flatMap(c => [0.2,0.3].map(height => ({...c,layer:height}))))('keeps a $layer mm brim at real dimensions on a $name model', test => {
    const bytes = scaledProject([test]), input = new Uint8Array(bytes);
    const project = importProject('scaled.3mf',bytes), settings = {...DEFAULT_BRIM,height:test.layer};
    const result = generateBrims(project,settings);
    expect(boundsOf(result.objects[0].footprint)).toEqual(test.bounds);
    const source = modelSnapshot(input)[0], output = modelSnapshot(exportProject(project,result))[0];
    expect(output.transform).toBe(source.transform);
    expect(output.parts[0]).toEqual(source.parts[0]);
    expect(output.parts).toHaveLength(2);
    const original = output.parts[0].faces.flatMap(f => f.corners.map(p => worldPoint(p,output.transform)));
    expect(Math.max(...original.map(p => p[2]))).toBeCloseTo(test.height,8);
    const brim = output.parts[1], points = brim.faces.flatMap(f => f.corners.map(p => worldPoint(p,output.transform)));
    expect(brim.settings.name).toBe('Rolling brim');
    expect(Math.min(...points.map(p => p[2]))).toBeCloseTo(0,8);
    expect(Math.max(...points.map(p => p[2]))).toBeCloseTo(test.layer,8);
    const reach = settings.width+settings.gap;
    expect(Math.min(...points.map(p => p[0]))).toBeCloseTo(test.bounds.minX-reach,3);
    expect(Math.max(...points.map(p => p[0]))).toBeCloseTo(test.bounds.maxX+reach,3);
    expect(Math.min(...points.map(p => p[1]))).toBeCloseTo(test.bounds.minY-reach,3);
    expect(Math.max(...points.map(p => p[1]))).toBeCloseTo(test.bounds.maxY+reach,3);
    let volume = 0;
    for (const face of brim.faces) {
      const [a,b,c] = face.corners.map(p => worldPoint(p,output.transform));
      volume += (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
    }
    // Mirrored placements invert raw winding; the physical solid stays equal.
    expect(Math.abs(volume)).toBeCloseTo(result.objects[0].areaMm2*test.layer,5);
  });
});
