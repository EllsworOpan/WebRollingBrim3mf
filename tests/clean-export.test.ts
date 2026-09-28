import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { exportProject, importProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { children, child, xml } from '../src/core/three-mf-xml';
import { modelSnapshot } from './painted-fixtures';
import { nativeFixture } from './native-fixtures';
import { box, stl } from './fixtures';

const open = (bytes: Uint8Array) => importProject('source.3mf',bytes.slice().buffer);
const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/${name}.3mf`));
const decode = (files: Record<string,Uint8Array>, path: string) => JSON.parse(strFromU8(files[path]));

describe('fresh clean 3MF exports', () => {
  it.each(['painted-prusa','painted-instances-prusa','painted-plates-bambu','painted-plates-orca','painted-plates-prusa3-alpha12','multimaterial-xl-prusa3-alpha12','multimaterial-mmu-prusa3-alpha12'])('retains geometry, roles, placement and selection from %s without changing the checkpoint', name => {
    const files = unzipSync(fixture(name)); files['Metadata/unknown-future-data.bin'] = strToU8('opaque source data');
    const p = open(zipSync(files)), checkpoint = structuredClone(p);
    const result = generateBrims(p,DEFAULT_BRIM,[p.objects[0].id]);
    const out = exportProject(p,result,undefined,{clean:true}), clean = unzipSync(out), round = open(out);
    expect(round.objects).toHaveLength(p.objects.length);
    for (const [i,object] of round.objects.entries()) {
      expect(object.parts.filter(part => part.name !== 'Rolling brim')).toEqual(p.objects[i].parts);
      expect(object.parts.filter(part => part.name === 'Rolling brim')).toHaveLength(i === 0 ? 1 : 0);
    }
    expect(clean['Metadata/unknown-future-data.bin']).toBeUndefined();
    expect(Object.keys(clean).some(path => /thumbnail|layer_heights|layer_config|gcode|cut_information|filament_sequence|slice_info/.test(path))).toBe(false);
    expect(p).toEqual(checkpoint);
    expect(unzipSync(exportProject(p,result,undefined,{clean:true}))).toEqual(clean);
    if (name !== 'painted-instances-prusa') expect(unzipSync(exportProject(p,result))['Metadata/unknown-future-data.bin']).toEqual(files['Metadata/unknown-future-data.bin']);
  });

  it('keeps Prusa 2 color paint on exactly the same ordered corners and removes all other settings/painting', () => {
    const input = fixture('painted-prusa'), p = open(input);
    const output = exportProject(p,generateBrims(p,DEFAULT_BRIM),undefined,{clean:true});
    const before = modelSnapshot(input), after = modelSnapshot(output);
    for (const [i,object] of before.entries()) for (const [j,part] of object.parts.entries()) {
      expect(after[i].parts[j].faces).toEqual(part.faces.map(f => ({corners:f.corners,attributes:Object.fromEntries(Object.entries(f.attributes).filter(([key]) => key === 'slic3rpe:mmu_segmentation'))})));
      expect(after[i].parts[j].settings.extruder).toBe(part.settings.extruder);
      expect(Object.keys(after[i].parts[j].settings).every(k => ['name','volume_type','modifier','extruder'].includes(k))).toBe(true);
    }
    const profile = strFromU8(unzipSync(output)['Metadata/Slic3r_PE.config']);
    expect(profile).toContain('filament_colour'); expect(profile).not.toContain('gcode'); expect(profile).not.toContain('temperature');
    expect(after[0].settings.elefant_foot_compensation).toBe('0');
    expect(after[0].parts.at(-1)!.settings.perimeters).toBe('99');
  });

  it.each(['bambu','orca'] as const)('copies only AMS paint and palette for %s, including shared meshes', format => {
    const p = importProject('source.3mf',nativeFixture(format === 'bambu' ? 'BambuStudio' : 'OrcaSlicer'));
    const files = unzipSync(exportProject(p,generateBrims(p,DEFAULT_BRIM),format,{clean:true}));
    const before = xml(strFromU8(p.source!.files['3D/Objects/shared.model'])), after = xml(strFromU8(files['3D/Objects/shared.model']));
    const faces = (doc: typeof before) => Array.from(doc.getElementsByTagName('triangle')).map(t => Object.fromEntries(Array.from(t.attributes).filter(a => ['v1','v2','v3','paint_color'].includes(a.name)).map(a => [a.name,a.value])));
    expect(faces(after)).toEqual(faces(before));
    expect(strFromU8(files['3D/Objects/shared.model'])).not.toMatch(/paint_support|paint_seam/);
    expect(decode(files,'Metadata/project_settings.config')).toMatchObject({filament_colour:['#FFFFFF','#FF0000']});
    expect(Object.keys(decode(files,'Metadata/project_settings.config')).every(k => ['filament_colour','extruder_colour','flush_volumes_matrix','flush_volumes_vector'].includes(k))).toBe(true);
    expect(strFromU8(files['Metadata/model_settings.config'])).not.toMatch(/future_setting|xy_size_compensation/);
    expect(strFromU8(files['Metadata/model_settings.config'])).toContain('key="wall_loops" value="99"');
  });

  it('retains Prusa 3 color annotations, slot numbers and virtual recipes but drops other annotations and profile settings', () => {
    const input = fixture('multimaterial-mmu-prusa3-alpha12'), p = open(input), files = unzipSync(exportProject(p,generateBrims(p,DEFAULT_BRIM),undefined,{clean:true}));
    const path = 'Metadata/PrusaSlicer3_project.json', original = decode(unzipSync(input),path), clean = decode(files,path);
    for (const [i,c] of clean.config_containers.entries()) {
      expect(c.virtual_extruders).toEqual(original.config_containers[i].virtual_extruders);
      expect(c.configuration.project_settings).toEqual({extruder_colour:original.config_containers[i].configuration.project_settings.extruder_colour});
      expect(c.configuration.print_settings).toEqual({spiral_vase:false});
      expect(c.configuration.printer_settings).not.toHaveProperty('start_gcode');
      expect(c.beds.every((b: object) => Object.keys(b).every(k => ['position_x','position_y'].includes(k)))).toBe(true);
    }
    const build = children(child(xml(strFromU8(p.source!.files['3D/3dmodel.model'])).documentElement,'build'),'item');
    expect(clean.objects.map((o: {object_settings:{extruder:number}}) => o.object_settings.extruder)).toEqual(build.map(item => original.objects.find((o: {id:number}) => String(o.id) === item.getAttribute('objectid')).object_settings.extruder));
    expect(strFromU8(files[path])).not.toContain('filepath');
    const paintPath = 'Metadata/Slic3r_facets_annotation.json';
    expect(decode(files,paintPath)).toEqual(expect.arrayContaining(decode(unzipSync(input),paintPath).map((p: Record<string,unknown>) => Object.fromEntries(Object.entries(p).filter(([k]) => ['id','mmSegmentationFacets','mmSegmentationFacetsVersion'].includes(k))))));
  });

  it('can bypass broken export-only layer metadata instead of parsing or repairing it', () => {
    const files = unzipSync(new Uint8Array(nativeFixture())); files['Metadata/layer_heights_profile.txt'] = strToU8('unrecognized payload');
    const p = open(zipSync(files)), result = generateBrims(p,DEFAULT_BRIM);
    expect(() => exportProject(p,result)).toThrow(/Cannot safely remap/);
    expect(open(exportProject(p,result,undefined,{clean:true})).objects).toHaveLength(p.objects.length);
  });

  it('exports STL to native Prusa 3 without profiles or hidden dependencies', () => {
    const p = importProject('body.stl',stl(box())), result = generateBrims(p,DEFAULT_BRIM);
    const out = exportProject(p,result,'prusa3'), files = unzipSync(out), round = open(out);
    expect(round.objects[0].parts[0].mesh).toEqual(p.objects[0].parts[0].mesh);
    expect(round.objects[0].parts[1].mesh).toEqual(result.objects[0].mesh);
    expect(decode(files,'Metadata/PrusaSlicer3_project.json').config_containers).toEqual([]);
    expect(children(child(xml(strFromU8(files['3D/3dmodel.model'])).documentElement,'build'),'item')).toHaveLength(1);
  });
});
