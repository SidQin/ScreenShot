document.addEventListener('DOMContentLoaded', function () {

  function showCancelBtn() {
    cancelBtn.style.display = 'block';
  }

  function hideCancelBtn() {
    cancelBtn.style.display = 'none';
  }

  /* ══════════════════════════════════════════
   * 主题管理
   * ══════════════════════════════════════════ */
  const THEME_KEY = 'ss_theme';

  function isMacOS() {
    return /mac/i.test(navigator.platform) || /Mac OS X/i.test(navigator.userAgent);
  }

  function resolveTheme(pref) {
    if (pref === 'glass')   return 'glass';
    if (pref === 'default') return 'default';
    return isMacOS() ? 'glass' : 'default';
  }

  function applyTheme(theme) {
    document.body.classList.toggle('theme-glass', theme === 'glass');
  }

  function syncThemeOptions(pref) {
    document.querySelectorAll('.theme-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === pref);
    });
  }

  const savedPref = localStorage.getItem(THEME_KEY) || 'auto';
  applyTheme(resolveTheme(savedPref));
  syncThemeOptions(savedPref);

  /* ── 提前检测当前 tab 是否受限 ── */
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      const url = tab.url || '';
      const isRestricted =
        url.startsWith('chrome://') ||
        url.startsWith('chrome-extension://') ||
        url.startsWith('edge://') ||
        url === '' ||
        url === 'about:blank' ||
        url === 'about:newtab';
      if (isRestricted) {
        captureBtn.disabled = true;
        captureBtn.textContent = '🚫 无法在此页面使用';
        showStatus('此页面为浏览器内置页面，无法截图\n请切换到普通网页后使用', 'error');
      }
    } catch (_) {}
  })();

  const settingsBtn      = document.getElementById('settings-btn');
  const settingsPanel    = document.getElementById('settings-panel');
  const settingsCloseBtn = document.getElementById('settings-close-btn');

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPanel.classList.toggle('show');
  });
  settingsCloseBtn.addEventListener('click', () => settingsPanel.classList.remove('show'));
  document.addEventListener('click', (e) => {
    if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) {
      settingsPanel.classList.remove('show');
    }
  });
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const pref = btn.dataset.theme;
      localStorage.setItem(THEME_KEY, pref);
      applyTheme(resolveTheme(pref));
      syncThemeOptions(pref);
      settingsPanel.classList.remove('show');
    });
  });

  /* ── 监听截图进度消息 ── */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'screenshotProgress' && request.message) {
      showStatus(request.message, 'info');
    }
  });

  /* ══════════════════════════════════════════
   * 文件名
   * ══════════════════════════════════════════ */
  function getScreenshotFilename() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const ext = imageFormat === 'jpeg' ? 'jpg' : 'png';
    return `ScreenShot_${date}_${time}.${ext}`;
  }

  /* ── DOM ── */
  const viewCapture  = document.getElementById('view-capture');
  const viewResult   = document.getElementById('view-result');
  const viewInfinite = document.getElementById('view-infinite');
  const viewSelect   = document.getElementById('view-select');
  const captureBtn   = document.getElementById('capture-btn');
  const statusDiv    = document.getElementById('status');
  const previewImg   = document.getElementById('preview-img');
  const downloadBtn  = document.getElementById('download-btn');
  const copyBtn      = document.getElementById('copy-btn');
  const retakeBtn    = document.getElementById('retake-btn');
  const resultStatus = document.getElementById('result-status');
  const previewWrap  = document.getElementById('preview-wrap');
  const cancelBtn    = document.getElementById('cancel-btn');

  /* ── 取消截图按钮事件 ── */
  cancelBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'cancelScreenshot' });
    cancelBtn.style.display = 'none';
    showStatus('正在取消截图...', 'info');
  });

  /* ── 图片格式选择 ── */
  const fmtPng   = document.getElementById('fmt-png');
  const fmtJpeg  = document.getElementById('fmt-jpeg');
  const qualityWrap  = document.getElementById('quality-wrap');
  const qualityRange = document.getElementById('quality-range');
  const qualityVal   = document.getElementById('quality-val');

  if (fmtPng && fmtJpeg) {
    fmtPng.addEventListener('click', () => {
      imageFormat = 'png';
      fmtPng.classList.add('selected');
      fmtJpeg.classList.remove('selected');
      if (qualityWrap) qualityWrap.style.display = 'none';
    });
    fmtJpeg.addEventListener('click', () => {
      imageFormat = 'jpeg';
      fmtJpeg.classList.add('selected');
      fmtPng.classList.remove('selected');
      if (qualityWrap) qualityWrap.style.display = 'flex';
    });
  }
  if (qualityRange) {
    qualityRange.addEventListener('input', () => {
      jpegQuality = parseInt(qualityRange.value, 10);
      if (qualityVal) qualityVal.textContent = jpegQuality + '%';
    });
  }

  /* view-select DOM */
  const regionsList       = document.getElementById('regions-list');
  const modeBtnFull       = document.getElementById('mode-btn-full');
  const modeBtnRegion     = document.getElementById('mode-btn-region');
  const selectCancelBtn   = document.getElementById('select-cancel-btn');
  const selectConfirmBtn  = document.getElementById('select-confirm-btn');

  /* ── 状态 ── */
  let currentImageData = null;
  let currentTab       = null;
  let selectedRounds   = 0;
  let detectedRegions  = [];   // background 返回的区域列表
  let selectedRegion   = null; // 当前选中的区域对象 { selector, label, ... }
  let currentMode      = 'full'; // 'full' | 'region'
  /* 图片格式与质量 */
  let imageFormat  = 'png';   // 'png' | 'jpeg'
  let jpegQuality  = 92;      // 50–100，仅 jpeg 时有效
  /* 区域截图时的无限滚动上下文 */
  let regionInfiniteCtx = null; // { selector }
  /* 记录进入截图前的视图，用于重新截图返回 */
  let previousViewBeforeCapture = 'capture'; // 'capture' | 'select'

  /* ──────────────────────────────────────────
   * 从预览返回时恢复结果页
   * 数据源：优先 IndexedDB（无配额限制），回退 chrome.storage.session
   * ────────────────────────────────────────── */
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs[0];
    chrome.storage.session.get(['ss_restore_preview', 'ss_preview_tab_id'], (result) => {
      const shouldRestore = !!result.ss_restore_preview;
      if (!shouldRestore) {
        // 非恢复模式，清除残留数据
        const sameTab = activeTab && result.ss_preview_tab_id === activeTab.id;
        if (!sameTab) {
          chrome.storage.session.remove(['ss_preview_tab_id', 'ss_restore_preview']);
        }
        return;
      }

      // 恢复模式：从 IndexedDB 读取截图数据（比 session storage 更可靠，无配额限制）
      (async () => {
        try {
          const imageData = await readDataUrlFromStorageKeep(); // 读取但不清除
          if (imageData) {
            currentImageData = imageData;
            currentTab = activeTab || { id: result.ss_preview_tab_id };
            showResultView(imageData);
          } else {
            // IndexedDB 无数据，尝试 chrome.storage.session 兜底
            const sessionData = await new Promise(resolve => {
              chrome.storage.session.get(['ss_preview_data'], r => resolve(r.ss_preview_data));
            });
            if (sessionData) {
              currentImageData = sessionData;
              currentTab = activeTab || { id: result.ss_preview_tab_id };
              showResultView(sessionData);
            }
          }
        } catch (e) {
          console.error('恢复预览数据失败:', e);
        }
        // 清除恢复标记
        chrome.storage.session.remove('ss_restore_preview');
      })();
    });
  });

  async function openFullPreview() {
    if (!currentImageData || !currentTab) return;
    chrome.runtime.sendMessage({ action: 'openPreview', tabId: currentTab.id, dataUrl: currentImageData });
    setTimeout(() => window.close(), 80);
  }
  previewWrap.addEventListener('click', openFullPreview);

  /* ── 无限滚动弹层（整页用）── */
  const infiniteCancelBtn  = document.getElementById('infinite-cancel-btn');
  const infiniteConfirmBtn = document.getElementById('infinite-confirm-btn');
  const roundCards         = document.querySelectorAll('.round-card');

  roundCards.forEach(card => {
    card.addEventListener('click', () => {
      roundCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedRounds = parseInt(card.dataset.rounds, 10);
    });
  });

  /* ──────────────────────────────────────────
   * 开始截图主入口：检测可滚动区域
   * ────────────────────────────────────────── */
  captureBtn.addEventListener('click', async function () {
    try {
      captureBtn.disabled = true;
      captureBtn.textContent = '⏳ 检测中...';
      showStatus('正在分析页面...', 'info');

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) { showStatus('无法获取当前标签页', 'error'); resetCaptureBtn(); return; }
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        showStatus('无法在此页面使用截图功能', 'error'); resetCaptureBtn(); return;
      }
      currentTab = tab;

      /* 检测可滚动区域 */
      let regions = [];
      try {
        const resp = await sendMsg({ action: 'detectScrollableRegions', tabId: tab.id });
        if (resp && resp.success) regions = resp.regions || [];
      } catch (_) {}

      resetCaptureBtn();
      hideStatus();

      if (regions.length === 0) {
        /* 无可滚动区域：走原来的整页截图（含整页无限滚动检测） */
        previousViewBeforeCapture = 'capture';
        await doFullPageFlow(tab);
      } else {
        /* 有可滚动区域：展示选择弹窗 */
        detectedRegions = regions;
        selectedRegion  = null;
        currentMode     = 'full';
        showSelectView(regions);
      }

    } catch (error) {
      console.error('截图入口错误:', error);
      showStatus('操作失败：' + error.message, 'error');
      resetCaptureBtn();
    }
  });

  /* ──────────────────────────────────────────
   * 渲染区域列表
   * ────────────────────────────────────────── */
  function showSelectView(regions) {
    regionsList.innerHTML = '';

    regions.forEach((r, i) => {
      const item = document.createElement('div');
      item.className = 'region-item';
      item.dataset.idx = i;

      // 图标：按标签类型选
      const iconMap = { ul:'📄', ol:'📄', table:'📊', div:'📦', section:'📦', main:'📦', aside:'📦', nav:'🗂️', article:'📄', canvas:'🖼️' };
      const icon = iconMap[r.tag] || '📋';
      // 滚动方向标签
      const dirMap = { vertical: '↕️ 纵向', horizontal: '↔️ 横向', both: '⬜ 双向', none: '—' };
      const dirLabel = dirMap[r.scrollDirection] || '';
      const meta = `${r.tag}  ${r.width}×${r.clientHeight}px  可滚 ${r.scrollHeight}px  ${dirLabel}`;

      // 构建 DOM（避免 innerHTML 注入风险）
      const iconSpan  = document.createElement('span');
      iconSpan.className = 'region-item-icon';
      iconSpan.textContent = icon;

      const infoSpan  = document.createElement('span');
      infoSpan.className = 'region-item-info';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'region-item-title';
      titleSpan.textContent = r.label || r.tag;

      const metaSpan  = document.createElement('span');
      metaSpan.className = 'region-item-meta';
      metaSpan.textContent = meta;

      infoSpan.appendChild(titleSpan);
      infoSpan.appendChild(metaSpan);

      const checkSpan = document.createElement('span');
      checkSpan.className = 'region-item-check';
      checkSpan.textContent = '✓';

      item.appendChild(iconSpan);
      item.appendChild(infoSpan);
      item.appendChild(checkSpan);

      item.addEventListener('click', () => selectRegionItem(item, r));
      regionsList.appendChild(item);
    });

    /* 更新模式按钮状态 */
    setMode('full');
    showView('select');
  }

  function selectRegionItem(item, region) {
    /* 视觉选中 */
    document.querySelectorAll('.region-item').forEach(el => el.classList.remove('selected'));
    item.classList.add('selected');
    selectedRegion = region;

    /* 自动切换模式为区域截图 */
    setMode('region');

    /* 高亮网页区域 */
    if (currentTab) {
      chrome.runtime.sendMessage({ action: 'highlightElement', tabId: currentTab.id, selector: region.selector });
    }
  }

  /* ── 模式按钮切换 ── */
  modeBtnFull.addEventListener('click', () => {
    setMode('full');
    /* 清除区域选中 */
    document.querySelectorAll('.region-item').forEach(el => el.classList.remove('selected'));
    selectedRegion = null;
    /* 取消高亮 */
    if (currentTab) chrome.runtime.sendMessage({ action: 'clearHighlight', tabId: currentTab.id });
  });

  modeBtnRegion.addEventListener('click', () => {
    if (!selectedRegion) {
      /* 没有选中区域时提示 */
      modeBtnRegion.style.animation = 'none';
      modeBtnRegion.style.borderColor = 'rgba(255,59,48,0.7)';
      setTimeout(() => { modeBtnRegion.style.borderColor = ''; }, 800);
      return;
    }
    setMode('region');
  });

  function setMode(mode) {
    currentMode = mode;
    modeBtnFull.classList.toggle('selected',   mode === 'full');
    modeBtnRegion.classList.toggle('selected', mode === 'region');
    /* 确认按钮：区域截图时需已选中区域 */
    updateConfirmBtn();
  }

  function updateConfirmBtn() {
    if (currentMode === 'full') {
      selectConfirmBtn.disabled = false;
      selectConfirmBtn.textContent = '🖥️ 整页截图';
    } else {
      selectConfirmBtn.disabled = !selectedRegion;
      selectConfirmBtn.textContent = '🎯 区域截图';
    }
  }

  /* ── 取消 ── */
  selectCancelBtn.addEventListener('click', () => {
    if (currentTab) chrome.runtime.sendMessage({ action: 'clearHighlight', tabId: currentTab.id });
    showView('capture');
  });

  /* ── 确认截图 ── */
  selectConfirmBtn.addEventListener('click', async () => {
    if (currentTab) chrome.runtime.sendMessage({ action: 'clearHighlight', tabId: currentTab.id });

    // 记录是从选择视图进入截图的
    previousViewBeforeCapture = 'select';
    // 标记当前是从 select 视图发起的，用于无限滚动确认时判断
    window.__ss_fromSelectView = true;

    if (currentMode === 'full') {
      showView('capture');
      await doFullPageFlow(currentTab);
    } else {
      if (!selectedRegion) return;
      showView('capture');
      await doRegionFlow(selectedRegion.selector);
    }
  });

  /* ──────────────────────────────────────────
   * 整页截图流程（含无限滚动检测）
   * ────────────────────────────────────────── */
  async function doFullPageFlow(tab) {
    captureBtn.disabled = true;
    captureBtn.textContent = '⏳ 检测中...';
    showStatus('正在检测页面类型...', 'info');

    let isInfinite = false;
    try {
      const detectResp = await sendMsg({ action: 'detectInfiniteScroll', tabId: tab.id });
      isInfinite = detectResp && detectResp.success && detectResp.isInfinite;
    } catch (_) {}

    if (isInfinite) {
      showInfiniteView();
      resetCaptureBtn();
    } else {
      await doCapture(tab.id, 0);
    }
  }

  /* ──────────────────────────────────────────
   * 区域截图流程（含区域无限滚动检测）
   * ────────────────────────────────────────── */
  async function doRegionFlow(selector) {
    captureBtn.disabled = true;
    captureBtn.textContent = '⏳ 检测中...';
    showStatus('正在检测区域类型...', 'info');

    let isInfinite = false;
    try {
      const resp = await sendMsg({ action: 'detectRegionInfiniteScroll', tabId: currentTab.id, selector });
      isInfinite = resp && resp.success && resp.isInfinite;
    } catch (_) {}

    resetCaptureBtn();

    if (isInfinite) {
      regionInfiniteCtx = { selector };
      /* 复用无限滚动弹层 */
      showInfiniteView(true);
    } else {
      await doCaptureRegion(selector, 0);
    }
  }

  /* ── 无限滚动弹层：取消 ── */
  infiniteCancelBtn.addEventListener('click', () => {
    regionInfiniteCtx = null;
    viewInfinite.style.display = 'none';

    // 检查是否从 select 视图进入
    const fromSelect = window.__ss_fromSelectView;
    window.__ss_fromSelectView = false;

    if (fromSelect && detectedRegions.length > 0) {
      // 返回选择视图
      showSelectView(detectedRegions);
      // 恢复之前的选中状态
      if (selectedRegion) {
        const items = document.querySelectorAll('.region-item');
        items.forEach((item, idx) => {
          if (detectedRegions[idx] && detectedRegions[idx].selector === selectedRegion.selector) {
            item.classList.add('selected');
          }
        });
        // 恢复高亮
        if (currentTab) {
          chrome.runtime.sendMessage({ action: 'highlightElement', tabId: currentTab.id, selector: selectedRegion.selector });
        }
      }
    } else {
      viewCapture.style.display = 'block';
      resetCaptureBtn();
      hideStatus();
    }
  });

  /* ── 无限滚动弹层：确认 ── */
  infiniteConfirmBtn.addEventListener('click', async () => {
    viewInfinite.style.display = 'none';
    viewCapture.style.display  = 'block';

    // 检查是否从 select 视图进入无限滚动弹层
    const fromSelect = window.__ss_fromSelectView;
    window.__ss_fromSelectView = false; // 清除标记

    // 如果从 select 视图进入，保持 previousViewBeforeCapture = 'select'
    // 如果直接从首页进入（无可滚动区域但页面是无限滚动），保持为 'capture'

    if (regionInfiniteCtx) {
      const { selector } = regionInfiniteCtx;
      regionInfiniteCtx = null;
      await doCaptureRegion(selector, selectedRounds);
    } else {
      if (!currentTab) return;
      await doCapture(currentTab.id, selectedRounds);
    }
  });

  /* ──────────────────────────────────────────
   * 实际整页截图
   * ────────────────────────────────────────── */
  async function doCapture(tabId, scrollRounds) {
    try {
      captureBtn.disabled = true;
      captureBtn.textContent = '⏳ 正在截图...';
      showCancelBtn();
      const hint = scrollRounds > 0 ? `（含 ${scrollRounds} 轮无限加载）` : '';
      showStatus(`正在截取完整页面...${hint}`, 'info');

      const response = await sendMsg({ action: 'captureFullPage', tabId, scrollRounds, format: imageFormat, quality: jpegQuality });
      if (!response) throw new Error('未收到响应，请检查扩展是否正确加载');
      if (!response.success) throw new Error(response.error || '截图失败');

      showStatus('正在读取截图数据...', 'info');
      const imageData = await readDataUrlFromStorage();

      currentImageData = imageData;
      try { chrome.storage.session.set({ ss_preview_data: imageData, ss_preview_tab_id: currentTab ? currentTab.id : null }); } catch (_) {}
      hideCancelBtn();
      showResultView(imageData);

    } catch (error) {
      console.error('整页截图错误:', error);
      hideCancelBtn();
      showStatus('截图失败：' + error.message, 'error');
      resetCaptureBtn();
    }
  }

  /* ──────────────────────────────────────────
   * 实际区域截图
   * ────────────────────────────────────────── */
  async function doCaptureRegion(selector, scrollRounds) {
    try {
      captureBtn.disabled = true;
      captureBtn.textContent = '⏳ 正在截图...';
      showCancelBtn();
      const hint = scrollRounds > 0 ? `（含 ${scrollRounds} 轮加载）` : '';
      showStatus(`正在截取区域...${hint}`, 'info');

      const response = await sendMsg({ action: 'captureRegionScreenshot', tabId: currentTab.id, selector, scrollRounds, format: imageFormat, quality: jpegQuality });
      if (!response) throw new Error('未收到响应');
      if (!response.success) throw new Error(response.error || '区域截图失败');

      showStatus('正在读取截图数据...', 'info');
      const imageData = await readDataUrlFromStorage();

      currentImageData = imageData;
      try { chrome.storage.session.set({ ss_preview_data: imageData, ss_preview_tab_id: currentTab ? currentTab.id : null }); } catch (_) {}
      hideCancelBtn();
      showResultView(imageData);

    } catch (error) {
      console.error('区域截图错误:', error);
      hideCancelBtn();
      showStatus('截图失败：' + error.message, 'error');
      resetCaptureBtn();
    }
  }

  /* ──────────────────────────────────────────
   * 下载
   * ────────────────────────────────────────── */
  downloadBtn.addEventListener('click', async function () {
    if (!currentImageData) return;
    downloadBtn.disabled = true;
    downloadBtn.textContent = '⏳ 下载中...';
    try {
      const a = document.createElement('a');
      a.href = currentImageData; a.download = getScreenshotFilename();
      a.style.display = 'none'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
      showResultStatus('✅ 图片已保存', 'ok');
    } catch (err) {
      showResultStatus('❌ 下载失败：' + err.message, 'err');
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = '📥 下载图片';
    }
  });

  /* ──────────────────────────────────────────
   * 复制
   * ────────────────────────────────────────── */
  copyBtn.addEventListener('click', async function () {
    if (!currentImageData) return;
    copyBtn.disabled = true;
    copyBtn.textContent = '⏳ 复制中...';
    try {
      const blob = await (await fetch(currentImageData)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      showResultStatus('✅ 已复制到剪切板', 'ok');
    } catch (err) {
      console.error('复制失败:', err);
      showResultStatus('❌ 复制失败，请尝试下载', 'err');
    } finally {
      copyBtn.disabled = false;
      copyBtn.textContent = '📋 复制到剪切板';
    }
  });

  /* ──────────────────────────────────────────
   * 重新截图：返回上一页（capture 或 select）
   * ────────────────────────────────────────── */
  retakeBtn.addEventListener('click', function () {
    currentImageData = null;
    previewImg.src = '';
    // 根据进入截图前的视图决定返回哪里
    if (previousViewBeforeCapture === 'select' && detectedRegions.length > 0) {
      // 重新显示区域选择视图，保持之前的选择状态
      showSelectView(detectedRegions);
      // 恢复之前的选中状态
      if (selectedRegion) {
        const items = document.querySelectorAll('.region-item');
        items.forEach((item, idx) => {
          if (detectedRegions[idx] && detectedRegions[idx].selector === selectedRegion.selector) {
            item.classList.add('selected');
          }
        });
        // 恢复高亮
        if (currentTab) {
          chrome.runtime.sendMessage({ action: 'highlightElement', tabId: currentTab.id, selector: selectedRegion.selector });
        }
      }
    } else {
      showView('capture');
      resetCaptureBtn();
      hideStatus();
    }
  });

  /* ──────────────────────────────────────────
   * IndexedDB 读取截图
   * ────────────────────────────────────────── */
  async function readDataUrlFromStorage() {
    const dataUrl = await readDataUrlFromStorageKeep();
    // 读取后删除（正常截图流程：读取一次即消费）
    const IDB_NAME = 'ss_store', IDB_STORE = 'screenshots', IDB_KEY = 'current';
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE);
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
    await new Promise(resolve => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
    return dataUrl;
  }

  /* 读取但不删除（预览恢复用，用户可能还需要下载/复制） */
  async function readDataUrlFromStorageKeep() {
    const IDB_NAME = 'ss_store', IDB_STORE = 'screenshots', IDB_KEY = 'current';
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE);
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
    const dataUrl = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const getReq = store.get(IDB_KEY);
      getReq.onsuccess = (e) => resolve(e.target.result || null);
      getReq.onerror   = (e) => reject(e.target.error);
    });
    db.close();
    return dataUrl;
  }

  /* ──────────────────────────────────────────
   * 视图切换
   * ────────────────────────────────────────── */
  function showView(name) {
    viewCapture.style.display  = name === 'capture'  ? 'block' : 'none';
    viewResult.style.display   = name === 'result'   ? 'block' : 'none';
    viewInfinite.style.display = name === 'infinite' ? 'block' : 'none';
    viewSelect.style.display   = name === 'select'   ? 'flex'  : 'none';
  }

  function showResultView(imageData) {
    previewImg.src = imageData;
    showView('result');
    resultStatus.className = 'result-status';
  }

  function showInfiniteView(isRegion) {
    /* 更新弹层提示文字（区域 vs 整页） */
    const h2 = viewInfinite.querySelector('h2');
    const p  = viewInfinite.querySelector('.infinite-header p');
    if (isRegion) {
      h2.textContent = '检测到无限滚动区域';
    } else {
      h2.textContent = '检测到无限滚动页面';
    }
    // 安全构建含 <br> 的文本
    p.textContent = '';
    p.appendChild(document.createTextNode(isRegion
      ? '该区域会随滚动持续加载更多内容，'
      : '该页面会随滚动持续加载更多内容，'));
    p.appendChild(document.createElement('br'));
    p.appendChild(document.createTextNode('截图前可选择额外加载轮次。'));
    /* 重置轮次选择为 0 */
    selectedRounds = 0;
    roundCards.forEach(c => c.classList.toggle('selected', c.dataset.rounds === '0'));
    showView('infinite');
    hideStatus();
  }

  function resetCaptureBtn() {
    captureBtn.disabled = false;
    captureBtn.textContent = '🎯 开始截图';
  }

  function showStatus(message, type = 'info') {
    statusDiv.textContent = message;
    statusDiv.className = 'status show ' + type;
  }

  function hideStatus() { statusDiv.className = 'status'; }

  function showResultStatus(message, type) {
    resultStatus.textContent = message;
    resultStatus.className = 'result-status show ' + type;
    setTimeout(() => { resultStatus.className = 'result-status'; }, 3000);
  }

  /* ── Promise 包装 sendMessage ── */
  function sendMsg(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });
  }

  /* ── HTML 转义 ── */
  function escHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  /* ── Popup 关闭时通知 background 清理 ── */
  window.addEventListener('unload', () => {
    try {
      const msg = { action: 'popupClosed' };
      if (currentTab && currentTab.id) msg.tabId = currentTab.id;
      chrome.runtime.sendMessage(msg);
    } catch (_) {}
  });

  /* 兼容保留（拼接分段，目前不直接使用） */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = src;
    });
  }
});
