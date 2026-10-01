/**
 * Знімки зрізу 2 у справжньому браузері (Chromium): сценарії, кнопка аналізу, пояснення недоступності.
 * УВАГА: відповіді «агента» тут дає ПІДСТАВНИЙ клієнт сценарію знімків (не AI) — це перевірка інтерфейсу й логіки,
 * а не доказ якості аналізу. Платних викликів немає. Запуск: node --import tsx scripts/walkthrough-scenario.ts
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright-core';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { seedDemoCase } from '../src/demo.ts';
import { ScriptedDemoClient } from '../src/runs.ts';
import { loadInstruction } from '../src/ai/prompt.ts';

const OUT = 'docs/demo';
mkdirSync(OUT, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'cx-walk2-'));

async function launch(withAnalyst: boolean) {
  const db = openDb(join(dir, withAnalyst ? 'a.sqlite' : 'b.sqlite'));
  const client = new ScriptedDemoClient((input) => {
    const out = structuredClone(input.head_content);
    out.summary = `Підставна відповідь сценарію знімків (не AI): джерел у запиті ${input.sources.length}.`;
    if (!out.claims.some((c) => c.id === 'C1') && input.sources.some((s) => s.id === 'SRC-02')) {
      out.claims.push({ id: 'C1', text: 'Пропозицію замовника (єдиний канал, категорії, строки) ще не погоджено з командами-джерелами', type: 'improvement_proposal', source_id: 'SRC-02', quote: 'Це лише моя пропозиція, із командами-джерелами її ще не погоджували.', scope: 'Пропозиція замовника; TO-BE, не AS-IS' });
    }
    return out;
  });
  const server = createApp({ db, mode: 'demo', accessCode: 'walk2', analyst: withAnalyst ? { client, instruction: loadInstruction() } : undefined });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { db, url: `http://localhost:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function shot(page: Page, name: string) { await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }); console.log('знімок', name); }

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
try {
  // ── 1. Деморежим без моделі: пояснення, чому AI недоступний; сценарії; об’єднена прогалина ──
  const a = await launch(false);
  seedDemoCase(a.db, 'demo');
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'uk-UA' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(`${a.url}/login?code=walk2`);
  await page.waitForSelector('text=Навчальні сценарії');
  await shot(page, '17-список-зі-сценаріями');

  await page.getByRole('link', { name: /ДЕМО: Зміна умов/ }).click();
  await page.waitForSelector('text=Критичні прогалини');
  const text = await page.locator('#app').innerText();
  assert.ok(!text.includes('Окремих полів'), 'пояснення внутрішньої реалізації прибрано');
  const gapBlock = await page.locator('[data-block=gaps] .blocker').count();
  assert.equal(gapBlock, 1, 'питання Q1 і невизначений перехід S5 — одна прогалина');
  const gapText = await page.locator('[data-block=gaps]').innerText();
  assert.match(gapText, /Наслідки для кроків/);
  assert.match(gapText, /S5/);
  assert.match(await page.locator('[data-ai-note]').innerText(), /деморежим/);
  assert.equal(await page.getByRole('button', { name: /Оновити аналіз \(AI\)/ }).isDisabled(), true);
  await shot(page, '18-прогалина-питання-і-перехід-разом');

  await page.goto(`${a.url}/#/`);
  await page.getByRole('button', { name: 'Створити сценарій Б' }).click();
  await page.waitForSelector('[data-block=scenario]');
  assert.match(await page.locator('[data-block=scenario]').innerText(), /Етап 0 з 5/);
  await shot(page, '19-сценарій-Б-до-початку-деморежим');
  await a.close();

  // ── 2. З підставним аналітичним клієнтом (не AI): етапи, запуск, блокування наступного етапу ──
  const b = await launch(true);
  const page2 = await (await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'uk-UA' })).newPage();
  page2.on('dialog', (d) => d.accept());
  await page2.goto(`${b.url}/login?code=walk2`);
  await page2.waitForSelector('text=Навчальні сценарії');
  await page2.getByRole('button', { name: 'Створити сценарій Б' }).click();
  await page2.waitForSelector('[data-block=scenario]');
  await page2.getByRole('button', { name: /Додати матеріали етапу 1/ }).click();
  await page2.waitForSelector('text=Етап 1 з 5');
  assert.equal(await page2.getByRole('button', { name: /Додати матеріали етапу 2/ }).isDisabled(), true, 'наступний етап заблоковано до опрацювання');
  await shot(page2, '20-етап-1-додано-наступний-заблоковано');
  await page2.getByRole('button', { name: /Оновити аналіз \(підставний клієнт, не AI\)/ }).click();
  await page2.waitForSelector('text=підставна відповідь тесту, не AI');
  await page2.waitForSelector('[data-block=lastrun]');
  assert.match(await page2.locator('[data-block=lastrun]').innerText(), /завершено/);
  assert.equal(await page2.getByRole('button', { name: /Додати матеріали етапу 2/ }).isEnabled(), true, 'після опрацювання етап 2 доступний');
  await shot(page2, '21-після-запуску-етап-2-доступний');
  await b.close();
} finally {
  await browser.close();
}
console.log('OK');
