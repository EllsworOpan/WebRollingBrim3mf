import { Matrix4 } from 'three';
import { strFromU8, strToU8 } from 'fflate';
import { compactMesh, transformMesh } from './mesh';
import { NS, xml, serialize, children, child, meta, matrix, readMesh, safePath, type Doc, type El } from './three-mf-xml';
import { packageFiles } from './three-mf-package';
import { importPrusaProject } from './prusa-3mf';
import { importNativeProject } from './bambu-3mf';
import { importPrusa3Project } from './prusa3-3mf';
import type { Mesh, Project, SlicerFormat } from './types';
import { translatePaint } from './paint-codec';

interface Part { name: string; kind: string; mesh: Mesh; transform: Matrix4; paint: string[]; extruder?: string }
interface ObjectData { name: string; parts: Part[]; transform: Matrix4; printable: boolean; extruder?: string }
interface P3Object { id: number; object_settings?: {extruder?: number}; volumes: {id:number;type:string;volume_settings?:{extruder?:number}}[]; instances?: {ord:number;printable:boolean}[] }
interface P3Paint { id:number;mmSegmentationFacetsVersion?:number;mmSegmentationFacets?:{triangle:number;dividing:string}[] }
interface P3Data { objects:P3Object[] }
const ROLES: Record<string,string> = {normal_part:'ModelPart',negative_part:'NegativeVolume',modifier_part:'ParameterModifier',support_enforcer:'SupportEnforcer',support_blocker:'SupportBlocker'};
const P3 = 'Metadata/PrusaSlicer3_project.json', PAINT = 'Metadata/Slic3r_facets_annotation.json';
const unsupported = (reason: string): never => { throw new Error(`${reason} Keep the original output slicer to preserve this color data.`); };
const slot = (value: unknown) => value === undefined || value === null || value === '' ? undefined : String(value);
const transformText = (m: Matrix4) => m.elements.filter((_,i) => i%4 !== 3).join(' ');

/** Read the small geometry/color contract shared by the clean target writers.
 * Paint is normalized to Prusa encoding, with the same triangle order/corners.
 * No printer profiles or source archive entries enter the new target package.
 */
