import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig, loadPricing } from './config.ts';
import { openDb } from './db.ts';
import { createApp } from './server.ts';
import { seedDemoCase } from './demo.ts';
import { recoverStuckRuns } from './runs.ts';
import { AnthropicAnalystClient } from './ai/anthropic-client.ts';
import { AnthropicBpmnClient } from './ai/anthropic-bpmn-client.ts';
import { makePolicy } from './ai/budget.ts';
import { loadBpmnInstruction, loadInstruction } from './ai/prompt.ts';

function loadAccessCode(dbPath: string): string {
  if (process.env.CX_ACCESS_CODE) return process.env.CX_ACCESS_CODE;
  const file = join(dirname(dbPath), 'access-code.txt');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dirname(file), { recursive: true });
  const code = randomBytes(9).toString('hex');
  writeFileSync(file, code + '\n', { mode: 0o600 });
  return code;
}

try {
  const cfg = loadConfig(process.env);
  const db = openDb(cfg.dbPath);
  const recovered = recoverStuckRuns(db);
  if (recovered) console.log(`Позначено помилкою запусків, перерваних попереднім завершенням: ${recovered}. Поточні версії не змінювались.`);
  if (process.argv.includes('--seed-demo')) {
    const id = seedDemoCase(db, cfg.mode);
    console.log(`Демо-кейс готовий (ID: ${id}).`);
  }
  const code = loadAccessCode(cfg.dbPath);
  let analyst;
  let reviewer;
  if (cfg.mode === 'real' && cfg.model) {
    const policy = makePolicy(cfg.model, loadPricing());
    analyst = { client: new AnthropicAnalystClient(cfg.model, policy), policy, instruction: loadInstruction() };
    // Той самий бюджет, що й в агента 1: політика спільна, облік — по всіх запусках справжньої моделі.
    reviewer = { client: new AnthropicBpmnClient(cfg.model, policy), policy, instruction: loadBpmnInstruction() };
  }
  const server = createApp({
    db, mode: cfg.mode, accessCode: code, analyst, reviewer,
    modelInfo: cfg.model ? { model: cfg.model.model, effort: cfg.model.effort, budgetTotalUsd: cfg.model.budgetTotalUsd, budgetPerRunUsd: cfg.model.budgetPerRunUsd } : undefined,
  });
  server.listen(cfg.port, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    console.log('');
    console.log('══════════════════════════════════════════════════════════════');
    if (cfg.mode === 'real' && cfg.model) {
      console.log(` РЕЖИМ СПРАВЖНЬОЇ МОДЕЛІ: ${cfg.model.model} (effort: ${cfg.model.effort}). Тексти джерел надсилаються постачальнику моделі.`);
      console.log(` Бюджет: $${cfg.model.budgetTotalUsd} загалом, $${cfg.model.budgetPerRunUsd} на запуск. Ключ у файли й журнали не пишеться.`);
    } else {
      console.log(' ДЕМОРЕЖИМ — не AI. Перевіряється програмна логіка.');
    }
    console.log(` База кейсів: ${cfg.dbPath}`);
    console.log(' Відкрийте в браузері це посилання (скопіюйте весь рядок нижче):');
    console.log('');
    console.log(`   http://localhost:${port}/login?code=${code}`);
    console.log('');
    console.log(' Зупинити: Ctrl+C. Дані збережуться й будуть доступні після перезапуску.');
    console.log('══════════════════════════════════════════════════════════════');
  });
  const stop = () => {
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (e) {
  console.error('Не вдалося запустити застосунок:', e instanceof Error ? e.message : e);
  process.exit(1);
}
