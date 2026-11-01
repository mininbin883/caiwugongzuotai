// 新手引导（逐步高亮界面上的位置）与“使用帮助”对话框。
import { TOUR_STEPS, HELP_TASKS, HELP_FAQ } from '../core/help-content.mjs';

const SEEN_KEY = 'moyin.tour.seen.v1';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function readSeen() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}

function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* 无痕模式等：只是下次还会显示 */ }
}

export function initGuide({ setActiveModule }) {
  const overlay = document.getElementById('tourOverlay');
  const spotlight = document.getElementById('tourSpotlight');
  const card = document.getElementById('tourCard');
  const helpDialog = document.getElementById('helpDialog');
  let index = -1;
  let current = null;

  function place() {
    if (index < 0) return;
    const step = TOUR_STEPS[index];
    const target = step.target ? document.querySelector(step.target) : null;
    const rect = target && target.offsetParent !== null ? target.getBoundingClientRect() : null;
    const margin = 16;
    if (!rect || !rect.width) {
      spotlight.classList.add('centered');
      spotlight.style.cssText = '';
      card.style.cssText = '';
      card.classList.add('centered');
      return;
    }
    spotlight.classList.remove('centered');
    card.classList.remove('centered');
    const pad = 6;
    spotlight.style.cssText = `top:${rect.top - pad}px;left:${rect.left - pad}px;width:${rect.width + pad * 2}px;height:${rect.height + pad * 2}px`;
    const cardRect = card.getBoundingClientRect();
    const width = Math.min(380, window.innerWidth - margin * 2);
    let top = rect.bottom + 14;
    if (top + cardRect.height > window.innerHeight - margin) top = Math.max(margin, rect.top - cardRect.height - 14);
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    card.style.cssText = `top:${top}px;left:${left}px;width:${width}px`;
  }

  function render() {
    const step = TOUR_STEPS[index];
    if (step.module) setActiveModule(step.module);
    card.replaceChildren();
    card.append(el('div', 'tour-count', `新手引导 ${index + 1} / ${TOUR_STEPS.length}`));
    card.append(el('h3', 'tour-title', step.title));
    card.append(el('p', 'tour-body', step.body));
    if (step.steps) {
      const list = el('ol', 'tour-flow');
      for (const item of step.steps) list.append(el('li', '', item));
      card.append(list);
    }
    const actions = el('div', 'tour-actions');
    const skip = el('button', 'link-button tour-skip', index === TOUR_STEPS.length - 1 ? '' : '跳过引导');
    skip.type = 'button';
    skip.addEventListener('click', stop);
    const back = el('button', 'button button-ghost button-small', '上一步');
    back.type = 'button';
    back.disabled = index === 0;
    back.addEventListener('click', () => go(index - 1));
    const next = el('button', 'button button-dark button-small', index === TOUR_STEPS.length - 1 ? '开始使用' : '下一步');
    next.type = 'button';
    next.addEventListener('click', () => (index === TOUR_STEPS.length - 1 ? stop() : go(index + 1)));
    actions.append(skip, back, next);
    card.append(actions);
    // 先让页面切换完成，再按目标位置摆放
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = step.target ? document.querySelector(step.target) : null;
      target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      place();
      next.focus();
    }));
  }

  function go(nextIndex) {
    index = Math.max(0, Math.min(TOUR_STEPS.length - 1, nextIndex));
    render();
  }

  function start() {
    if (helpDialog.open) helpDialog.close();
    current = document.activeElement;
    overlay.classList.remove('hidden');
    document.body.classList.add('touring');
    go(0);
  }

  function stop() {
    index = -1;
    overlay.classList.add('hidden');
    document.body.classList.remove('touring');
    markSeen();
    setActiveModule('redact');
    current?.focus?.();
  }

  window.addEventListener('resize', place);
  document.addEventListener('keydown', (event) => {
    if (index < 0) return;
    if (event.key === 'Escape') stop();
    else if (event.key === 'ArrowRight') go(index + 1);
    else if (event.key === 'ArrowLeft') go(index - 1);
  });

  // 使用帮助
  function buildHelp() {
    const tasks = document.getElementById('helpTasks');
    tasks.replaceChildren(...HELP_TASKS.map((task) => {
      const box = el('section', 'help-task');
      const head = el('div', 'help-task-head');
      head.append(el('h3', '', task.title));
      const go = el('button', 'link-button', '去这一页 →');
      go.type = 'button';
      go.addEventListener('click', () => {
        helpDialog.close();
        setActiveModule(task.module);
      });
      head.append(go);
      box.append(head);
      const list = el('ol', 'help-steps');
      for (const step of task.steps) list.append(el('li', '', step));
      box.append(list);
      return box;
    }));
    const faq = document.getElementById('helpFaq');
    faq.replaceChildren(...HELP_FAQ.map((item) => {
      const details = el('details', 'help-faq-item');
      details.append(el('summary', '', item.q));
      details.append(el('p', '', item.a));
      return details;
    }));
  }

  buildHelp();
  document.getElementById('helpButton').addEventListener('click', () => helpDialog.showModal());
  document.getElementById('helpReplayTour').addEventListener('click', start);
  document.getElementById('helpClose').addEventListener('click', () => helpDialog.close());

  return {
    start,
    /** 第一次打开时自动开始（等激活页等对话框关掉之后）。 */
    maybeStartFirstRun() {
      if (readSeen()) return;
      const blocking = document.querySelector('dialog[open]');
      if (blocking) {
        blocking.addEventListener('close', () => setTimeout(() => this.maybeStartFirstRun(), 200), { once: true });
        return;
      }
      start();
    }
  };
}
