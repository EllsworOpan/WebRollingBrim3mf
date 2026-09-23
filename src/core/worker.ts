import { importProject, exportProject } from './three-mf';
import { generateBrims } from './brim';
import type { Project, WorkerRequest, WorkerResponse } from './types';
let project: Project | undefined;
self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  const send = (message: WorkerResponse) => self.postMessage(message);
  try {
    if (data.type === 'load') {
      project = importProject(data.name, data.bytes);
      const { source: _source, ...publicProject } = project;
      send({ type: 'loaded', id: data.id, project: publicProject });
    } else {
      if (!project) throw new Error('Load a model first.');
      const result = generateBrims(project, data.settings, data.enabled);
      if (data.type === 'generate') send({ type: 'generated', id: data.id, result });
      else send({ type: 'exported', id: data.id, bytes: exportProject(project, result) });
    }
  } catch (error) { send({ type: 'error', id: data.id, message: error instanceof Error ? error.message : String(error) }); }
};
