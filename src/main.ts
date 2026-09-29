import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { createApp } from './server.ts';
import { seedDemoCase } from './demo.ts';

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
  if (process.argv.includes('--seed-demo')) {
    const id = seedDemoCase(db, cfg.mode);
    console.log(`Демо-кейс готовий (ID: ${id}).`);
  }
  const code = loadAccessCode(cfg.dbPath);
  const server = createApp({ db, mode: cfg.mode, accessCode: code });
  server.listen(cfg.port, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    console.log('');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(' ДЕМОРЕЖИМ — не AI. Перевіряється програмна логіка.');
    console.log(` База кейсів: ${cfg.dbPath}`);
    console.log(` Відкрийте: http://localhost:${port}/login?code=${code}`);
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
