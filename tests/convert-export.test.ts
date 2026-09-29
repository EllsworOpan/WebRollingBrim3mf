import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { paintedFaces } from './converted-fixtures';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { exportProject, importProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM, type Mesh, type SlicerFormat } from '../src/core/types';
import { nativeFixture } from './native-fixtures';
import { readDocument, writeDocument } from '../src/vendor/three-mf/index.js';
const convert = (source: ReturnType<typeof readDocument>, target: SlicerFormat) => writeDocument(source,{mode:'create',target}).bytes;

const open = (bytes:Uint8Array) => importProject('source.3mf',bytes.slice().buffer);
const fixture = (name:string) => new Uint8Array(readFileSync(`tests/fixtures/${name}.3mf`));
const formats: SlicerFormat[] = ['prusa','prusa3','bambu','orca'];
const faceGeometry = (mesh:Mesh) => Array.from({length:mesh.triangles.length/3},(_,i) => mesh.triangles.slice(i*3,i*3+3).map(v => mesh.vertices.slice(v*3,v*3+3).map(n => n.toFixed(5)).join(',')).sort().join('|')).sort();

describe('safe mode format changes', () => {
  for (const name of ['painted-prusa','painted-instances-prusa','painted-plates-bambu','painted-plates-orca','painted-plates-prusa3-alpha12']) {
    const source = fixture(name), p = open(source);
    for (const target of formats.filter(f => f !== p.format)) it(`${name} to ${target} keeps geometry, selected brims and painted corners`, () => {
      const result = generateBrims(p,DEFAULT_BRIM,[p.objects[0].id]), checkpoint = structuredClone(p);
      expect(() => exportProject(p,result,target)).toThrow(/original slicer/);
      const bytes = exportProject(p,result,target,{clean:true}), round = open(bytes);
      expect(round.format).toBe(target);
      expect(round.objects.map(o => o.id)).toEqual(p.objects.map(o => o.id));
      for (const [i,o] of round.objects.entries()) {
        const parts = o.parts.filter(p => p.name !== 'Rolling brim');
        expect(parts.map(p => p.kind)).toEqual(p.objects[i].parts.map(p => p.kind));
        expect(parts.map(p => faceGeometry(p.mesh))).toEqual(p.objects[i].parts.map(p => faceGeometry(p.mesh)));
        const brims = o.parts.filter(p => p.name === 'Rolling brim');
        expect(brims).toHaveLength(i === 0 ? 1 : 0);
        if (brims.length) expect(faceGeometry(brims[0].mesh)).toEqual(faceGeometry(result.objects[0].mesh));
      }
      expect(paintedFaces(bytes)).toEqual(paintedFaces(source));
      expect(p).toEqual(checkpoint);
      const files = unzipSync(bytes);
      expect(files['Metadata/Slic3r_PE.config']).toBeUndefined();
      expect(files['Metadata/project_settings.config']).toBeUndefined();
      if (target === 'prusa3') expect(JSON.parse(strFromU8(files['Metadata/PrusaSlicer3_project.json'])).config_containers).toEqual([]);
      expect(Object.keys(files).some(k => /gcode|thumbnail|layer_height|layer_config|opaque/.test(k))).toBe(false);
    });
  }
  it('reads only geometry and color when rebuilding a different format', () => {
    const files = unzipSync(new Uint8Array(nativeFixture()));
    files['Metadata/layer_heights_profile.txt'] = strToU8('broken unrelated data');
    const p = open(zipSync(files)), result = generateBrims(p,DEFAULT_BRIM);
    const bytes = exportProject(p,result,'prusa',{clean:true});
    expect(open(bytes).objects).toHaveLength(p.objects.length);
    expect(paintedFaces(bytes)).toEqual(paintedFaces(zipSync(files)));
    expect(Object.values(unzipSync(bytes)).map(b => strFromU8(b)).join('')).not.toMatch(/future_setting|paint_supports|paint_seam|broken unrelated/);
  });
  it('keeps blend and gradient assignments as flat regions when cleaning or converting', () => {
    const p = open(fixture('multimaterial-mmu-prusa3-alpha12')), result = generateBrims(p,DEFAULT_BRIM);
    for (const format of ['prusa','bambu','prusa3'] as const) {
      const bytes = exportProject(p,result,format,{clean:true}), files = unzipSync(bytes);
      expect(open(bytes).format).toBe(format);
      expect(open(bytes).objects).toHaveLength(p.objects.length);
      expect(files['Metadata/project_settings.config']).toBeUndefined();
      expect(files['Metadata/Slic3r_PE.config']).toBeUndefined();
      expect(Object.values(files).map(bytes => strFromU8(bytes)).join('')).not.toMatch(/virtual_extruders|hw_config|printer_settings|nozzle_diameter/);
      if (format === 'prusa3') expect(paintedFaces(bytes)).toEqual(paintedFaces(fixture('multimaterial-mmu-prusa3-alpha12')));
      if (format === 'prusa') expect(strFromU8(files['Metadata/Slic3r_PE_model.config'])).toContain('key="extruder" value="20"');
      if (format === 'bambu') expect(strFromU8(files['Metadata/model_settings.config'])).toContain('key="extruder" value="20"');
    }
    // Region IDs still obey the selected vendor's paint encoding limits.
    expect(() => exportProject(p,result,'orca',{clean:true})).toThrow(/1–16/);
  });
  it('refuses unknown paint versions instead of silently dropping color data', () => {
    const files = unzipSync(fixture('painted-plates-prusa3-alpha12'));
    const path = 'Metadata/Slic3r_facets_annotation.json', paint = JSON.parse(strFromU8(files[path]));
    paint[0].mmSegmentationFacetsVersion = 3; files[path] = strToU8(JSON.stringify(paint));
    expect(() => open(zipSync(files))).toThrow(/paint format/);
  });

  it('does not require matching per-bed palette colors for clean conversion', () => {
    const files = unzipSync(fixture('painted-plates-prusa3-alpha12'));
    const path = 'Metadata/PrusaSlicer3_project.json', data = JSON.parse(strFromU8(files[path]));
    data.config_containers[1].configuration.project_settings.extruder_colour = ['#123456','#FEDCBA'];
    files[path] = strToU8(JSON.stringify(data));
    const bytes = zipSync(files), source = open(bytes), result = generateBrims(source,DEFAULT_BRIM);
    for (const target of formats) {
      const exported = exportProject(source,result,target,{clean:true});
      expect(paintedFaces(exported)).toEqual(paintedFaces(bytes));
    }
  });

  it('converts Bambu extended paint to Prusa 2 and 3 with correct version metadata', () => {
    const files = unzipSync(fixture('painted-plates-bambu'));
    for (const path of Object.keys(files).filter(p => p.endsWith('.model')))
      files[path] = strToU8(strFromU8(files[path]).replace(/paint_color="[^"]+"/g,'paint_color="EFC"'));
    const source = readDocument(zipSync(files));
    const prusa = convert(source,'prusa');
    const model = strFromU8(unzipSync(prusa)['3D/3dmodel.model']);
    expect(model).toContain('slic3rpe:mmu_segmentation="0FEC"');
    expect(model).toContain('slic3rpe:MmPaintingVersion">2<');
    const native = convert(source,'prusa3');
    const annotations = JSON.parse(strFromU8(unzipSync(native)['Metadata/Slic3r_facets_annotation.json']));
    expect(annotations[0].mmSegmentationFacetsVersion).toBe(2);
    expect(annotations[0].mmSegmentationFacets[0].dividing).toBe('0FEC');
    const back = convert(readDocument(prusa),'bambu');
    expect(strFromU8(unzipSync(back)['3D/3dmodel.model'])).toContain('paint_color="EFC"');
    expect(() => convert(source,'orca')).toThrow(/1–16/);
    expect(() => convert(readDocument(native),'orca')).toThrow(/1–16/);
  });

  it('refuses extended paint on native Orca exports as well as cross-conversions', () => {
    const files = unzipSync(fixture('painted-plates-orca'));
    for (const path of Object.keys(files).filter(p => p.endsWith('.model')))
      files[path] = strToU8(strFromU8(files[path]).replace(/paint_color="[^"]+"/g,'paint_color="EFC"'));
    const source = open(zipSync(files)), result = generateBrims(source,DEFAULT_BRIM);
    for (const clean of [true,false]) expect(() => exportProject(source,result,'orca',{clean})).toThrow(/1–16/);
  });
});

