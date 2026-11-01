// 授权：右上角状态、首次打开的激活页、授权对话框。
// 只有“导出新的脱敏副本”需要授权；其余功能不受影响，所以激活页可以点“暂不激活”。

const DISMISS_KEY = 'moyin.license.dismissedAt';

function $(id) {
  return document.getElementById(id);
}

function dateText(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function licenseBadgeText(status) {
  if (!status) return { text: '正在读取授权…', tone: '' };
  switch (status.state) {
    case 'valid':
      if (status.plan === 'perpetual') return { text: '已授权 · 永久', tone: 'ok' };
      if (status.plan === 'trial') return { text: `试用 · 剩 ${status.daysLeft} 天`, tone: status.daysLeft <= 2 ? 'warn' : 'ok' };
      return { text: `已授权 · ${status.planLabel} · 到 ${dateText(status.expires)}`, tone: status.daysLeft <= 7 ? 'warn' : 'ok' };
    case 'pending': return { text: `授权 ${dateText(status.issued)} 生效`, tone: 'warn' };
    case 'expired': return { text: status.plan === 'trial' ? '试用已到期 · 点此激活' : '授权已到期 · 点此续期', tone: 'bad' };
    case 'clock': return { text: '电脑时间异常 · 暂停导出', tone: 'bad' };
    case 'machine': return { text: '授权不属于这台电脑', tone: 'bad' };
    case 'updates': return { text: '版本超出永久授权升级期', tone: 'bad' };
    case 'invalid': return { text: '授权码损坏 · 请重新导入', tone: 'bad' };
    case 'device': return { text: '读不到设备码', tone: 'bad' };
    default: return { text: '未激活 · 点此激活', tone: 'warn' };
  }
}

export function licenseStatusLines(status) {
  if (!status || status.state === 'none') return [];
  const lines = [];
  if (status.id) lines.push(`授权编号 ${status.id} · ${status.planLabel}${status.customer ? ` · ${status.customer}` : ''}`);
  if (status.state === 'valid') {
    lines.push(status.expires ? `有效期至 ${dateText(status.expires)}（剩 ${status.daysLeft} 天）` : `永久有效${status.updatesUntil ? `，免费升级至 ${dateText(status.updatesUntil)}` : ''}`);
    if (status.next) lines.push(`已导入续期：${status.next.planLabel}，${dateText(status.next.issued)} 起生效${status.next.expires ? `，到 ${dateText(status.next.expires)}` : ''}`);
  } else {
    lines.push(licenseBadgeText(status).text);
  }
  if (status.version) lines.push(`墨隐 ${status.version}`);
  return lines;
}

export function initLicenseUi({ friendlyError, showToast }) {
  const dialog = $('licenseDialog');
  const badge = $('licenseBadge');
  let current = null;

  function render(status) {
    current = status;
    const view = licenseBadgeText(status);
    badge.textContent = view.text;
    badge.className = `license-badge ${view.tone}`.trim();
    $('licenseDevice').value = status?.device || '读取失败';
    $('licenseHowTo').textContent = status?.howToGet || '';
    $('licenseContacts').replaceChildren(...(status?.contacts || []).map((line) => {
      const item = document.createElement('li');
      item.textContent = line;
      return item;
    }));
    $('licensePublisher').textContent = status?.publisher || '';
    const box = $('licenseStatusBox');
    const lines = licenseStatusLines(status);
    box.replaceChildren(...lines.map((line) => {
      const row = document.createElement('div');
      row.textContent = line;
      return row;
    }));
    box.classList.toggle('hidden', !lines.length);
    box.classList.toggle('bad', Boolean(status && status.state !== 'valid' && status.state !== 'none'));
    const active = status?.state === 'valid';
    $('licenseKicker').textContent = active ? '授权与激活' : '激活墨隐';
    $('licenseTitle').textContent = active ? '授权状态' : (status?.activated ? '需要新的授权码' : '输入授权码，开始使用');
    $('licenseLater').textContent = active ? '关闭' : '暂不激活';
    $('licenseActivate').textContent = active ? '导入新授权码' : '激活';
    if (!$('licenseIntro').dataset.first) $('licenseIntro').dataset.first = $('licenseIntro').textContent;
    $('licenseIntro').textContent = active
      ? '续期或换套餐：把新的授权码粘贴到下面导入。续期码可以从当前授权到期那天生效，导入后不影响现在使用，到期自动接上。'
      : $('licenseIntro').dataset.first;
  }

  async function refresh() {
    try {
      render(await window.veilforge.licenseStatus());
    } catch (error) {
      badge.textContent = '授权读取失败';
      badge.className = 'license-badge bad';
    }
    return current;
  }

  function open() {
    $('licenseError').textContent = '';
    if (!dialog.open) dialog.showModal();
    $('licenseCode').focus();
  }

  async function activate(text) {
    const code = String(text || '').trim();
    if (!code) {
      $('licenseError').textContent = '请先粘贴授权码。';
      return;
    }
    try {
      const status = await window.veilforge.importLicense(code);
      render({ ...current, ...status });
      $('licenseCode').value = '';
      dialog.close();
      showToast(`激活成功：${licenseBadgeText(status).text}`);
    } catch (error) {
      $('licenseError').textContent = friendlyError(error);
    }
  }

  badge.addEventListener('click', open);
  $('licenseLater').addEventListener('click', () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* 无痕模式等 */ }
    dialog.close();
  });
  $('licenseActivate').addEventListener('click', () => activate($('licenseCode').value));
  $('licenseFromFile').addEventListener('click', async () => {
    try {
      const result = await window.veilforge.readLicenseFile();
      if (result?.text) await activate(result.text);
    } catch (error) {
      $('licenseError').textContent = friendlyError(error);
    }
  });
  $('licenseCopyDevice').addEventListener('click', async () => {
    try {
      const result = await window.veilforge.copyDeviceCode();
      showToast(`已复制设备码 ${result.device}`);
    } catch (error) {
      $('licenseError').textContent = friendlyError(error);
    }
  });

  // 首次打开（从没激活过）自动弹出激活页；之后只在状态异常时，每天最多自动提醒一次。
  void refresh().then((status) => {
    if (!status || status.state === 'valid') return;
    let dismissedAt = 0;
    try { dismissedAt = Number(localStorage.getItem(DISMISS_KEY)) || 0; } catch { dismissedAt = 0; }
    if (!status.activated || Date.now() - dismissedAt > 24 * 60 * 60 * 1000) open();
  });

  return {
    refresh,
    open,
    /** 导出被授权拦下时调用：打开激活页并显示原因。返回 true 表示是授权错误。 */
    handleExportError(error) {
      if (!/LOCAL_LICENSE_/u.test(String(error?.message || ''))) return false;
      void refresh().then(() => {
        open();
        $('licenseError').textContent = friendlyError(error);
      });
      return true;
    }
  };
}
