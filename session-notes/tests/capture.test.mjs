import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitMarkdown, collectSources, sourceStrings, blocksFromView,
  tableToMarkdown, fenceSources, captureFromElement, readSelection, topLevelCaptures, previewBlock,
} from '../src/main.js';

test('splitMarkdown finds pipe tables with and without outer pipes', () => {
  const markdown = 'Intro text.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nOutro text.\n\nName | Value\n---- | ------\nx    | y';
  const blocks = splitMarkdown(markdown);
  assert.equal(blocks.filter(block => block.type === 'table').length, 2);
  assert.equal(blocks.filter(block => block.type === 'text').length, 2);
  assert.match(blocks.find(block => block.type === 'table').markdown, /\| 1 \| 2 \|/);
});

test('splitMarkdown recognises backtick and tilde fences, HTML and LaTeX tables', () => {
  const markdown = [
    '```mermaid', 'graph TD; A-->B', '```',
    '~~~python', 'print("hi")', '~~~',
    '<table><tr><th>A</th></tr><tr><td>1</td></tr></table>',
    '\\begin{tabular}{cc} a & b \\\\ c & d \\end{tabular}',
  ].join('\n');
  const types = splitMarkdown(markdown).map(block => block.type);
  assert.deepEqual(types, ['diagram', 'code', 'table', 'table']);
});

test('collectSources reads tables and diagrams from structured tool payloads', () => {
  const part = {
    type: 'tool', text: 'short answer',
    data: { markdown: '| x | y |\n|---|---|' },
    output: [{ text: '```mermaid\ngraph LR; A-->B\n```' }],
    result: { content: [{ text: 'nested text' }] },
    toolCallId: 'ignore-me',
  };
  const sources = collectSources(part);
  assert.ok(sources.some(source => source.includes('| x | y |')));
  assert.ok(sources.some(source => source.includes('graph LR')));
  assert.ok(sources.includes('nested text'));
  assert.ok(!sources.includes('ignore-me'));
});

test('sourceStrings and blocksFromView scan transcript and fallback messages', () => {
  const view = { transcript: [{ parts: [
    { text: 'plain paragraph' },
    { type: 'tool', data: { markdown: '| a | b |\n|---|---|' } },
  ] }] };
  assert.equal(sourceStrings(view).length, 2);
  const blocks = blocksFromView(view);
  assert.ok(blocks.some(block => block.type === 'text' && block.markdown.includes('plain paragraph')));
  assert.ok(blocks.some(block => block.type === 'table'));

  const fallback = { messages: [{ message: { content: [{ text: '```mermaid\ngraph TD; A-->B\n```' }] } }] };
  assert.ok(blocksFromView(fallback).some(block => block.type === 'diagram'));
});

test('fenceSources separates diagrams from code blocks', () => {
  const source = '```mermaid\ngraph TD; A-->B\n```\n\n```js\nconst x = 1;\n```';
  assert.equal(fenceSources(source, true).length, 1);
  assert.equal(fenceSources(source, false).length, 1);
  assert.equal(fenceSources(source, true)[0].lang, 'mermaid');
  assert.equal(fenceSources(source, false)[0].lang, 'js');
});

test('tableToMarkdown converts a rendered table into a Markdown table', () => {
  const cell = text => ({ textContent: text });
  const row = (cells, header = false) => ({
    querySelectorAll: selector => selector === 'th,td' ? cells : [],
    _header: header,
  });
  const header = row([cell('Name'), cell('Marks')]);
  const data = row([cell('A| B'), cell('9')]);
  const table = {
    querySelectorAll: selector => selector === 'tr' ? [header, data] : [],
    querySelector: selector => selector === 'thead tr' ? header : null,
    outerHTML: '<table></table>',
  };
  const markdown = tableToMarkdown(table);
  assert.match(markdown, /\| Name \| Marks \|/);
  assert.match(markdown, /\| --- \| --- \|/);
  assert.match(markdown, /A\\\| B/);
});

test('captureFromElement prefers the original diagram source and skips nested matches', () => {
  const source = '```mermaid\ngraph LR; A-->B\n```';
  const node = { matches: selector => selector.includes('md-mermaid'), textContent: 'rendered svg text', outerHTML: '<div></div>' };
  const block = captureFromElement(node, source, [node]);
  assert.equal(block.type, 'diagram');
  assert.equal(block.caption, 'Diagram');
  assert.match(block.markdown, /graph LR; A-->B/);

  const nested = { matches: selector => selector === 'table', contains: other => other === inner, textContent: 'x' };
  const inner = { matches: selector => selector === 'svg', contains: () => false, outerHTML: '<svg/>' };
  assert.deepEqual(topLevelCaptures({ querySelectorAll: () => [nested, inner] }), [nested]);
});

test('previewBlock makes a short plain-text label for the picker', () => {
  assert.equal(previewBlock({ type: 'table', markdown: '| A | B |\n|---|---|\n| 1 | 2 |' }), 'A B 1 2');
  assert.equal(previewBlock({ type: 'diagram', markdown: '```mermaid\ngraph TD; A-->B\n```' }), 'graph TD; A-->B');
  assert.equal(previewBlock({ type: 'text', markdown: '**Bold** and `code`' }), 'Bold and code');
  assert.equal(previewBlock({ type: 'code', markdown: '' }), 'code');
});

test('readSelection reads from shadow DOM scopes as well as the document', () => {
  const fakeRoot = { getRootNode: () => ({ getSelection: () => ({ toString: () => '  selected words  ' }) }) };
  assert.equal(readSelection(null, fakeRoot), 'selected words');
});
