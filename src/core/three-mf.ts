import { Matrix4 } from 'three';
import { loadStl } from './mesh';
import { importObj } from './obj';
import { readDocument, geometryView, fromGeometryView, appendParts, identity, outputTarget } from '../vendor/three-mf/index.js';
import type { Document, PrintOverrides, ExportResult } from '../vendor/three-mf/index.js';
import type { Project, BrimResult, SlicerFormat } from './types';
const documents = new WeakMap<Project,Document>();
export function importProject(name:string, bytes:ArrayBuffer):Project {
  if (/\.obj$/i.test(name)) return importObj(name,bytes);
  if (/\.stl$/i.test(name)) {
    const mesh=loadStl(bytes);
    return {name,objects:[{id:'object-0',name:name.replace(/\.stl$/i,''),transform:new Matrix4().toArray(),parts:[{name,kind:'ModelPart',mesh}]}],warnings:['STL units are assumed to be millimetres. The model was placed on Z=0; disconnected shells remain one object.']};
  }
  if(!/\.3mf$/i.test(name))throw new Error('Choose an STL, OBJ or 3MF file.');
  const document=readDocument(bytes,name),project=geometryView(document);
  documents.set(project,document);return project;
}
export function exportProjectReport(project:Project,result:BrimResult,format:SlicerFormat=outputTarget(project.format) as SlicerFormat,options:{clean?:boolean}={}):ExportResult {
  if(!result.objects.some(o=>o.mesh.triangles.length))throw new Error('Generate at least one brim before exporting.');
  const original=documents.get(project),document=original||fromGeometryView(project);
  const overrides:PrintOverrides={sourceName:'rolling-brim.generated.stl',perimeterCount:result.settings.perimeters,infillPercent:0,topLayers:0,bottomLayers:0,topThickness:0,bottomThickness:0,gapFill:false,verticalShells:false,firstLayerSingleWall:false,topSingleWall:false,ironing:false,wipeIntoInfill:false};
  const additions=result.objects.filter(o=>o.mesh.triangles.length).map(o=>({objectId:o.id,space:'world' as const,part:{id:o.id+'/generated-brim',name:'Rolling brim',kind:'ModelPart' as const,mesh:o.mesh,transform:identity(),paint:Array.from({length:o.mesh.triangles.length/3},()=>({region:0})),overrides}}));
  return appendParts(document,additions,{mode:options.clean||!original?'create':'update',target:format,objectOverrides:{elephantFootCompensation:0},applicationMetadata:{name:'rolling_brim',data:{version:1,settings:result.settings,sampleZ:result.settings.height/2,printOrder:'Determined by the slicer; brim-first is not guaranteed.'}}});
}


export function exportProject(...args:Parameters<typeof exportProjectReport>):Uint8Array { return exportProjectReport(...args).bytes; }
