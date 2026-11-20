import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitMarkdown, collectSources, sourceStrings, blocksFromView,
  tableToMarkdown, fenceSources, captureFromElement, readSelection, topLevelCaptures, previewBlock,
  diagramSources, findRegions, regionToBlock, rectsOverlap, REGION_SELECTOR,
  regionAtPointFromRects, noteToMarkdown, printableDocumentHtml,
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

test('tableToMarkdown sizes the separator to the widest row and handles line breaks', () => {
  const cell = (text, innerText) => ({ textContent: text, innerText });
  const row = cells => ({ querySelectorAll: selector => selector === 'th,td' ? cells : [] });
  const header = row([cell('A'), cell('B')]);
  const data = row([cell('one\ntwo', 'one\ntwo'), cell('2'), cell('3')]);
  const table = {
    querySelectorAll: selector => selector === 'tr' ? [header, data] : [],
    querySelector: selector => selector === 'thead tr' ? header : null,
  };
  const lines = tableToMarkdown(table).split('\n');
  assert.equal(lines[1], '| --- | --- | --- |');
  assert.equal(lines[2], '| one two | 2 | 3 |');
});

test('noteToMarkdown exports note metadata, prose and captured blocks', () => {
  const markdown = noteToMarkdown({
    title: 'Complex numbers', sessionTitle: 'IB AA HL', text: 'Remember De Moivre.',
    topics: ['Complex'], tags: ['exam', 'revision'],
    nodes: [{ id: 'n1', label: 'Polar form' }],
    blocks: [
      { type: 'table', caption: 'Marks', markdown: '| A | B |\n|---|---|\n| 1 | 2 |' },
      { type: 'diagram', caption: 'Map', markdown: '```mermaid\ngraph LR; A-->B\n```' },
    ],
  });
  assert.match(markdown, /^# Complex numbers\n/);
  assert.match(markdown, /- \*\*Session:\*\* IB AA HL/);
  assert.match(markdown, /- \*\*Tags:\*\* exam, revision/);
  assert.match(markdown, /- \*\*Nodes:\*\* Polar form/);
  assert.match(markdown, /Remember De Moivre\./);
  assert.match(markdown, /### 1\. Marks/);
  assert.match(markdown, /### 2\. Map/);
  assert.match(markdown, /```mermaid/);
});

test('noteToMarkdown expands placed blocks at their note-text positions', () => {
  const markdown = noteToMarkdown({
    title: 'Positioned',
    text: 'Intro text.\n\n[[block:b2]]\n\nConclusion text.',
    blocks: [
      { id: 'b1', type: 'text', caption: 'Loose', markdown: 'unused block' },
      { id: 'b2', type: 'diagram', caption: 'Map', markdown: '```mermaid\ngraph LR; A-->B\n```' },
    ],
  });
  const intro = markdown.indexOf('Intro text.');
  const diagram = markdown.indexOf('graph LR; A-->B');
  const conclusion = markdown.indexOf('Conclusion text.');
  assert.ok(intro >= 0 && diagram > intro && conclusion > diagram);
  assert.ok(!markdown.includes('[[block:'));
  assert.equal(markdown.split('graph LR; A-->B').length - 1, 1);
  assert.match(markdown, /## Captured blocks[\s\S]*unused block/);
});

test('printableDocumentHtml builds a standalone print document with the rendered note', () => {
  const html = printableDocumentHtml('<h1>Title</h1><svg></svg>', 'A < B & C', '.lh-prose { color: red; }');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>A &lt; B &amp; C<\/title>/);
  assert.match(html, /\.lh-prose \{ color: red; \}/);
  assert.match(html, /<main class="sn-print-root"><h1>Title<\/h1><svg><\/svg><\/main>/);
  assert.match(html, /@page \{ margin: 14mm; \}/);
  assert.match(html, /body \* \{ visibility: visible !important; \}/);
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

test('diagramSources reads Mermaid from plan tool inputs as well as Markdown fences', () => {
  const view = {
    transcript: [{ parts: [{ type: 'tool-plan_init', input: { mermaid: 'graph TD; A-->B' } }] }],
    messages: [{ role: 'assistant', content: [
      { type: 'text', text: '```mermaid\ngraph LR; C-->D\n```' },
      { type: 'toolCall', name: 'plan_init', arguments: { mermaid: 'graph TB; E-->F' } },
    ] }],
  };
  const sources = diagramSources(view);
  assert.equal(sources.length, 3);
  assert.ok(sources.every(source => source.startsWith('```mermaid')));
  assert.ok(sources.some(source => source.includes('A-->B')));
  assert.ok(sources.some(source => source.includes('C-->D')));
  assert.ok(sources.some(source => source.includes('E-->F')));
});

test('REGION_SELECTOR covers settled-session DOM shapes as well as fresh ones', () => {
  for (const selector of [
    '.lh-prose', '[data-testid="user-message"]', '[data-source-message-id]',
    '[data-testid="tool-call-card"]', '[data-testid="answered-card"]',
    '[data-testid="submitted-images"] img', '[data-streamdown="image-wrapper"]',
    '[data-testid="md-mermaid"]', 'table', '[data-streamdown="code-block"]',
  ]) {
    assert.ok(REGION_SELECTOR.includes(selector), `missing selector: ${selector}`);
  }
});

test('findRegions keeps structured blocks ahead of their transcript wrappers', () => {
  const selectors = {
    table: ['table[data-streamdown="table"]', 'table'],
    mermaid: ['[data-testid="md-mermaid"]'],
    p: ['p'],
    wrapper: ['[data-source-message-id]'],
  };
  const make = (kind, children = []) => ({
    children,
    matches: value => value.split(', ').some(part => selectors[kind].includes(part)),
    contains: other => children.includes(other) || children.some(child => child.contains?.(other)),
    closest: () => null,
  });
  const table = make('table');
  const para = make('p');
  const diagram = make('mermaid');
  const wrapper = make('wrapper', [table, para, diagram]);
  for (const child of wrapper.children) child.parentElement = wrapper;
  const regions = findRegions({ querySelectorAll: () => [wrapper, table, para, diagram] });
  assert.deepEqual(regions.map(region => region.type), ['table', 'text', 'diagram']);
  assert.deepEqual(regions.map(region => region.diagramIndex), [-1, -1, 0]);
});

test('findRegions returns every unique region in a long session', () => {
  const nodes = Array.from({ length: 160 }, (_, i) => {
    const text = `paragraph ${i}`;
    return {
      innerText: text,
      textContent: text,
      matches: value => value.split(', ').includes('p'),
      contains: () => false,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }),
    };
  });
  const regions = findRegions({ querySelectorAll: () => nodes });
  assert.equal(regions.length, 160);
});

test('findRegions merges transcript roots with hit-tested nodes and drops hidden ones', () => {
  const make = (kind, rect = { width: 100, height: 20 }) => ({
    matches: value => value.split(', ').some(part => [kind].includes(part)),
    contains: () => false,
    closest: () => null,
    getBoundingClientRect: () => rect,
  });
  const paragraph = make('p');
  const collapsed = make('p', { width: 0, height: 0 });
  const roots = [
    { querySelectorAll: () => [paragraph] },
    { querySelectorAll: () => [collapsed] },
  ];
  const hit = make('p');
  const regions = findRegions(...roots, { querySelectorAll: () => [hit] });
  assert.equal(regions.length, 2);
  assert.ok(regions.some(region => region.node === hit));
  assert.ok(!regions.some(region => region.node === collapsed));
});

test('findRegions accepts an array of nodes and drops giant session wrappers', () => {
  const make = (kind, childCount = 0) => ({
    matches: value => value.split(', ').some(part => [kind].includes(part)),
    contains: () => false,
    closest: () => null,
    getBoundingClientRect: () => ({ width: 200, height: 20 }),
    querySelectorAll: () => Array.from({ length: childCount }, () => ({})),
  });
  const paragraph = make('p');
  const giant = make('[data-source-message-id]', 5);
  const regions = findRegions([paragraph, giant]);
  assert.deepEqual(regions.map(region => region.node), [paragraph]);
});

test('findRegions drops nodes with whole-session text', () => {
  const make = text => ({
    matches: value => value.split(', ').includes('p'),
    contains: () => false,
    closest: () => null,
    getBoundingClientRect: () => ({ width: 400, height: 20 }),
    innerText: text,
    textContent: text,
    querySelectorAll: () => [],
  });
  const giant = make('x'.repeat(900));
  const fine = make('a short paragraph');
  assert.deepEqual(findRegions([giant, fine]).map(region => region.node), [fine]);
});

test('regionToBlock reproduces tables, diagrams, code and text', () => {
  const cell = text => ({ textContent: text });
  const row = cells => ({ querySelectorAll: () => cells });
  const header = row([cell('A'), cell('B')]);
  const data = row([cell('1'), cell('2')]);
  const table = {
    matches: selector => selector === 'table',
    querySelectorAll: selector => selector === 'tr' ? [header, data] : [],
    querySelector: selector => selector === 'thead tr' ? header : null,
    outerHTML: '<table></table>',
  };
  assert.match(regionToBlock({ type: 'table', node: table }).markdown, /\| A \| B \|/);

  const sources = ['```mermaid\ngraph LR; A-->B\n```'];
  const diagram = { type: 'diagram', node: {
    outerHTML: '<div/>', textContent: 'graph TB; X-->Y',
    querySelector: () => null,
  }, diagramIndex: 0 };
  assert.equal(regionToBlock(diagram, sources).markdown, sources[0]);
  assert.match(regionToBlock({ ...diagram, diagramIndex: 1 }, sources).markdown, /graph TB; X-->Y/);

  const image = { type: 'diagram', isImage: true, node: {
    matches: () => false,
    querySelector: () => ({ getAttribute: name => name === 'src' ? 'https://example.com/a.png' : 'Chart' }),
  } };
  assert.equal(regionToBlock(image).markdown, '![Chart](https://example.com/a.png)');

  const code = { type: 'code', node: {
    getAttribute: () => 'js', querySelector: () => ({ textContent: 'const x = 1;' }), textContent: '',
  } };
  assert.equal(regionToBlock(code).markdown, '```js\nconst x = 1;\n```');
  assert.equal(regionToBlock({ type: 'text', node: { innerText: '  hello  ' } }).markdown, 'hello');
});

test('regionToBlock collapses stacked math glyph lines', () => {
  const node = {
    innerText: '𝑧\nˉ\n=\n𝑎\n−\n𝑏\n𝑖\nz\nˉ\n=a−bi — the reflection across the real axis',
    textContent: '𝑧ˉ=𝑎−𝑏𝑖zˉ=a−bi — the reflection across the real axis',
  };
  assert.equal(
    regionToBlock({ type: 'text', node }).markdown,
    '𝑧ˉ=𝑎−𝑏𝑖zˉ=a−bi — the reflection across the real axis',
  );
});

test('rectsOverlap detects drag selection intersections', () => {
  const box = { left: 10, top: 10, right: 30, bottom: 30 };
  assert.equal(rectsOverlap(box, { left: 20, top: 20, right: 40, bottom: 40 }), true);
  assert.equal(rectsOverlap(box, { left: 31, top: 10, right: 40, bottom: 40 }), false);
});

test('readSelection reads from shadow DOM scopes as well as the document', () => {
  const fakeRoot = { getRootNode: () => ({ getSelection: () => ({ toString: () => '  selected words  ' }) }) };
  assert.equal(readSelection(null, fakeRoot), 'selected words');
});

test('regionAtPointFromRects picks the smallest cached region containing a click', () => {
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
  const matches = names => selector => names.some(name => selector.split(',').map(part => part.trim()).includes(name));
  const wrapper = { matches: () => false };
  const paragraph = { matches: matches(['p']) };
  const table = { matches: matches(['table']) };
  const entries = [
    { node: wrapper, rect: rect(0, 0, 500, 500) },
    { node: paragraph, rect: rect(10, 10, 200, 40) },
    { node: table, rect: rect(10, 50, 200, 90) },
  ];
  assert.equal(regionAtPointFromRects({ clientX: 100, clientY: 20 }, entries), paragraph);
  assert.equal(regionAtPointFromRects({ clientX: 100, clientY: 70 }, entries), table);
  assert.equal(regionAtPointFromRects({ clientX: 600, clientY: 20 }, entries), null);
});
