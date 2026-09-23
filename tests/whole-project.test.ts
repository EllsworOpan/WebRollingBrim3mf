import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { importProject, exportProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { boundsOf, totalArea } from '../src/core/geometry';
import { children, child, xml, type El } from '../src/core/three-mf-xml';
import { P3_MODEL, P3_PROJECT, P3_PAINT } from './prusa3-fixtures';
import { nativeFixture } from './native-fixtures';

const open = (bytes: Uint8Array) => importProject('project.3mf',bytes.slice().buffer);
const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/${name}.3mf`));
const data = (files: Record<string,Uint8Array>) => JSON.parse(strFromU8(files[P3_PROJECT]));
const placements = (files: Record<string,Uint8Array>, path = P3_MODEL) => children(child(xml(strFromU8(files[path])).documentElement,'build'),'item').map(i => i.getAttribute('transform'));
// Compare global build ordinals, independent of IDs changed by instance splitting.
function plateMembership(files:Record<string,Uint8Array>) {
  const build = children(child(xml(strFromU8(files[P3_MODEL])).documentElement,'build'),'item'), counts = new Map<string,number>();
  const indices = new Map(build.map((item,i) => { const id = item.getAttribute('objectid')!, ordinal = counts.get(id) || 0; counts.set(id,ordinal+1); return [`${id}/${ordinal}`,i]; }));
  const metadata = (node:El) => Object.fromEntries(children(node,'metadata').map(m => [m.getAttribute('key'),m.getAttribute('value')]));
  return children(xml(strFromU8(files['Metadata/model_settings.config'])).documentElement,'plate').map(plate => ({
    metadata:Object.fromEntries(Object.entries(metadata(plate)).filter(([key]) => !/^(?:gcode_file|thumbnail_file|thumbnail_no_light_file|top_file|pick_file|pattern_file|pattern_bbox_file|prediction|weight)$/.test(key))),
    instances:children(plate,'model_instance').map(ref => { const {object_id,instance_id,...opaque} = metadata(ref); return {ordinal:indices.get(`${object_id}/${instance_id}`),opaque}; }),
  }));
}

describe('whole-project editing', () => {
  it.each(['painted-plates-bambu','painted-plates-orca','painted-plates-prusa3-alpha12','multimaterial-xl-prusa3-alpha12','multimaterial-mmu-prusa3-alpha12'])('preserves every plate, placement and original mesh in %s', name => {
    const bytes = fixture(name), source = unzipSync(bytes), p = open(bytes), pristine = structuredClone(p);
    expect(p.objects.length).toBeGreaterThan(1);
    const enabled = p.objects.filter((_,i) => i%2===0).map(o => o.id);
    const result = generateBrims(p,DEFAULT_BRIM,enabled), output = exportProject(p,result), files = unzipSync(output), round = open(output);
    expect(round.objects).toHaveLength(p.objects.length);
    expect(placements(files)).toEqual(placements(source));
    round.objects.forEach((object,i) => {
      expect(object.parts.filter(part => part.name !== 'Rolling brim')).toEqual(p.objects[i].parts);
      expect(object.parts.filter(part => part.name === 'Rolling brim')).toHaveLength(enabled.includes(p.objects[i].id) ? 1 : 0);
    });
    if (p.format === 'prusa3') {
      expect(data(files).config_containers).toEqual(data(source).config_containers);
      expect(data(files).project).toEqual(data(source).project);
      const before = JSON.parse(strFromU8(source[P3_PAINT])), after = JSON.parse(strFromU8(files[P3_PAINT]));
      expect(after).toEqual(expect.arrayContaining(before));
      for (const paint of after) expect(before.map(({id:_id,...value}: Record<string,unknown>) => value)).toContainEqual((({id:_id,...value}) => value)(paint));
    } else {
      expect(plateMembership(files)).toEqual(plateMembership(source));
      for (const [path,bytes] of Object.entries(source)) if (/^3D\/Objects\/.*\.model$/.test(path) || ['Metadata/project_settings.config','Metadata/custom_gcode_per_layer.xml'].includes(path)) expect(files[path]).toEqual(bytes);
    }
    expect(p).toEqual(pristine);
    expect(unzipSync(exportProject(p,result))).toEqual(files);
  });

  it('keeps full brims for shared instances even when they cross a plate edge', () => {
    const files = unzipSync(new Uint8Array(nativeFixture()));
    // Same source mesh, but the second instance sits at its plate's right edge.
    files[P3_MODEL] = strToU8(strFromU8(files[P3_MODEL]).replace('1 0 0 0 1 0 0 0 1 120 0 0','1 0 0 0 1 0 0 0 1 178 0 0'));
    const p = open(zipSync(files)), result = generateBrims(p,DEFAULT_BRIM);
    const first = result.objects.find(o => o.id === 'object-0')!, edge = result.objects.find(o => o.id === 'object-1')!;
    expect(boundsOf(edge.area).maxX).toBeCloseTo(223.1,4);
    expect(totalArea(edge.area)).toBeCloseTo(totalArea(first.area),2);
    const round = open(exportProject(p,result));
    expect(round.objects[0].parts.at(-1)!.mesh).not.toEqual(round.objects[1].parts.at(-1)!.mesh);
  });

  it('copies unfamiliar settings and unrelated sidecars without interpreting them', () => {
    const files = unzipSync(fixture('multimaterial-mmu-prusa3-alpha12')), project = data(files);
    project.config_containers[0].configuration.future_settings = {opaque:['leave',7,null,{nested:true}]};
    project.objects[0].object_settings.future_setting = {value:'retain'};
    project.objects[0].volumes[0].volume_settings.future_material_setting = [1,2,3];
    const painting = JSON.parse(strFromU8(files[P3_PAINT]));
    painting[0].vendor_painting = {version:72,payload:'opaque'};
    files[P3_PAINT] = strToU8(JSON.stringify(painting));
    files['Metadata/vendor-private.bin'] = new Uint8Array([0,255,8,3]);
    files[P3_PROJECT] = strToU8(JSON.stringify(project));
    const p = open(zipSync(files)), out = unzipSync(exportProject(p,generateBrims(p,DEFAULT_BRIM)));
    expect(data(out).config_containers).toEqual(project.config_containers);
    expect(data(out).objects[0].object_settings.future_setting).toEqual({value:'retain'});
    expect(data(out).objects[0].volumes[0].volume_settings.future_material_setting).toEqual([1,2,3]);
    expect(out['Metadata/vendor-private.bin']).toEqual(files['Metadata/vendor-private.bin']);
    expect(JSON.parse(strFromU8(out[P3_PAINT]))).toEqual(expect.arrayContaining(painting));
  });

  it('retains Bambu/Orca plate material sequences, private metadata and unrelated relationships', () => {
    const files = unzipSync(new Uint8Array(nativeFixture()));
    files['Metadata/filament_sequence.json'] = strToU8('{"plate_1":{"sequence":[2,1],"nozzle_sequence":[0,0]},"plate_2":{"sequence":[1,2]}}');
    files['Metadata/model_settings.config'] = strToU8(strFromU8(files['Metadata/model_settings.config']).replace('<assemble>', '<assemble vendor="retained"><vendor_data value="opaque"/>').replace('<plate>', '<plate><metadata key="custom_gcode_setting" value="keep"/>'));
    files['3D/_rels/3dmodel.model.rels'] = strToU8(strFromU8(files['3D/_rels/3dmodel.model.rels']).replace('</Relationships>', '<Relationship Id="private" Target="/Metadata/opaque.bin" Type="urn:private"/></Relationships>'));
    const p = open(zipSync(files)), out = unzipSync(exportProject(p,generateBrims(p,DEFAULT_BRIM)));
    expect(out['Metadata/filament_sequence.json']).toEqual(files['Metadata/filament_sequence.json']);
    expect(out['3D/_rels/3dmodel.model.rels']).toEqual(files['3D/_rels/3dmodel.model.rels']);
    expect(strFromU8(out['Metadata/model_settings.config'])).toContain('<assemble vendor="retained"><vendor_data value="opaque"/>');
    expect(strFromU8(out['Metadata/model_settings.config'])).toContain('key="custom_gcode_setting" value="keep"');
  });
});
