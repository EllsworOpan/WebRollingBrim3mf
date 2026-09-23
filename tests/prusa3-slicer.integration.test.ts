import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { importProject, exportProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { child, children, matrix, xml, serialize } from '../src/core/three-mf-xml';
import { boundsOf } from '../src/core/geometry';
import { sliceMesh } from '../src/core/mesh';
import { P3_MODEL, P3_PROJECT } from './prusa3-fixtures';

const executable = process.env.PRUSA_SLICER3 || resolve('.local/prusa3/PrusaSlicer-3.0.0-alpha12/PrusaSlicer.exe');
const dir = resolve('.local/prusa3-validation'), dataDir = resolve(dir,'data');
const path = (name: string) => resolve(dir,name);
const load = (name: string) => importProject(name,new Uint8Array(readFileSync(name)).buffer);
function run(...args: string[]) {
  mkdirSync(dir,{recursive:true});
  const output = args.indexOf('--output');
  if (output >= 0) rmSync(args[output+1],{force:true}); // An alpha CLI failure can exit 0; stale files must not pass.
  const run = spawnSync(executable,['--datadir',dataDir,...args],{cwd:dir,windowsHide:true,encoding:'utf8',timeout:60000,stdio:'pipe'});
  const log = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.error || run.status !== 0) throw new Error(`PrusaSlicer failed: ${run.error ?? run.status}\n${log}`);
  return log;
}
describe.skipIf(!existsSync(executable))('PrusaSlicer 3.0 alpha12 integration', () => {
  it.each(['painted-plates','multimaterial-xl','multimaterial-mmu'])('reopens the entire %s project with all beds and material recipes intact', name => {
    const source = load(resolve(`tests/fixtures/${name}-prusa3-alpha12.3mf`));
    const result = generateBrims(source,DEFAULT_BRIM), output = exportProject(source,result);
    const inputPath = path(`whole-${name}.3mf`), roundPath = path(`whole-${name}-reloaded.3mf`);
    mkdirSync(dir,{recursive:true}); writeFileSync(inputPath,output);
    run('--export-3mf','--dont-arrange','--no-ensure-on-bed',inputPath,'--output',roundPath);
    const round = load(roundPath), before = JSON.parse(strFromU8(unzipSync(output)[P3_PROJECT]));
    const after = JSON.parse(strFromU8(unzipSync(readFileSync(roundPath))[P3_PROJECT]));
    expect(round.objects).toHaveLength(source.objects.length);
    for (const [i,container] of before.config_containers.entries()) {
      expect(after.config_containers[i].beds).toEqual(container.beds);
      expect(after.config_containers[i].configuration).toEqual(container.configuration);
      expect(after.config_containers[i].virtual_extruders).toEqual(container.virtual_extruders);
      expect(after.config_containers[i].preset.materials).toEqual(container.preset.materials);
    }
    for (const [i,o] of round.objects.entries()) {
      expect(o.parts.filter(p => p.name === 'Rolling brim')).toHaveLength(1);
      const bounds = boundsOf(sliceMesh(o.parts[0].mesh,0.1)), old = boundsOf(sliceMesh(source.objects[i].parts[0].mesh,0.1));
      for (const key of ['minX','minY','maxX','maxY'] as const) expect(bounds[key]).toBeCloseTo(old[key],4);
      expect(after.objects[i].object_settings).toEqual(before.objects[i].object_settings);
      expect(after.objects[i].volumes.map((v: {volume_settings:unknown}) => v.volume_settings)).toEqual(before.objects[i].volumes.map((v: {volume_settings:unknown}) => v.volume_settings));
    }
  },90000);

  it.each(['xl','mmu'])('slices physical, blend and gradient brim assignments on %s hardware', kind => {
    const files = unzipSync(readFileSync(`tests/fixtures/multimaterial-${kind}-prusa3-alpha12.3mf`));
    const data = JSON.parse(strFromU8(files[P3_PROJECT])), config = data.config_containers[0].configuration;
    Object.assign(config.printer_settings,{start_gcode:'',end_gcode:'',before_layer_gcode:'',layer_gcode:'G92 E0',binary_gcode:false,use_relative_e_distances:true});
    Object.assign(config.print_settings,{first_layer_height:{value:0.2,is_percent:false},skirts:0,brim_width:0});
    if (config.toolprint_settings.first_layer_height) config.toolprint_settings.first_layer_height = config.toolprint_settings.first_layer_height.map(() => ({value:0.2,is_percent:false}));
    // Make a one-bed slicing fixture, independently of the app's export path.
    const bed = data.config_containers[0].beds[1], model = xml(strFromU8(files[P3_MODEL])), build = child(model.documentElement,'build');
    build.removeChild(child(build,'item')); // Omit the first bed's test box.
    for (const item of children(build,'item')) {
      const m = matrix(item.getAttribute('transform')); m.elements[12]-=bed.position_x; m.elements[13]-=bed.position_y;
      item.setAttribute('transform',m.elements.filter((_,i)=>i%4!==3).join(' '));
    }
    for (const object of data.objects) for (const instance of object.instances || []) instance.ord--;
    data.config_containers[0].beds = [{...bed,position_x:0,position_y:0}];
    files[P3_MODEL] = serialize(model); files[P3_PROJECT] = strToU8(JSON.stringify(data));
    const p = importProject('multi.3mf',zipSync(files).slice().buffer), result = generateBrims(p,DEFAULT_BRIM);
    const inputPath = path(`virtual-${kind}.3mf`), gcodePath = path(`virtual-${kind}.gcode`);
    writeFileSync(inputPath,exportProject(p,result));
    const log = run('--export-gcode','--dont-arrange','--no-ensure-on-bed',inputPath,'--output',gcodePath);
    expect(existsSync(gcodePath),log).toBe(true);
    const areas = result.objects.map(o => ({body:boundsOf(o.footprint),brim:boundsOf(o.area),tools:new Set<number>(),moves:0}));
    let x=0,y=0,z=0,type='',tool=-1;
    for (const line of readFileSync(gcodePath,'utf8').split(/\r?\n/)) {
      if (line.startsWith(';TYPE:')) type=line.slice(6);
      const selection = /^T(\d+)(?:\s|$)/.exec(line); if (selection) tool=Number(selection[1]);
      if (!/^G[01] /.test(line)) continue;
      const fields = Object.fromEntries([...line.matchAll(/([XYZE])([-+]?(?:\d+\.?\d*|\.\d+))/g)].map(m=>[m[1],Number(m[2])]));
      const px=x,py=y; x=fields.X??x; y=fields.Y??y; z=fields.Z??z;
      if (!(fields.E>0) || Math.hypot(x-px,y-py)<0.001) continue;
      const mx=(x+px)/2,my=(y+py)/2;
      for (const a of areas) {
        if (mx<a.brim.minX-0.02 || mx>a.brim.maxX+0.02 || my<a.brim.minY-0.02 || my>a.brim.maxY+0.02) continue;
        if (mx>=a.body.minX-0.02 && mx<=a.body.maxX+0.02 && my>=a.body.minY-0.02 && my<=a.body.maxY+0.02) continue;
        a.moves++; a.tools.add(tool); expect(z).toBeCloseTo(0.2,4); expect(type).toMatch(/perimeter/i);
      }
    }
    for (const area of areas) { expect(area.moves).toBeGreaterThan(50); expect([...area.tools].every(t => t>=0 && t<2)).toBe(true); }
    expect([...areas[0].tools]).toEqual([1]); // Parent uses physical material 2.
  },90000);

  it.each([0.2,0.3])('slices scaled mirrored brims only as perimeters at Z=%s', height => {
    const files = unzipSync(readFileSync('tests/fixtures/box-prusa3-alpha12.3mf')), data = JSON.parse(strFromU8(files[P3_PROJECT]));
    const config = data.config_containers[0].configuration;
    Object.assign(config.printer_settings,{start_gcode:'',end_gcode:'',before_layer_gcode:'',layer_gcode:'G92 E0',binary_gcode:false,use_relative_e_distances:true});
    Object.assign(config.print_settings,{first_layer_height:{value:height,is_percent:false},skirts:0,brim_width:0});
    files[P3_PROJECT] = strToU8(JSON.stringify(data));
    const model = xml(strFromU8(files[P3_MODEL])); child(child(model.documentElement,'build'),'item').setAttribute('transform','-1.5 0 0 0 0.75 0 0 0 3 100 0 0'); files[P3_MODEL] = serialize(model);
    const p = importProject('scaled.3mf',zipSync(files).slice().buffer), result = generateBrims(p,{...DEFAULT_BRIM,height});
    const inputPath = path(`scaled-${height}.3mf`), gcodePath = path(`scaled-${height}.gcode`); writeFileSync(inputPath,exportProject(p,result));
    const log = run('--export-gcode','--dont-arrange','--no-ensure-on-bed',inputPath,'--output',gcodePath);
    expect(existsSync(gcodePath),log).toBe(true);
    const body = boundsOf(result.objects[0].footprint), area = boundsOf(result.objects[0].area);
    let x=0,y=0,z=0,type='',brimMoves=0,modelMoves=0;
    for (const line of readFileSync(gcodePath,'utf8').split(/\r?\n/)) {
      if (line.startsWith(';TYPE:')) type=line.slice(6);
      if (!/^G[01] /.test(line)) continue;
      const fields = Object.fromEntries([...line.matchAll(/([XYZE])([-+]?(?:\d+\.?\d*|\.\d+))/g)].map(m=>[m[1],Number(m[2])]));
      const px=x,py=y; x=fields.X??x; y=fields.Y??y; z=fields.Z??z;
      if (!(fields.E>0) || Math.hypot(x-px,y-py)<0.001) continue;
      const mx=(x+px)/2,my=(y+py)/2;
      if (mx>=body.minX-0.02 && mx<=body.maxX+0.02 && my>=body.minY-0.02 && my<=body.maxY+0.02) { modelMoves++; continue; }
      expect(mx).toBeGreaterThanOrEqual(area.minX-0.02); expect(mx).toBeLessThanOrEqual(area.maxX+0.02);
      expect(my).toBeGreaterThanOrEqual(area.minY-0.02); expect(my).toBeLessThanOrEqual(area.maxY+0.02);
      brimMoves++; expect(z).toBeCloseTo(height,4); expect(type).toMatch(/perimeter/i);
    }
    expect(brimMoves).toBeGreaterThan(100); expect(modelMoves).toBeGreaterThan(100);
  },90000);
});
