import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { exportProject, importProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { children, child, xml, meta } from '../src/core/three-mf-xml';
import { box, stl } from './fixtures';
import { nativeFixture } from './native-fixtures';
import { paintedFaces } from './converted-fixtures';

const dir = resolve('.local/clean-validation');
const programs = {
  prusa:process.env.PRUSA_SLICER || 'C:/Program Files/Prusa3D/PrusaSlicer/prusa-slicer-console.exe',
  prusa3:process.env.PRUSA_SLICER3 || resolve('.local/prusa3/PrusaSlicer-3.0.0-alpha12/PrusaSlicer.exe'),
  bambu:process.env.BAMBU_STUDIO || resolve('.local/bambu/bambu-studio.exe'),
  orca:process.env.ORCA_SLICER || resolve('.local/orca/orca-slicer.exe'),
};
const fixtureNames = {prusa:'painted-prusa',prusa3:'multimaterial-mmu-prusa3-alpha12',bambu:'painted-plates-bambu',orca:'painted-plates-orca'};
const open = (bytes: Uint8Array) => importProject('test.3mf',bytes.slice().buffer);
function reopen(format: keyof typeof programs, input: Uint8Array, name: string) {
  mkdirSync(dir,{recursive:true});
  const path = resolve(dir,`${name}.3mf`), round = resolve(dir,`${name}-round.3mf`);
  writeFileSync(path,input); rmSync(round,{force:true});
  const args = format === 'bambu' || format === 'orca' ? ['--arrange','0','--export-3mf',round,path]
    : [...(format === 'prusa3' ? ['--datadir',resolve(dir,'prusa3-data')] : []),'--export-3mf','--dont-arrange','--no-ensure-on-bed',path,'--output',round];
  const run = spawnSync(programs[format],args,{cwd:dir,windowsHide:true,timeout:60000,encoding:'utf8'});
  expect(run.error).toBeUndefined(); expect(run.status,`${run.stdout}\n${run.stderr}`).toBe(0); expect(existsSync(round)).toBe(true);
  return new Uint8Array(readFileSync(round));
}

for (const format of ['prusa','prusa3','bambu','orca'] as const) it.skipIf(!existsSync(programs[format]))(`reopens clean ${format} with color paint, part roles and brim settings`, () => {
  const p = open(new Uint8Array(readFileSync(`tests/fixtures/${fixtureNames[format]}.3mf`)));
  const exported = exportProject(p,generateBrims(p,DEFAULT_BRIM,[p.objects[0].id]),format,{clean:true});
  const bytes = reopen(format,exported,`clean-${format}`), round = open(bytes), files = unzipSync(bytes);
  expect(round.objects).toHaveLength(p.objects.length);
  expect(round.objects.flatMap(o => o.parts).filter(p => p.name === 'Rolling brim')).toHaveLength(1);
  if (format === 'prusa3') {
    const before = JSON.parse(strFromU8(unzipSync(exported)['Metadata/PrusaSlicer3_project.json']));
    const after = JSON.parse(strFromU8(files['Metadata/PrusaSlicer3_project.json']));
    expect(after.config_containers.map((c: {virtual_extruders:unknown}) => c.virtual_extruders)).toEqual(before.config_containers.map((c: {virtual_extruders:unknown}) => c.virtual_extruders));
    expect(after.config_containers.map((c: {configuration:{project_settings:{extruder_colour:unknown}}}) => c.configuration.project_settings.extruder_colour)).toEqual(before.config_containers.map((c: {configuration:{project_settings:{extruder_colour:unknown}}}) => c.configuration.project_settings.extruder_colour));
    expect(after.objects.flatMap((o: {volumes:{volume_settings:{perimeters?:number}}[]}) => o.volumes).some((v: {volume_settings:{perimeters?:number}}) => v.volume_settings.perimeters === 99)).toBe(true);
    const paint = JSON.parse(strFromU8(files['Metadata/Slic3r_facets_annotation.json']));
    expect(paint.some((p: {mmSegmentationFacets:unknown[]}) => p.mmSegmentationFacets?.length)).toBe(true);
  } else {
    const config = xml(strFromU8(files[format === 'prusa' ? 'Metadata/Slic3r_PE_model.config' : 'Metadata/model_settings.config']));
    const parts = children(config.documentElement,'object').flatMap(o => children(o,format === 'prusa' ? 'volume' : 'part'));
    expect(parts.some(p => meta(p,format === 'prusa' ? 'perimeters' : 'wall_loops') === '99')).toBe(true);
    const paint = Object.entries(files).filter(([p]) => /\.model$/.test(p)).flatMap(([,bytes]) => {
      const doc = xml(strFromU8(bytes));
      return children(child(doc.documentElement,'resources'),'object').flatMap(o => children(o,'mesh')).flatMap(mesh => children(child(mesh,'triangles'),'triangle')).filter(t => t.hasAttribute(format === 'prusa' ? 'slic3rpe:mmu_segmentation' : 'paint_color'));
    });
    expect(paint.length).toBeGreaterThan(0);
  }
},90000);

it.skipIf(!existsSync(programs.prusa3))('opens STL output in Prusa 3 with brim overrides and no embedded profile', () => {
  const p = importProject('body.stl',stl(box())), bytes = exportProject(p,generateBrims(p,DEFAULT_BRIM),'prusa3');
  const round = open(reopen('prusa3',bytes,'stl-prusa3'));
  expect(round.objects[0].parts.map(p => p.name)).toEqual(['body.stl','Rolling brim']);
},90000);

for (const format of ['prusa','prusa3','bambu','orca'] as const) it.skipIf(!existsSync(programs[format]))(`opens a clean conversion in ${format} with painted triangles`, () => {
  const p = format === 'prusa' ? importProject('painted.3mf',nativeFixture()) : open(new Uint8Array(readFileSync('tests/fixtures/painted-prusa.3mf')));
  const result = generateBrims(p,DEFAULT_BRIM,[p.objects[0].id]);
  const bytes = exportProject(p,result,format,{clean:true});
  const reopened = reopen(format,bytes,`converted-${format}`), round = open(reopened), files = unzipSync(reopened);
  expect(round.objects.flatMap(o => o.parts).filter(p => p.name === 'Rolling brim')).toHaveLength(1);
  expect(paintedFaces(reopened)).toEqual(paintedFaces(bytes));
  if (format === 'prusa3') {
    const paint = JSON.parse(strFromU8(files['Metadata/Slic3r_facets_annotation.json']));
    expect(paint.some((p: {mmSegmentationFacets:{dividing:string}[]}) => p.mmSegmentationFacets?.some(f => f.dividing === '4'))).toBe(true);
    const data = JSON.parse(strFromU8(files['Metadata/PrusaSlicer3_project.json']));
    expect(data.objects[0].object_settings.extruder).toBe(JSON.parse(strFromU8(unzipSync(bytes)['Metadata/PrusaSlicer3_project.json'])).objects[0].object_settings.extruder);
    expect(JSON.parse(strFromU8(unzipSync(bytes)['Metadata/PrusaSlicer3_project.json'])).config_containers).toEqual([]);
  } else expect(Object.entries(files).filter(([k]) => k.endsWith('.model')).some(([,b]) => strFromU8(b).includes(format === 'prusa' ? 'slic3rpe:mmu_segmentation="4"' : 'paint_color="4"'))).toBe(true);
},90000);
