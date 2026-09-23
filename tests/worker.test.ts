import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { exportProject, importProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM, type WorkerRequest, type WorkerResponse } from '../src/core/types';
import { box, stl } from './fixtures';
import { MODEL, modelSnapshot, paintedSeed } from './painted-fixtures';
import { nativeFixture } from './native-fixtures';

describe('model worker lifecycle', () => {
  let scope: { postMessage: ReturnType<typeof vi.fn>; onmessage?: (message: {data: WorkerRequest}) => void };
  const send = (data: WorkerRequest): WorkerResponse => {
    scope.onmessage!({data});
    expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({id:data.id}));
    return scope.postMessage.mock.lastCall![0];
  };
  beforeEach(async () => {
    vi.resetModules();
    scope = {postMessage:vi.fn()};
    vi.stubGlobal('self', scope);
    await import('../src/core/worker');
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('reports optimization progress and returns a verified preview that can be exported', async () => {
    vi.useFakeTimers();
    send({type:'load',id:1,name:'box.stl',bytes:stl(box())});
    expect(send({type:'maximize',id:2,settings:DEFAULT_BRIM,enabled:['object-0']})).toMatchObject({type:'maximizing',progress:{diameter:0.05}});
    await vi.runAllTimersAsync();
    const response = scope.postMessage.mock.lastCall![0] as WorkerResponse;
    expect(response).toMatchObject({type:'maximized',id:2,outcome:{status:'found',atLimit:true}});
    if (response.type !== 'maximized' || response.outcome.status !== 'found') throw new Error('Expected optimized preview');
    expect(response.outcome.result.settings.diameter).toBe(100);
    expect(response.outcome.result.objects[0].uncovered).toEqual([]);
    expect(send({type:'export',id:3,settings:response.outcome.result.settings,enabled:['object-0']})).toMatchObject({type:'exported'});
  });

  it.each(['cancel','generate','load'] as const)('supersedes a running search on %s without emitting a stale result', async type => {
    vi.useFakeTimers();
    send({type:'load',id:1,name:'box.stl',bytes:stl(box())});
    send({type:'maximize',id:2,settings:DEFAULT_BRIM,enabled:['object-0']});
    if (type === 'cancel') expect(send({type,id:3})).toMatchObject({type:'cancelled'});
    else if (type === 'load') send({type,id:3,name:'replacement.stl',bytes:stl(box(80,20))});
    else send({type,id:3,settings:{...DEFAULT_BRIM,diameter:2},enabled:['object-0']});
    const calls = scope.postMessage.mock.calls.length;
    await vi.runAllTimersAsync();
    expect(scope.postMessage).toHaveBeenCalledTimes(calls);
    expect(scope.postMessage.mock.calls.some(([r])=>r.type==='maximized')).toBe(false);
    expect(send({type:'generate',id:4,settings:DEFAULT_BRIM,enabled:['object-0']})).toMatchObject({type:'generated'});
  });

  it('rejects requests without a loaded model and recovers after an invalid setting', () => {
    expect(send({type:'generate',id:1,settings:DEFAULT_BRIM,enabled:[]})).toMatchObject({type:'error',message:expect.stringContaining('Load a model')});
    expect(send({type:'load',id:2,name:'box.stl',bytes:stl(box())})).toMatchObject({type:'loaded'});
    expect(send({type:'generate',id:3,settings:{...DEFAULT_BRIM,height:NaN},enabled:['object-0']})).toMatchObject({type:'error'});
    expect(send({type:'generate',id:4,settings:DEFAULT_BRIM,enabled:['object-0']})).toMatchObject({type:'generated'});
    const response = send({type:'export',id:5,settings:{...DEFAULT_BRIM,perimeters:7},enabled:['object-0']});
    expect(response.type).toBe('exported');
    if (response.type !== 'exported') throw new Error('Expected export');
    expect(strFromU8(unzipSync(response.bytes)['Metadata/Slic3r_PE_model.config'])).toContain('key="perimeters" value="7"');
  });

  it('cannot accidentally export the previous model after a replacement fails to load', () => {
    send({type:'load',id:1,name:'old.stl',bytes:stl(box())});
    expect(send({type:'load',id:2,name:'broken.stl',bytes:new ArrayBuffer(0)})).toMatchObject({type:'error'});
    expect(send({type:'export',id:3,settings:DEFAULT_BRIM,enabled:['object-0']})).toMatchObject({type:'error',message:expect.stringContaining('Load a model')});
    expect(send({type:'load',id:4,name:'new.stl',bytes:stl(box(70,20))})).toMatchObject({type:'loaded',project:{name:'new.stl'}});
    expect(send({type:'generate',id:5,settings:DEFAULT_BRIM,enabled:['object-0']})).toMatchObject({type:'generated'});
  });

  it('rejects PrusaSlicer 3 metadata without retaining a previous exportable checkpoint', () => {
    send({type:'load',id:1,name:'old.stl',bytes:stl(box())});
    const files = unzipSync(new Uint8Array(paintedSeed('')));
    files['Metadata/PrusaSlicer3_project.json'] = strToU8('{"config_containers":[]}');
    expect(send({type:'load',id:2,name:'prusa3.3mf',bytes:zipSync(files).slice().buffer})).toMatchObject({type:'error',message:expect.stringContaining('PrusaSlicer 3.0')});
    expect(send({type:'export',id:3,settings:DEFAULT_BRIM,enabled:['object-0']})).toMatchObject({type:'error',message:expect.stringContaining('Load a model')});
    expect(send({type:'load',id:4,name:'new.stl',bytes:stl(box())})).toMatchObject({type:'loaded'});
  });

  it('switches plates from the immutable upload and exports only the active plate', () => {
    const bytes = nativeFixture();
    expect(send({type:'load',id:1,name:'multi.3mf',bytes})).toMatchObject({type:'loaded',project:{activePlateId:'1',format:'orca'}});
    expect(send({type:'plate',id:2,plateId:'2'})).toMatchObject({type:'loaded',project:{activePlateId:'2',objects:expect.any(Array)}});
    const first = send({type:'export',id:3,settings:DEFAULT_BRIM,enabled:['object-1']});
    if (first.type !== 'exported') throw new Error('Expected export');
    expect(first.filename).toBe('multi-Plate 2-rolling-brim.3mf');
    expect(importProject('out.3mf',first.bytes.slice().buffer).objects.map(o => o.parts.length)).toEqual([3,2]);
    send({type:'plate',id:4,plateId:'3'});
    expect(send({type:'generate',id:5,settings:{...DEFAULT_BRIM,width:8},enabled:['object-4']})).toMatchObject({type:'generated'});
    expect(send({type:'plate',id:6,plateId:'missing'})).toMatchObject({type:'error'});
    send({type:'plate',id:7,plateId:'2'});
    const restored = send({type:'export',id:8,settings:DEFAULT_BRIM,enabled:['object-1']});
    if (restored.type !== 'exported') throw new Error('Expected export');
    expect(unzipSync(restored.bytes)).toEqual(unzipSync(first.bytes));
  });

  it('lets a plate switch supersede an optimization without returning the old result', async () => {
    vi.useFakeTimers();
    send({type:'load',id:1,name:'multi.3mf',bytes:nativeFixture()});
    send({type:'maximize',id:2,settings:DEFAULT_BRIM,enabled:['object-0']});
    send({type:'plate',id:3,plateId:'2'});
    await vi.runAllTimersAsync();
    expect(scope.postMessage.mock.calls.some(([r]) => r.type === 'maximized')).toBe(false);
    expect(send({type:'generate',id:4,settings:DEFAULT_BRIM,enabled:['object-1']})).toMatchObject({type:'generated',result:{objects:expect.arrayContaining([expect.objectContaining({id:'object-1'})])}});
  });

  it('uses the selected Prusa 3 bed and its native format after switching away and back', () => {
    const bytes = new Uint8Array(readFileSync('tests/fixtures/painted-plates-prusa3-alpha12.3mf')).buffer;
    expect(send({type:'load',id:1,name:'alpha12.3mf',bytes})).toMatchObject({type:'loaded',project:{format:'prusa3',activePlateId:'1'}});
    const selected = send({type:'plate',id:2,plateId:'3'});
    if (selected.type !== 'loaded') throw new Error('Expected selected bed');
    expect(selected.project.suggestedHeight).toBe(0.3);
    const enabled = selected.project.objects.map(o => o.id);
    const first = send({type:'export',id:3,settings:{...DEFAULT_BRIM,height:0.3},enabled});
    if (first.type !== 'exported') throw new Error('Expected native export');
    expect(first.filename).toMatch(/^alpha12-Bed 3.*rolling-brim\.3mf$/);
    expect(importProject('export.3mf',first.bytes.slice().buffer)).toMatchObject({format:'prusa3',plates:[{objectCount:3}]});
    send({type:'plate',id:4,plateId:'1'});
    send({type:'generate',id:5,settings:{...DEFAULT_BRIM,width:8},enabled:['object-0']});
    send({type:'plate',id:6,plateId:'3'});
    const second = send({type:'export',id:7,settings:{...DEFAULT_BRIM,height:0.3},enabled});
    if (second.type !== 'exported') throw new Error('Expected repeated native export');
    expect(unzipSync(second.bytes)).toEqual(unzipSync(first.bytes));
  });

  it('switches painted instances across previews and exports without leaking brims or changing original parts', () => {
    const files = unzipSync(new Uint8Array(paintedSeed(readFileSync('examples/validation.ini','utf8'))));
    files[MODEL] = strToU8(strFromU8(files[MODEL]).replace('</build>','<item objectid="1" transform="1 0 0 0 1 0 0 0 1 40 0 0"/></build>'));
    const bytes = zipSync(files).slice().buffer, pristine = importProject('painted-instances.3mf',bytes);
    const originalParts = modelSnapshot(new Uint8Array(bytes)).map(o=>o.parts);
    expect(send({type:'load',id:1,name:'painted-instances.3mf',bytes})).toMatchObject({type:'loaded'});
    let id = 2;
    for (const enabled of [['object-0'],['object-1'],['object-0','object-1'],[],['object-0']]) {
      const preview = send({type:'generate',id:id++,settings:DEFAULT_BRIM,enabled});
      if (preview.type !== 'generated') throw new Error('Expected preview');
      expect(preview.result.objects.map(o=>o.mesh.triangles.length>0)).toEqual(pristine.objects.map(o=>enabled.includes(o.id)));
      const output = send({type:'export',id:id++,settings:DEFAULT_BRIM,enabled});
      if (!enabled.length) {
        expect(output).toMatchObject({type:'error',message:expect.stringContaining('at least one brim')});
        continue;
      }
      if (output.type !== 'exported') throw new Error('Expected export');
      const standalone = exportProject(pristine,generateBrims(pristine,DEFAULT_BRIM,enabled));
      expect(unzipSync(output.bytes)).toEqual(unzipSync(standalone));
      const objects = modelSnapshot(output.bytes);
      expect(objects).toHaveLength(2);
      objects.forEach((object,i) => {
        expect(object.parts.filter(p=>p.settings.name!=='Rolling brim')).toEqual(originalParts[i]);
        expect(object.parts.filter(p=>p.settings.name==='Rolling brim')).toHaveLength(enabled.includes(pristine.objects[i].id) ? 1 : 0);
        expect(object.settings.elefant_foot_compensation).toBe('0');
      });
    }
    expect(unzipSync(new Uint8Array(bytes))).toEqual(files);
  });

  it.each(['stl','obj','3mf'])('always regenerates %s from its clean import after preview and export changes', format => {
    const mesh = box();
    const obj = [...Array.from({length:mesh.vertices.length/3},(_,i) => `v ${mesh.vertices.slice(i*3,i*3+3).join(' ')}`),...Array.from({length:mesh.triangles.length/3},(_,i) => `f ${mesh.triangles.slice(i*3,i*3+3).map(v => v+1).join(' ')}`)].join('\n');
    const bytes = format === 'stl' ? stl(mesh) : format === 'obj' ? strToU8(obj).slice().buffer : paintedSeed(readFileSync('examples/validation.ini','utf8'));
    const original = new Uint8Array(bytes).slice();
    expect(send({type:'load',id:1,name:`input.${format}`,bytes})).toMatchObject({type:'loaded'});
    const exported = (id: number, width: number) => {
      const response = send({type:'export',id,settings:{...DEFAULT_BRIM,width},enabled:['object-0']});
      if (response.type !== 'exported') throw new Error('Expected export');
      return response.bytes;
    };
    const first = exported(2,3);
    expect(send({type:'generate',id:3,settings:{...DEFAULT_BRIM,width:6},enabled:['object-0']})).toMatchObject({type:'generated'});
    const changed = exported(4,6), restored = exported(5,3);
    expect(unzipSync(restored)).toEqual(unzipSync(first));
    expect(new Uint8Array(bytes)).toEqual(original);
    const firstParts = modelSnapshot(first)[0].parts, changedParts = modelSnapshot(changed)[0].parts;
    expect(firstParts.slice(0,-1)).toEqual(changedParts.slice(0,-1));
    expect(changedParts.at(-1)!.faces).not.toEqual(firstParts.at(-1)!.faces);
    expect(changedParts.filter(p => p.settings.name === 'Rolling brim')).toHaveLength(1);
  });
});
