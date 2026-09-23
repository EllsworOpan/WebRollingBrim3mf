import { describe, expect, it, vi } from 'vitest';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { loadStl } from '../src/core/mesh';
import { exportProject, importProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM, type Mesh } from '../src/core/types';
import { box, stl } from './fixtures';

function expectClosed(mesh: Mesh) {
  const edges = new Map<string, number>(), directed = new Set<string>();
  for (let i = 0; i < mesh.triangles.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = mesh.triangles[i+j], b = mesh.triangles[i+(j+1)%3];
    const key = [a,b].sort((x,y) => x-y).join(',');
    edges.set(key, (edges.get(key) || 0) + 1);
    expect(directed.has(`${a},${b}`)).toBe(false);
    directed.add(`${a},${b}`);
  }
  expect([...edges.values()].every(count => count === 2)).toBe(true);
}

describe('STL topology in 3MF', () => {
  it('ignores discarded triangles when grounding the usable model', () => {
    const mesh = box();
    mesh.vertices.push(0,0,-100);
    mesh.triangles.push(8,8,8);
    const loaded = loadStl(stl(mesh));
    expect(Math.min(...loaded.vertices.filter((_,i) => i % 3 === 2))).toBe(0);
    expectClosed(loaded);
    expect(generateBrims(importProject('grounded.stl',stl(mesh)), DEFAULT_BRIM).objects[0].areaMm2).toBeGreaterThan(0);
  });
  it('rejects truncated binary data with a useful error', () => {
    const bytes = stl(box(), true).slice(0,-1);
    expect(() => loadStl(bytes)).toThrow(/STL.*truncated|STL.*length/);
  });
  it('checks binary face limits before the loader can allocate from an untrusted count', () => {
    const bytes = new ArrayBuffer(84);
    new DataView(bytes).setUint32(80, 0xffffffff, true);
    const parse = vi.spyOn(STLLoader.prototype, 'parse').mockImplementation(() => { throw new Error('Loader must not allocate'); });
    try {
      expect(() => loadStl(bytes)).toThrow(/triangle.*limit/);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });
  it('accepts a binary STL whose header starts with solid', () => {
    const bytes = stl(box(), true);
    new Uint8Array(bytes).set(new TextEncoder().encode('solid binary model'));
    expectClosed(loadStl(bytes));
  });
  it.each(['missing solid end', 'missing facet end', 'missing vertex', 'extra vertex'])('rejects an ASCII STL with %s instead of silently dropping model data', defect => {
    const valid = new TextDecoder().decode(stl(box()));
    let damaged = valid;
    if (defect === 'missing solid end') damaged = valid + '\n' + valid.replace('endsolid fixture','');
    if (defect === 'missing facet end') damaged = valid.replace('endfacet','');
    if (defect === 'missing vertex') damaged = valid.replace(/vertex[^\n]*\n/,'');
    if (defect === 'extra vertex') damaged = valid.replace('endloop','vertex 0 0 0\nendloop');
    expect(() => loadStl(new TextEncoder().encode(damaged).buffer)).toThrow(/ASCII STL/);
  });
  it('accepts multiple complete ASCII solids with CRLF and a UTF-8 BOM', () => {
    const valid = new TextDecoder().decode(stl(box()));
    const text = '\ufeff' + valid.replaceAll('\n','\r\n') + '\r\n' + new TextDecoder().decode(stl(box(70,20)));
    const mesh = loadStl(new TextEncoder().encode(text).buffer);
    expect(mesh.triangles).toHaveLength(24*3);
    expectClosed(mesh);
  });
  it.each([new ArrayBuffer(0), new TextEncoder().encode('solid empty\nendsolid empty').buffer])('rejects empty inputs with an STL error', bytes => {
    expect(() => loadStl(bytes)).toThrow(/STL/);
  });
  it.each([false,true])('keeps adjacent faces connected with opposite edge directions (binary: %s)', binary => {
    const original = box(), input = stl(original,binary), mesh = loadStl(input);
    expect(mesh.vertices).toHaveLength(8*3);
    expect(mesh.triangles).toHaveLength(12*3);
    // Face order, winding, and positions survive indexing unchanged.
    expect(mesh.triangles.flatMap(i => mesh.vertices.slice(i*3,i*3+3))).toEqual(original.triangles.flatMap(i => original.vertices.slice(i*3,i*3+3)));
    expectClosed(mesh);
    const p = importProject('box.stl',input);
    const output = exportProject(p,generateBrims(p,DEFAULT_BRIM));
    const round = importProject('box.3mf',output.slice().buffer);
    expectClosed(round.objects[0].parts[0].mesh);
  });
  it('does not merge nearby distinct vertices or round their exported coordinates', () => {
    const a=box(1e-8,0,1e-8,20), b=box();
    const mesh={vertices:[...a.vertices,...b.vertices],triangles:[...a.triangles,...b.triangles.map(i=>i+8)]};
    const p = importProject('precise.stl',stl(mesh));
    const before = p.objects[0].parts[0].mesh;
    expect(before.vertices).toHaveLength(16*3);
    const output = exportProject(p,generateBrims(p,DEFAULT_BRIM));
    const after = importProject('precise.3mf',output.slice().buffer).objects[0].parts[0].mesh;
    const corners = (m: Mesh) => m.triangles.flatMap(i => m.vertices.slice(i*3,i*3+3));
    expect(corners(after)).toEqual(corners(before));
  });
  it('keeps closed shells touching on an edge separate and discards facets with collapsed corners', () => {
    const a=box(0,0,20,20), b=box(20,20,20,20);
    const input={vertices:[...a.vertices,...b.vertices],triangles:[...a.triangles,...b.triangles.map(i=>i+8),0,0,1]};
    const mesh=loadStl(stl(input));
    expect(mesh.triangles).toHaveLength(24*3);
    expect(mesh.vertices).toHaveLength(16*3);
    expectClosed(mesh);
  });
  it('preserves collinear faces with distinct corners that connect neighbouring edges', () => {
    const mesh=box(), [a,b,c]=mesh.triangles.slice(0,3), m=mesh.vertices.length/3;
    for(let j=0;j<3;j++) mesh.vertices.push((mesh.vertices[a*3+j]+mesh.vertices[b*3+j])/2);
    mesh.triangles.splice(0,3,a,b,m,a,m,c,m,b,c);
    const loaded=loadStl(stl(mesh));
    expect(loaded.triangles).toHaveLength(14*3);
    expectClosed(loaded);
  });
});
