import { archive, box, meshXml } from './fixtures';

export const scaledCases = [
  {name:'up',transform:'2 0 0 0 2 0 0 0 2 20 20 0',bounds:{minX:20,minY:20,maxX:60,maxY:60},height:8},
  {name:'down',transform:'0.5 0 0 0 0.5 0 0 0 0.5 90 20 0',bounds:{minX:90,minY:20,maxX:100,maxY:30},height:2},
  {name:'nonuniform',transform:'1.5 0 0 0 0.75 0 0 0 3 130 20 0',bounds:{minX:130,minY:20,maxX:160,maxY:35},height:12},
  {name:'rotated',transform:'0 1.25 0 -0.5 0 0 0 0 4 50 110 0',bounds:{minX:40,minY:110,maxX:50,maxY:135},height:16},
  {name:'mirrored',transform:'-1.5 0 0 0 0.75 0 0 0 2 130 110 0',bounds:{minX:100,minY:110,maxX:130,maxY:125},height:8},
];

export function scaledProject(cases = scaledCases): ArrayBuffer {
  const mesh = meshXml(box(0,0,20,20,4));
  const resources = cases.map((_,i) => `<object id="${i+1}" type="model">${mesh}</object>`).join('');
  const build = cases.map((c,i) => `<item objectid="${i+1}" transform="${c.transform}"/>`).join('');
  const config = `<config>${cases.map((c,i) => `<object id="${i+1}" instances_count="1"><metadata type="object" key="name" value="${c.name}"/><volume firstid="0" lastid="11"><metadata type="volume" key="name" value="${c.name} body"/><metadata type="volume" key="volume_type" value="ModelPart"/><metadata type="volume" key="fill_density" value="19%"/></volume></object>`).join('')}</config>`;
  return archive(resources,build,config);
}

// Decode the serialized 3MF coordinates independently of the app's Three.js
// import/export transform helpers, so a mistaken inverse cannot cancel out.
export function worldPoint(point: number[], transform: string): number[] {
  const m = transform.split(/\s+/).map(Number), [x,y,z] = point;
  return [m[0]*x+m[3]*y+m[6]*z+m[9],m[1]*x+m[4]*y+m[7]*z+m[10],m[2]*x+m[5]*y+m[8]*z+m[11]];
}
