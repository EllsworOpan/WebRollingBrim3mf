import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { DEFAULT_BRIM, type WorkerRequest, type WorkerResponse } from '../src/core/types';
import { box, stl } from './fixtures';

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
  afterEach(() => vi.unstubAllGlobals());

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
});
