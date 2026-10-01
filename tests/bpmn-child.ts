/** Допоміжний запуск в окремому процесі ОС: node --import tsx tests/bpmn-child.ts <номер процесу>. Друкує JSON. */
import { createHash } from 'node:crypto';
import { generateBpmn } from '../src/bpmn/generate.ts';
import { makeProcess } from './bpmn-gen.ts';

const i = Number(process.argv[2]);
const r = await generateBpmn(makeProcess(i));
process.stdout.write(JSON.stringify({ i, status: r.status, sha: r.status === 'ok' ? createHash('sha256').update(r.bpmn).digest('hex') : null, pid: process.pid }) + '\n');
