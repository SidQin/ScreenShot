document.addEventListener('DOMContentLoaded', function () {

  /* ══════════════════════════════════════════
   * 主题管理
   * 支持三种模式：auto（跟随系统）/ glass（液态玻璃）/ default（经典渐变）
   * 偏好存储在 localStorage key: 'ss_theme'
   * ══════════════════════════════════════════ */
  const THEME_KEY = 'ss_theme';

  /** 检测当前系统是否为 macOS */
  function isMacOS() {
    return /mac/i.test(navigator.platform) ||
           /Mac OS X/i.test(navigator.userAgent);
  }

  /** 解析当前应用主题（glass 或 default） */
  function resolveTheme(pref) {
    if (pref === 'glass')   return 'glass';
    if (pref === 'default') return 'default';
    // auto：macOS 默认 glass，其他默认 default
    return isMacOS() ? 'glass' : 'default';
  }

  /** 应用主题到 body */
  function applyTheme(theme) {
    document.body.classList.toggle('theme-glass', theme === 'glass');
  }

  /** 同步高亮设置面板选项 */
  function syncThemeOptions(pref) {
    document.querySelectorAll('.theme-option').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === pref);
    });
  }

  // 初始化主题
  const savedPref = localStorage.getItem(THEME_KEY) || 'auto';
  applyTheme(resolveTheme(savedPref));
  syncThemeOptions(savedPref);

  // 设置面板交互
  const settingsBtn      = document.getElementById('settings-btn');
  const settingsPanel    = document.getElementById('settings-panel');
  const settingsCloseBtn = document.getElementById('settings-close-btn');

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPanel.classList.toggle('show');
  });

  settingsCloseBtn.addEventListener('click', () => {
    settingsPanel.classList.remove('show');
  });

  // 点击面板外关闭
  document.addEventListener('click', (e) => {
    if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) {
      settingsPanel.classList.remove('show');
    }
  });

  // 主题选项点击
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const pref = btn.dataset.theme;
      localStorage.setItem(THEME_KEY, pref);
      applyTheme(resolveTheme(pref));
      syncThemeOptions(pref);
      settingsPanel.classList.remove('show');
    });
  });

  /* ══════════════════════════════════════════
   * 生成下载文件名：ScreenShot_YYYY-MM-DD_HH-mm-ss.png
   * ══════════════════════════════════════════ */
  function getScreenshotFilename() {
    const now  = new Date();
    const pad  = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return `ScreenShot_${date}_${time}.png`;
  }

  /* ── DOM 引用 ── */
  const viewCapture   = document.getElementById('view-capture');
  const viewResult    = document.getElementById('view-result');
  const viewInfinite  = document.getElementById('view-infinite');
  const captureBtn    = document.getElementById('capture-btn');
  const statusDiv     = document.getElementById('status');
  const previewImg    = document.getElementById('preview-img');
  const downloadBtn   = document.getElementById('download-btn');
  const copyBtn       = document.getElementById('copy-btn');
  const retakeBtn     = document.getElementById('retake-btn');
  const resultStatus  = document.getElementById('result-status');

  /* 全屏预览：注入被截图页面 */
  const previewWrap = document.getElementById('preview-wrap');

  /* ── 从预览返回时恢复结果页 ── */
  chrome.storage.session.get(['ss_restore_preview', 'ss_preview_data'], (result) => {
    if (result.ss_restore_preview && result.ss_preview_data) {
      // 清除恢复标记
      chrome.storage.session.remove('ss_restore_preview');
      currentImageData = result.ss_preview_data;
      showResultView(result.ss_preview_data);
    }
  });

  async function openFullPreview() {
    if (!currentImageData || !currentTab) return;
    chrome.runtime.sendMessage({
      action: 'openPreview',
      tabId:  currentTab.id,
      dataUrl: currentImageData
    });
    // 发完消息后关闭 popup，让用户在注入弹窗里操作（popup 浮在最顶层无法绕开）
    setTimeout(() => window.close(), 80);
  }

  /* 点击预览图打开全屏预览 */
  previewWrap.addEventListener('click', openFullPreview);

  /* 无限滚动弹层 */
  const infiniteCancelBtn  = document.getElementById('infinite-cancel-btn');
  const infiniteConfirmBtn = document.getElementById('infinite-confirm-btn');
  const roundCards         = document.querySelectorAll('.round-card');

  /* 当前截图的 dataURL，供下载和复制使用 */
  let currentImageData = null;
  /* 当前活跃的标签页 */
  let currentTab = null;
  /* 用户选择的额外滚动轮次 */
  let selectedRounds = 0;

  /* ── 轮次选择卡片交互 ── */
  roundCards.forEach(card => {
    card.addEventListener('click', () => {
      roundCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedRounds = parseInt(card.dataset.rounds, 10);
    });
  });

  /* ──────────────────────────────────────────
   * 开始截图（主入口）
   * ────────────────────────────────────────── */
  captureBtn.addEventListener('click', async function () {
    try {
      captureBtn.disabled = true;
      captureBtn.textContent = '⏳ 检测中...';

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        showStatus('无法获取当前标签页', 'error');
        resetCaptureBtn();
        return;
      }

      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        showStatus('无法在此页面使用截图功能', 'error');
        resetCaptureBtn();
        return;
      }

      currentTab = tab;

      /* 检测无限滚动 */
      showStatus('正在检测页面类型...', 'info');
      let isInfinite = false;
      try {
        const detectResp = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { action: 'detectInfiniteScroll', tabId: tab.id },
            (resp) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(resp);
            }
          );
        });
        isInfinite = detectResp && detectResp.success && detectResp.isInfinite;
      } catch (_) {
        // 检测失败不影响主流程，按普通页面处理
      }

      if (isInfinite) {
        /* 展示无限滚动弹层，等用户选择 */
        showInfiniteView();
        resetCaptureBtn();
      } else {
        /* 普通页面，直接截图 */
        await doCapture(tab.id, 0);
      }

    } catch (error) {
      console.error('截图错误:', error);
      showStatus('截图失败：' + error.message, 'error');
      resetCaptureBtn();
    }
  });

  /* ── 无限滚动弹层：取消 ── */
  infiniteCancelBtn.addEventListener('click', () => {
    viewInfinite.style.display = 'none';
    viewCapture.style.display = 'block';
    resetCaptureBtn();
    hideStatus();
  });

  /* ── 无限滚动弹层：确认截图 ── */
  infiniteConfirmBtn.addEventListener('click', async () => {
    if (!currentTab) return;
    viewInfinite.style.display = 'none';
    viewCapture.style.display = 'block';
    await doCapture(currentTab.id, selectedRounds);
  });

  /* ──────────────────────────────────────────
   * 实际执行截图
   * ────────────────────────────────────────── */
  async function doCapture(tabId, scrollRounds) {
    try {
      captureBtn.disabled = true;
      captureBtn.textContent = '⏳ 正在截图...';

      const roundsHint = scrollRounds > 0 ? `（含 ${scrollRounds} 轮无限加载）` : '';
      showStatus(`正在截取完整页面...${roundsHint}`, 'info');

      /* 向 background 发送截图请求 */
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: 'captureFullPage', tabId, scrollRounds },
          (resp) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(resp);
          }
        );
      });

      if (!response) throw new Error('未收到响应，请检查扩展是否正确加载');
      if (!response.success) throw new Error(response.error || '截图失败');

      /* 从 storage 读取截图数据（background 已分块存储，绕过 64MiB 消息限制） */
      showStatus('正在读取截图数据...', 'info');
      const imageData = await readDataUrlFromStorage();

      /* 展示结果界面 */
      currentImageData = imageData;
      // 存入 session，供预览弹窗关闭后恢复使用
      try { chrome.storage.session.set({ ss_preview_data: imageData }); } catch (_) {}
      showResultView(imageData);

    } catch (error) {
      console.error('截图错误:', error);
      showStatus('截图失败：' + error.message, 'error');
      resetCaptureBtn();
    }
  }

  /* ──────────────────────────────────────────
   * 下载图片
   * ────────────────────────────────────────── */
  downloadBtn.addEventListener('click', async function () {
    if (!currentImageData) return;

    downloadBtn.disabled = true;
    downloadBtn.textContent = '⏳ 下载中...';

    try {
      // 用 <a download> 触发下载，filename 参数 100% 生效
      const a        = document.createElement('a');
      a.href         = currentImageData;
      a.download     = getScreenshotFilename();
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      showResultStatus('✅ 图片已保存', 'ok');
    } catch (err) {
      showResultStatus('❌ 下载失败：' + err.message, 'err');
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = '📥 下载图片';
    }
  });

  /* ──────────────────────────────────────────
   * 复制到剪切板
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
      copyBtn.innerHTML = '📋 复制到剪切板';
    }
  });

  /* ──────────────────────────────────────────
   * 重新截图
   * ────────────────────────────────────────── */
  retakeBtn.addEventListener('click', function () {
    currentImageData = null;
    previewImg.src = '';
    viewResult.style.display = 'none';
    viewCapture.style.display = 'block';
    resetCaptureBtn();
    hideStatus();
  });

  /* ──────────────────────────────────────────
   * 从 IndexedDB 读取截图 dataUrl
   * background.js 把 dataUrl 存入 IndexedDB，无配额限制
   * 读取完毕后删除，避免占用空间
   * ────────────────────────────────────────── */
  async function readDataUrlFromStorage() {
    const IDB_NAME  = 'ss_store';
    const IDB_STORE = 'screenshots';
    const IDB_KEY   = 'current';

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
      const tx    = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const getReq = store.get(IDB_KEY);
      getReq.onsuccess = (e) => {
        const val = e.target.result;
        // 读完立即删除
        store.delete(IDB_KEY);
        resolve(val || null);
      };
      getReq.onerror = (e) => reject(e.target.error);
    });

    db.close();

    if (!dataUrl) throw new Error('IndexedDB 中无截图数据');
    console.log(`从 IndexedDB 读取截图完成，总长: ${dataUrl.length}`);
    return dataUrl;
  }

  /* ──────────────────────────────────────────
   * 拼接分段截图（兼容保留，当前整页截图为单段不需要）
   * ────────────────────────────────────────── */
  async function stitchSegments(segments, dpr) {
    dpr = dpr || 1;

    const totalCssWidth  = segments[0].cssWidth  || 1280;
    const totalCssHeight = segments.reduce((sum, s) => sum + s.cssHeight, 0);

    const canvasWidth  = Math.round(totalCssWidth  * dpr);
    const canvasHeight = Math.round(totalCssHeight * dpr);

    console.log(`拼接画布(物理px): ${canvasWidth} x ${canvasHeight}，段数: ${segments.length}`);

    const canvas = document.createElement('canvas');
    canvas.width  = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    let currentY = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const img = await loadImage('data:image/png;base64,' + seg.data);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      console.log(`绘制段 ${i + 1}，img=${w}x${h}，绘制到Y=${currentY}`);
      ctx.drawImage(img, 0, 0, w, h, 0, currentY, w, h);
      currentY += h;
    }

    return canvas.toDataURL('image/png');
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = src;
    });
  }

  /* ──────────────────────────────────────────
   * 视图切换辅助
   * ────────────────────────────────────────── */
  function showResultView(imageData) {
    previewImg.src = imageData;
    viewCapture.style.display  = 'none';
    viewInfinite.style.display = 'none';
    viewResult.style.display   = 'block';
    resultStatus.className = 'result-status'; // 隐藏旧的状态
  }

  function showInfiniteView() {
    viewCapture.style.display  = 'none';
    viewResult.style.display   = 'none';
    viewInfinite.style.display = 'block';
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

  function hideStatus() {
    statusDiv.className = 'status';
  }

  function showResultStatus(message, type) {
    resultStatus.textContent = message;
    resultStatus.className = 'result-status show ' + type;
    // 3 秒后自动隐藏
    setTimeout(() => { resultStatus.className = 'result-status'; }, 3000);
  }
});
