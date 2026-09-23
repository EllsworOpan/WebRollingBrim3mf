import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { importProject, exportProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { children, child, xml } from '../src/core/three-mf-xml';
import { boundsOf, totalArea } from '../src/core/geometry';
import { box, stl } from './fixtures';
import { nativeFixture } from './native-fixtures';
const open = (bytes: Uint8Array | ArrayBuffer) => importProject('native.3mf', bytes instanceof Uint8Array ? bytes.slice().buffer : bytes);
const altered = (change: (files: Record<string,Uint8Array>) => void) => { const files = unzipSync(new Uint8Array(nativeFixture())); change(files); return zipSync(files); };

describe('Bambu Studio and OrcaSlicer project adapters', () => {
  it.each(['BambuStudio','OrcaSlicer'])('reads all %s build instances in stored coordinates', format => {
    const p = open(nativeFixture(format)), result = generateBrims(p,DEFAULT_BRIM);
    expect(p.format).toBe(format === 'BambuStudio' ? 'bambu' : 'orca');
    expect(p.objects).toHaveLength(5);
    expect(result.objects.map(o=>boundsOf(o.footprint).minX)).toEqual([20,140,175,20,180]);
    expect(result.objects.map(o=>boundsOf(o.footprint).minY)).toEqual([20,20,20,-100,-60]);
    expect(totalArea(result.objects[0].footprint)).toBeCloseTo(375,4);
  });

  it('exports every instance, preserves paint and settings, and removes stale slice caches', () => {
    const p = open(nativeFixture()), before = structuredClone(p);
    const result = generateBrims(p,DEFAULT_BRIM,[p.objects[0].id]), bytes = exportProject(p,result), files = unzipSync(bytes), round = open(bytes);
    expect(round.objects).toHaveLength(5);
    expect(round.objects.map(o => o.parts.length)).toEqual([3,2,2,2,1]);
    round.objects.forEach((o,i) => expect(o.parts.filter(p=>p.name!=='Rolling brim')).toEqual(p.objects[i].parts));
    expect(files['3D/Objects/shared.model']).toEqual(p.source!.files['3D/Objects/shared.model']);
    expect(files['3D/Objects/other.model']).toEqual(p.source!.files['3D/Objects/other.model']);
    expect(files['Metadata/opaque.bin']).toEqual(new Uint8Array([2,4,6]));
    expect(Object.keys(files).some(p => /gcode$|plate_2.png|slice_info/.test(p))).toBe(false);
    const config = strFromU8(files['Metadata/model_settings.config']);
    expect(config.match(/key="future_setting" value="keep"/g)).toHaveLength(5);
    expect(config.match(/key="elefant_foot_compensation" value="0"/g)).toHaveLength(5);
    expect(config).toContain('key="wall_loops" value="99"');
    expect(config).toContain('key="gap_infill_speed" value="0"');
    const profile = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
    expect(profile.filament_colour).toEqual(['#FFFFFF','#FF0000']);
    expect(profile.wipe_tower_x).toEqual(['10','15','20','25']);
    expect(profile.elefant_foot_compensation).toBe('0.2');
    expect(strFromU8(files['Metadata/layer_heights_profile.txt'])).toBe(Array.from({length:5},(_,i)=>`object_id=${i+1}|0;0.2;1;0.2;2;0.2\n`).join('')+'object_id=6|0;0.1;1;0.1;2;0.1\n');
    expect(strFromU8(files['Metadata/layer_config_ranges.xml'])).toContain('>8<');
    expect(strFromU8(files['Metadata/custom_gcode_per_layer.xml'])).toContain('M117 second');
    expect(strFromU8(files['Metadata/custom_gcode_per_layer.xml'])).toContain('M117 first');
    expect(p).toEqual(before);
    expect(unzipSync(exportProject(p,result))).toEqual(files);
  });

  it.each(['bambu','orca'] as const)('exports STL as %s multipart objects with equivalent geometry', format => {
    const p = importProject('body.stl',stl(box(20,20,20,20,2))), result = generateBrims(p,DEFAULT_BRIM);
    const output = exportProject(p,result,format), round = open(output);
    expect(round.format).toBe(format);
    expect(round.objects).toHaveLength(1); expect(round.objects[0].parts).toHaveLength(2);
    expect(round.objects[0].parts[0].mesh).toEqual(p.objects[0].parts[0].mesh);
    expect(round.objects[0].parts[1].mesh).toEqual(result.objects[0].mesh);
  });

  it('rejects missing resources, cycles, unknown extensions and bad plate membership', () => {
    expect(() => open(altered(f => { delete f['3D/Objects/shared.model']; }))).toThrow(/Missing model/);
    expect(() => open(altered(f => { f['3D/3dmodel.model'] = strToU8(strFromU8(f['3D/3dmodel.model']).replace('p:path="/3D/Objects/shared.model" objectid="1"','objectid="3"')); f['Metadata/model_settings.config'] = strToU8(strFromU8(f['Metadata/model_settings.config']).replace('<part id="1"','<part id="3"')); }))).toThrow(/circular/);
    expect(() => open(altered(f => { f['3D/3dmodel.model'] = strToU8(strFromU8(f['3D/3dmodel.model']).replace('requiredextensions="p"','requiredextensions="other"')); }))).toThrow(/extension/);
    expect(() => open(altered(f => { f['Metadata/model_settings.config'] = strToU8(strFromU8(f['Metadata/model_settings.config']).replace('key="instance_id" value="0"','key="instance_id" value="90"')); }))).toThrow(/assignment/);
  });

  it('remaps layer metadata by first build occurrence rather than resource ID', () => {
    const input = altered(files => {
      const doc = xml(strFromU8(files['3D/3dmodel.model'])), build = child(doc.documentElement,'build');
      build.insertBefore(children(build,'item').at(-1)!,build.firstChild);
      files['3D/3dmodel.model'] = strToU8(doc.toString());
    });
    const p = open(input), files = unzipSync(exportProject(p,generateBrims(p,DEFAULT_BRIM)));
    expect(strFromU8(files['Metadata/layer_heights_profile.txt'])).toBe('object_id=1|0;0.2;1;0.2;2;0.2\n'+Array.from({length:5},(_,i)=>`object_id=${i+2}|0;0.1;1;0.1;2;0.1\n`).join(''));
    expect(strFromU8(files['Metadata/layer_config_ranges.xml'])).toContain('>4<');
    expect(strFromU8(files['Metadata/layer_config_ranges.xml'])).toContain('>8<');
  });

  it.each(['unknown_part','constructor','__proto__'])('rejects an unrecognized part role: %s', role => {
    const input = altered(files => { files['Metadata/model_settings.config'] = strToU8(strFromU8(files['Metadata/model_settings.config']).replace('subtype="normal_part"',`subtype="${role}"`)); });
    expect(() => open(input)).toThrow(`Unsupported Bambu/Orca part type: ${role}`);
  });

  it('removes stale caches without deleting similarly named unrelated metadata', () => {
    const keep = ['Metadata/plate_1_notes.json','Metadata/pattern_1_custom.json','Metadata/slice_info.config.backup','Metadata/bbl_thumbnail.png.backup','Auxiliaries/template.gcode.txt'];
    const stale = ['Metadata/plate_1.gcode.md5','Metadata/plate_no_light_1.png','Metadata/top_1.png','Metadata/pattern_1_bbox.json','Metadata/custom-preview.bin'];
    const input = altered(files => {
      for (const path of [...keep,...stale]) files[path] = strToU8(path);
      files['Metadata/model_settings.config'] = strToU8(strFromU8(files['Metadata/model_settings.config']).replace('<plate>','<plate><metadata key="thumbnail_file" value="/Metadata/custom-preview.bin"/>'));
    });
    const p = open(input), files = unzipSync(exportProject(p,generateBrims(p,DEFAULT_BRIM)));
    for (const path of keep) expect(files[path]).toEqual(strToU8(path));
    for (const path of stale) expect(files[path]).toBeUndefined();
    expect(strFromU8(files['Metadata/model_settings.config'])).not.toContain('thumbnail_file');
  });

  it.each(['3D/Objects/shared.model','Metadata/project_settings.config'])('rejects a cache reference to required project data: %s', path => {
    const input = altered(files => { files['Metadata/model_settings.config'] = strToU8(strFromU8(files['Metadata/model_settings.config']).replace('<plate>',`<plate><metadata key="thumbnail_file" value="/${path}"/>`)); });
    const p = open(input), pristine = structuredClone(p);
    expect(() => exportProject(p,generateBrims(p,DEFAULT_BRIM))).toThrow(/cache refers to model or project data/);
    expect(p).toEqual(pristine);
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

  it('preserves empty plates and includes unassigned instances', () => {
    const p = open(altered(files => {
      const doc = xml(strFromU8(files['Metadata/model_settings.config'])), plate = children(doc.documentElement,'plate')[1];
      children(plate,'model_instance').forEach(n => plate.removeChild(n)); files['Metadata/model_settings.config'] = strToU8(doc.toString());
    }));
    expect(p.objects).toHaveLength(5);
    const out = unzipSync(exportProject(p,generateBrims(p,DEFAULT_BRIM)));
    const plates = children(xml(strFromU8(out['Metadata/model_settings.config'])).documentElement,'plate');
    expect(plates).toHaveLength(4); expect(children(plates[1],'model_instance')).toEqual([]);
  });

  it('does not leak a brim into an assembly that references the same build parent', () => {
    const input = altered(files => {
      files['3D/3dmodel.model'] = strToU8(strFromU8(files['3D/3dmodel.model']).replace('p:path="/3D/Objects/other.model" objectid="5"','objectid="3"'));
      files['Metadata/model_settings.config'] = strToU8(strFromU8(files['Metadata/model_settings.config']).replace('<part id="5"','<part id="3"'));
    });
    const p = open(input), output = exportProject(p,generateBrims(p,DEFAULT_BRIM,[p.objects[0].id])), round = open(output);
    expect(round.objects[0].parts.filter(part => part.name === 'Rolling brim')).toHaveLength(1);
    expect(round.objects.at(-1)!.parts).toEqual(p.objects.at(-1)!.parts);
    const parent = (bytes:Uint8Array) => children(child(xml(strFromU8(unzipSync(bytes)['3D/3dmodel.model'])).documentElement,'resources'),'object').find(o => o.getAttribute('id') === '3')!.toString();
    expect(parent(output)).toBe(parent(input));
  });

  it('does not invent plate data when the source has none', () => {
    const input = altered(files => {
      const doc = xml(strFromU8(files['Metadata/model_settings.config']));
      children(doc.documentElement,'plate').forEach(p => doc.documentElement.removeChild(p));
      files['Metadata/model_settings.config'] = strToU8(doc.toString());
      const profile = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
      delete profile.printable_area;
      files['Metadata/project_settings.config'] = strToU8(JSON.stringify(profile));
    });
    const p = open(input), files = unzipSync(exportProject(p,generateBrims(p,DEFAULT_BRIM)));
    expect(p.objects).toHaveLength(5);
    expect(children(xml(strFromU8(files['Metadata/model_settings.config'])).documentElement,'plate')).toEqual([]);
    expect(files['Metadata/project_settings.config']).toEqual(unzipSync(input)['Metadata/project_settings.config']);
  });
});
