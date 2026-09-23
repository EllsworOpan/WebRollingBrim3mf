import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { importProject, exportProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';

const input=process.env.ROLLING_BRIM_TEST_STL;
const slicer=process.env.PRUSA_SLICER || 'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe';
// Opt-in acceptance check for a private model. Never copy the input into fixtures.
it.skipIf(!input || !existsSync(slicer))('adds a brim to a local STL without introducing slicer mesh repairs', () => {
  mkdirSync('.local',{recursive:true});
  const runInfo = (path: string) => execFileSync(slicer,['--info',path],{encoding:'utf8',timeout:120000});
  const original=runInfo(input!);
  const bytes=readFileSync(input!), p=importProject(basename(input!),bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const result=generateBrims(p,DEFAULT_BRIM), output=resolve('.local',basename(input!).replace(/\.stl$/i,'-rolling-brim.3mf'));
  writeFileSync(output,exportProject(p,result));
  const exported=runInfo(output);
  const stats=(text: string) => Object.fromEntries([...text.matchAll(/^(\w+) = (.+)$/gm)].map(m=>[m[1],m[2].trim()]));
  const before=stats(original), after=stats(exported);
  writeFileSync('.local/local-model-validation.json',JSON.stringify({input,output,before,after,vertices:p.objects[0].parts[0].mesh.vertices.length/3,modelTriangles:p.objects[0].parts[0].mesh.triangles.length/3,brimTriangles:result.objects[0].mesh.triangles.length/3},null,2));
  console.log(JSON.stringify({output,before,after}));
  expect(after.manifold).toBe('yes');
  for(const key of ['degenerate_facets','facets_removed','edges_fixed','facets_reversed','backwards_edges','normals_fixed']) expect(Number(after[key] || 0),key).toBeLessThanOrEqual(Number(before[key] || 0));
},240000);
