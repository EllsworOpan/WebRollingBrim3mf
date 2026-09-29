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
    expect(clean['Metadata/Slic3r_PE.config']).toBeUndefined();
    expect(clean['Metadata/project_settings.config']).toBeUndefined();
    if (clean['Metadata/PrusaSlicer3_project.json']) expect(decode(clean,'Metadata/PrusaSlicer3_project.json').config_containers).toEqual([]);
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
    expect(unzipSync(output)['Metadata/Slic3r_PE.config']).toBeUndefined();
    expect(after[0].settings.elefant_foot_compensation).toBe('0');
    expect(after[0].parts.at(-1)!.settings.perimeters).toBe('99');
  });

  it.each(['bambu','orca'] as const)('copies AMS regions without a palette profile or purge table for %s', format => {
    const p = importProject('source.3mf',nativeFixture(format === 'bambu' ? 'BambuStudio' : 'OrcaSlicer'));
    const files = unzipSync(exportProject(p,generateBrims(p,DEFAULT_BRIM),format,{clean:true}));
    const before = xml(strFromU8(p.source!.files['3D/Objects/shared.model'])), after = xml(strFromU8(files['3D/Objects/shared.model']));
    const faces = (doc: typeof before) => Array.from(doc.getElementsByTagName('triangle')).map(t => Object.fromEntries(Array.from(t.attributes).filter(a => ['v1','v2','v3','paint_color'].includes(a.name)).map(a => [a.name,a.value])));
    expect(faces(after)).toEqual(faces(before));
    expect(strFromU8(files['3D/Objects/shared.model'])).not.toMatch(/paint_support|paint_seam/);
    expect(files['Metadata/project_settings.config']).toBeUndefined();
    expect(strFromU8(files['Metadata/model_settings.config'])).not.toMatch(/future_setting|xy_size_compensation/);
    expect(strFromU8(files['Metadata/model_settings.config'])).toContain('key="wall_loops" value="99"');
  });

  it('retains Prusa 3 region numbers and our overrides without hardware, presets, beds or virtual recipes', () => {
    const input = fixture('multimaterial-mmu-prusa3-alpha12'), p = open(input), files = unzipSync(exportProject(p,generateBrims(p,DEFAULT_BRIM),undefined,{clean:true}));
    const path = 'Metadata/PrusaSlicer3_project.json', original = decode(unzipSync(input),path), clean = decode(files,path);
    expect(clean.config_containers).toEqual([]);
    const adjusted = clean.objects.filter((o: {object_settings:{elefant_foot_compensation?:number}}) => o.object_settings.elefant_foot_compensation !== undefined);
    expect(adjusted).toHaveLength(p.objects.length);
    for (const object of adjusted) {
      expect(Object.keys(object.object_settings).sort()).toEqual(['elefant_foot_compensation','extruder']);
      expect(object.object_settings.elefant_foot_compensation).toBe(0);
      for (const volume of object.volumes) {
        expect(volume.volume_settings.elefant_foot_compensation).toBe(0);
        if (volume.volume_settings.perimeters === undefined)
          expect(Object.keys(volume.volume_settings).sort()).toEqual(['elefant_foot_compensation','extruder']);
        else expect(volume.volume_settings.perimeters).toBe(99);
      }
    }
    expect(strFromU8(files[path])).not.toMatch(/hw_config|printer_settings|virtual_extruders|nozzle|bed_shape|preset/);
    const build = children(child(xml(strFromU8(p.source!.files['3D/3dmodel.model'])).documentElement,'build'),'item');
    expect(clean.objects.map((o: {object_settings:{extruder:number}}) => o.object_settings.extruder)).toEqual(build.map(item => original.objects.find((o: {id:number}) => String(o.id) === item.getAttribute('objectid')).object_settings.extruder));
    expect(strFromU8(files[path])).not.toContain('filepath');
    const paintPath = 'Metadata/Slic3r_facets_annotation.json';
    expect(decode(files,paintPath)).toEqual(expect.arrayContaining(decode(unzipSync(input),paintPath).map((p: Record<string,unknown>) => Object.fromEntries(Object.entries(p).filter(([k]) => ['id','mmSegmentationFacets','mmSegmentationFacetsVersion'].includes(k))))));
  });

  it('cleans Prusa 3 paint without depending on source hardware or preset records', () => {
    const files = unzipSync(fixture('painted-plates-prusa3-alpha12'));
    const path = 'Metadata/PrusaSlicer3_project.json', data = decode(files,path);
    for (const container of data.config_containers) delete container.preset;
    files[path] = strToU8(JSON.stringify(data));
    const p = open(zipSync(files));
    const clean = unzipSync(exportProject(p,generateBrims(p,DEFAULT_BRIM),'prusa3',{clean:true}));
    expect(decode(clean,path).config_containers).toEqual([]);
    expect(decode(clean,'Metadata/Slic3r_facets_annotation.json').some((p: {mmSegmentationFacets:unknown[]}) => p.mmSegmentationFacets?.length)).toBe(true);
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
