import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importProject, exportProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { formats, transforms, transformedFixture, serializedParts } from './transformed-fixtures';

const executables = {
  prusa:process.env.PRUSA_SLICER || 'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe',
  prusa3:process.env.PRUSA_SLICER3 || resolve('.local/prusa3/PrusaSlicer-3.0.0-alpha12/PrusaSlicer.exe'),
  bambu:process.env.BAMBU_STUDIO || resolve('.local/bambu/bambu-studio.exe'),
  orca:process.env.ORCA_SLICER || resolve('.local/orca/orca-slicer.exe'),
};
for (const format of formats) describe.skipIf(!existsSync(executables[format]))(`${format} native transformed shared instances`, () => {
  it('reopens independent full brims without changing their height or shape', () => {
    const dir = resolve(`.local/transformed-validation/${format}`); mkdirSync(dir,{recursive:true});
    // Fit this native validation model inside the smallest fixture's 180 mm bed.
    const cases = transforms.map((c,i) => ({...c,matrix:c.matrix.split(' ').map((v,j) => j === 9 ? String(30+(i%3)*55) : j === 10 ? String(25+Math.floor(i/3)*55) : v).join(' ')}));
    const input = transformedFixture(format,cases), p = importProject('shared.3mf',input.slice().buffer);
    const height = 0.3, result = generateBrims(p,{...DEFAULT_BRIM,height}), output = exportProject(p,result);
    const source = resolve(dir,'brims.3mf'), saved = resolve(dir,'reopened.3mf');
    writeFileSync(source,output); rmSync(saved,{force:true});
    const args = format === 'bambu' || format === 'orca' ? ['--arrange','0','--export-3mf',saved,source] : [
      ...(format === 'prusa3' ? ['--datadir',resolve(dir,'data'),'--no-ensure-on-bed'] : []),
      '--export-3mf','--dont-arrange','--output',saved,source,
    ];
    execFileSync(executables[format],args,{cwd:dir,windowsHide:true,timeout:60000,stdio:'pipe'});
    expect(existsSync(saved)).toBe(true);
    const actual = serializedParts(readFileSync(saved),format), expected = serializedParts(output,format);
    expect(actual).toHaveLength(cases.length);
    const points = (faces:number[][][]) => [...new Set(faces.flat().map(p => p.map(v => Math.round(v*1000)).join(',')))].sort();
    // Prusa 2 may reorder independent objects when saving the project.
    const remaining = [...expected];
    actual.forEach(object => {
      const index = remaining.findIndex(o => JSON.stringify(points(o.body)) === JSON.stringify(points(object.body)));
      expect(index).toBeGreaterThanOrEqual(0);
      const original = remaining.splice(index,1)[0];
      expect(points(object.brim)).toEqual(points(original.brim));
      expect(Math.min(...object.brim.flat().map(p => p[2]))).toBeCloseTo(0,4);
      expect(Math.max(...object.brim.flat().map(p => p[2]))).toBeCloseTo(height,4);
    });
    expect(remaining).toHaveLength(0);
  },90000);
});