function readCleanObjects(project: Project) {
  const {files,modelPath} = project.source!;
  const docs = new Map<string,Doc>();
  const model = (path: string): Doc => {
    if (!docs.has(path)) docs.set(path,xml(strFromU8(files[path])));
    return docs.get(path)!;
  };
  const resource = (path:string,id:string) => children(child(model(path).documentElement,'resources'),'object').find(o => o.getAttribute('id') === id)!;
  const ref = (node:El,path:string) => ({path:safePath(Array.from(node.attributes).find(a => a.localName === 'path')?.value || path),id:node.getAttribute('objectid')!});
  const root = model(modelPath).documentElement;
  const native = project.format === 'bambu' || project.format === 'orca';
  const configPath = native ? 'Metadata/model_settings.config' : 'Metadata/Slic3r_PE_model.config';
  const configs = files[configPath] ? children(xml(strFromU8(files[configPath])).documentElement,'object') : [];
  const p3: P3Data | undefined = project.format === 'prusa3' ? JSON.parse(strFromU8(files[P3])) : undefined;
  const annotations: P3Paint[] = p3 && files[PAINT] ? JSON.parse(strFromU8(files[PAINT])) : [];
  // Settings, palette swatches, hardware routing and mixing recipes are outside
  // the clean contract. Preserve their numeric assignments as color-region IDs.
  const collect = (path:string,id:string,transform:Matrix4,cfg?:El,seen=new Set<string>()): Part[] => {
    const key = `${path}#${id}`;
    if (seen.has(key) || seen.size > 64) throw new Error('The 3MF has circular or excessive component nesting.');
    const next = new Set(seen).add(key), object = resource(path,id);
    if (!object) throw new Error('A 3MF component references a missing object.');
    if (object.hasAttribute('pid')) unsupported('Core 3MF material/color resources cannot yet be converted between slicers.');
    const body = children(object,'mesh')[0];
    if (!body) return children(child(object,'components'),'component').flatMap((c,index) => {
      const target = ref(c,path), partConfig = cfg && children(cfg,'part')[index];
      return collect(target.path,target.id,transform.clone().multiply(matrix(c.getAttribute('transform'))),partConfig || configs.find(o => o.getAttribute('id') === target.id) || cfg,next);
    });
    const mesh = readMesh(body), triangles = children(child(body,'triangles'),'triangle');
    if (triangles.some(t => ['pid','p1','p2','p3'].some(k => t.hasAttribute(k)))) unsupported('Core 3MF material/color resources cannot yet be converted between slicers.');
    const paint = triangles.map(t => {
      const prusa = t.getAttribute('slic3rpe:mmu_segmentation') || '', bambu = t.getAttribute('paint_color') || '';
      const payload = native ? bambu : prusa || bambu;
      return translatePaint(payload, project.format === 'orca' ? 'orca' : native || !prusa ? 'bambu' : 'prusa','prusa').hex;
    });
    const version = children(model(path).documentElement,'metadata').find(m => /:MmPaintingVersion$/.test(m.getAttribute('name') || ''));
    if (paint.some(Boolean) && version && ![1,2].includes(Number(version.textContent))) unsupported('This file uses an unknown color-paint version.');
    const volumes = cfg ? children(cfg,'volume') : [];
    if (volumes.length) return volumes.map(v => {
      const first = Number(v.getAttribute('firstid')), last = Number(v.getAttribute('lastid'));
      return {name:meta(v,'name'),kind:meta(v,'volume_type') || (meta(v,'modifier') === '1' ? 'ParameterModifier' : 'ModelPart'),mesh:compactMesh({vertices:mesh.vertices,triangles:mesh.triangles.slice(first*3,(last+1)*3)}),transform,paint:paint.slice(first,last+1),extruder:slot(meta(v,'extruder'))};
    });
    return [{name:meta(cfg,'name') || object.getAttribute('name') || 'Model',kind:ROLES[cfg?.getAttribute('subtype') || 'normal_part'] || 'ModelPart',mesh,transform,paint,extruder:slot(meta(cfg,'extruder'))}];
  };
  const units: Record<string,number> = {micron:0.001,millimeter:1,centimeter:10,inch:25.4,foot:304.8,meter:1000};
  const objects: ObjectData[] = children(child(root,'build'),'item').map((item,index) => {
    const target = ref(item,modelPath), parent = resource(target.path,target.id), loaded = project.objects.find(o => o.buildIndex === index);
    const alias = children(parent,'components')[0];
    const aliasId = alias && children(alias,'component').length === 1 ? children(alias,'component')[0].getAttribute('objectid') : undefined;
    const cfg = configs.find(c => c.getAttribute('id') === (loaded?.resourceId || target.id))
      || (!native && !p3 && aliasId ? configs.find(c => c.getAttribute('id') === aliasId) : undefined);
    const data = p3?.objects.find(o => String(o.id) === target.id);
    let parts: Part[];
    if (data) parts = children(child(parent,'components'),'component').flatMap((c,i) => {
      const volume = data.volumes[i], target = ref(c,modelPath);
      const parts = collect(target.path,target.id,matrix(c.getAttribute('transform')));
      const paint = annotations.find(p => p.id === volume.id);
      if (paint?.mmSegmentationFacets?.length && ![1,2].includes(paint.mmSegmentationFacetsVersion!)) unsupported('This PrusaSlicer 3 file uses an unknown color-paint version.');
      const part = parts[0]; part.name = resource(target.path,target.id).getAttribute('name') || part.name; part.kind = volume.type; part.extruder = slot(volume.volume_settings?.extruder);
      for (const facet of paint?.mmSegmentationFacets || []) {
        if (!Number.isInteger(facet.triangle) || facet.triangle < 0 || facet.triangle >= part.paint.length || typeof facet.dividing !== 'string') unsupported('This project has color annotations that cannot be mapped to its meshes.');
        part.paint[facet.triangle] = translatePaint(facet.dividing,'prusa','prusa').hex;
      }
      return parts;
    });
    else parts = collect(target.path,target.id,new Matrix4(),cfg);
    const printable = data ? !data.instances?.some(i => i.ord === index && !i.printable) : !['0','false'].includes(item.getAttribute('printable') || '');
    return {name:loaded?.name || meta(cfg,'name') || parent.getAttribute('name') || parts[0].name,parts,transform:matrix(item.getAttribute('transform'),units[root.getAttribute('unit') || 'millimeter']),printable,extruder:slot(data?.object_settings?.extruder ?? meta(cfg,'extruder'))};
  });
  return {objects};
}

