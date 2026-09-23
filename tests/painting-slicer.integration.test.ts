import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { exportProject, importProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { MODEL, PAINT, direct, encode, parse, modelSnapshot, paintedSeed } from './painted-fixtures';

const slicer = process.env.PRUSA_SLICER || 'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe';
const iniSettings = (bytes: Uint8Array) => Object.fromEntries(strFromU8(bytes).split(/\r?\n/).flatMap(line => {
  const match = line.match(/^;?\s*([^;=\s]+)\s*=\s*(.*)$/);
  return match ? [[match[1],match[2]]] : [];
}));
const PROFILE = 'Metadata/Slic3r_PE.config';
const AUXILIARY = {
  'Metadata/Slic3r_PE_layer_heights_profile.txt':'object_id=1|0;0.2;5;0.15;10;0.2\n',
  'Metadata/Prusa_Slicer_layer_config_ranges.xml':'<objects><object id="1"><range min_z="2" max_z="4"><option opt_key="perimeters">6</option></range></object></objects>',
};

describe.skipIf(!existsSync(slicer))('PrusaSlicer painting preservation integration', () => {
  it('recognizes all four painting types before and after adding a brim, with all original settings retained', () => {
    mkdirSync('.local/painting',{recursive:true});
    const save = (input: string, output: string) => execFileSync(slicer,['--export-3mf','--output',resolve(output),resolve(input)],{encoding:'utf8',timeout:60000});
    const seedFiles = unzipSync(new Uint8Array(paintedSeed(readFileSync('examples/validation.ini','utf8'))));
    for (const [path,text] of Object.entries(AUXILIARY)) seedFiles[path] = strToU8(text);
    const seed = zipSync(seedFiles);
    writeFileSync('.local/painting/seed.3mf',seed);
    // Let the actual slicer validate and normalize our own tiny painted fixture.
    save('.local/painting/seed.3mf','.local/painting/baseline.3mf');
    // CLI --export-3mf saves geometry/annotations but omits the print profile.
    // Put the fixture's embedded profile back before testing our full export.
    const baselineFiles = unzipSync(readFileSync('.local/painting/baseline.3mf'));
    baselineFiles[PROFILE] = unzipSync(seed)[PROFILE];
    const source = zipSync(baselineFiles);
    writeFileSync('.local/painting/baseline.3mf',source);
    const before = modelSnapshot(source)[0];
    // A control save separates PrusaSlicer's own normalization (such as source
    // reload matrices) from any change introduced by our exporter.
    save('.local/painting/baseline.3mf','.local/painting/control.3mf');
    const controlBytes = readFileSync('.local/painting/control.3mf');
    const control = modelSnapshot(controlBytes)[0];
    expect(before.parts).toHaveLength(6);
    for (const key of PAINT) {
      expect(before.parts.some(p => p.faces.some(f => (f.attributes[key]?.length || 0)>1)),key).toBe(true);
    }
    expect(before.settings).toMatchObject({elefant_foot_compensation:'0.3',xy_size_compensation:'0.07'});
    const project = importProject('painted.3mf',source.slice().buffer);
    const output = exportProject(project,generateBrims(project,DEFAULT_BRIM));
    expect(modelSnapshot(output)[0].parts.slice(0,6)).toEqual(before.parts);
    writeFileSync('.local/painting/with-brim.3mf',output);
    save('.local/painting/with-brim.3mf','.local/painting/reopened.3mf');
    const reopened = readFileSync('.local/painting/reopened.3mf');
    const after = modelSnapshot(reopened)[0];
    expect(after.settings).toEqual({...before.settings,elefant_foot_compensation:'0'});
    expect(after.parts.slice(0,6)).toEqual(control.parts);
    expect(after.transform).toEqual(control.transform);
    expect(after.parts).toHaveLength(7);
    expect(after.parts[6].settings).toMatchObject({name:'Rolling brim',perimeters:'99',fill_density:'0%'});
    expect(after.parts[6].faces.every(f => PAINT.every(key => !(key in f.attributes)))).toBe(true);
    expect(baselineFiles[PROFILE].length).toBeGreaterThan(100);
    expect(unzipSync(output)[PROFILE]).toEqual(baselineFiles[PROFILE]);
    const loadedSettings = (name: string) => {
      const path = resolve(`.local/painting/${name}-profile.ini`);
      execFileSync(slicer,['--save',path,resolve(`.local/painting/${name}.3mf`)],{encoding:'utf8',timeout:60000});
      return iniSettings(readFileSync(path));
    };
    const beforeProfile = loadedSettings('baseline');
    expect(beforeProfile).toMatchObject({
      filament_colour:'#FF0000;#00FF00;#0000FF',extruder_colour:'#FF0000;#00FF00;#0000FF',
      single_extruder_multi_material:'1',nozzle_diameter:'0.4,0.4,0.4',
      elefant_foot_compensation:'0.25',xy_size_compensation:'0.12',
      print_settings_id:'Painting preservation fixture',printer_settings_id:'Test MMU printer',
    });
    expect(loadedSettings('with-brim')).toEqual(beforeProfile);
    for (const path of Object.keys(AUXILIARY)) {
      expect(baselineFiles[path]?.length,path).toBeGreaterThan(20);
      expect(unzipSync(output)[path],path).toEqual(baselineFiles[path]);
      expect(unzipSync(reopened)[path],path).toEqual(unzipSync(controlBytes)[path]);
    }
  },90000);

  it('keeps painted mirrored instances intact when exporting only one instance with a brim', () => {
    mkdirSync('.local/painting',{recursive:true});
    const files = unzipSync(new Uint8Array(paintedSeed(readFileSync('examples/validation.ini','utf8'))));
    const model = parse(files[MODEL]), build = direct(model.documentElement,'build')[0];
    const mirrored = direct(build,'item')[0].cloneNode(true) as Element;
    mirrored.setAttribute('transform','-1 0 0 0 1 0 0 0 1 150 0 0'); build.appendChild(mirrored);
    files[MODEL] = encode(model);
    const save = (name: string, bytes: Uint8Array) => {
      const input = resolve(`.local/painting/${name}.3mf`), saved = resolve(`.local/painting/${name}-saved.3mf`);
      writeFileSync(input,bytes);
      execFileSync(slicer,['--export-3mf','--output',saved,input],{encoding:'utf8',timeout:60000});
      return new Uint8Array(readFileSync(saved));
    };
    // Use native PrusaSlicer instance aliases as the actual app input.
    const source = save('instances-seed',zipSync(files));
    const project = importProject('instances.3mf',source.slice().buffer);
    const mirroredObject = project.objects.find(o => o.transform[0] < 0)!;
    expect(mirroredObject).toBeDefined();
    const output = exportProject(project,generateBrims(project,DEFAULT_BRIM,[mirroredObject.id]));
    const control = modelSnapshot(save('instances-control',source)), actual = modelSnapshot(save('instances-brim',output));
    expect(actual).toHaveLength(2); expect(control).toHaveLength(2);
    actual.forEach(object => {
      const original = control.find(c => c.transform === object.transform)!;
      expect(original).toBeDefined();
      expect(object.settings).toEqual({...original.settings,elefant_foot_compensation:'0'});
      expect(object.parts.slice(0,6)).toEqual(original.parts);
      expect(object.parts).toHaveLength(object.transform.startsWith('-1') ? 7 : 6);
    });
  },90000);
});
