import { Matrix4, Vector3 } from 'three';
import { strFromU8, unzipSync } from 'fflate';
import { children, child, xml, matrix, readMesh, safePath } from '../src/vendor/three-mf/compat/three-mf-xml.js';
// Decode independently through the XML resource graph, including hidden build
// items. Compare opaque paint against its ordered world-space triangle corners.
export function paintedFaces(bytes:Uint8Array) {
  const files = unzipSync(bytes), path = '3D/3dmodel.model';
  const annotations: {id:number;mmSegmentationFacets?:{triangle:number;dividing:string}[]}[] = files['Metadata/Slic3r_facets_annotation.json'] ? JSON.parse(strFromU8(files['Metadata/Slic3r_facets_annotation.json'])) : [];
  const faces:string[] = [];
  const visit = (path:string,id:string,transform:Matrix4,paint?:typeof annotations[number]) => {
    const doc = xml(strFromU8(files[path])), object = children(child(doc.documentElement,'resources'),'object').find(o => o.getAttribute('id') === id)!;
    paint = annotations.find(p => String(p.id) === id) || paint;
    const mesh = children(object,'mesh')[0];
    if (mesh) {
      const geometry = readMesh(mesh);
      for (const [i,face] of children(child(mesh,'triangles'),'triangle').entries()) {
        const value = paint?.mmSegmentationFacets?.find(p => p.triangle === i)?.dividing || face.getAttribute('paint_color') || face.getAttribute('slic3rpe:mmu_segmentation');
        if (value) faces.push(JSON.stringify([geometry.triangles.slice(i*3,i*3+3).map(v => new Vector3(...geometry.vertices.slice(v*3,v*3+3) as [number,number,number]).applyMatrix4(transform).toArray().map(n => n.toFixed(5))),value]));
      }
    } else for (const ref of children(child(object,'components'),'component')) visit(safePath(Array.from(ref.attributes).find(a => a.localName === 'path')?.value || path),ref.getAttribute('objectid')!,transform.clone().multiply(matrix(ref.getAttribute('transform'))),paint);
  };
  const doc = xml(strFromU8(files[path]));
  for (const item of children(child(doc.documentElement,'build'),'item')) visit(path,item.getAttribute('objectid')!,matrix(item.getAttribute('transform')));
  return faces.sort();
}