export function convertCleanProject(project: Project, format: SlicerFormat): Project {
  const {objects} = readCleanObjects(project), modelPath = '3D/3dmodel.model';
  let paintingVersion = 1;
  for (const object of objects) for (const part of object.parts) part.paint = part.paint.map(hex => {
    const result = translatePaint(hex,'prusa',format === 'bambu' ? 'bambu' : format === 'orca' ? 'orca' : 'prusa');
    if (result.maxState > 16) paintingVersion = 2;
    return result.hex;
  });
  const doc = xml(`<model xmlns="${NS}" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06" unit="millimeter"><resources/><build/></model>`);
  const resources = child(doc.documentElement,'resources'), build = child(doc.documentElement,'build'), config = xml('<config/>');
  const files = packageFiles(modelPath), objectConfigs: P3Object[] = [], painting: P3Paint[] = [];
  const node = (tag:string,parent?:El,attrs:Record<string,string>={}) => {
    const el = doc.createElementNS(NS,tag); for (const [k,v] of Object.entries(attrs)) el.setAttribute(k,v); parent?.appendChild(el); return el;
  };
  const metadata = (name:string,value:string) => { const m = node('metadata',undefined,{name}); m.appendChild(doc.createTextNode(value)); doc.documentElement.insertBefore(m,resources); };
  const setting = (parent:El,key:string,value:string|undefined,type='volume') => {
    if (value === undefined) return;
    const m = config.createElement('metadata'); m.setAttribute('key',key); m.setAttribute('value',value); if (format === 'prusa') m.setAttribute('type',type); parent.appendChild(m);
  };
  const cfgNode = (tag:string,parent:El,attrs:Record<string,string>={}) => {
    const el = config.createElement(tag); for (const [k,v] of Object.entries(attrs)) el.setAttribute(k,v); parent.appendChild(el); return el;
  };
  const meshNode = (parent:El,mesh:Mesh,paint:string[],base=0) => {
    const body = children(parent,'mesh')[0] || node('mesh',parent);
    const vertices = children(body,'vertices')[0] || node('vertices',body), triangles = children(body,'triangles')[0] || node('triangles',body);
    for (let i=0;i<mesh.vertices.length;i+=3) node('vertex',vertices,{x:String(mesh.vertices[i]),y:String(mesh.vertices[i+1]),z:String(mesh.vertices[i+2])});
    for (let i=0;i<mesh.triangles.length;i+=3) {
      const face = node('triangle',triangles,{v1:String(base+mesh.triangles[i]),v2:String(base+mesh.triangles[i+1]),v3:String(base+mesh.triangles[i+2])});
      if (paint[i/3] && format !== 'prusa3') face.setAttribute(format === 'prusa' ? 'slic3rpe:mmu_segmentation' : 'paint_color',paint[i/3]);
    }
  };
  if (format === 'prusa3') metadata('Application','PrusaSlicer-3.0.0-alpha12');
  else if (format === 'prusa') { metadata('slic3rpe:Version3mf','1'); metadata('slic3rpe:MmPaintingVersion',String(paintingVersion)); }
  else { metadata('Application','RollingBrim-0.1.0'); metadata('RollingBrim:TargetSlicer',format); metadata('BambuStudio:3mfVersion','1'); metadata('BambuStudio:MmPaintingVersion','1'); }
  let id = 1;
  const plate = format === 'bambu' || format === 'orca' ? cfgNode('plate',config.documentElement) : undefined;
  if (plate) setting(plate,'plater_id','1');
  for (const [index,object] of objects.entries()) {
    const parent = node('object',undefined,{name:object.name,type:'model'}), components = format === 'prusa' ? undefined : node('components',parent);
    const cfg = format === 'prusa3' ? undefined : cfgNode('object',config.documentElement);
    if (cfg) { setting(cfg,'name',object.name,'object'); setting(cfg,'extruder',object.extruder,'object'); }
    const volumes: P3Object['volumes'] = [];
    let vertexCount = 0, triangleCount = 0;
    for (const part of object.parts) {
      if (format === 'prusa') {
        if (part.transform.determinant() < 0 && part.paint.some(Boolean)) unsupported('Mirrored painted parts cannot yet be converted to PrusaSlicer 2.x without changing their painted corners.');
        const mesh = transformMesh(part.mesh,part.transform);
        meshNode(parent,mesh,part.paint,vertexCount);
        const volume = cfgNode('volume',cfg!,{firstid:String(triangleCount),lastid:String(triangleCount+mesh.triangles.length/3-1)});
        setting(volume,'name',part.name); setting(volume,'volume_type',part.kind); setting(volume,'extruder',part.extruder);
        vertexCount += mesh.vertices.length/3; triangleCount += mesh.triangles.length/3;
      } else {
        const meshId = id++, mesh = node('object',resources,{id:String(meshId),type:'model',name:part.name}); meshNode(mesh,part.mesh,part.paint);
        let partId = meshId;
        if (format === 'prusa3') {
          partId = id++; const volume = node('object',resources,{id:String(partId),name:part.name});
          node('component',node('components',volume),{objectid:String(meshId)});
          volumes.push({id:partId,type:part.kind,volume_settings:part.extruder === undefined ? {} : {extruder:Number(part.extruder)}});
          if (part.paint.some(Boolean)) painting.push({id:partId,mmSegmentationFacetsVersion:paintingVersion,mmSegmentationFacets:part.paint.flatMap((dividing,triangle) => dividing ? [{triangle,dividing}] : [])});
        } else {
          const partCfg = cfgNode('part',cfg!,{id:String(partId),subtype:Object.keys(ROLES).find(key => ROLES[key] === part.kind)!});
          setting(partCfg,'name',part.name); setting(partCfg,'extruder',part.extruder);
        }
        node('component',components,{objectid:String(partId),transform:transformText(part.transform)});
      }
    }
    const parentId = id++; parent.setAttribute('id',String(parentId)); resources.appendChild(parent);
    if (cfg) { cfg.setAttribute('id',String(parentId)); if (format === 'prusa') cfg.setAttribute('instances_count','1'); }
    const item = node('item',build,{objectid:String(parentId),transform:transformText(object.transform)});
    if (!object.printable && format !== 'prusa3') item.setAttribute('printable','0');
    if (plate) { const instance = cfgNode('model_instance',plate); setting(instance,'object_id',String(parentId)); setting(instance,'instance_id','0'); }
    objectConfigs.push({id:parentId,volumes,object_settings:object.extruder === undefined ? {} : {extruder:Number(object.extruder)},...(!object.printable ? {instances:[{ord:index,printable:false}]} : {})});
  }
  files[modelPath] = serialize(doc);
  if (format === 'prusa3') {
    // A converted project has no Prusa hardware slot definitions. As with STL,
    // let the slicer supply the user's profiles and palette; keep numeric paint
    // and material assignments intact without inventing a printer definition.
    files[P3] = strToU8(JSON.stringify({project:{id:'00000000-0000-4000-8000-000000000001',version:0},objects:objectConfigs,config_containers:[]}));
    if (painting.length) files[PAINT] = strToU8(JSON.stringify(painting));
    return importPrusa3Project(project.name,files,modelPath,doc);
  }
  if (format === 'prusa') {
    files['Metadata/Slic3r_PE_model.config'] = serialize(config);
    return importPrusaProject(project.name,files,modelPath,doc);
  }
  files['Metadata/model_settings.config'] = serialize(config);
  return importNativeProject(project.name,files,modelPath,doc);
}
