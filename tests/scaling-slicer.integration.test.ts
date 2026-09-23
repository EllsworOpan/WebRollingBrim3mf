import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importProject, exportProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { boundsOf } from '../src/core/geometry';
import { modelSnapshot } from './painted-fixtures';
import { scaledCases, scaledProject, worldPoint } from './scaled-fixtures';

const slicer = process.env.PRUSA_SLICER || 'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe';
describe.skipIf(!existsSync(slicer))('scaled models through PrusaSlicer', () => {
  it.each([0.2,0.3])('prints the brim only at Z=%s despite different model scale factors', height => {
    mkdirSync('.local/scaling',{recursive:true});
    const file = (name: string) => resolve(`.local/scaling/${height}-${name}`);
    const run = (...args: string[]) => execFileSync(slicer,args,{encoding:'utf8',timeout:60000});
    writeFileSync(file('seed.3mf'),new Uint8Array(scaledProject()));
    run('--export-3mf','--output',file('input.3mf'),file('seed.3mf'));
    const project = importProject('scaled.3mf',new Uint8Array(readFileSync(file('input.3mf'))).buffer);
    const result = generateBrims(project,{...DEFAULT_BRIM,height});
    expect(project.objects).toHaveLength(scaledCases.length);
    writeFileSync(file('output.3mf'),exportProject(project,result));
    run('--export-3mf','--output',file('reopened.3mf'),file('output.3mf'));
    const saved = modelSnapshot(readFileSync(file('reopened.3mf')));
    expect(saved).toHaveLength(scaledCases.length);
    for (const object of saved) {
      const brim = object.parts.find(p => p.settings.name === 'Rolling brim')!;
      expect(brim).toBeDefined();
      const points = brim.faces.flatMap(f => f.corners.map(p => worldPoint(p,object.transform)));
      expect(Math.min(...points.map(p => p[2]))).toBeCloseTo(0,6);
      expect(Math.max(...points.map(p => p[2]))).toBeCloseTo(height,6);
    }
    run('--load',resolve('examples/validation.ini'),'--first-layer-height',String(height),'--dont-arrange','--export-gcode','--output',file('sliced.gcode'),file('output.3mf'));
    const regions = project.objects.map((o,i) => ({name:o.name,body:scaledCases.find(c => c.name === o.name)!.bounds,brim:boundsOf(result.objects[i].area),moves:0}));
    let x=0,y=0,z=0,type='',modelMoves=0;
    for (const line of readFileSync(file('sliced.gcode'),'utf8').split(/\r?\n/)) {
      if (line.startsWith(';TYPE:')) type=line.slice(6);
      if (!/^G[01] /.test(line)) continue;
      const fields = Object.fromEntries([...line.matchAll(/([XYZE])([-+]?(?:\d+\.?\d*|\.\d+))/g)].map(m => [m[1],Number(m[2])]));
      const px=x,py=y; x=fields.X??x; y=fields.Y??y; z=fields.Z??z;
      if (!(fields.E>0) || Math.hypot(x-px,y-py)<0.001) continue;
      const mx=(x+px)/2,my=(y+py)/2;
      if (regions.some(({body:b}) => mx>=b.minX-0.02&&mx<=b.maxX+0.02&&my>=b.minY-0.02&&my<=b.maxY+0.02)) { modelMoves++; continue; }
      const region = regions.find(({brim:b}) => mx>=b.minX-0.02&&mx<=b.maxX+0.02&&my>=b.minY-0.02&&my<=b.maxY+0.02);
      expect(region,`Unexpected extrusion at ${mx}, ${my}, ${z}`).toBeDefined();
      expect(z,region!.name).toBeCloseTo(height,4);
      expect(type).toMatch(/perimeter/i);
      region!.moves++;
    }
    expect(modelMoves).toBeGreaterThan(100);
    for (const region of regions) expect(region.moves,region.name).toBeGreaterThan(20);
  },90000);
});
