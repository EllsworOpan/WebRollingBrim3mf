import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { paintedFaces } from './converted-fixtures';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { exportProject, importProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM, type Mesh, type SlicerFormat } from '../src/core/types';
import { nativeFixture } from './native-fixtures';

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
  it('refuses conversion of virtual color recipes and still allows a clean export to their original format', () => {
    const p = open(fixture('multimaterial-mmu-prusa3-alpha12')), result = generateBrims(p,DEFAULT_BRIM);
    expect(() => exportProject(p,result,'bambu',{clean:true})).toThrow(/blend\/gradient/);
    expect(open(exportProject(p,result,'prusa3',{clean:true})).format).toBe('prusa3');
  });
  it('refuses unsupported extended paint instead of silently dropping color data', () => {
    const files = unzipSync(fixture('painted-plates-prusa3-alpha12'));
    const path = 'Metadata/Slic3r_facets_annotation.json', paint = JSON.parse(strFromU8(files[path]));
    paint[0].mmSegmentationFacetsVersion = 2; files[path] = strToU8(JSON.stringify(paint));
    const p = open(zipSync(files));
    expect(() => exportProject(p,generateBrims(p,DEFAULT_BRIM),'orca',{clean:true})).toThrow(/extended color painting/);
  });
});

