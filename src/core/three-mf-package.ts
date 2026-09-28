import { strToU8 } from 'fflate';
import { xml, serialize } from './three-mf-xml';

/** A new package manifest, with no relationships or sidecars from the upload. */
export function packageFiles(modelPath: string): Record<string,Uint8Array> {
  const rels = xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  const relation = rels.createElementNS(rels.documentElement.namespaceURI!,'Relationship');
  relation.setAttribute('Id','model'); relation.setAttribute('Target',`/${modelPath}`);
  relation.setAttribute('Type','http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel'); rels.documentElement.appendChild(relation);
  return {
    '_rels/.rels':serialize(rels),
    '[Content_Types].xml':strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="application/octet-stream"/><Default Extension="json" ContentType="application/json"/></Types>'),
  };
}
