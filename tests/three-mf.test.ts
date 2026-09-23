import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { importProject, exportProject } from '../src/core/three-mf';
import { generateBrims } from '../src/core/brim';
import { DEFAULT_BRIM } from '../src/core/types';
import { archive, box, meshXml, project } from './fixtures';
import { boundsOf } from '../src/core/geometry';
import { sliceMesh } from '../src/core/mesh';
const ab=(bytes:Uint8Array)=>bytes.slice().buffer;
describe('3MF import/export',()=>{
  it('exports two objects with a separate configured brim part on each',()=>{
    const p=project([box(),box(70,20)]), bytes=exportProject(p,generateBrims(p,DEFAULT_BRIM));
    const files=unzipSync(bytes),config=strFromU8(files['Metadata/Slic3r_PE_model.config']);
    expect(config.match(/value="Rolling brim"/g)).toHaveLength(2); expect(config.match(/key="perimeters" value="99"/g)).toHaveLength(2);
    const loaded=importProject('result.3mf',ab(bytes)); expect(loaded.objects).toHaveLength(2); expect(loaded.objects[0].parts).toHaveLength(2);
  });
  it('preserves project profiles, existing part settings, painting and placement',()=>{
    const mesh=meshXml(box()).replace('<triangle ','<triangle slic3rpe:paint_supports="1" ');
    const config='<config><object id="1"><metadata type="object" key="name" value="Bracket"/><metadata type="object" key="layer_height" value="0.15"/><volume firstid="0" lastid="11"><metadata type="volume" key="name" value="Original body"/><metadata type="volume" key="fill_density" value="42%"/></volume></object></config>';
    const input=archive(`<object id="1">${mesh}</object>`,'<item objectid="1" transform="1 0 0 0 1 0 0 0 1 50 10 0"/>',config,{'Metadata/Slic3r_PE.config':strToU8('; first_layer_height = 0.2\n; bed_shape = 0x0,250x0,250x210,0x210\n; fill_density = 15%\n'),'Metadata/custom.bin':new Uint8Array([1,2,3])});
    const p=importProject('input.3mf',input), result=generateBrims(p,DEFAULT_BRIM); expect(boundsOf(result.objects[0].footprint).minX).toBe(70);
    const output=unzipSync(exportProject(p,result)), before=unzipSync(new Uint8Array(input));
    expect(output['Metadata/Slic3r_PE.config']).toEqual(before['Metadata/Slic3r_PE.config']); expect(output['Metadata/custom.bin']).toEqual(before['Metadata/custom.bin']);
    expect(strFromU8(output['Metadata/Slic3r_PE_model.config'])).toContain('value="42%"'); expect(strFromU8(output['3D/3dmodel.model'])).toContain('paint_supports="1"');
    const round=importProject('out.3mf',ab(exportProject(p,result))); expect(round.objects[0].parts[0]).toEqual(p.objects[0].parts[0]);
  });
  it('overrides elephant-foot compensation once per object, including objects without a brim',()=>{
    const config='<config><object id="1"><metadata type="object" key="elefant_foot_compensation" value="0.3"/><metadata type="object" key="elefant_foot_compensation" value="0.4"/></object></config>';
    const input=archive(`<object id="1">${meshXml(box())}</object><object id="2">${meshXml(box(70,20))}</object>`,'<item objectid="1"/><item objectid="2"/>',config,{'Metadata/Slic3r_PE.config':strToU8('; elefant_foot_compensation = 0.2\n; xy_size_compensation = 0.1\n')});
    const p=importProject('compensated.3mf',input), result=generateBrims(p,DEFAULT_BRIM,['object-0']);
    const output=unzipSync(exportProject(p,result)), text=strFromU8(output['Metadata/Slic3r_PE_model.config']);
    expect(text.match(/type="object" key="elefant_foot_compensation" value="0"/g)).toHaveLength(2);
    expect(text).not.toMatch(/value="0\.[34]"/);
    expect(output['Metadata/Slic3r_PE.config']).toEqual(unzipSync(new Uint8Array(input))['Metadata/Slic3r_PE.config']);
    expect(p.warnings.join(' ')).toContain('XY size compensation');
    expect(p.warnings.join(' ')).not.toContain('elephant');
  });
  it('detaches repeated instances and creates a brim in each instance’s coordinates',()=>{
    const input=archive(`<object id="7">${meshXml(box())}</object>`,'<item objectid="7"/><item objectid="7" transform="1 0 0 0 1 0 0 0 1 50 0 0"/>');
    const p=importProject('copies.3mf',input), result=generateBrims(p,DEFAULT_BRIM), out=exportProject(p,result);
    const round=importProject('out.3mf',ab(out)); expect(round.objects).toHaveLength(2); expect(new Set(round.objects.map(o=>o.resourceId)).size).toBe(2);
    expect(round.objects.map(o=>boundsOf(sliceMesh(o.parts[0].mesh,0.1)).minX)).toEqual([20,70]);
  });
  it('preserves generic component grouping and unit transforms',()=>{
    const input=archive(`<object id="1">${meshXml(box(0,0,1,1,1))}</object><object id="2"><components><component objectid="1"/><component objectid="1" transform="1 0 0 0 1 0 0 0 1 2 0 0"/></components></object>`,'<item objectid="2"/>','<config/>',{},'inch');
    const p=importProject('inches.3mf',input); expect(p.objects).toHaveLength(1); expect(p.objects[0].parts).toHaveLength(2);
    const result=generateBrims(p,DEFAULT_BRIM); expect(boundsOf(result.objects[0].footprint).maxX).toBeCloseTo(76.2,3);
    const round=importProject('out.3mf',ab(exportProject(p,result))); expect(round.objects[0].parts).toHaveLength(3);
    round.objects[0].parts.slice(0,2).forEach((part,i) => {
      const before=boundsOf(sliceMesh(p.objects[0].parts[i].mesh,0.1)), after=boundsOf(sliceMesh(part.mesh,0.1));
      expect(after.minX).toBeCloseTo(before.minX,6); expect(after.maxX).toBeCloseTo(before.maxX,6);
      expect(after.minY).toBeCloseTo(before.minY,6); expect(after.maxY).toBeCloseTo(before.maxY,6);
    });
  });
  it('rejects invalid indices, cyclic references, and unsupported project formats',()=>{
    expect(()=>importProject('bad.3mf',archive('<object id="1"><components><component objectid="1"/></components></object>','<item objectid="1"/>'))).toThrow(/circular/);
    expect(()=>importProject('bad.3mf',archive(`<object id="1">${meshXml(box()).replace('v1="0"','v1="99999"')}</object>`,'<item objectid="1"/>'))).toThrow(/indices/);
    expect(()=>importProject('orca.3mf',archive(`<object id="1">${meshXml(box())}</object>`,'<item objectid="1"/>','<config/>',{'Metadata/project_settings.config':strToU8('{}')}))).toThrow(/Bambu\/Orca/);
  });
});
