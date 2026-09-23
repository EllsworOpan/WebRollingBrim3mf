import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { importProject, exportProject, selectPlate } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { children, child, xml } from '../src/core/three-mf-xml';
import { boundsOf, totalArea } from '../src/core/geometry';
import { box, stl } from './fixtures';
import { nativeFixture } from './native-fixtures';
const open = (bytes: Uint8Array | ArrayBuffer) => importProject('native.3mf', bytes instanceof Uint8Array ? bytes.slice().buffer : bytes);
const altered = (change: (files: Record<string,Uint8Array>) => void) => { const files = unzipSync(new Uint8Array(nativeFixture())); change(files); return zipSync(files); };

describe('Bambu Studio and OrcaSlicer project adapters', () => {
  it.each(['bambu','orca'])('preserves the checked-in %s native fixture without a slicer installation', format => {
    const original = new Uint8Array(readFileSync(`tests/fixtures/painted-plates-${format}.3mf`));
    const project = open(original);
    expect(project.format).toBe(format); expect(project.plates).toHaveLength(4);
    for (const plate of project.plates!) {
      const p = selectPlate(project,plate.id), result = generateBrims(p,DEFAULT_BRIM), out = exportProject(p,result), round = open(out);
      expect(round.plates).toHaveLength(1);
      expect(round.plates![0].name).toBe(plate.name);
      expect(round.objects).toHaveLength(p.objects.length);
      round.objects.forEach((object,i) => expect(object.parts.slice(0,-1)).toEqual(p.objects[i].parts));
      const inputFiles = unzipSync(original), outputFiles = unzipSync(out);
      for (const [name,bytes] of Object.entries(outputFiles)) if (/^3D\/Objects\/.*\.model$/.test(name)) {
        const before = xml(strFromU8(inputFiles[name])), after = xml(strFromU8(bytes));
        expect(Array.from(after.getElementsByTagName('triangle')).map(t => t.toString())).toEqual(Array.from(before.getElementsByTagName('triangle')).map(t => t.toString()));
      }
    }
  });
  it.each(['BambuStudio','OrcaSlicer'])('reads %s plates with shared painted geometry in plate-local coordinates', format => {
    const p = open(nativeFixture(format));
    expect(p.format).toBe(format === 'BambuStudio' ? 'bambu' : 'orca');
    expect(p.plates?.map(p => p.objectCount)).toEqual([1,3,1,1]);
    for (const id of ['1','2','3']) {
      const selected = selectPlate(p,id), result = generateBrims(selected,DEFAULT_BRIM);
      expect(boundsOf(result.objects[0].footprint)).toEqual({minX:20,minY:20,maxX:40,maxY:40});
      expect(totalArea(result.objects[0].footprint)).toBeCloseTo(375,4);
      expect(selected.objects[0].parts.map(p => p.kind)).toEqual(['ModelPart','NegativeVolume']);
      expect(result.objects[0].area).toEqual(generateBrims(p,DEFAULT_BRIM).objects[0].area);
    }
    expect(p.activePlateId).toBeUndefined();
    expect(selectPlate(p,'4').objects[0].name).toBe('Other plate only');
  });

  it('exports one complete plate, preserves paint and settings, and removes unused geometry and slice caches', () => {
    const p = selectPlate(open(nativeFixture()),'2'), before = structuredClone(p);
    const result = generateBrims(p,DEFAULT_BRIM,[p.objects[0].id]), bytes = exportProject(p,result), files = unzipSync(bytes), round = open(bytes);
    expect(round.plates).toMatchObject([{id:'1',name:'Plate 2',objectCount:3}]);
    expect(round.objects).toHaveLength(2);
    expect(round.objects.map(o => o.parts.length)).toEqual([3,2]);
    round.objects.forEach((o,i) => expect(o.parts.slice(0,2)).toEqual(p.objects[i].parts));
    expect(files['3D/Objects/shared.model']).toEqual(p.source!.files['3D/Objects/shared.model']);
    expect(files['3D/Objects/other.model']).toBeUndefined();
    expect(files['Metadata/opaque.bin']).toEqual(new Uint8Array([2,4,6]));
    expect(Object.keys(files).some(p => /gcode$|plate_2.png|slice_info/.test(p))).toBe(false);
    const config = strFromU8(files['Metadata/model_settings.config']);
    expect(config.match(/key="future_setting" value="keep"/g)).toHaveLength(3);
    expect(config.match(/key="elefant_foot_compensation" value="0"/g)).toHaveLength(2);
    expect(config).toContain('key="wall_loops" value="99"');
    expect(config).toContain('key="gap_infill_speed" value="0"');
    const profile = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
    expect(profile.filament_colour).toEqual(['#FFFFFF','#FF0000']);
    expect(profile.wipe_tower_x).toEqual(['15']);
    expect(profile.elefant_foot_compensation).toBe('0.2');
    expect(strFromU8(files['Metadata/layer_heights_profile.txt'])).toBe('object_id=1|0;0.2;1;0.2;2;0.2\nobject_id=2|0;0.2;1;0.2;2;0.2\nobject_id=3|0;0.2;1;0.2;2;0.2\n');
    expect(strFromU8(files['Metadata/layer_config_ranges.xml'])).not.toContain('>8<');
    expect(strFromU8(files['Metadata/custom_gcode_per_layer.xml'])).toContain('M117 second');
    expect(strFromU8(files['Metadata/custom_gcode_per_layer.xml'])).not.toContain('M117 first');
    expect(p).toEqual(before);
    expect(unzipSync(exportProject(p,result))).toEqual(files);
    mkdirSync('.local',{recursive:true}); writeFileSync('.local/native-seed.3mf',new Uint8Array(nativeFixture())); writeFileSync('.local/native-selected.3mf',bytes);
  });

  it.each(['bambu','orca'] as const)('exports STL as %s multipart objects with equivalent geometry', format => {
    const p = importProject('body.stl',stl(box(20,20,20,20,2))), result = generateBrims(p,DEFAULT_BRIM);
    const output = exportProject(p,result,format), round = open(output);
    expect(round.format).toBe(format);
    expect(round.objects).toHaveLength(1); expect(round.objects[0].parts).toHaveLength(2);
    expect(round.objects[0].parts[0].mesh).toEqual(p.objects[0].parts[0].mesh);
    expect(round.objects[0].parts[1].mesh).toEqual(result.objects[0].mesh);
    mkdirSync('.local',{recursive:true}); writeFileSync(`.local/${format}-generated.3mf`,output);
  });

  it('keeps brim dimensions in final millimetres under mirrored nonuniform parent scaling', () => {
    const p = selectPlate(open(altered(files => { files['3D/3dmodel.model'] = strToU8(strFromU8(files['3D/3dmodel.model']).replace('1 0 0 0 1 0 0 0 1 120 0 0','-1.5 0 0 0 0.75 0 0 0 3 200 0 0')); })),'2');
    const result = generateBrims(p,DEFAULT_BRIM), round = open(exportProject(p,result));
    const brim = round.objects[0].parts.at(-1)!.mesh;
    expect(Math.max(...brim.vertices.filter((_,i) => i%3 === 2))).toBeCloseTo(0.2,8);
    expect(round.objects[0].parts[0]).toEqual(p.objects[0].parts[0]);
  });

  it('rejects missing resources, cycles, unknown extensions and bad plate membership', () => {
    expect(() => open(altered(f => { delete f['3D/Objects/shared.model']; }))).toThrow(/Missing model/);
    expect(() => open(altered(f => { f['3D/3dmodel.model'] = strToU8(strFromU8(f['3D/3dmodel.model']).replace('p:path="/3D/Objects/shared.model" objectid="1"','objectid="3"')); f['Metadata/model_settings.config'] = strToU8(strFromU8(f['Metadata/model_settings.config']).replace('<part id="1"','<part id="3"')); }))).toThrow(/circular/);
    expect(() => open(altered(f => { f['3D/3dmodel.model'] = strToU8(strFromU8(f['3D/3dmodel.model']).replace('requiredextensions="p"','requiredextensions="other"')); }))).toThrow(/extension/);
    expect(() => open(altered(f => { f['Metadata/model_settings.config'] = strToU8(strFromU8(f['Metadata/model_settings.config']).replace('key="instance_id" value="0"','key="instance_id" value="90"')); }))).toThrow(/assignment/);
  });

  it('does not carry mesh resources from an unselected plate in the main model', () => {
    const bytes = exportProject(selectPlate(open(nativeFixture()),'4'),generateBrims(selectPlate(open(nativeFixture()),'4'),DEFAULT_BRIM));
    const files = unzipSync(bytes), root = xml(strFromU8(files['3D/3dmodel.model'])).documentElement;
    expect(children(child(root,'build'),'item')).toHaveLength(1);
    expect(children(child(root,'resources'),'object')).toHaveLength(2);
    expect(files['3D/Objects/shared.model']).toBeUndefined();
    expect(strFromU8(files['Metadata/layer_heights_profile.txt'])).toBe('object_id=1|0;0.1;1;0.1;2;0.1\n');
  });

  it('remaps layer metadata by first build occurrence rather than resource ID', () => {
    const input = altered(files => {
      const doc = xml(strFromU8(files['3D/3dmodel.model'])), build = child(doc.documentElement,'build');
      build.insertBefore(children(build,'item').at(-1)!,build.firstChild);
      files['3D/3dmodel.model'] = strToU8(doc.toString());
    });
    const p = selectPlate(open(input),'4'), files = unzipSync(exportProject(p,generateBrims(p,DEFAULT_BRIM)));
    expect(strFromU8(files['Metadata/layer_heights_profile.txt'])).toBe('object_id=1|0;0.2;1;0.2;2;0.2\n');
    expect(strFromU8(files['Metadata/layer_config_ranges.xml'])).toContain('>4<');
    expect(strFromU8(files['Metadata/layer_config_ranges.xml'])).not.toContain('>8<');
  });

  it('keeps unconfigured original components when adding the first configured brim part', () => {
    const input = altered(files => {
      const doc = xml(strFromU8(files['Metadata/model_settings.config']));
      for (const object of children(doc.documentElement,'object')) children(object,'part').forEach(p => object.removeChild(p));
      files['Metadata/model_settings.config'] = strToU8(doc.toString());
    });
    const p = open(input), round = open(exportProject(p,generateBrims(p,DEFAULT_BRIM)));
    expect(round.objects[0].parts).toHaveLength(3);
    expect(round.objects[0].parts.slice(0,2)).toEqual(p.objects[0].parts);
  });

  it('allows an empty plate selection and subsequent recovery to a populated plate', () => {
    const p = open(altered(files => {
      const doc = xml(strFromU8(files['Metadata/model_settings.config'])), plate = children(doc.documentElement,'plate')[1];
      children(plate,'model_instance').forEach(n => plate.removeChild(n)); files['Metadata/model_settings.config'] = strToU8(doc.toString());
    }));
    const empty = selectPlate(p,'2'); expect(empty.objects).toEqual([]); expect(empty.activePlateId).toBe('2');
    expect(selectPlate(empty,'3').objects).toHaveLength(1);
  });
});
