/** Строгий XML-розбір і розкладка: поведінка на межах. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, XmlError, escapeAttr, serialize, attr, elementChildren } from '../src/bpmn/xml.ts';
import { textProblem, wrapLines, neededTaskHeight } from '../src/bpmn/text.ts';

const bad = (xml: string, re: RegExp): void => assert.throws(() => parseXml(xml), (e: unknown) => e instanceof XmlError && re.test(e.message), xml);

test('строгий розбір відхиляє те, що поблажливі розбирачі мовчки «лагодять»', () => {
  bad('<a b="x"y"/>', /пробіл|Некоректне|значення/);
  bad('<a b="x" b="y"/>', /повторюється/);
  bad('<a b=x/>', /лапках/);
  bad('<a b="<"/>', /«<»/);
  bad('<a>&nbsp;</a>', /сутність/);
  bad('<a>a & b</a>', /сутність|«;»/);
  bad('<a>&#0;</a>', /недозволений/);
  bad('<a>&#xB;</a>', /недозволений/);
  bad('<a></b>', /не відповідає/);
  bad('<a><b></a>', /не відповідає|Не закритий/);
  bad('<a/><b/>', /Другий кореневий/);
  bad('<!DOCTYPE a><a/>', /DOCTYPE/);
  bad('<?pi x?><a/>', /Інструкції|Некоректна/);
  bad('<p:a/>', /Префікс/);
  bad('', /Немає кореневого/);
  bad('<a>\u000b</a>', /Недозволений символ/);
  bad('<a>x</a>trailing', /Текст поза/);
  bad('<a b="1" xmlns:p="u" xmlns:q="u" p:c="1" q:c="2"/>', /той самий простір/);
});

test('правильний розбір: сутності, символьні посилання, нормалізація значень атрибутів за стандартом XML', () => {
  const r = parseXml('<?xml version="1.0" encoding="UTF-8"?><a x="&quot;&amp;&lt;&gt;&apos;&#10;&#x41;&#9;" y="a\tb\nc">t&amp;&#233;</a>');
  assert.equal(attr(r, 'x'), '"&<>\'\nA\t', 'символьні посилання зберігаються');
  assert.equal(attr(r, 'y'), 'a b c', 'сирі \\t і \\n у значенні атрибута нормалізуються до пробілу (саме тому сира табуляція — втрата)');
  assert.deepEqual(r.children, ['t&é']);
});

test('екранування й серіалізація повертають той самий текст', () => {
  const nasty = 'a"b\'c&d<e>f\ng\rh\ti ✅ «» №';
  const xml = `<r v="${escapeAttr(nasty)}"/>`;
  assert.equal(attr(parseXml(xml), 'v'), nasty);
  const again = serialize(parseXml(xml), 0, false);
  assert.equal(attr(parseXml(again), 'v'), nasty);
});

test('простори імен: префікс не має значення, значення має URI', () => {
  const r = parseXml('<x:a xmlns:x="urn:u"><x:b/><c xmlns="urn:v"/></x:a>');
  assert.equal(r.ns, 'urn:u');
  const [b, c] = elementChildren(r);
  assert.equal(b!.ns, 'urn:u');
  assert.equal(c!.ns, 'urn:v');
});

test('перевірка допустимості тексту: що можна, а що ні', () => {
  assert.equal(textProblem('Звичайний текст «з лапками» & <b> "x" \'y\' ✅'), null);
  assert.equal(textProblem('рядок\nз переносом'), null);
  for (const t of ['a\tb', 'a\rb', 'a\u0000b', 'a\u000bb', 'a\u001fb', 'a\u0085b', 'a￾b', 'a\ud800b']) assert.notEqual(textProblem(t), null, JSON.stringify(t));
});

test('оцінка розміру тексту: більше тексту — більше висоти; розмір блока обирається за найдовшою дією', () => {
  assert.ok(wrapLines('слово '.repeat(30), 100).length > wrapLines('слово', 100).length);
  assert.equal(wrapLines('а'.repeat(500), 100).every((l) => l.length > 0), true, 'надто довге слово розбивається');
  assert.ok(neededTaskHeight('слово '.repeat(40), 140) > neededTaskHeight('слово', 140));
});

// Збій розкладки більше не перевіряється тут: розкладку виконує крок пайплайна власниці, і його помилка —
// це `verification_failed` зі стадією `layout_step.mjs` (tests/pipeline-run.test.ts).
