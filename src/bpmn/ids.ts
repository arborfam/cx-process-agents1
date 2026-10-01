/**
 * Контракт ID елементів схеми. Це єдина домовленість між генератором і незалежним читачем:
 * задача кроку має ID `Task_<ID кроку>`. Решта (доріжки, шлюзи, переходи) читач виводить зі структури файлу.
 */
export const STEP_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const MAX_STEP_ID = 40;

export const ID = {
  definitions: 'Definitions_1',
  collaboration: 'Collaboration_1',
  participant: 'Participant_1',
  process: 'Process_1',
  laneSet: 'LaneSet_1',
  start: 'StartEvent_1',
  startFlow: 'Flow_start',
  lane: (index: number): string => `Lane_${index}`,
  task: (stepId: string): string => `Task_${stepId}`,
  gateway: (stepId: string): string => `Gateway_${stepId}`,
  toGateway: (stepId: string): string => `Flow_${stepId}_g`,
  branchFlow: (stepId: string, k: number): string => `Flow_${stepId}_${k}`,
  end: (stepId: string, k: number): string => `End_${stepId}_${k}`,
} as const;

export const TASK_PREFIX = 'Task_';

export const NS = {
  bpmn: 'http://www.omg.org/spec/BPMN/20100524/MODEL',
  bpmndi: 'http://www.omg.org/spec/BPMN/20100524/DI',
  dc: 'http://www.omg.org/spec/DD/20100524/DC',
  di: 'http://www.omg.org/spec/DD/20100524/DI',
  cx: 'urn:cx-process-agents:as-is-binding',
} as const;

export const GENERATOR_NAME = 'cx-bpmn-generator-3a';
