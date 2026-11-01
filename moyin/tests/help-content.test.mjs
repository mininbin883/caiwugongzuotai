import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOUR_STEPS, HELP_TASKS, HELP_FAQ } from '../src/core/help-content.mjs';
import { MODULE_DEFINITIONS, MODULE_IDS } from '../src/core/navigation-controller.mjs';

const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../src/renderer/renderer.mjs', import.meta.url), 'utf8');
const nav = readFileSync(new URL('../src/core/navigation-controller.mjs', import.meta.url), 'utf8');
const ui = html + renderer + nav;

test('新手引导高亮的位置都在页面上', () => {
  for (const step of TOUR_STEPS) {
    if (!step.target) continue;
    const id = step.target.match(/^#([\w-]+)$/u)?.[1];
    const moduleId = step.target.match(/data-module="(\w+)"/u)?.[1];
    if (id) assert.match(html, new RegExp(`id="${id}"`, 'u'), step.target);
    else assert.ok(moduleId && MODULE_IDS.includes(moduleId), step.target);
    if (step.module) assert.ok(MODULE_IDS.includes(step.module));
  }
});

test('帮助里引号中的按钮名称在界面上都存在', () => {
  const texts = [...TOUR_STEPS.map((step) => step.body), ...HELP_TASKS.flatMap((task) => task.steps), ...HELP_FAQ.map((item) => item.a),
    ...Object.values(MODULE_DEFINITIONS).flatMap((definition) => definition.checklist)];
  const ignore = new Set(['给 AI 的要求', '筛查结果', '建筑业税务风险筛查', '标准', '已完成', '接下来', '名称：']);
  for (const text of texts) {
    for (const [, name] of text.matchAll(/“([^”]+)”/gu)) {
      if (ignore.has(name)) continue;
      assert.ok(ui.includes(name), `界面上找不到“${name}”`);
    }
  }
  for (const task of HELP_TASKS) assert.ok(MODULE_IDS.includes(task.module));
});

test('页面说明不再提图片或技术名词', () => {
  const copy = JSON.stringify(MODULE_DEFINITIONS);
  for (const word of ['图片', 'AES', '映射', 'NER']) assert.ok(!copy.includes(word), word);
});
