// Service Worker 启动日志

// ── 截图会话管理（替代全局 screenshotCancelled）──
let isCapturing = false;          // 互斥锁：同一时间只允许一个截图操作
let captureSessionId = 0;         // 递增会话 ID，用于取消特定会话
let cancelledSessionId = null;    // 被取消的会话 ID

// ── OffscreenCanvas 像素上限 ──
const MAX_TOTAL_PIXELS = 500_000_000; // 5亿像素上限（约 23K × 23K）

// ── IndexedDB 常量 ──
const IDB_NAME    = 'ss_store';
const IDB_VERSION = 1;
const IDB_STORE   = 'screenshots';
const IDB_KEY     = 'current';

// ── Debugger 辅助：安全附加（已附加则忽略）──
async function ensureDebuggerAttached(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (e.message && e.message.includes('Already attached')) {
      // 已经附加，直接继续
    } else {
      throw e;
    }
  }
}

// ── Debugger 辅助：安全分离（未附加则静默忽略）──
async function safeDetachDebugger(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) {
    // 静默忽略（如 "Not attached" 错误）
  }
}

// ── 用户手动关闭调试条时清理状态 ──
chrome.debugger.onDetach.addListener((source, reason) => {
  // 清理截图会话状态，防止后续操作认为 debugger 仍附加
  if (isCapturing) {
    if (captureSessionId > 0) cancelledSessionId = captureSessionId;
    isCapturing = false;
  }
});

// ── 键盘快捷键：触发整页截图 ──
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-full-page') return;
  if (isCapturing) return; // 已有截图进行中，忽略
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://')) return;

    // 开始：显示 badge
    chrome.action.setBadgeText({ text: '\u{1F4F8}' });
    chrome.action.setBadgeBackgroundColor({ color: '#4A90D9' });

    await captureFullPageScreenshot(tab.id, 0).then(async ({ dataUrl }) => {
      await storeDataUrl(dataUrl);
      // 通过 storage 通知 popup 恢复结果页（如果 popup 已打开）
      await chrome.storage.session.set({ ss_shortcut_done: true });

      // 成功：显示 ✓
      chrome.action.setBadgeText({ text: '\u2713' });
      chrome.action.setBadgeBackgroundColor({ color: '#34C759' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
    });
  } catch (e) {
    console.error('[Shortcut] 截图失败:', e.message);
    // 失败：显示 ✗
    chrome.action.setBadgeText({ text: '\u2717' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF3B30' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
  }
});

// 监听截图和下载请求
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // ── 安全：校验消息来源 ──
  const isOwnPage = sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
  // popupClosed / cancelScreenshot 只接受来自扩展自身页面的消息
  if ((request.action === 'popupClosed' || request.action === 'cancelScreenshot') && !isOwnPage) {
    sendResponse({ success: false, error: 'Unauthorized' });
    return false;
  }

  // ── 在被截图的标签页注入全屏预览弹窗 ──
  if (request.action === 'openPreview') {
    const { tabId, dataUrl } = request;
    if (!tabId || !dataUrl) { sendResponse({ success: false, error: '缺少参数' }); return false; }

    // 保存到 IndexedDB（无配额限制，恢复时优先读取）+ session storage tabId
    storeDataUrl(dataUrl).catch(() => {});
    try {
      chrome.storage.session.set({ ss_preview_tab_id: tabId });
    } catch (_) {}

    chrome.scripting.executeScript({
      target: { tabId },
      func: injectPreviewOverlay,
      args: [dataUrl]
    }).then(() => sendResponse({ success: true }))
      .catch(err => {
        console.error('[Background] 预览脚本注入失败:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // ── 预览关闭后恢复 popup ──
  if (request.action === 'restorePopup') {
    // 设置恢复标记，popup 打开后会检测并自动显示结果页
    // 同时将截图数据写入 IndexedDB（比 chrome.storage.session 无配额限制）
    chrome.storage.session.set({ ss_restore_preview: true }, () => {
      // 重新打开 popup（仅在用户当前窗口有效）
      chrome.action.openPopup().catch(() => {
        // openPopup 在某些情况下可能失败（如没有活跃窗口），静默忽略
      });
    });
    sendResponse({ success: true });
    return false;
  }

  // ── 检测页面是否为无限滚动 ──
  if (request.action === 'detectInfiniteScroll') {
    const tabId = request.tabId;
    if (!tabId) { sendResponse({ success: false, error: '未提供标签页 ID' }); return false; }
    detectInfiniteScroll(tabId)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err   => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ── 截取完整页面 ──
  if (request.action === 'captureFullPage') {
    const tabId = request.tabId;
    if (!tabId) { sendResponse({ success: false, error: '未提供标签页 ID' }); return false; }
    const scrollRounds = typeof request.scrollRounds === 'number' ? request.scrollRounds : 0;
    const format  = request.format  || 'png';
    const quality = request.quality || 92;

    captureFullPageScreenshot(tabId, scrollRounds, format, quality)
      .then(async ({ dataUrl, cssWidth, cssHeight, dpr }) => {
        // 把 dataUrl 切块存入 storage，消息只返回元信息
        await storeDataUrl(dataUrl);
        sendResponse({ success: true, cssWidth, cssHeight, dpr });
      })
      .catch(error => {
        console.error('截图失败:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // ── 下载图片（dataUrl 由 popup 从 storage 读取后直接传入） ──
  if (request.action === 'downloadImage') {
    downloadImage(request.dataUrl, request.filename)
      .then(downloadId => sendResponse({ success: true, downloadId }))
      .catch(error     => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // ── 检测页面可滚动区域列表 ──
  if (request.action === 'detectScrollableRegions') {
    const tabId = request.tabId;
    if (!tabId) { sendResponse({ success: false, error: '未提供 tabId' }); return false; }
    chrome.scripting.executeScript({
      target: { tabId },
      func: detectScrollableRegionsInPage
    }).then(results => {
      const regions = (results && results[0] && results[0].result) || [];
      sendResponse({ success: true, regions });
    }).catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ── 高亮页面中的某个可滚动区域 ──
  if (request.action === 'highlightElement') {
    const { tabId, selector } = request;
    if (!tabId || !selector) { sendResponse({ success: false, error: '缺少参数' }); return false; }
    chrome.scripting.executeScript({
      target: { tabId },
      func: highlightElementInPage,
      args: [selector]
    }).then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ── 清除高亮 ──
  if (request.action === 'clearHighlight') {
    const tabId = request.tabId;
    if (!tabId) { sendResponse({ success: false }); return false; }
    chrome.scripting.executeScript({
      target: { tabId },
      func: clearHighlightInPage
    }).then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  // ── 检测指定区域是否有无限滚动 ──
  if (request.action === 'detectRegionInfiniteScroll') {
    const { tabId, selector } = request;
    if (!tabId || !selector) { sendResponse({ success: false, isInfinite: false }); return false; }
    detectRegionInfiniteScroll(tabId, selector)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err   => sendResponse({ success: false, isInfinite: false, error: err.message }));
    return true;
  }

  // ── 截取页面指定可滚动区域 ──
  if (request.action === 'captureRegionScreenshot') {
    const { tabId, selector, scrollRounds, format, quality } = request;
    if (!tabId || !selector) { sendResponse({ success: false, error: '缺少参数' }); return false; }
    captureRegionScreenshot(tabId, selector, scrollRounds || 0, format || 'png', quality || 92)
      .then(async ({ dataUrl }) => {
        await storeDataUrl(dataUrl);
        sendResponse({ success: true });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ── 取消截图 ──
  if (request.action === 'cancelScreenshot') {
    if (isCapturing && captureSessionId > 0) {
      cancelledSessionId = captureSessionId;
    }
    sendResponse({ success: true });
    return false;
  }

  // ── Popup 关闭清理 ──
  if (request.action === 'popupClosed') {
    const tabId = request.tabId;
    if (tabId) {
      safeDetachDebugger(tabId);
    } else {
      // fallback：没有 tabId 时尝试查询
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id) safeDetachDebugger(tabs[0].id);
      });
    }
    sendResponse({ success: true });
    return false;
  }

  return false;
});

// ══════════════════════════════════════════
// IndexedDB 辅助（Service Worker 支持 indexedDB）
// ══════════════════════════════════════════
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

// 把 dataUrl 写入 IndexedDB（覆盖旧值，无配额限制）
async function storeDataUrl(dataUrl) {
  const db = await openIDB();
  await new Promise((resolve, reject) => {
    const tx    = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    store.put(dataUrl, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror    = (e) => reject(e.target.error);
  });
  db.close();
}

// ══════════════════════════════════════════
// 检测页面是否具有无限滚动特征
// ══════════════════════════════════════════
async function detectInfiniteScroll(tabId) {
  try {
    await ensureDebuggerAttached(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');

    const before  = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
    const beforeH = Math.ceil((before.cssContentSize || before.contentSize).height);

    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'window.scrollTo(0, document.body.scrollHeight)'
    });
    await sleep(900);

    const after  = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
    const afterH = Math.ceil((after.cssContentSize || after.contentSize).height);

    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'window.scrollTo(0, 0)'
    });
    await sleep(200);
    await safeDetachDebugger(tabId);

    const isInfinite = afterH > beforeH + 50;
    return { isInfinite, beforeH, afterH };
  } catch (e) {
    await safeDetachDebugger(tabId);
    throw e;
  }
}

// ══════════════════════════════════════════
// 截取完整页面（返回拼接完成的 dataUrl）
// ══════════════════════════════════════════
async function captureFullPageScreenshot(tabId, scrollRounds = 0, format = 'png', quality = 92) {
  if (isCapturing) throw new Error('正在截图，请等待当前截图完成');
  isCapturing = true;
  const sessionId = ++captureSessionId;
  const isCancelled = () => cancelledSessionId === sessionId;

  try {
    await ensureDebuggerAttached(tabId);

    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');

      // 获取 DPR
      const dprRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: 'window.devicePixelRatio', returnByValue: true
      });
      const dpr = dprRes.result && dprRes.result.value ? dprRes.result.value : 1;

      // 滚到顶部
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: 'window.scrollTo(0, 0)'
      });
      await sleep(400);

      // ── 步骤0：预滚动，触发懒加载 ──
      const initM   = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
      const initC   = initM.cssContentSize   || initM.contentSize;
      const initVp  = initM.cssLayoutViewport || initM.layoutViewport;
      const initH   = Math.ceil(initC  ? initC.height  : 10000);
      const initVpH = Math.ceil(initVp ? initVp.clientHeight : 900);

      try { chrome.runtime.sendMessage({ action: 'screenshotProgress', message: '正在预滚动加载页面...' }); } catch (_) {}
      const step = Math.floor(initVpH * 0.8);
      let preY = 0;
      while (preY < initH) {
        if (isCancelled()) throw new Error('截图已取消');
        preY = Math.min(preY + step, initH);
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `window.scrollTo(0, ${preY})`
        });
        await sleep(120);
      }
      await waitImagesLoad(tabId, 1500);
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: 'window.scrollTo(0, 0)'
      });
      await sleep(300);

      // ── 步骤0b：无限滚动额外加载轮次 ──
      if (scrollRounds > 0) {
        for (let r = 0; r < scrollRounds; r++) {
          if (isCancelled()) throw new Error('截图已取消');
          try { chrome.runtime.sendMessage({ action: 'screenshotProgress', message: `正在加载第 ${r + 1}/${scrollRounds} 轮...` }); } catch (_) {}
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: 'window.scrollTo(0, document.body.scrollHeight)'
          });
          await sleep(1000);
          await waitImagesLoad(tabId, 1500);
        }
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: 'window.scrollTo(0, 0)'
        });
        await sleep(300);
      }

      // ── 步骤1：获取页面尺寸 ──
      const lm = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
      const cs = lm.cssContentSize || lm.contentSize;
      if (!cs || cs.width === 0 || cs.height === 0) throw new Error('无法获取页面尺寸');

      const totalWidth  = Math.ceil(cs.width);
      const totalHeight = Math.ceil(cs.height);

      // ── 步骤3：截图（超高页面分段，在 background 用 OffscreenCanvas 拼接）──
      // CDP 截图单次物理像素高度上限约 16384px，超过需分段
      const MAX_PHYSICAL_H = 16000; // 留一点余量
      const maxCssSegH = Math.floor(MAX_PHYSICAL_H / dpr);

      let dataUrl;

      try {
        if (totalHeight <= maxCssSegH) {
          // ── 整页一次截完 ──
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
            width: totalWidth, height: totalHeight,
            deviceScaleFactor: dpr, mobile: false
          });
          await sleep(200);

          const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
            format: format, fromSurface: true, captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: totalWidth, height: totalHeight, scale: 1 }
          });
          const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
          dataUrl = 'data:' + mime + ';base64,' + res.data;

        } else {
          // ── 超长页面：分段截图后用 OffscreenCanvas 拼接 ──

          // 先把视口高度设为 maxCssSegH，宽度不变
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
            width: totalWidth, height: maxCssSegH,
            deviceScaleFactor: dpr, mobile: false
          });
          await sleep(200);

          const segments = []; // { data: base64, w: physW, h: physH, mime }
          let segY = 0;
          let segIdx = 0;
          const totalSegs = Math.ceil(totalHeight / maxCssSegH);
          const segMime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
          while (segY < totalHeight) {
            if (isCancelled()) throw new Error('截图已取消');
            const segH = Math.min(maxCssSegH, totalHeight - segY);
            segIdx++;
            try { chrome.runtime.sendMessage({ action: 'screenshotProgress', message: `正在截取第 ${segIdx}/${totalSegs} 段...` }); } catch (_) {}
            const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
              format: format, fromSurface: true, captureBeyondViewport: true,
              clip: { x: 0, y: segY, width: totalWidth, height: segH, scale: 1 }
            });
            const physW = Math.round(totalWidth * dpr);
            const physH = Math.round(segH * dpr);
            segments.push({ data: res.data, w: physW, h: physH, mime: segMime });
            segY += segH;
          }

          // 用 OffscreenCanvas 拼接（Service Worker 支持）
          const totalPhysW = Math.round(totalWidth  * dpr);
          const totalPhysH = Math.round(totalHeight * dpr);
          if (totalPhysW * totalPhysH > MAX_TOTAL_PIXELS) {
            throw new Error(`页面过大（${Math.round(totalPhysW * totalPhysH / 1e6)}MP），超过 500MP 上限，请缩小页面或降低分辨率`);
          }
          const canvas = new OffscreenCanvas(totalPhysW, totalPhysH);
          const ctx = canvas.getContext('2d');
          if (format === 'jpeg') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, totalPhysW, totalPhysH);
          }

          let drawY = 0;
          for (const seg of segments) {
            const imgBlob = base64ToBlob(seg.data, seg.mime);
            const bitmap  = await createImageBitmap(imgBlob);
            ctx.drawImage(bitmap, 0, 0, seg.w, seg.h, 0, drawY, seg.w, seg.h);
            bitmap.close();
            drawY += seg.h;
          }

          const outMime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
          const outOpts = format === 'jpeg' ? { type: 'image/jpeg', quality: quality / 100 } : { type: 'image/png' };
          const blob = await canvas.convertToBlob(outOpts);
          dataUrl = await blobToDataUrl(blob);
        }

      } finally {
        try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride'); } catch (_) {}
        try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: 'window.scrollTo(0, 0)' }); } catch (_) {}
      }

      await safeDetachDebugger(tabId);

      return { dataUrl, cssWidth: totalWidth, cssHeight: totalHeight, dpr };

    } catch (e) {
      await safeDetachDebugger(tabId);
      throw e;
    }
  } catch (error) {
    console.error('截图失败:', error);
    throw error;
  } finally {
    if (captureSessionId === sessionId) isCapturing = false;
    if (cancelledSessionId === sessionId) cancelledSessionId = null;
  }
}

// ── 等待页面图片加载完成 ──
async function waitImagesLoad(tabId, timeout = 1500) {
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `new Promise(function(resolve) {
      var imgs = Array.from(document.images).filter(function(img) { return !img.complete; });
      if (imgs.length === 0) { resolve(); return; }
      var count = imgs.length;
      function done() { count--; if (count <= 0) resolve(); }
      imgs.forEach(function(img) {
        img.addEventListener('load', done);
        img.addEventListener('error', done);
      });
      setTimeout(resolve, ${timeout});
    })`,
    awaitPromise: true
  });
}

// ── ArrayBuffer → base64（分块编码，避免大图栈溢出）──
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// ── base64 → Blob ──
function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

// ── Blob → dataUrl ──
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// 延时函数
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 使用 downloads API 下载图片
async function downloadImage(dataUrl, filename) {
  try {
    const downloadId = await chrome.downloads.download({
      url: dataUrl, filename, saveAs: true, conflictAction: 'uniquify'
    });
    return downloadId;
  } catch (error) {
    console.error('下载失败:', error);
    throw error;
  }
}

// ══════════════════════════════════════════
// 注入页面：检测可滚动区域
// ══════════════════════════════════════════
function detectScrollableRegionsInPage() {
  var results = [];
  var seen = new WeakSet();
  var vpW = window.innerWidth;
  var vpH = window.innerHeight;

  /* ── CSS overflow 简写到独立值的映射 ── */
  function resolveOverflow(cs, axis) {
    // browser 会将 overflow 简写拆分为 overflowX / overflowY
    // 优先读独立值，若返回空字符串则回退到简写
    var val = axis === 'x' ? cs.overflowX : cs.overflowY;
    if (val === '' || !val) val = cs.overflow;
    return val || 'visible';
  }

  /* ── 判断 computed overflow 是否允许滚动 ── */
  function overflowAllowsScroll(ov) {
    return ov === 'auto' || ov === 'scroll' || ov === 'overlay';
  }

  /* ── 判断元素是否在视口内可见 ── */
  function isRectVisible(rect) {
    return rect.bottom > 0 && rect.top < vpH && rect.right > 0 && rect.left < vpW;
  }

  /* ── 获取元素的 client viewport 占比 ── */
  function getViewportRatio(rect) {
    var visibleH = Math.min(rect.bottom, vpH) - Math.max(rect.top, 0);
    var visibleW = Math.min(rect.right, vpW) - Math.max(rect.left, 0);
    return (visibleH * visibleW) / (rect.width * rect.height);
  }

  /* ── 生成选择器 ── */
  function getSelector(el) {
    // 1. ID 优先
    if (el.id) return '#' + CSS.escape(el.id);
    // 2. data-testid
    var testid = el.getAttribute('data-testid');
    if (testid) return el.tagName.toLowerCase() + '[data-testid="' + CSS.escape(testid) + '"]';
    // 3. aria-label
    var arialabel = el.getAttribute('aria-label');
    if (arialabel) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(arialabel) + '"]';
    // 4. 唯一 class
    if (el.className && typeof el.className === 'string') {
      var classes = el.className.trim().split(/\s+/).filter(function(c) { return c.length > 2; });
      for (var ci = 0; ci < classes.length; ci++) {
        var sel = el.tagName.toLowerCase() + '.' + CSS.escape(classes[ci]);
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }
    // 5. 回退到 nth-of-type 路径
    var path = [];
    var cur = el;
    while (cur && cur !== document.documentElement) {
      var tag = cur.tagName.toLowerCase();
      var idx = 1;
      var sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName.toLowerCase() === tag) idx++; sib = sib.previousElementSibling; }
      path.unshift(tag + ':nth-of-type(' + idx + ')');
      cur = cur.parentElement;
    }
    return path.join(' > ');
  }

  /* ── 提取可读标签 ── */
  function getLabel(el) {
    return el.getAttribute('aria-label') ||
           el.getAttribute('data-testid') ||
           el.getAttribute('role') ||
           el.title ||
           (el.id ? '#' + el.id : '') ||
           (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '') ||
           el.tagName.toLowerCase();
  }

  /* ── 核心：判断一个元素是否是「真正的」可滚动容器 ── */
  function isRealScrollable(el) {
    if (seen.has(el)) return false;
    if (el === document.documentElement || el === document.body) return false;

    var rect = el.getBoundingClientRect();

    // 过小元素忽略
    if (rect.width < 80 || rect.height < 60) return false;
    // 至少部分在视口内可见（允许稍超出）
    if (rect.bottom < -50 || rect.top > vpH + 50 || rect.right < -50 || rect.left > vpW + 50) return false;
    // 占视口面积太小的也忽略（避免检测到页面角落的微型滚动容器）
    if (getViewportRatio(rect) < 0.005 && !isRectVisible(rect)) return false;

    var cs = window.getComputedStyle(el);
    var ovY = resolveOverflow(cs, 'y');
    var ovX = resolveOverflow(cs, 'x');

    // ── 1. 标准 CSS 可滚动容器 ──
    //    overflow: auto / scroll / overlay + 内容确实溢出
    var canScrollY = overflowAllowsScroll(ovY) && (el.scrollHeight - el.clientHeight > 2);
    var canScrollX = overflowAllowsScroll(ovX) && (el.scrollWidth - el.clientWidth > 2);

    if (canScrollY || canScrollX) {
      // 排除「scrollHeight > clientHeight 但仅因子元素 margin/padding 导致」的假阳性
      if (canScrollY && el.scrollHeight - el.clientHeight <= 5) canScrollY = false;
      if (canScrollX && el.scrollWidth - el.clientWidth <= 5) canScrollX = false;
      if (canScrollY || canScrollX) return true;
    }

    // ── 2. overflow:hidden + 实际 JS 可滚动（如钉钉文档、飞书等）
    //    更严格的阈值：内容溢出量必须 > 20% 才认为是有意义的可滚动
    var hiddenScrollY = (ovY === 'hidden') && el.scrollHeight > 0 && el.clientHeight > 0 &&
                        (el.scrollHeight - el.clientHeight) / el.clientHeight > 0.2;
    var hiddenScrollX = (ovX === 'hidden') && el.scrollWidth > 0 && el.clientWidth > 0 &&
                        (el.scrollWidth - el.clientWidth) / el.clientWidth > 0.2;

    if (hiddenScrollY || hiddenScrollX) {
      // 进一步验证：通过检查 scrollTop max 是否 > 0（不实际滚动）
      // scrollTop max ≈ scrollHeight - clientHeight
      var maxScrollY = el.scrollHeight - el.clientHeight;
      var maxScrollX = el.scrollWidth - el.clientWidth;
      if (maxScrollY > 10 || maxScrollX > 10) return true;
    }

    // ── 3. Shadow DOM 内的可滚动容器 ──
    if (el.shadowRoot) {
      try {
        var shadowEls = el.shadowRoot.querySelectorAll('*');
        for (var si = 0; si < shadowEls.length; si++) {
          var se = shadowEls[si];
          var sRect = se.getBoundingClientRect();
          if (sRect.width < 80 || sRect.height < 60) continue;
          if (!isRectVisible(sRect) && getViewportRatio(sRect) < 0.005) continue;
          var sCs = window.getComputedStyle(se);
          var sOvY = resolveOverflow(sCs, 'y');
          if (overflowAllowsScroll(sOvY) && se.scrollHeight - se.clientHeight > 5) {
            return true;
          }
        }
      } catch (_) {}
    }

    // ── 4. Canvas 元素（大型画布，如 Figma、在线文档编辑器）──
    if (el.tagName.toLowerCase() === 'canvas') {
      // 大面积 Canvas 在视口内可见即算可滚动候选
      // （钉钉/腾讯文档的 Canvas 自身不可滚动，滚动在父容器上，
      //   但 Canvas 是用户视觉上看到的区域，应保留在候选列表中，
      //   截图阶段会自动转换到可滚动父容器）
      if (rect.width > 300 && rect.height > 200 && isRectVisible(rect)) return true;
    }

    return false;
  }

  /* ── 去重：如果祖先元素已被标记为可滚动，跳过后代 ── */
  function hasScrollableAncestor(el) {
    var parent = el.parentElement;
    while (parent && parent !== document.documentElement) {
      if (seen.has(parent)) return true;
      parent = parent.parentElement;
    }
    return false;
  }

  /* ── 主循环 ── */
  var containerTags = 'div,section,main,aside,nav,article,ul,ol,table,pre,code,canvas,iframe,details,dialog';
  var all = document.querySelectorAll(containerTags);
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (hasScrollableAncestor(el)) continue;
    if (!isRealScrollable(el)) continue;

    seen.add(el);
    var rect = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    var ovY = resolveOverflow(cs, 'y');
    var ovX = resolveOverflow(cs, 'x');
    var tag  = el.tagName.toLowerCase();

    // 判断滚动方向
    var scrollDir = 'none';
    if (overflowAllowsScroll(ovY) || el.scrollHeight - el.clientHeight > 5) scrollDir = 'vertical';
    if (overflowAllowsScroll(ovX) || el.scrollWidth - el.clientWidth > 5) {
      scrollDir = scrollDir === 'vertical' ? 'both' : 'horizontal';
    }

    results.push({
      selector: getSelector(el),
      tag: tag,
      label: String(getLabel(el)).slice(0, 40),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      width:  Math.round(rect.width),
      height: Math.round(rect.height),
      scrollDirection: scrollDir,
      overflowY: ovY,
      overflowX: ovX
    });
    if (results.length >= 20) break;
  }
  return results;
}

// ══════════════════════════════════════════
// 注入页面：高亮元素（支持 Shadow DOM 和 Canvas）
// ══════════════════════════════════════════
function highlightElementInPage(selector) {
  // 内联的 highlightRect 函数
  function createHighlightBox(rect, type) {
    // 确保 rect 有效
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return;
    }

    // 清除旧高亮
    var old = document.getElementById('__ss_hl__');
    if (old) old.remove();
    var oldStyle = document.getElementById('__ss_hl_style__');
    if (oldStyle) oldStyle.remove();

    var box = document.createElement('div');
    box.id = '__ss_hl__';
    Object.assign(box.style, {
      position: 'fixed',
      top:    Math.max(0, rect.top    - 2) + 'px',
      left:   Math.max(0, rect.left   - 2) + 'px',
      width:  (rect.width  + 4) + 'px',
      height: (rect.height + 4) + 'px',
      border: '3px solid rgba(0,122,255,0.95)',
      borderRadius: '6px',
      background: 'rgba(0,122,255,0.08)',
      zIndex: '2147483647',
      pointerEvents: 'none',
      boxShadow: '0 0 0 6px rgba(0,122,255,0.15), inset 0 0 16px rgba(0,122,255,0.06)',
      transition: 'all 0.25s ease',
      animation: '__ss_hl_pulse 1.6s ease-in-out infinite'
    });

    var style = document.createElement('style');
    style.id = '__ss_hl_style__';
    style.textContent = '@keyframes __ss_hl_pulse { 0%,100%{box-shadow:0 0 0 6px rgba(0,122,255,0.15),inset 0 0 16px rgba(0,122,255,0.06)} 50%{box-shadow:0 0 0 10px rgba(0,122,255,0.25),inset 0 0 24px rgba(0,122,255,0.10)} }';

    document.head.appendChild(style);
    document.documentElement.appendChild(box);

    // 高亮框随滚动更新位置（每帧更新）
    var rafId = null;
    function updatePos() {
      var boxEl = document.getElementById('__ss_hl__');
      if (!boxEl) return;
      var el = document.querySelector(selector);
      if (!el) return;
      var curRect = el.getBoundingClientRect();
      boxEl.style.top    = Math.max(0, curRect.top  - 2) + 'px';
      boxEl.style.left   = Math.max(0, curRect.left - 2) + 'px';
      boxEl.style.width  = (curRect.width + 4) + 'px';
      boxEl.style.height = (curRect.height + 4) + 'px';
      if (document.getElementById('__ss_hl__')) {
        rafId = requestAnimationFrame(updatePos);
      }
    }
    rafId = requestAnimationFrame(updatePos);
  }

  var el;
  try { el = document.querySelector(selector); } catch(e) { return; }
  if (!el) { return; }

  // 获取元素位置
  var rect = el.getBoundingClientRect();

  // 如果是 Canvas，直接高亮 Canvas 元素本身
  if (el.tagName.toLowerCase() === 'canvas') {
    createHighlightBox(rect, 'canvas');
    return;
  }

  // 检查 Shadow DOM 内的可滚动容器
  if (el.shadowRoot) {
    try {
      var shadowEls = el.shadowRoot.querySelectorAll('*');
      for (var se of shadowEls) {
        var sCs = window.getComputedStyle(se);
        var sOvY = sCs.overflowY;
        if ((sOvY === 'auto' || sOvY === 'scroll') && se.scrollHeight > se.clientHeight + 10) {
          createHighlightBox(se.getBoundingClientRect(), 'shadow');
          return;
        }
      }
    } catch (_) {}
  }

  // 标准元素高亮 - 优先检测元素内部的可滚动容器
  var canScroll = el.scrollHeight > el.clientHeight + 10;
  if (canScroll) {
    createHighlightBox(rect, 'standard-scroll');
    return;
  }

  // 标准元素高亮
  createHighlightBox(rect, 'standard');
}

// ══════════════════════════════════════════
// 注入页面：清除高亮
// ══════════════════════════════════════════
function clearHighlightInPage() {
  var el = document.getElementById('__ss_hl__');
  if (el) el.remove();
  var st = document.getElementById('__ss_hl_style__');
  if (st) st.remove();
}

// ══════════════════════════════════════════
// 检测指定区域是否有无限滚动
// ══════════════════════════════════════════
async function detectRegionInfiniteScroll(tabId, selector) {
  try {
    await ensureDebuggerAttached(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');

    const getH = `(function(){var el=document.querySelector(${JSON.stringify(selector)});return el?el.scrollHeight:0})()`;
    const before = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: getH, returnByValue: true
    });
    const beforeH = (before.result && before.result.value) || 0;

    // 滚到底
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(el)el.scrollTop=el.scrollHeight})()`
    });
    await sleep(1000);

    const after = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: getH, returnByValue: true
    });
    const afterH = (after.result && after.result.value) || 0;

    // 滚回顶
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(el)el.scrollTop=0})()`
    });
    await sleep(200);
    await safeDetachDebugger(tabId);

    const isInfinite = afterH > beforeH + 50;
    return { isInfinite, beforeH, afterH };
  } catch (e) {
    await safeDetachDebugger(tabId);
    console.warn('区域无限滚动检测失败:', e.message);
    return { isInfinite: false };
  }
}

// ══════════════════════════════════════════
// 辅助：区域截图 - 展开策略
// ══════════════════════════════════════════
async function captureRegionWithExpansion(tabId, selector, elX, elY, elW, clientH, scrollH, dpr, pageW, format = 'png', quality = 92) {
  const expandScript = `(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    const saved = {
      overflow: el.style.overflow,
      overflowX: el.style.overflowX,
      overflowY: el.style.overflowY,
      height: el.style.height,
      maxHeight: el.style.maxHeight,
      position: el.style.position,
      top: el.style.top,
      bottom: el.style.bottom,
      flexShrink: el.style.flexShrink,
      flexGrow: el.style.flexGrow
    };
    el.style.overflow = 'visible';
    el.style.overflowX = 'visible';
    el.style.overflowY = 'visible';
    el.style.height = 'auto';
    el.style.maxHeight = 'none';
    // 防止 sticky/fixed 定位导致展开后位置异常
    if (cs.position === 'sticky' || cs.position === 'fixed') {
      el.style.position = 'relative';
    }
    // 防止 flex 子元素展开后被压缩或拉伸
    el.style.flexShrink = '0';
    el.style.flexGrow = '0';
    window.__ss_region_saved = { el, saved };
    // 返回展开后的实际高度
    return el.getBoundingClientRect().height;
  })()`;

  const expandRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: expandScript, returnByValue: true
  });
  const expandedHeight = expandRes.result && expandRes.result.value;

  let dataUrl;
  try {
    // 如果展开后高度没有显著增加，说明展开策略对此元素无效
    //（常见于 Canvas 绘制或 JS 虚拟滚动的在线文档，如腾讯文档、飞书等）
    if (!expandedHeight || expandedHeight <= clientH + 20) {
      throw new Error('EXPANSION_INEFFECTIVE');
    }

    await sleep(300);
    // 重新获取位置和尺寸（展开后）
    const freshRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(function(){
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: r.left + window.scrollX,
          y: r.top + window.scrollY,
          w: r.width,
          h: r.height
        };
      })()`,
      returnByValue: true
    });
    const fresh = freshRes.result && freshRes.result.value;
    if (!fresh) throw new Error('无法获取展开后的区域信息');

    // 确保高度有效（保底逻辑）
    const capW = elW;
    const capH = fresh.h || clientH || scrollH;
    if (capH <= 0) {
      console.error(`区域展开后高度无效: fresh.h=${fresh.h}, clientH=${clientH}, scrollH=${scrollH}`);
      throw new Error('区域展开后高度为0，无法截图');
    }

    // 设置视口覆盖整个展开后的区域
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      width: Math.max(pageW, Math.ceil(capW)),
      height: Math.ceil(fresh.y + capH + 100),
      deviceScaleFactor: dpr,
      mobile: false
    });
    await sleep(300);

    // 确保页面滚动到目标区域可见位置（防止元素在新视口外未渲染）
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(function(){
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) el.scrollIntoView({ block: 'start' });
      })()`
    });
    await sleep(200);

    // scrollIntoView 后重新获取绝对坐标（页面可能发生了滚动）
    const recheckRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(function(){
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: r.left + window.scrollX,
          y: r.top + window.scrollY
        };
      })()`,
      returnByValue: true
    });
    const recheck = recheckRes.result && recheckRes.result.value;
    if (recheck) {
      fresh.x = recheck.x;
      fresh.y = recheck.y;
    }

    // 一次截完
    const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: format,
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: fresh.x, y: fresh.y, width: capW, height: capH, scale: 1 }
    });
    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    dataUrl = 'data:' + mime + ';base64,' + res.data;

  } finally {
    // 恢复原始样式
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(function(){
        const ctx = window.__ss_region_saved;
        if (!ctx) return;
        const el = ctx.el;
        const s = ctx.saved;
        if (s.overflow) el.style.overflow = s.overflow; else el.style.removeProperty('overflow');
        if (s.overflowX) el.style.overflowX = s.overflowX; else el.style.removeProperty('overflow-x');
        if (s.overflowY) el.style.overflowY = s.overflowY; else el.style.removeProperty('overflow-y');
        if (s.height) el.style.height = s.height; else el.style.removeProperty('height');
        if (s.maxHeight) el.style.maxHeight = s.maxHeight; else el.style.removeProperty('max-height');
        if (s.position) el.style.position = s.position; else el.style.removeProperty('position');
        if (s.top) el.style.top = s.top; else el.style.removeProperty('top');
        if (s.bottom) el.style.bottom = s.bottom; else el.style.removeProperty('bottom');
        if (s.flexShrink) el.style.flexShrink = s.flexShrink; else el.style.removeProperty('flex-shrink');
        if (s.flexGrow) el.style.flexGrow = s.flexGrow; else el.style.removeProperty('flex-grow');
        delete window.__ss_region_saved;
      })()`
    });
  }

  return dataUrl;
}

// ══════════════════════════════════════════
// 辅助：通过 JS WheelEvent 派发滚动（增强版）
// ══════════════════════════════════════════
// 补全所有主流浏览器 WheelEvent 属性，包括 WebKit 遗留的 wheelDelta，
// 并同时尝试正负两个方向（某些框架对 deltaY 符号要求相反）。
// ══════════════════════════════════════════
async function dispatchJsWheelEvent(tabId, selector, deltaY) {
  const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      var target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return { ok: false, error: 'element not found' };
      var canvas = target.tagName.toLowerCase() === 'canvas' ? target : target.querySelector('canvas');
      var rect = canvas ? canvas.getBoundingClientRect() : target.getBoundingClientRect();
      var cx = Math.floor(rect.left + rect.width * 0.5);
      var cy = Math.floor(rect.top + rect.height * 0.5);
      var now = Date.now();
      var delta = ${deltaY};

      function buildOpts(dir) {
        var d = dir * delta;
        return {
          deltaX: 0,
          deltaY: d,
          deltaZ: 0,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          wheelDelta: -d * 3,
          wheelDeltaX: 0,
          wheelDeltaY: -d * 3,
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: cx, clientY: cy,
          screenX: cx, screenY: cy,
          pageX: cx + window.scrollX,
          pageY: cy + window.scrollY,
          offsetX: Math.floor(rect.width * 0.5),
          offsetY: Math.floor(rect.height * 0.5),
          movementX: 0, movementY: 0,
          ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
          button: 0, buttons: 0,
          isPrimary: true,
          pointerType: 'mouse',
          timeStamp: now,
          relatedTarget: null
        };
      }

      function sendTo(el, dir) {
        if (!el) return;
        try { el.dispatchEvent(new WheelEvent('wheel', buildOpts(dir))); } catch(e) {}
      }

      // 同时尝试正负两个方向
      [1, -1].forEach(function(dir) {
        // 1. target 元素
        sendTo(target, dir);
        // 2. Canvas 子元素
        if (canvas && canvas !== target) sendTo(canvas, dir);
        // 3. 所有祖先元素
        var el = target;
        while (el) { sendTo(el, dir); el = el.parentElement; }
        // 4. window / document
        sendTo(window, dir);
        sendTo(document, dir);
        // 5. 已知容器
        var known = ['.excel-container','.canvasContainer','.grid-root','.sheet-view','.spreadsheet-view','.surface_editor-wrapper','.editor-zone_grid','.docx-editor-wrapper'];
        known.forEach(function(sel) {
          document.querySelectorAll(sel).forEach(function(node) { sendTo(node, dir); });
        });
      });

      return { ok: true, vpX: cx, vpY: cy };
    })()`,
    returnByValue: true
  });
  const val = res.result && res.result.value;
  if (val && !val.ok) {
    console.log('[SS-DIAG] JS WheelEvent 派发失败:', val.error);
  }
  return val;
}

// ══════════════════════════════════════════
// 辅助：通过 CDP 派发真实鼠标滚轮事件（isTrusted: true）
// ══════════════════════════════════════════
// CDP Input.dispatchMouseEvent 发送的是浏览器原生事件，
// 在某些检查 isTrusted 的应用（如腾讯文档）上比 JS 合成事件更有效。
// 注意：扩展 debugger 中 Input 域可能不可用，此函数会优雅降级。
// ══════════════════════════════════════════
async function dispatchCdpWheelEvent(tabId, vpX, vpY, deltaY) {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: vpX,
      y: vpY,
      deltaX: 0,
      deltaY: deltaY
    });
    return true;
  } catch (e) {
    console.log('[SS-DIAG] CDP mouseWheel 失败:', e.message);
    return false;
  }
}

// ══════════════════════════════════════════
// 辅助：通过 JS 程序化滚动（scrollTop/scrollBy）
// ══════════════════════════════════════════
// 某些在线文档虽然不响应 WheelEvent，但允许程序化修改 scrollTop/scrollBy。
// 此函数尝试在目标元素及其祖先上设置 scrollTop。
// ══════════════════════════════════════════
async function tryProgrammaticScroll(tabId, selector, deltaY) {
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      // 1. scrollBy
      try { el.scrollBy(0, ${deltaY}); } catch(e) {}
      // 2. scrollTop
      try { el.scrollTop += ${deltaY}; } catch(e) {}
      // 3. 祖先元素（某些文档的滚动容器在父级）
      var p = el.parentElement;
      var depth = 5;
      while (p && depth-- > 0) {
        try {
          if (p.scrollHeight > p.clientHeight + 5) {
            p.scrollTop += ${deltaY};
          }
        } catch(e) {}
        p = p.parentElement;
      }
    })()`,
    returnByValue: true
  });
}

// ══════════════════════════════════════════
// 辅助：通过 CDP 派发键盘滚动事件（PageDown / ArrowDown）
// ══════════════════════════════════════════
// 电子表格编辑器（腾讯文档/金山文档等）通常对键盘事件响应更可靠，
// 即使 isTrusted 检查导致 WheelEvent 失效，键盘事件仍可能触发滚动。
// 先 focus 目标元素再发送 keydown/keyup，确保焦点正确。
// 返回 true = 发送成功（不保证滚动有效）
// ══════════════════════════════════════════
async function dispatchKeyboardScroll(tabId, selector, pageDownCount, arrowDownCount) {
  try {
    // 1. focus 目标元素
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (el) { try { el.focus(); } catch(e) {} }
      })()`,
      returnByValue: true
    });
    await sleep(50);

    // 2. 发送 PageDown
    for (let k = 0; k < pageDownCount; k++) {
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34
      });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34
      });
      await sleep(80);
    }

    // 3. 发送 ArrowDown
    for (let k = 0; k < arrowDownCount; k++) {
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40
      });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40
      });
      await sleep(50);
    }
    return true;
  } catch (e) {
    console.log('[SS-DIAG] CDP 键盘事件失败:', e.message);
    return false;
  }
}

// ══════════════════════════════════════════
// 辅助：获取 Canvas 的视口坐标（用于 CDP 滚轮事件）
// ══════════════════════════════════════════
async function getCanvasViewportCoords(tabId, selector) {
  const vpRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      var canvas = el.tagName.toLowerCase() === 'canvas' ? el : el.querySelector('canvas');
      var rect = canvas ? canvas.getBoundingClientRect() : el.getBoundingClientRect();
      return { x: Math.floor(rect.left + rect.width * 0.5), y: Math.floor(rect.top + rect.height * 0.5) };
    })()`,
    returnByValue: true
  });
  return vpRes.result && vpRes.result.value;
}

// ══════════════════════════════════════════
// 辅助：Touch 拖拽模拟滚动
// ══════════════════════════════════════════
// 移动端优先的 WebApp（包括腾讯文档）可能只响应 touch 事件而非 wheel。
// 模拟手指在 Canvas 中心按下 → 向上拖拽 → 松开的完整手势。
// 向上拖拽（decreasing clientY）= 内容向下滚动。
// ══════════════════════════════════════════
async function dispatchTouchScroll(tabId, selector, distance) {
  const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      var target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return { ok: false, error: 'element not found' };
      var canvas = target.tagName.toLowerCase() === 'canvas' ? target : target.querySelector('canvas');
      var el = canvas || target;
      var rect = el.getBoundingClientRect();
      var cx = Math.floor(rect.left + rect.width * 0.5);
      var cy = Math.floor(rect.top + rect.height * 0.5);
      var dist = ${distance};
      var now = Date.now();

      function makeTouch(y) {
        return new Touch({
          identifier: 1,
          target: el,
          clientX: cx, clientY: y,
          screenX: cx, screenY: y,
          pageX: cx + window.scrollX,
          pageY: y + window.scrollY,
          radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1
        });
      }

      var touchList = function(t) { return { length: 1, item: function(i){ return i===0?t:null; }, 0: t }; };

      // touchstart
      var ts = makeTouch(cy);
      el.dispatchEvent(new TouchEvent('touchstart', {
        touches: touchList(ts), targetTouches: touchList(ts), changedTouches: touchList(ts),
        bubbles: true, cancelable: true, composed: true
      }));

      // touchmove（分 5 步平滑拖拽）
      var steps = 5;
      for (var i = 1; i <= steps; i++) {
        var y = cy - Math.round(dist * i / steps);
        var tm = makeTouch(y);
        el.dispatchEvent(new TouchEvent('touchmove', {
          touches: touchList(tm), targetTouches: touchList(tm), changedTouches: touchList(tm),
          bubbles: true, cancelable: true, composed: true
        }));
      }

      // touchend
      var te = makeTouch(cy - dist);
      el.dispatchEvent(new TouchEvent('touchend', {
        touches: touchList(null), targetTouches: touchList(null), changedTouches: touchList(te),
        bubbles: true, cancelable: true, composed: true
      }));

      return { ok: true, startY: cy, endY: cy - dist };
    })()`,
    returnByValue: true
  });
  return res.result && res.result.value;
}

// ══════════════════════════════════════════
// 辅助：Pointer 拖拽模拟滚动
// ══════════════════════════════════════════
// 部分现代 WebApp 使用 Pointer Events（统一鼠标/触摸/笔）。
// 模拟 pointerdown → pointermove ×N → pointerup 的拖拽流程。
// ══════════════════════════════════════════
async function dispatchPointerScroll(tabId, selector, distance) {
  const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      var target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return { ok: false, error: 'element not found' };
      var canvas = target.tagName.toLowerCase() === 'canvas' ? target : target.querySelector('canvas');
      var el = canvas || target;
      var rect = el.getBoundingClientRect();
      var cx = Math.floor(rect.left + rect.width * 0.5);
      var cy = Math.floor(rect.top + rect.height * 0.5);
      var dist = ${distance};
      var now = Date.now();

      var base = {
        pointerId: 1, pointerType: 'touch',
        isPrimary: true,
        width: 1, height: 1, pressure: 1, tangentialPressure: 0,
        tiltX: 0, tiltY: 0, twist: 0,
        clientX: cx, clientY: cy,
        screenX: cx, screenY: cy,
        pageX: cx + window.scrollX, pageY: cy + window.scrollY,
        bubbles: true, cancelable: true, composed: true
      };

      function makeEvt(type, y) {
        return new PointerEvent(type, Object.assign({}, base, {
          clientY: y, screenY: y, pageY: y + window.scrollY
        }));
      }

      // pointerdown
      el.dispatchEvent(makeEvt('pointerdown', cy));
      // pointermove
      var steps = 5;
      for (var i = 1; i <= steps; i++) {
        el.dispatchEvent(makeEvt('pointermove', cy - Math.round(dist * i / steps)));
      }
      // pointerup
      el.dispatchEvent(makeEvt('pointerup', cy - dist));

      return { ok: true, startY: cy, endY: cy - dist };
    })()`,
    returnByValue: true
  });
  return res.result && res.result.value;
}

// ══════════════════════════════════════════
// 辅助：探查页面内部滚动 API
// ══════════════════════════════════════════
// 腾讯文档等重度封装应用可能在 window 或 DOM 元素上挂载了内部滚动控制器。
// 此函数枚举常见属性名，寻找可调用或可读写的 scroll/viewport/offset 接口。
// 返回找到的所有候选对象路径和类型。
// ══════════════════════════════════════════
async function probeInternalScrollApi(tabId, selector) {
  const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      var found = [];
      var el = document.querySelector(${JSON.stringify(selector)});

      // 1. 在 window 上搜索常见滚动相关全局对象
      var winKeys = ['sheets','spreadsheet','docApp','app','editor','grid','sheet','workbook','viewport','scrollManager','scrollController','viewController'];
      winKeys.forEach(function(k) {
        if (window[k]) {
          var obj = window[k];
          var methods = [];
          try {
            for (var mk in obj) {
              if (typeof obj[mk] === 'function' && /scroll|viewport|offset|pan|translate/i.test(mk)) {
                methods.push(mk);
              }
            }
          } catch(e) {}
          found.push({ scope: 'window', key: k, type: typeof obj, methods: methods.slice(0, 8) });
        }
      });

      // 2. 在目标元素上搜索自定义属性
      if (el) {
        var elKeys = ['__reactFiber','__reactInternalInstance','_reactListeners','_listeners','_events','_handler','_scrollHandler','_controller'];
        elKeys.forEach(function(k) {
          for (var prop in el) {
            if (prop.indexOf(k) !== -1) {
              found.push({ scope: 'element', key: prop, tag: el.tagName.toLowerCase() });
            }
          }
        });
      }

      // 3. 搜索 document / body 上的特殊属性
      var docKeys = ['_reactListeners','_events','__v','__vue','__ngContext'];
      [document, document.body].forEach(function(node) {
        docKeys.forEach(function(k) {
          for (var prop in node) {
            if (prop.indexOf(k) !== -1) {
              found.push({ scope: 'document', key: prop });
            }
          }
        });
      });

      // 4. 搜索特定事件监听（腾讯文档可能在特定元素上监听 wheel）
      var knownSelectors = ['.excel-container','.canvasContainer','.grid-root','.sheet-view','.spreadsheet-view'];
      knownSelectors.forEach(function(sel) {
        var nodes = document.querySelectorAll(sel);
        nodes.forEach(function(node) {
          found.push({ scope: 'knownContainer', selector: sel, tag: node.tagName.toLowerCase() });
        });
      });

      return found;
    })()`,
    returnByValue: true
  });
  return res.result && res.result.value;
}

// ══════════════════════════════════════════
// 辅助：调用内部滚动 API（实验性）
// ══════════════════════════════════════════
// 尝试直接调用页面上已知的内部滚动函数或修改内部状态。
// 对腾讯文档等重度封装应用，这是最后的手段。
// ══════════════════════════════════════════
async function tryInternalScrollApi(tabId, selector, deltaY) {
  const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      var delta = ${deltaY};
      var attempts = [];

      // 1. 尝试 window.sheets / window.spreadsheet 等常见对象的 scroll 方法
      var winTargets = ['sheets','spreadsheet','docApp','app','editor','grid','sheet','workbook'];
      for (var i = 0; i < winTargets.length; i++) {
        var obj = window[winTargets[i]];
        if (!obj) continue;
        var methods = ['scrollBy','scrollTo','scrollY','scrollTop','setScrollTop','setViewport','setOffset','panBy','translateBy'];
        for (var j = 0; j < methods.length; j++) {
          var m = methods[j];
          if (typeof obj[m] === 'function') {
            try { obj[m](0, delta); attempts.push('window.' + winTargets[i] + '.' + m + '(0,' + delta + ')'); } catch(e) {}
          }
        }
      }

      // 2. 尝试触发目标元素上已知的自定义事件
      if (el) {
        // React 合成事件系统：尝试读取并触发 _reactListeners
        try {
          var keys = Object.keys(el);
          for (var k = 0; k < keys.length; k++) {
            if (keys[k].indexOf('__reactEventHandlers') !== -1 || keys[k].indexOf('__reactProps') !== -1) {
              var handlers = el[keys[k]];
              if (handlers && handlers.onWheel) {
                var rect = el.getBoundingClientRect();
                var cx = Math.floor(rect.left + rect.width * 0.5);
                var cy = Math.floor(rect.top + rect.height * 0.5);
                handlers.onWheel({
                  deltaX: 0, deltaY: delta,
                  deltaMode: 0,
                  clientX: cx, clientY: cy,
                  preventDefault: function(){}, stopPropagation: function(){},
                  nativeEvent: { deltaY: delta }
                });
                attempts.push('reactOnWheel');
              }
            }
          }
        } catch(e) {}
      }

      // 3. 尝试修改已知容器的 CSS transform（某些 Canvas 应用用 transform 做视口偏移）
      var known = ['.excel-container','.canvasContainer','.grid-root','.sheet-view','.spreadsheet-view'];
      for (var ki = 0; ki < known.length; ki++) {
        var nodes = document.querySelectorAll(known[ki]);
        for (var ni = 0; ni < nodes.length; ni++) {
          var node = nodes[ni];
          var cs = window.getComputedStyle(node);
          var tf = cs.transform;
          if (tf && tf !== 'none') {
            // 如果当前有 translateY，尝试增加 delta
            try {
              var mat = new DOMMatrix(tf);
              mat.f -= delta; // translateY 减小 = 内容向上移动 = 向下滚动
              node.style.transform = mat.toString();
              attempts.push(known[ki] + '.transform');
            } catch(e) {}
          }
          // 尝试直接修改 marginTop / top
          try {
            var curTop = parseInt(cs.top, 10);
            if (!isNaN(curTop)) {
              node.style.top = (curTop - delta) + 'px';
              attempts.push(known[ki] + '.top');
            }
          } catch(e) {}
        }
      }

      return { ok: true, attempts: attempts };
    })()`,
    returnByValue: true
  });
  return res.result && res.result.value;
}

// ══════════════════════════════════════════
// 模板匹配：从 prev 帧底部提取模板，在 curr 帧中搜索，计算精确滚动偏移
// 比全帧亮度匹配更可靠，因为模板包含多行上下文信息，不易被重复行欺骗
// 返回 prev 帧顶部到匹配行的距离 = 实际滚动量（物理像素）
// ══════════════════════════════════════════
// ══════════════════════════════════════════
// 检测冻结表头（Frozen Header）
// 在线文档（钉钉/腾讯文档等）在 Canvas 顶部固定绘制表头行，
// 每帧截图的顶部都会包含相同的表头内容。
// 通过比较 frame0 和 frame1 的顶部像素来检测表头高度。
// ══════════════════════════════════════════
function detectFrozenHeader(f0Data, f0W, f0H, f1Data, f1W, f1H) {
  const MAX_HEADER = Math.min(Math.floor(f0H * 0.25), 250); // 表头最多 25% 或 250px
  const COL_START = Math.floor(f0W * 0.12);  // 更宽的采样范围
  const COL_END   = Math.floor(f0W * 0.88);
  const SAMPLE_STRIDE = 2;  // 每 2 像素采一个样（更密集）
  const BASE_THRESH = 5;    // 基础阈值更低

  const rowDiffs = [];  // 记录每行差异值，用于诊断

  // ── 逐行计算差异 ──
  for (let y = 0; y < MAX_HEADER; y++) {
    let diff = 0, samples = 0;
    for (let x = COL_START; x < COL_END; x += SAMPLE_STRIDE) {
      const i0 = (y * f0W + x) * 4;
      const i1 = (y * f1W + x) * 4;
      diff += Math.abs(f0Data[i0]     - f1Data[i1])
            + Math.abs(f0Data[i0 + 1] - f1Data[i1 + 1])
            + Math.abs(f0Data[i0 + 2] - f1Data[i1 + 2]);
      samples++;
    }
    const avgDiff = samples > 0 ? diff / samples : 0;
    rowDiffs.push(avgDiff);
  }

  // ── 打印诊断（前 30 行）──
  if (typeof console !== 'undefined') {
    let diagRows = rowDiffs.slice(0, 30).map((d, i) => `行${i}:${d.toFixed(1)}`).join(' ');
    console.log(`[SS-DIAG] 冻结表头检测: ${f0W}x${f0H} / ${f1W}x${f1H}, 前30行差异: ${diagRows}`);
  }

  // ── 策略1: 累积均值跳变检测（最鲁棒）──
  // 原理：表头行差异 ≈ 0，内容行差异 > 0。找第一个 avgDiff 显著超过前几行平均值的行。
  let headerH = 0;
  let runningSum = 0;
  let runningCount = 0;

  for (let y = 0; y < rowDiffs.length; y++) {
    const curr = rowDiffs[y];
    // 前五行噪声容忍——至少5行后才能判断跳变
    if (y >= 5 && runningCount > 0) {
      const runningAvg = runningSum / runningCount;
      // 条件1: 当前行差异 > 运行均值 * 4（相对跳变）
      // 条件2: 当前行差异 > BASE_THRESH（绝对阈值）
      // 条件3: 下一行也高于运行均值（确认非噪声）
      if (curr > runningAvg * 4 && curr > BASE_THRESH) {
        // 确认下一行
        const next = y + 1 < rowDiffs.length ? rowDiffs[y + 1] : curr;
        if (next > runningAvg * 2 || next > BASE_THRESH * 2) {
          headerH = y;
          break;
        }
      }
    }
    // 只将小差异行加入运行均值（表头区域差异应该很小）
    if (curr < BASE_THRESH) {
      runningSum += curr;
      runningCount++;
    }
  }

  // ── 策略2（回退）: 如果跳变检测没找到，用绝对阈值法 ──
  if (headerH === 0) {
    for (let y = 0; y < rowDiffs.length; y++) {
      if (rowDiffs[y] > BASE_THRESH) {
        // 确认后续 2 行中也至少 1 行高于 BASE_THRESH
        let confirmed = false;
        if (y + 1 < rowDiffs.length) {
          for (let cy = y + 1; cy < Math.min(y + 3, rowDiffs.length); cy++) {
            if (rowDiffs[cy] > BASE_THRESH) {
              confirmed = true;
              break;
            }
          }
        }
        if (confirmed || y >= rowDiffs.length - 2) {
          headerH = y;
          console.log(`[SS-DIAG] 冻结表头检测(策略2-绝对阈值法): 表头=${headerH}px, 行${y}差异=${rowDiffs[y].toFixed(1)}`);
          break;
        }
      }
    }
  } else {
    console.log(`[SS-DIAG] 冻结表头检测(策略1-跳变法): 表头=${headerH}px, 跳变行=${headerH}差异=${rowDiffs[headerH].toFixed(1)}`);
  }

  // ── 策略3（最后回退）: 如果前两个策略都失败，尝试从帧对比中发现任何差异 ──
  if (headerH === 0) {
    // 找第一个非零差异行
    for (let y = 0; y < rowDiffs.length; y++) {
      if (rowDiffs[y] > 2) {
        headerH = y;
        console.log(`[SS-DIAG] 冻结表头检测(策略3-首次非零法): 表头=${headerH}px, 行${y}差异=${rowDiffs[y].toFixed(1)}`);
        break;
      }
    }
  }

  // ── 最终判定 ──
  // 至少 6px 才认可（比之前的 8px 更宽松）
  if (headerH < 6) {
    console.log(`[SS-DIAG] 冻结表头检测结果: headerH=${headerH} (过小，视为无冻结表头)`);
    return 0;
  }

  console.log(`[SS-DIAG] 冻结表头检测通过: headerH=${headerH}px`);
  return headerH;
}

// ══════════════════════════════════════════
// 测量两帧之间的实际滚动偏移
// 核心思路：prev 帧底部的内容在滚动后会出现在 curr 帧顶部附近。
// 因此在 curr 帧的顶部重叠区搜索 prev 底部模板，找到最佳匹配位置。
// ══════════════════════════════════════════
function measureOffset(prevData, prevW, prevH, currData, currW, currH, skipY = 0) {
  const STRIP_H = Math.min(50, Math.floor(prevH * 0.06));   // 模板条高度 ~50px
  const OVERLAP = Math.min(280, Math.floor(prevH * 0.28));   // 重叠区域 ~280px 或 28% 帧高

  // 从 prev 帧底部重叠区取模板条
  const prevY = Math.max(Math.floor(prevH * 0.55), prevH - OVERLAP);
  const stripH = Math.min(STRIP_H, prevH - prevY);
  if (stripH < 15) return { offset: 0, confidence: Infinity, valid: false };

  // 在 curr 帧顶部重叠区搜索（模板滚动后应该出现在这里）
  // skipY 用于跳过冻结表头区域（表头在每帧顶部固定出现，不参与匹配）
  const searchStart = Math.max(0, skipY);
  const searchMax = Math.min(currH - stripH, OVERLAP);

  // 取中间 50% 宽度，避开边缘列
  const colStart = Math.floor(prevW * 0.25);
  const colEnd = Math.floor(prevW * 0.75);
  const stripW = colEnd - colStart;

  let bestY = 0;
  let bestDiff = Infinity;

  for (let y = searchStart; y <= searchMax; y++) {
    let diff = 0;
    let samples = 0;

    for (let row = 0; row < stripH; row += 2) {
      const pRow = prevY + row;
      const cRow = y + row;
      if (pRow >= prevH || cRow >= currH) break;

      for (let x = 0; x < stripW; x += 4) {
        const pX = colStart + x;
        const cX = Math.min(Math.floor(pX * currW / prevW), currW - 1);

        const pIdx = (pRow * prevW + pX) * 4;
        const cIdx = (cRow * currW + cX) * 4;

        diff += Math.abs(prevData[pIdx] - currData[cIdx])
              + Math.abs(prevData[pIdx + 1] - currData[cIdx + 1])
              + Math.abs(prevData[pIdx + 2] - currData[cIdx + 2]);
        samples++;
      }
    }

    if (samples === 0) continue;
    const avgDiff = diff / samples;
    if (avgDiff < bestDiff) {
      bestDiff = avgDiff;
      bestY = y;
    }
  }

  // 滚动偏移 = 模板在 prev 中的位置 - 在 curr 中的匹配位置
  const offset = prevY - bestY;

  // 有效性检查：偏移量不能太小（至少滚动 30% 帧高），匹配质量不能太差
  const valid = bestDiff < 100 && offset > prevH * 0.3 && offset < prevH * 1.5;

  return { offset, confidence: bestDiff, valid };
}

// 兼容旧调用（函数签名保持一致）
function findBestVerticalOverlap(prevData, prevW, prevH, currData, currW, currH, expectedDelta, skipY = 0) {
  const result = measureOffset(prevData, prevW, prevH, currData, currW, currH, skipY);
  return { offset: result.valid ? result.offset : expectedDelta, confidence: result.confidence };
}

// ══════════════════════════════════════════
// 辅助：区域截图 - 虚拟滚动 Canvas 策略
// ══════════════════════════════════════════
// 钉钉/腾讯文档等在线文档使用固定尺寸 Canvas + JS 虚拟滚动，
// 没有标准 CSS 滚动容器（scrollH == clientH）。
// 此策略通过 JS WheelEvent 逐帧滚动，逐帧截图，最后像素级对齐拼接。
// ══════════════════════════════════════════
async function captureCanvasVirtualScroll(tabId, selector, elX, elY, elW, clientH, dpr, format = 'png', quality = 92, isCancelledFn = null) {
  const STEP_RATIO = 0.85;            // 每帧滚动 85% 视口高度（保留 15% 重叠用于对齐）
  const MAX_SEGS = 100;               // 最多 100 帧
  const MIN_SEGS = 10;                // 最少截 10 帧（防止过早触发底部检测）
  const STUCK_THRESHOLD = 3;          // 连续 3 次滚动无效才判定到底（降低后减少尾部空白帧）
  const WHEEL_DELTA = Math.round(clientH * STEP_RATIO); // 每次滚动的 CSS 像素

  console.log('[SS-DIAG] 虚拟滚动策略参数:', JSON.stringify({
    selector, elX, elY, elW, clientH, dpr, format, WHEEL_DELTA, MAX_SEGS, MIN_SEGS, STUCK_THRESHOLD
  }));

  // ── 辅助：采样 Canvas 多个位置像素（用于检测滚动是否有效）──
  async function sampleCanvasPixels() {
    const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        var canvas = el.tagName.toLowerCase() === 'canvas' ? el : el.querySelector('canvas');
        if (!canvas) return null;
        try {
          var ctx2d = canvas.getContext('2d');
          if (!ctx2d) return null;
          var w = canvas.width, h = canvas.height;
          // 4 个采样点：中心、中心偏下、右下、左下（增加采样点提高可靠性）
          var p1 = ctx2d.getImageData(Math.floor(w*0.5), Math.floor(h*0.5), 1, 1).data;
          var p2 = ctx2d.getImageData(Math.floor(w*0.5), Math.floor(h*0.75), 1, 1).data;
          var p3 = ctx2d.getImageData(Math.floor(w*0.75), Math.floor(h*0.75), 1, 1).data;
          var p4 = ctx2d.getImageData(Math.floor(w*0.25), Math.floor(h*0.75), 1, 1).data;
          return {
            p1: { r: p1[0], g: p1[1], b: p1[2] },
            p2: { r: p2[0], g: p2[1], b: p2[2] },
            p3: { r: p3[0], g: p3[1], b: p3[2] },
            p4: { r: p4[0], g: p4[1], b: p4[2] }
          };
        } catch(e) { return null; }
      })()`,
      returnByValue: true
    });
    return res.result ? res.result.value : null;
  }

  // ── 辅助：比较两组采样点的总变化量 ──
  function calcPixelDelta(before, after) {
    let total = 0;
    for (const key of ['p1', 'p2', 'p3', 'p4']) {
      const b = before[key], a = after[key];
      if (!b || !a) continue;
      total += Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    }
    return total;
  }

  // ── 辅助：等待 Canvas 像素稳定（用于异步渲染的 Canvas 应用如腾讯文档）──
  // 滚动后 Canvas 可能需要异步加载数据并重绘，此函数轮询采样直到像素不再变化。
  // minWait: 最少等待时间（ms）
  // maxWait: 最大等待时间（ms）
  // stabilityThreshold: 连续两次采样变化小于此值认为已稳定
  // ══════════════════════════════════════════
  async function waitCanvasStable(minWait = 1200, maxWait = 6000, stabilityThreshold = 10) {
    // 1. 先等待最小时间
    await sleep(minWait);

    // 2. 轮询检测 Canvas 是否稳定
    let prev = await sampleCanvasPixels();
    if (!prev) {
      console.log('[SS-DIAG] Canvas 稳定检测：无法采样，跳过');
      return;
    }

    const startTime = Date.now();
    const pollInterval = 300; // 每 300ms 采样一次
    let stableRounds = 0; // 连续稳定的次数

    while (Date.now() - startTime < maxWait - minWait) {
      await sleep(pollInterval);
      const curr = await sampleCanvasPixels();
      if (!curr) return;

      const delta = calcPixelDelta(prev, curr);
      console.log(`[SS-DIAG] Canvas 稳定检测: delta=${delta}, threshold=${stabilityThreshold}`);

      if (delta < stabilityThreshold) {
        stableRounds++;
        if (stableRounds >= 2) { // 连续 2 次稳定才确认
          console.log(`[SS-DIAG] Canvas 已稳定，共等待 ${Date.now() - startTime + minWait}ms`);
          return;
        }
      } else {
        stableRounds = 0; // 不稳定，重置计数
      }
      prev = curr;
    }

    console.log(`[SS-DIAG] Canvas 稳定检测超时 (${maxWait}ms)，强制继续`);
  }

  // ══════════════════════════════════════════
  // 辅助：检测帧是否大面积空白（Canvas 异步渲染未完成的标志）
  // 对 pixelData 随机采样多个点，如果颜色高度一致（接近单色），认为帧空白。
  // 返回 { isBlank: boolean, avgDiff: number }
  // ══════════════════════════════════════════
  function checkFrameBlank(pixelData, width, height) {
    const SAMPLE_COUNT = 24;
    const samples = [];
    // 伪随机采样（固定种子模式，保证可复现）
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const x = Math.floor(width * (0.05 + 0.9 * ((i * 7 + 3) % SAMPLE_COUNT) / SAMPLE_COUNT));
      const y = Math.floor(height * (0.05 + 0.9 * ((i * 13 + 5) % SAMPLE_COUNT) / SAMPLE_COUNT));
      const idx = (y * width + x) * 4;
      samples.push({ r: pixelData[idx], g: pixelData[idx+1], b: pixelData[idx+2] });
    }

    // 计算所有样本点之间的平均颜色差异
    let totalDiff = 0;
    let pairCount = 0;
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        const a = samples[i], b = samples[j];
        totalDiff += Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
        pairCount++;
      }
    }
    const avgDiff = pairCount > 0 ? totalDiff / pairCount : 0;
    // 如果平均差异 < 12 认为是空白（大面积单色背景）
    const isBlank = avgDiff < 12;
    console.log(`[SS-DIAG] 空白帧检测: avgDiff=${avgDiff.toFixed(1)}, isBlank=${isBlank}`);
    return { isBlank, avgDiff };
  }

  // ══════════════════════════════════════════
  // 辅助：检测帧是否大面积暗色/黑色（Canvas 渲染中途清空状态）
  // 采样多个点，计算平均亮度 (R+G+B)/3，如果大部分点亮度很低则认为是暗帧。
  // 返回 { isDark: boolean, avgBrightness: number }
  // ══════════════════════════════════════════
  function checkFrameDark(pixelData, width, height) {
    const SAMPLE_COUNT = 16;
    let totalBrightness = 0;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const x = Math.floor(width * (0.05 + 0.9 * ((i * 5 + 7) % SAMPLE_COUNT) / SAMPLE_COUNT));
      const y = Math.floor(height * (0.05 + 0.9 * ((i * 11 + 3) % SAMPLE_COUNT) / SAMPLE_COUNT));
      const idx = (y * width + x) * 4;
      const brightness = (pixelData[idx] + pixelData[idx+1] + pixelData[idx+2]) / 3;
      totalBrightness += brightness;
    }
    const avgBrightness = totalBrightness / SAMPLE_COUNT;
    // 平均亮度 < 30 认为是暗帧（黑色或接近黑色）
    const isDark = avgBrightness < 30;
    if (isDark) {
      console.log(`[SS-DIAG] 暗帧检测: avgBrightness=${avgBrightness.toFixed(1)}, isDark=${isDark}`);
    }
    return { isDark, avgBrightness };
  }

  const chunks = [];  // { dataUrl, width, height, pixelData }
  let stuckCount = 0;  // 连续滚动无效计数
  let useSmallerDelta = false; // 当滚不动时尝试减小滚动量
  let consecutiveBlankFrames = 0; // 连续空白帧计数（用于加速底部退出）

  // ── 滚动方法自动检测 ──
  // 'jsWheel'     = JS WheelEvent（默认，钉钉文档有效）
  // 'cdpWheel'    = CDP Input.dispatchMouseEvent（真实事件，isTrusted: true）
  // 'programmatic'= scrollTop/scrollBy 程序化滚动
  // 'keyboard'    = CDP Input.dispatchKeyEvent（PageDown/ArrowDown，电子表格编辑器常用）
  // 'touch'       = Touch 拖拽模拟（移动端优先应用）
  // 'pointer'     = Pointer 拖拽模拟（统一事件模型应用）
  // 'internal'    = 直接调用页面内部 API（最后手段）
  let scrollMethod = 'jsWheel';
  let cdpViewportCoords = null;  // CDP 滚轮所需的视口坐标
  let cdpWheelAvailable = null;  // null = 未测试, true/false
  let keyboardAvailable = null;  // null = 未测试, true/false
  let touchAvailable = null;     // null = 未测试, true/false
  let pointerAvailable = null;   // null = 未测试, true/false
  let internalApiAvailable = null; // null = 未测试, true/false

  try {
    for (let i = 0; i < MAX_SEGS; i++) {
      if (isCancelledFn ? isCancelledFn() : false) throw new Error('截图已取消');
      try { chrome.runtime.sendMessage({ action: 'screenshotProgress', message: `正在截取虚拟滚动第 ${i + 1} 帧...` }); } catch (_) {}

      // ── 截图当前帧 ──
      const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
        format, fromSurface: true, captureBeyondViewport: true,
        clip: { x: elX, y: elY, width: elW, height: clientH, scale: 1 }
      });
      const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const dataUrl = 'data:' + mime + ';base64,' + res.data;

      // ── 转为像素数据（用于后续对齐）──
      const img = await createImageBitmap(await fetch(dataUrl).then(r => r.blob()));
      const c = new OffscreenCanvas(img.width, img.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);

      // ── 保存当前帧 ──
      chunks.push({
        dataUrl,
        width: imageData.width,
        height: imageData.height,
        pixelData: imageData.data
      });
      console.log(`[SS-DIAG] 虚拟滚动 帧${i+1} 已截取 (${imageData.width}×${imageData.height})`);

      // ── 检测异常帧（空白/暗色/渲染未完成）──
      // 腾讯文档等异步渲染 Canvas 可能截到空白或暗色（渲染中途清空状态）
      const blankCheck = checkFrameBlank(imageData.data, imageData.width, imageData.height);
      const darkCheck = checkFrameDark(imageData.data, imageData.width, imageData.height);
      const isBadFrame = (blankCheck.isBlank || darkCheck.isDark) && i > 0;

      if (isBadFrame) {
        const reason = blankCheck.isBlank ? '空白' : '暗色';
        console.log(`[SS-DIAG] 帧${i+1} 检测到${reason}帧，重试中...`);
        // 额外等待并重截一次（给异步渲染更多时间）
        await waitCanvasStable(2000, 6000);
        const retryRes = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
          format, fromSurface: true, captureBeyondViewport: true,
          clip: { x: elX, y: elY, width: elW, height: clientH, scale: 1 }
        });
        const retryMime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const retryDataUrl = 'data:' + retryMime + ';base64,' + retryRes.data;
        const retryImg = await createImageBitmap(await fetch(retryDataUrl).then(r => r.blob()));
        const retryC = new OffscreenCanvas(retryImg.width, retryImg.height);
        const retryCtx = retryC.getContext('2d');
        retryCtx.drawImage(retryImg, 0, 0);
        const retryImageData = retryCtx.getImageData(0, 0, retryImg.width, retryImg.height);

        const retryBlankCheck = checkFrameBlank(retryImageData.data, retryImageData.width, retryImageData.height);
        const retryDarkCheck = checkFrameDark(retryImageData.data, retryImageData.width, retryImageData.height);

        if (!retryBlankCheck.isBlank && !retryDarkCheck.isDark) {
          console.log(`[SS-DIAG] 帧${i+1} 重截成功，替换异常帧`);
          consecutiveBlankFrames = 0; // 恢复成功，重置计数
          chunks[chunks.length - 1] = {
            dataUrl: retryDataUrl,
            width: retryImageData.width,
            height: retryImageData.height,
            pixelData: retryImageData.data
          };
        } else {
          consecutiveBlankFrames++;
          console.log(`[SS-DIAG] 帧${i+1} 重截仍为${reason}帧 (连续${consecutiveBlankFrames}次)`);
          // 连续 3 次异常帧 = 必定到达底部，无条件退出
          if (consecutiveBlankFrames >= 3) {
            console.log('[SS-DIAG] 连续3次异常帧，确认到达底部，终止');
            break;
          }
        }
      } else {
        consecutiveBlankFrames = 0; // 正常帧，重置计数
      }

      // ── 滚动前采样 ──
      const beforePixels = await sampleCanvasPixels();
      if (!beforePixels) {
        console.log('[SS-DIAG] 无法采样 Canvas 像素，停止滚动');
        break;
      }

      // ── 发送滚动事件 ──
      const actualDelta = useSmallerDelta ? Math.round(WHEEL_DELTA / 2) : WHEEL_DELTA;
      console.log(`[SS-DIAG] 虚拟滚动 帧${i+1}: 滚动方法=${scrollMethod}, deltaY=${actualDelta}${useSmallerDelta ? ' (减半重试)' : ''}`);

      if (scrollMethod === 'cdpWheel') {
        // CDP 真实滚轮事件
        if (cdpViewportCoords) {
          await dispatchCdpWheelEvent(tabId, cdpViewportCoords.x, cdpViewportCoords.y, actualDelta);
        }
      } else if (scrollMethod === 'programmatic') {
        // 程序化滚动
        await tryProgrammaticScroll(tabId, selector, actualDelta);
      } else if (scrollMethod === 'keyboard') {
        // 键盘滚动：PageDown 2次 + ArrowDown 8次，约等于一屏高度
        const pageDownCount = Math.max(1, Math.round(actualDelta / clientH * 2));
        const arrowDownCount = Math.max(2, Math.round(actualDelta / 20));
        await dispatchKeyboardScroll(tabId, selector, pageDownCount, arrowDownCount);
      } else if (scrollMethod === 'touch') {
        // Touch 拖拽模拟滚动（移动端优先应用）
        await dispatchTouchScroll(tabId, selector, Math.min(actualDelta, clientH * 0.6));
      } else if (scrollMethod === 'pointer') {
        // Pointer 拖拽模拟滚动（统一事件模型应用）
        await dispatchPointerScroll(tabId, selector, Math.min(actualDelta, clientH * 0.6));
      } else if (scrollMethod === 'internal') {
        // 直接调用页面内部 API（最后手段）
        await tryInternalScrollApi(tabId, selector, actualDelta);
      } else {
        // JS WheelEvent（默认）
        await dispatchJsWheelEvent(tabId, selector, actualDelta);
      }
      await waitCanvasStable(1200, 6000); // 等待 Canvas 稳定（腾讯文档等异步渲染应用需要）

      // ── 滚动后采样 ──
      const afterPixels = await sampleCanvasPixels();
      if (!afterPixels) {
        console.log('[SS-DIAG] 滚动后无法采样 Canvas 像素，停止滚动');
        break;
      }

      // ── 比较像素变化 ──
      const pixelDelta = calcPixelDelta(beforePixels, afterPixels);
      console.log(`[SS-DIAG] 帧${i+1} 像素变化: delta=${pixelDelta} (方法=${scrollMethod})`);

      // 底部检测：需要连续 STUCK_THRESHOLD 次 delta < 15 才判定到底（前 MIN_SEGS 帧不检测）
      if (pixelDelta < 15) {
        stuckCount++;
        console.log(`[SS-DIAG] 像素变化小，累计无效滚动: ${stuckCount}/${STUCK_THRESHOLD}`);

        // ── 自动切换滚动方法（前5帧内才尝试，避免浪费时间）──
        if (stuckCount <= 3 && i < 6 && scrollMethod === 'jsWheel') {
          // 1. 尝试 CDP 真实滚轮事件
          if (cdpWheelAvailable === null) {
            cdpViewportCoords = await getCanvasViewportCoords(tabId, selector);
            if (cdpViewportCoords) {
              cdpWheelAvailable = await dispatchCdpWheelEvent(tabId, cdpViewportCoords.x, cdpViewportCoords.y, actualDelta);
              if (cdpWheelAvailable) {
                await waitCanvasStable(800, 4000);
                const cdpAfter = await sampleCanvasPixels();
                if (cdpAfter && calcPixelDelta(beforePixels, cdpAfter) >= 15) {
                  scrollMethod = 'cdpWheel';
                  stuckCount = 0;
                  useSmallerDelta = false;
                  console.log('[SS-DIAG] 自动切换到 CDP mouseWheel（isTrusted: true）');
                  continue;
                }
              }
            } else {
              cdpWheelAvailable = false;
            }
          }

          // 2. CDP 滚轮不行，尝试程序化滚动
          console.log('[SS-DIAG] CDP mouseWheel 无效，尝试程序化滚动...');
          await tryProgrammaticScroll(tabId, selector, actualDelta);
          await waitCanvasStable(800, 4000);
          const progAfter = await sampleCanvasPixels();
          if (progAfter && calcPixelDelta(beforePixels, progAfter) >= 15) {
            scrollMethod = 'programmatic';
            stuckCount = 0;
            useSmallerDelta = false;
            console.log('[SS-DIAG] 自动切换到程序化滚动（scrollBy/scrollTop）');
            continue;
          }

          // 3. 程序化也不行，尝试键盘事件（PageDown/ArrowDown）
          if (keyboardAvailable === null) {
            console.log('[SS-DIAG] 程序化滚动无效，尝试键盘滚动...');
            keyboardAvailable = await dispatchKeyboardScroll(tabId, selector, 2, 8);
            if (keyboardAvailable) {
              await waitCanvasStable(1200, 5000); // 键盘事件触发后需要更长时间重绘
              const kbAfter = await sampleCanvasPixels();
              if (kbAfter && calcPixelDelta(beforePixels, kbAfter) >= 15) {
                scrollMethod = 'keyboard';
                stuckCount = 0;
                useSmallerDelta = false;
                console.log('[SS-DIAG] 自动切换到键盘滚动（PageDown/ArrowDown）');
                continue;
              }
            }
          }

          // 4. 键盘也不行，尝试 Touch 拖拽
          if (touchAvailable === null) {
            console.log('[SS-DIAG] 键盘滚动无效，尝试 Touch 拖拽...');
            touchAvailable = await dispatchTouchScroll(tabId, selector, Math.min(actualDelta, clientH * 0.6));
            if (touchAvailable && touchAvailable.ok) {
              await waitCanvasStable(1000, 5000);
              const touchAfter = await sampleCanvasPixels();
              if (touchAfter && calcPixelDelta(beforePixels, touchAfter) >= 15) {
                scrollMethod = 'touch';
                stuckCount = 0;
                useSmallerDelta = false;
                console.log('[SS-DIAG] 自动切换到 Touch 拖拽滚动');
                continue;
              }
            }
          }

          // 5. Touch 也不行，尝试 Pointer 拖拽
          if (pointerAvailable === null) {
            console.log('[SS-DIAG] Touch 拖拽无效，尝试 Pointer 拖拽...');
            pointerAvailable = await dispatchPointerScroll(tabId, selector, Math.min(actualDelta, clientH * 0.6));
            if (pointerAvailable && pointerAvailable.ok) {
              await waitCanvasStable(1000, 5000);
              const ptrAfter = await sampleCanvasPixels();
              if (ptrAfter && calcPixelDelta(beforePixels, ptrAfter) >= 15) {
                scrollMethod = 'pointer';
                stuckCount = 0;
                useSmallerDelta = false;
                console.log('[SS-DIAG] 自动切换到 Pointer 拖拽滚动');
                continue;
              }
            }
          }

          // 6. Pointer 也不行，探查并尝试内部 API
          if (internalApiAvailable === null) {
            console.log('[SS-DIAG] Pointer 拖拽无效，探查页面内部 API...');
            const probeResult = await probeInternalScrollApi(tabId, selector);
            console.log('[SS-DIAG] 内部 API 探查结果:', JSON.stringify(probeResult));
            const intResult = await tryInternalScrollApi(tabId, selector, actualDelta);
            if (intResult && intResult.ok && intResult.attempts && intResult.attempts.length > 0) {
              internalApiAvailable = true;
              await waitCanvasStable(1000, 5000);
              const intAfter = await sampleCanvasPixels();
              if (intAfter && calcPixelDelta(beforePixels, intAfter) >= 15) {
                scrollMethod = 'internal';
                stuckCount = 0;
                useSmallerDelta = false;
                console.log('[SS-DIAG] 自动切换到内部 API 滚动，方法:', intResult.attempts);
                continue;
              }
            }
          }

          // 7. 所有方法都无效，尝试减半滚动量
          if (!useSmallerDelta) {
            console.log('[SS-DIAG] 所有滚动方法无效，尝试减半滚动量');
            useSmallerDelta = true;
            continue;
          }
        }

        // 已锁定非 JS Wheel 方法后，第一次 stuck 尝试减半滚动量
        if (stuckCount === 1 && scrollMethod !== 'jsWheel' && !useSmallerDelta) {
          console.log('[SS-DIAG] 尝试减半滚动量重试');
          useSmallerDelta = true;
          continue;
        }

        // JS Wheel 模式下前3次 stuck 内，再次尝试其他方法（CDP Input 域可能刚准备好）
        if (stuckCount === 2 && scrollMethod === 'jsWheel') {
          console.log('[SS-DIAG] 再次尝试键盘/Touch/Pointer/Internal 滚动...');
          // 键盘
          if (keyboardAvailable === null) {
            keyboardAvailable = await dispatchKeyboardScroll(tabId, selector, 2, 8);
            if (keyboardAvailable) {
              await waitCanvasStable(1200, 5000);
              const kbAfter = await sampleCanvasPixels();
              if (kbAfter && calcPixelDelta(beforePixels, kbAfter) >= 15) {
                scrollMethod = 'keyboard';
                stuckCount = 0;
                useSmallerDelta = false;
                console.log('[SS-DIAG] 自动切换到键盘滚动（PageDown/ArrowDown）');
                continue;
              }
            }
          }
          // Touch
          if (touchAvailable === null) {
            touchAvailable = await dispatchTouchScroll(tabId, selector, Math.min(actualDelta, clientH * 0.6));
            if (touchAvailable && touchAvailable.ok) {
              await waitCanvasStable(1000, 5000);
              const touchAfter = await sampleCanvasPixels();
              if (touchAfter && calcPixelDelta(beforePixels, touchAfter) >= 15) {
                scrollMethod = 'touch';
                stuckCount = 0;
                useSmallerDelta = false;
                console.log('[SS-DIAG] 自动切换到 Touch 拖拽滚动');
                continue;
              }
            }
          }
          // Pointer
          if (pointerAvailable === null) {
            pointerAvailable = await dispatchPointerScroll(tabId, selector, Math.min(actualDelta, clientH * 0.6));
            if (pointerAvailable && pointerAvailable.ok) {
              await waitCanvasStable(1000, 5000);
              const ptrAfter = await sampleCanvasPixels();
              if (ptrAfter && calcPixelDelta(beforePixels, ptrAfter) >= 15) {
                scrollMethod = 'pointer';
                stuckCount = 0;
                useSmallerDelta = false;
                console.log('[SS-DIAG] 自动切换到 Pointer 拖拽滚动');
                continue;
              }
            }
          }
          // 内部 API
          if (internalApiAvailable === null) {
            const probeResult = await probeInternalScrollApi(tabId, selector);
            console.log('[SS-DIAG] 内部 API 探查结果:', JSON.stringify(probeResult));
            const intResult = await tryInternalScrollApi(tabId, selector, actualDelta);
            if (intResult && intResult.ok && intResult.attempts && intResult.attempts.length > 0) {
              internalApiAvailable = true;
              await waitCanvasStable(1000, 5000);
              const intAfter = await sampleCanvasPixels();
              if (intAfter && calcPixelDelta(beforePixels, intAfter) >= 15) {
                scrollMethod = 'internal';
                stuckCount = 0;
                useSmallerDelta = false;
                console.log('[SS-DIAG] 自动切换到内部 API 滚动');
                continue;
              }
            }
          }
        }

        if (i >= MIN_SEGS && stuckCount >= STUCK_THRESHOLD) {
          console.log('[SS-DIAG] 连续 ' + STUCK_THRESHOLD + ' 次滚动无变化，确认到达底部');
          break;
        }
      } else {
        stuckCount = 0;
        useSmallerDelta = false; // 滚动有效，恢复正常滚动量
      }
    }

    if (chunks.length === 0) throw new Error('没有截到任何帧');
    if (chunks.length === 1) return chunks[0].dataUrl;

    console.log(`[SS-DIAG] 虚拟滚动共截取 ${chunks.length} 帧，开始像素级对齐拼接...`);

    // ── 阶段0：检测冻结表头 ──
    // 在线文档（钉钉/腾讯文档等）在 Canvas 顶部固定绘制表头行，
    // 每帧截图的顶部都会包含相同的表头内容。拼接时需要跳过后续帧的表头，
    // 否则表头会在最终图片中重复出现。
    let headerH = 0;
    if (chunks.length >= 2) {
      headerH = detectFrozenHeader(
        chunks[0].pixelData, chunks[0].width, chunks[0].height,
        chunks[1].pixelData, chunks[1].width, chunks[1].height
      );
      if (headerH > 0) {
        console.log(`[SS-DIAG] 检测到冻结表头: ${headerH}px — 拼接时将跳过后续帧的表头区域`);
      } else {
        console.log(`[SS-DIAG] 未检测到冻结表头，正常拼接`);
      }
    }

    // ── 阶段1：测量前3帧对，判断偏移是否稳定 ──
    const measuredOffsets = [];
    for (let i = 1; i < Math.min(chunks.length, 4); i++) {
      const match = measureOffset(
        chunks[i - 1].pixelData, chunks[i - 1].width, chunks[i - 1].height,
        chunks[i].pixelData, chunks[i].width, chunks[i].height,
        headerH  // 跳过冻结表头区域搜索
      );
      console.log(`[SS-DIAG] 帧${i} 实测偏移: ${match.offset}px (有效=${match.valid}, 置信度=${Math.round(match.confidence)})`);
      if (match.valid) measuredOffsets.push(match.offset);
    }

    let fixedOffset = null;
    if (measuredOffsets.length >= 2) {
      const avg = measuredOffsets.reduce((a, b) => a + b, 0) / measuredOffsets.length;
      const variance = measuredOffsets.reduce((sum, o) => sum + (o - avg) * (o - avg), 0) / measuredOffsets.length;
      const stdDev = Math.sqrt(variance);
      const cv = stdDev / avg; // 变异系数

      if (cv < 0.08) {
        // 偏移稳定（变异 < 8%），固定使用平均值
        fixedOffset = Math.round(avg);
        console.log(`[SS-DIAG] 偏移校准完成: 固定=${fixedOffset}px (样本=[${measuredOffsets.join(',')}], 标准差=${Math.round(stdDev)})`);
      } else {
        console.log(`[SS-DIAG] 偏移不稳定(变异系数=${cv.toFixed(2)})，逐帧测量`);
      }
    } else {
      console.log(`[SS-DIAG] 有效测量不足(${measuredOffsets.length}个)，逐帧测量`);
    }

    // ── 阶段2：拼接所有帧 ──
    // offsets[i] 表示第 i 帧的「主体内容」在输出画布上的起始 Y 坐标
    // 对于帧 0：主体从 headerH 开始（表头占 [0, headerH)）
    // 对于帧 1+：主体也从 headerH 开始（冻结表头在每帧顶部重复）
    // 拼接时：帧 0 画完整帧，帧 1+ 只画 [headerH, frameH) 部分到 offsets[i] + headerH
    const offsets = [0];
    for (let i = 1; i < chunks.length; i++) {
      let offset;

      if (fixedOffset !== null) {
        // 使用固定偏移，但每5帧验证一次
        offset = fixedOffset;
        if (i % 5 === 0) {
          const verify = measureOffset(
            chunks[i - 1].pixelData, chunks[i - 1].width, chunks[i - 1].height,
            chunks[i].pixelData, chunks[i].width, chunks[i].height,
            headerH  // 跳过冻结表头
          );
          if (verify.valid && Math.abs(verify.offset - fixedOffset) > chunks[i - 1].height * 0.15) {
            console.log(`[SS-DIAG] 帧${i} 验证偏离: 固定=${fixedOffset}, 实测=${verify.offset}，重新校准`);
            fixedOffset = verify.offset;
            offset = verify.offset;
          }
        }
      } else {
        // 逐帧测量
        const match = measureOffset(
          chunks[i - 1].pixelData, chunks[i - 1].width, chunks[i - 1].height,
          chunks[i].pixelData, chunks[i].width, chunks[i].height,
          headerH  // 跳过冻结表头
        );
        if (match.valid) {
          offset = match.offset;
        } else {
          // 回退：用上一帧的偏移，或预期值
          offset = (i > 1 && offsets[i - 1] - offsets[i - 2] > 0)
            ? offsets[i - 1] - offsets[i - 2]
            : Math.round(WHEEL_DELTA * dpr);
          console.log(`[SS-DIAG] 帧${i} 测量失败，回退到 ${offset}px`);
        }
      }

      const actualOffset = offsets[i - 1] + offset;
      offsets.push(actualOffset);
      console.log(`[SS-DIAG] 帧${i} 最终偏移: ${offset}px, 累计=${actualOffset}px`);
    }

    const physW = chunks[0].width;
    // 有冻结表头时，最后一帧主体内容到 offsets[last]+headerH+主体高度 = offsets[last]+frameH
    // 无冻结表头时，同样是 offsets[last]+frameH，公式不变
    const totalPhysH = offsets[offsets.length - 1] + chunks[chunks.length - 1].height;

    const avgOffset = (offsets[offsets.length - 1]) / (chunks.length - 1);
    console.log(`[SS-DIAG] 对齐后总高度: ${totalPhysH}px (共${chunks.length}帧, 平均偏移=${Math.round(avgOffset)}px, 表头=${headerH}px)`);

    if (physW * totalPhysH > MAX_TOTAL_PIXELS) {
      throw new Error(`区域过大（${Math.round(physW * totalPhysH / 1e6)}MP），超过 500MP 上限`);
    }

    const outCanvas = new OffscreenCanvas(physW, totalPhysH);
    const outCtx = outCanvas.getContext('2d');
    if (format === 'jpeg') {
      outCtx.fillStyle = '#ffffff';
      outCtx.fillRect(0, 0, physW, totalPhysH);
    }

    // 拼接绘制：帧 0 画完整帧；帧 1+ 跳过冻结表头区域
    // 原理：在线文档 Canvas 每帧顶部都有冻结表头，只有帧 0 的表头需要保留。
    // 帧 1+ 的主体内容 (canvas_y=[headerH, frameH)) 对应的输出位置是 offsets[i] + headerH，
    // 因为 offsets[i] 是滚动累积偏移（主体内容的文档位置），headerH 是表头占用的像素。
    for (let i = 0; i < chunks.length; i++) {
      const img = await createImageBitmap(await fetch(chunks[i].dataUrl).then(r => r.blob()));
      if (i === 0 || headerH === 0) {
        // 帧 0 或无冻结表头：画完整帧
        outCtx.drawImage(img, 0, offsets[i]);
      } else {
        // 帧 1+ 有冻结表头：只画表头以下的部分
        // drawImage(img, srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH)
        const srcY = headerH;
        const srcH = img.height - headerH;
        const dstY = offsets[i] + headerH;
        outCtx.drawImage(img, 0, srcY, img.width, srcH, 0, dstY, img.width, srcH);
      }
    }

    const blob = await outCanvas.convertToBlob({
      type: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      quality: quality / 100
    });
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    console.log(`[SS-DIAG] 虚拟滚动拼接完成: ${physW}x${totalPhysH} 像素`);
    return dataUrl;

  } finally {
    // 无需清理 Input 域（未使用）
  }
}

// 计算两帧的 RGB 平均差异，返回相似度（0~1，1 表示完全相同）
function calculateFrameSimilarity(prevData, currData, width, height) {
  let diff = 0;
  const len = Math.min(prevData.length, currData.length);
  const pixels = len / 4;
  for (let i = 0; i < len; i += 4) {
    diff += Math.abs(prevData[i] - currData[i]);         // R
    diff += Math.abs(prevData[i + 1] - currData[i + 1]); // G
    diff += Math.abs(prevData[i + 2] - currData[i + 2]); // B
  }
  const avgDiff = diff / (pixels * 3);
  return Math.max(0, 1 - (avgDiff / 255));
}

// ══════════════════════════════════════════
// 辅助：区域截图 - 逐段滚动策略
// ══════════════════════════════════════════
async function captureRegionWithScrolling(tabId, selector, elX, elY, elW, clientH, scrollH, dpr, pageW, format = 'png', quality = 92, isCancelledFn = null) {

  const MAX_PHYSICAL_H = 16000;
  const maxSegCssH = Math.floor(MAX_PHYSICAL_H / dpr);
  const totalH = scrollH;
  const segH = Math.min(clientH, maxSegCssH - 100);
  const segs = Math.ceil(totalH / segH);

  console.log('[SS-DIAG] 逐段滚动策略参数:', JSON.stringify({
    selector, elX, elY, elW, clientH, scrollH, dpr, pageW,
    totalH, segH, segs, maxSegCssH
  }));

  // 对 sticky/fixed 元素临时改为 relative，避免视口变化时定位异常
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      const cs = window.getComputedStyle(el);
      if (cs.position === 'sticky' || cs.position === 'fixed') {
        window.__ss_scroll_saved_position = el.style.position;
        el.style.position = 'relative';
      }
    })()`
  });

  // Input 域在扩展 debugger 中不可用（-32601），已改用 JS WheelEvent

  // ── 先确保目标元素在页面视口内可见 ──
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.scrollIntoView({ block: 'start', inline: 'start' });
    })()`
  });
  await sleep(300);

  // ── 诊断：查找页面中所有可能响应滚动的元素 ──
  const diagRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      var results = [];
      // 1. 检查 selector 元素本身
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el) {
        results.push({
          name: 'selector元素',
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 80) : '',
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          overflow: window.getComputedStyle(el).overflow,
          overflowY: window.getComputedStyle(el).overflowY
        });
      }
      // 2. 检查 document.scrollingElement
      var se = document.scrollingElement;
      if (se) {
        results.push({
          name: 'document.scrollingElement',
          tag: se.tagName.toLowerCase(),
          scrollTop: se.scrollTop,
          scrollHeight: se.scrollHeight,
          clientHeight: se.clientHeight
        });
      }
      // 3. 检查 Canvas 子元素（selector 内的 canvas）
      if (el) {
        var canvas = el.querySelector('canvas');
        if (canvas) {
          var cr = canvas.getBoundingClientRect();
          results.push({
            name: 'Canvas子元素',
            tag: 'canvas',
            w: Math.round(cr.width),
            h: Math.round(cr.height),
            scrollH: canvas.scrollHeight,
            clientH: canvas.clientHeight
          });
        }
      }
      // 4. 检查 selector 的直接子元素中有 overflow 的
      if (el) {
        var children = el.children;
        for (var ci = 0; ci < Math.min(children.length, 10); ci++) {
          var child = children[ci];
          var ccs = window.getComputedStyle(child);
          if (ccs.overflowY !== 'visible' || child.scrollHeight > child.clientHeight + 5) {
            results.push({
              name: '子元素[' + ci + ']',
              tag: child.tagName.toLowerCase(),
              cls: (child.className && typeof child.className === 'string') ? child.className.slice(0, 60) : '',
              overflowY: ccs.overflowY,
              scrollH: child.scrollHeight,
              clientH: child.clientHeight,
              scrollTop: child.scrollTop
            });
          }
        }
      }
      return results;
    })()`,
    returnByValue: true
  });
  const diagInfo = diagRes.result && diagRes.result.value;
  console.log('[SS-DIAG] 滚动元素诊断:', JSON.stringify(diagInfo, null, 2));

  // 获取元素在视口中的位置（用于 CDP 鼠标事件坐标）
  const elPosRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`,
    returnByValue: true
  });
  const elPos = elPosRes.result && elPosRes.result.value;
  if (!elPos) throw new Error('无法获取滚动区域位置');

  // CDP 鼠标坐标：元素中心
  const mouseX = Math.round(elPos.left + elPos.width / 2);
  const mouseY = Math.round(elPos.top + elPos.height / 2);

  // 先将元素 scrollTop 归零
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.scrollTop = 0;
    })()`
  });
  await sleep(200);

  // ── 诊断：测试 scrollTop 归零是否生效 ──
  const zeroCheckRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      return el ? { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null;
    })()`,
    returnByValue: true
  });
  console.log('[SS-DIAG] scrollTop归零检查:', JSON.stringify(zeroCheckRes.result && zeroCheckRes.result.value));

  // ── 诊断：尝试一个小的 scrollTop 写入测试 ──
  const testScrollRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: 'element not found' };
      var before = el.scrollTop;
      el.scrollTop = 100;
      var after = el.scrollTop;
      el.scrollTop = 0; // 归零
      return { before: before, after: after, writable: (after > before + 5) };
    })()`,
    returnByValue: true
  });
  console.log('[SS-DIAG] scrollTop写入测试:', JSON.stringify(testScrollRes.result && testScrollRes.result.value));

  const chunks = [];
  try {
    // 不使用 setDeviceMetricsOverride —— 在线文档（钉钉/腾讯文档/飞书等）
    // 会在视口变化时重新布局，导致 Canvas 内容重置或滚动状态丢失。
    // 改为保持原始视口 + captureBeyondViewport: true 截取。
    // 对于纯 DOM 滚动区域（如普通 div），这种方式同样有效。

    for (let i = 0; i < segs; i++) {
      if (isCancelledFn ? isCancelledFn() : cancelledSessionId === captureSessionId) throw new Error('截图已取消');
      try { chrome.runtime.sendMessage({ action: 'screenshotProgress', message: `正在截取区域第 ${i + 1}/${segs} 段...` }); } catch (_) {}
      const scrollTarget = i * segH;
      const remaining = totalH - scrollTarget;
      const curH = Math.min(segH, remaining);

      // ── 滚动到目标位置 ──
      // 双管齐下：先设置 scrollTop（对普通 div 有效），
      // 再用 CDP 鼠标滚轮（对 JS 虚拟滚动的在线文档有效）
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(function(){
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) el.scrollTop = ${scrollTarget};
        })()`
      });
      await sleep(100);

      // 获取当前实际 scrollTop，计算差额
      const curScrollRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(function(){
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
          return {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight
          };
        })()`,
        returnByValue: true
      });
      const curScrollInfo = curScrollRes.result && curScrollRes.result.value;
      const curScrollTop = (curScrollInfo && curScrollInfo.scrollTop) || 0;
      const scrollDelta = scrollTarget - curScrollTop;

      console.log(`[SS-DIAG] 段${i+1}/${segs}: scrollTarget=${scrollTarget}, curScrollTop=${curScrollTop}, scrollDelta=${scrollDelta}, scrollH=${(curScrollInfo && curScrollInfo.scrollHeight) || '?'}, clientH=${(curScrollInfo && curScrollInfo.clientHeight) || '?'}`);

      // 如果 scrollTop 没到位，用 CDP 鼠标滚轮补齐
      // 在线文档（钉钉/腾讯文档等）使用 JS 虚拟滚动，不响应直接 scrollTop 赋值，
      // 但会响应通过浏览器输入管道派发的鼠标滚轮事件
      if (Math.abs(scrollDelta) > 2) {
        console.log(`[SS-DIAG] 段${i+1}: scrollTop 未到位(delta=${scrollDelta}), 使用 JS WheelEvent`);

        // ── 累积式多次小步滚轮 ──
        // 一次性发送大的 deltaY 可能被钉钉等应用忽略或过度滚动，
        // 改为多次发送小步 deltaY（每次 120px，模拟真实鼠标滚轮的 3-4 行步进），
        // 每步之间等待一小段时间让应用处理事件
        const STEP_PX = 120;
        const steps = Math.ceil(Math.abs(scrollDelta) / STEP_PX);
        const direction = scrollDelta > 0 ? 1 : -1;
        let accumulatedDelta = 0;
        for (let s = 0; s < steps; s++) {
          const stepDelta = Math.min(STEP_PX, Math.abs(scrollDelta) - accumulatedDelta) * direction;
          await dispatchJsWheelEvent(tabId, selector, stepDelta);
          accumulatedDelta += Math.abs(stepDelta);
          await sleep(30); // 每步间隔 30ms，让事件队列处理
        }
        await sleep(200); // 等待最终滚动动画和 Canvas 重绘

        // 检查鼠标滚轮后的实际 scrollTop
        const afterWheelRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `(function(){
            const el = document.querySelector(${JSON.stringify(selector)});
            return el ? el.scrollTop : 0;
          })()`,
          returnByValue: true
        });
        const afterWheelTop = (afterWheelRes.result && afterWheelRes.result.value) || 0;
        console.log(`[SS-DIAG] 段${i+1}: JS WheelEvent 后 scrollTop=${afterWheelTop}, 变化=${afterWheelTop - curScrollTop}`);

        // 如果 scrollTop 仍然没有变化，尝试在 Canvas 子元素上派发
        if (Math.abs(afterWheelTop - curScrollTop) < 2 && i === 0) {
          console.log('[SS-DIAG] 滚轮无效，尝试查找 Canvas 子元素...');
          const canvasRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: `(function(){
              var el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return null;
              var canvas = el.querySelector('canvas');
              if (canvas) {
                return { selector: 'canvas', found: true };
              }
              return null;
            })()`,
            returnByValue: true
          });
          const canvasInfo = canvasRes.result && canvasRes.result.value;
          if (canvasInfo && canvasInfo.found) {
            console.log('[SS-DIAG] 找到 Canvas 子元素，重新派发滚轮...');
            // 用 Canvas selector 重试
            for (let s = 0; s < steps; s++) {
              const stepDelta = Math.min(STEP_PX, Math.abs(scrollDelta) - s * STEP_PX) * direction;
              if (stepDelta === 0) break;
              await dispatchJsWheelEvent(tabId, selector + ' canvas', stepDelta);
              await sleep(30);
            }
            await sleep(300);
            const retryRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
              expression: `(function(){
                const el = document.querySelector(${JSON.stringify(selector)});
                return el ? el.scrollTop : 0;
              })()`,
              returnByValue: true
            });
            const retryTop = (retryRes.result && retryRes.result.value) || 0;
            console.log(`[SS-DIAG] Canvas 子元素重试后 scrollTop=${retryTop}, 变化=${retryTop - curScrollTop}`);
          }
        }
      }

      // 等待 Canvas 重绘（在线文档需要更长时间）
      await sleep(400);

      // ── 诊断：Canvas 像素采样检测（确认滚动后 Canvas 内容是否变化）──
      if (i <= 1) { // 只在前两段检测，避免拖慢
        const canvasCheckRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `(function(){
            var el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { hasCanvas: false };
            var canvas = el.querySelector('canvas');
            if (!canvas) return { hasCanvas: false };
            try {
              var ctx = canvas.getContext('2d');
              if (!ctx) return { hasCanvas: true, readable: false };
              // 采样5个点的像素值
              var w = canvas.width, h = canvas.height;
              var samples = [];
              var pts = [
                [Math.floor(w*0.25), Math.floor(h*0.25)],
                [Math.floor(w*0.5), Math.floor(h*0.5)],
                [Math.floor(w*0.75), Math.floor(h*0.25)],
                [Math.floor(w*0.25), Math.floor(h*0.75)],
                [Math.floor(w*0.75), Math.floor(h*0.75)]
              ];
              for (var pi = 0; pi < pts.length; pi++) {
                var d = ctx.getImageData(pts[pi][0], pts[pi][1], 1, 1).data;
                samples.push(d[0]+','+d[1]+','+d[2]);
              }
              return { hasCanvas: true, readable: true, size: w+'x'+h, samples: samples };
            } catch(e) {
              return { hasCanvas: true, readable: false, error: e.message };
            }
          })()`,
          returnByValue: true
        });
        console.log(`[SS-DIAG] 段${i+1} Canvas像素采样:`, JSON.stringify(canvasCheckRes.result && canvasCheckRes.result.value));
      }

      // 获取当前区域位置（滚动后重新定位）
      const posRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(function(){
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            x: r.left + window.scrollX,
            y: r.top + window.scrollY,
            w: r.width,
            h: r.height
          };
        })()`,
        returnByValue: true
      });
      const pos = posRes.result && posRes.result.value;
      if (!pos) {
        console.warn(`第 ${i+1} 段无法获取位置，跳过`);
        continue;
      }

      // 截图
      console.log(`[SS-DIAG] 段${i+1}: 截图 clip: x=${pos.x}, y=${pos.y}, w=${pos.w}, h=${curH}, scale=1`);
      const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
        format: format,
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: pos.x, y: pos.y, width: pos.w, height: curH, scale: 1 }
      });
      const chunkMime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      chunks.push({ dataUrl: 'data:' + chunkMime + ';base64,' + res.data, h: curH });
    }

    // 拼接
    if (chunks.length === 0) throw new Error('没有截到任何分段');
    if (chunks.length === 1) return chunks[0].dataUrl;

    // 使用 OffscreenCanvas 拼接（DPR 感知）
    const physW = Math.round(elW * dpr);
    const physH = Math.round(totalH * dpr);
    if (physW * physH > MAX_TOTAL_PIXELS) {
      throw new Error(`区域过大（${Math.round(physW * physH / 1e6)}MP），超过 500MP 上限`);
    }
    const canvas = new OffscreenCanvas(physW, physH);
    const ctx = canvas.getContext('2d');
    if (format === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, physW, physH);
    }

    let curY = 0;
    for (const chunk of chunks) {
      const img = await createImageBitmap(await fetch(chunk.dataUrl).then(r => r.blob()));
      ctx.drawImage(img, 0, Math.round(curY * dpr));
      curY += chunk.h;
    }

    const outMime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const outOpts = format === 'jpeg' ? { type: 'image/jpeg', quality: quality / 100 } : { type: 'image/png' };
    const blob = await canvas.convertToBlob(outOpts);
    const buffer = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);

    const returnMime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return 'data:' + returnMime + ';base64,' + base64;
  } finally {
    // 恢复 position（如果有修改过）
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(function(){
        if (window.__ss_scroll_saved_position !== undefined) {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) {
            if (window.__ss_scroll_saved_position) el.style.position = window.__ss_scroll_saved_position;
            else el.style.removeProperty('position');
          }
          delete window.__ss_scroll_saved_position;
        }
      })()`
    });
  }
}

// ══════════════════════════════════════════
// 截取指定可滚动区域（逐段拼接）
// ══════════════════════════════════════════
async function captureRegionScreenshot(tabId, selector, scrollRounds = 0, format = 'png', quality = 92) {
  if (isCapturing) throw new Error('正在截图，请等待当前截图完成');
  isCapturing = true;
  const sessionId = ++captureSessionId;
  const isCancelled = () => cancelledSessionId === sessionId;

  try {
    await ensureDebuggerAttached(tabId);
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');

      const dprRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: 'window.devicePixelRatio', returnByValue: true
      });
      const dpr = (dprRes.result && dprRes.result.value) || 1;

      // ── Canvas 自动转换到可滚动父容器 ──
      // 在线文档（钉钉/腾讯文档/飞书等）的 Canvas 自身不可滚动（scrollH ≈ clientH），
      // 真正的滚动在父容器 div 上。此处自动向上查找可滚动父容器，
      // 用父容器的 selector 替代 Canvas 本身，后续所有操作都使用 effectiveSelector。
      let effectiveSelector = selector;
      {
        const tagRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `(function(){
            var el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { tag: 'unknown', scrollH: 0, clientH: 0 };
            return {
              tag: el.tagName.toLowerCase(),
              scrollH: el.scrollHeight,
              clientH: el.clientHeight,
              offsetW: el.offsetWidth,
              offsetH: el.offsetHeight,
              rectW: el.getBoundingClientRect().width,
              rectH: el.getBoundingClientRect().height
            };
          })()`,
          returnByValue: true
        });
        const tagInfo = tagRes.result && tagRes.result.value;
        console.log('[SS-DIAG] Canvas 检测:', JSON.stringify(tagInfo), '原始selector:', selector);

        if (tagInfo && tagInfo.tag === 'canvas' && tagInfo.scrollH <= tagInfo.clientH + 5) {
          // Canvas 不可滚动，向上查找可滚动父容器
          const parentRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: `(function(){
              var el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return { found: false };
              var parent = el.parentElement;
              var candidates = [];
              while (parent && parent !== document.documentElement) {
                var pCS = window.getComputedStyle(parent);
                var pOvY = pCS.overflowY || pCS.overflow;
                var pOvX = pCS.overflowX || pCS.overflow;
                var canScrollY = (pOvY === 'auto' || pOvY === 'scroll' || pOvY === 'overlay') &&
                                 (parent.scrollHeight - parent.clientHeight > 5);
                var canScrollX = (pOvX === 'auto' || pOvX === 'scroll' || pOvX === 'overlay') &&
                                 (parent.scrollWidth - parent.clientWidth > 5);
                // overflow:hidden 但 JS 可滚动（钉钉文档场景）
                var hiddenScrollY = pOvY === 'hidden' && parent.scrollHeight > 0 && parent.clientHeight > 0 &&
                                    (parent.scrollHeight - parent.clientHeight) > 10;
                var hiddenScrollX = pOvX === 'hidden' && parent.scrollWidth > 0 && parent.clientWidth > 0 &&
                                    (parent.scrollWidth - parent.clientWidth) > 10;
                candidates.push({
                  tag: parent.tagName.toLowerCase(),
                  id: parent.id || '',
                  cls: (parent.className && typeof parent.className === 'string') ? parent.className.slice(0, 60) : '',
                  overflowY: pOvY,
                  overflowX: pOvX,
                  scrollH: parent.scrollHeight,
                  clientH: parent.clientHeight,
                  canScrollY: canScrollY,
                  canScrollX: canScrollX,
                  hiddenScrollY: hiddenScrollY,
                  hiddenScrollX: hiddenScrollX
                });
                if (canScrollY || canScrollX || hiddenScrollY || hiddenScrollX) {
                  var sel = (function() {
                    if (parent.id) return '#' + CSS.escape(parent.id);
                    if (parent.className && typeof parent.className === 'string') {
                      var classes = parent.className.trim().split(/\\s+/).filter(function(c) { return c.length > 2; });
                      for (var ci = 0; ci < classes.length; ci++) {
                        var s = parent.tagName.toLowerCase() + '.' + CSS.escape(classes[ci]);
                        if (document.querySelectorAll(s).length === 1) return s;
                      }
                    }
                    var path = [];
                    var cur = parent;
                    while (cur && cur !== document.documentElement) {
                      var tag = cur.tagName.toLowerCase();
                      var idx = 1;
                      var sib = cur.previousElementSibling;
                      while (sib) { if (sib.tagName.toLowerCase() === tag) idx++; sib = sib.previousElementSibling; }
                      path.unshift(tag + ':nth-of-type(' + idx + ')');
                      cur = cur.parentElement;
                    }
                    return path.join(' > ');
                  })();
                  return { found: true, selector: sel, info: candidates[candidates.length - 1], allCandidates: candidates };
                }
                parent = parent.parentElement;
              }
              return { found: false, allCandidates: candidates };
            })()`,
            returnByValue: true
          });
          const parentResult = parentRes.result && parentRes.result.value;
          console.log('[SS-DIAG] 父容器查找结果:', JSON.stringify(parentResult, null, 2));
          const parentSelector = parentResult && parentResult.found && parentResult.selector;
          if (parentSelector && typeof parentSelector === 'string') {
            effectiveSelector = parentSelector;
            console.log('[SS-DIAG] effectiveSelector 已切换为:', effectiveSelector);
          } else {
            console.log('[SS-DIAG] 未找到可滚动父容器，继续使用原始 Canvas selector');
          }
        }
      }

      // ── 无限滚动额外加载 ──
      if (scrollRounds > 0) {
        for (let r = 0; r < scrollRounds; r++) {
          if (isCancelled()) throw new Error('截图已取消');
          try { chrome.runtime.sendMessage({ action: 'screenshotProgress', message: `正在加载区域第 ${r + 1}/${scrollRounds} 轮...` }); } catch (_) {}
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: `(function(){var el=document.querySelector(${JSON.stringify(effectiveSelector)});if(el)el.scrollTop=el.scrollHeight})()`
          });
          await sleep(1000);
          await waitImagesLoad(tabId, 1500);
        }
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `(function(){var el=document.querySelector(${JSON.stringify(effectiveSelector)});if(el)el.scrollTop=0})()`
        });
        await sleep(300);
      }

      // ── 获取区域尺寸和位置 ──
      const rectRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(function(){
          var el=document.querySelector(${JSON.stringify(effectiveSelector)});
          if(!el) return null;
          var r=el.getBoundingClientRect();
          // 绝对坐标 = 视口坐标 + 页面滚动
          return {
            x: r.left + window.scrollX,
            y: r.top  + window.scrollY,
            w: r.width,
            h: r.height,
            scrollH: el.scrollHeight,
            clientH: el.clientHeight,
            clientW: el.clientWidth,
            overflowY: window.getComputedStyle(el).overflowY,
            overflowX: window.getComputedStyle(el).overflowX,
            scrollTop: el.scrollTop,
            scrollLeft: el.scrollLeft
          };
        })()`,
        returnByValue: true
      });
      const elInfo = rectRes.result && rectRes.result.value;
      if (!elInfo) throw new Error('无法找到目标区域: ' + effectiveSelector);
      console.log('[SS-DIAG] 区域信息:', JSON.stringify({
        selector: effectiveSelector,
        x: elInfo.x, y: elInfo.y, w: elInfo.w, h: elInfo.h,
        scrollH: elInfo.scrollH, clientH: elInfo.clientH, clientW: elInfo.clientW,
        overflowY: elInfo.overflowY, overflowX: elInfo.overflowX,
        scrollTop: elInfo.scrollTop, scrollLeft: elInfo.scrollLeft
      }));

      let { x: elX, y: elY, w: elW, h: elH, scrollH, clientH, clientW } = elInfo;
      // 保底：确保高度有效
      if (!clientH || clientH <= 0) clientH = elH || 100;
      if (!scrollH || scrollH <= 0) scrollH = clientH;

      // 保存原始滚动位置
      const origScrollRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(function(){var el=document.querySelector(${JSON.stringify(effectiveSelector)});if(!el)return null;return{top:el.scrollTop,left:el.scrollLeft}})()`,
        returnByValue: true
      });
      const origScroll = (origScrollRes.result && origScrollRes.result.value) || { top: 0, left: 0 };

      // ── 获取页面总宽，以设置 override ──
      const lm = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
      const cs = lm.cssContentSize || lm.contentSize;
      const pageW = Math.ceil(cs.width);

      const MAX_PHYSICAL_H = 16000;
      const maxSegCssH = Math.floor(MAX_PHYSICAL_H / dpr);

      let dataUrl;

      // ── 虚拟滚动 Canvas 检测 ──
      // 钉钉/腾讯文档等在线文档使用固定尺寸 Canvas + JS 虚拟滚动，
      // scrollH == clientH，但内容远超视口，需要逐帧滚轮截图。
      // 在直接截图之前先检测，避免遗漏这种场景。
      let isVirtualScrollCanvas = false;
      {
        const vcRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `(function(){
            var el = document.querySelector(${JSON.stringify(effectiveSelector)});
            if (!el) return { isVirtual: false };
            var tag = el.tagName.toLowerCase();
            var hasCanvas = tag === 'canvas' || !!el.querySelector('canvas');
            var cs = window.getComputedStyle(el);
            var overflowY = cs.overflowY || cs.overflow;
            // Canvas 或包含 Canvas，且 overflow 为 clip/hidden/visible（非原生滚动）
            var isVirtual = hasCanvas && (overflowY === 'clip' || overflowY === 'hidden' || overflowY === 'visible');
            return { isVirtual: isVirtual, tag: tag, hasCanvas: hasCanvas, overflowY: overflowY, scrollH: el.scrollHeight, clientH: el.clientHeight };
          })()`,
          returnByValue: true
        });
        const vc = vcRes.result && vcRes.result.value;
        isVirtualScrollCanvas = vc && vc.isVirtual;
        if (isVirtualScrollCanvas) {
          console.log('[SS-DIAG] 检测到虚拟滚动 Canvas:', JSON.stringify(vc));
        }
      }

      try {
        if (scrollH <= clientH + 2 && !isVirtualScrollCanvas) {
          // ── 区域不需要滚动，直接一次截完 ──
          console.log('[SS-DIAG] scrollH <= clientH，走直接截图路径');
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
            width: pageW, height: Math.ceil(elY + clientH + 50),
            deviceScaleFactor: dpr, mobile: false
          });
          await sleep(200);
          // 确保目标区域在视口内可见（视口大小变化后元素可能未渲染）
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: `(function(){
              const el = document.querySelector(${JSON.stringify(effectiveSelector)});
              if (el) el.scrollIntoView({ block: 'start' });
            })()`
          });
          await sleep(200);
          // 重新获取坐标（scrollIntoView 可能改变了 window.scrollX/Y）
          const reRect = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: `(function(){
              const el = document.querySelector(${JSON.stringify(effectiveSelector)});
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
            })()`,
            returnByValue: true
          });
          const reInfo = reRect.result && reRect.result.value;
          if (reInfo) { elX = reInfo.x; elY = reInfo.y; elW = reInfo.w; clientH = reInfo.h || clientH; }
          const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
            format: format, fromSurface: true, captureBeyondViewport: true,
            clip: { x: elX, y: elY, width: elW, height: clientH, scale: 1 }
          });
          const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
          dataUrl = 'data:' + mime + ';base64,' + res.data;

        } else {
          // ── 区域需要滚动，根据元素类型选择策略 ──
          // 检测元素类型：Canvas 或复杂表格类元素（如钉钉）使用逐段滚动策略
          const typeRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: `(function(){
              const el = document.querySelector(${JSON.stringify(effectiveSelector)});
              if (!el) return { type: 'unknown' };
              // 检测是否是 Canvas 或包含 Canvas（递归检查 shadow DOM）
              function hasCanvasRecursive(node) {
                if (node.tagName.toLowerCase() === 'canvas') return true;
                if (node.querySelector('canvas')) return true;
                const allEls = node.querySelectorAll('*');
                for (var cei = 0; cei < allEls.length; cei++) {
                  if (allEls[cei].shadowRoot && allEls[cei].shadowRoot.querySelector('canvas')) return true;
                }
                return false;
              }
              const hasCanvas = hasCanvasRecursive(el);
              // 检测是否是钉钉类复杂应用（使用 Shadow DOM 或特殊结构）
              const isDingTalk = el.shadowRoot || el.className.includes('ding') || el.id.includes('ding');
              // 检测是否是原生可滚动 div
              const cs = window.getComputedStyle(el);
              const isNativeScroll = cs.overflow === 'auto' || cs.overflow === 'scroll' ||
                                    cs.overflowY === 'auto' || cs.overflowY === 'scroll';
              // 检测元素或其祖先是否有 position:sticky/fixed（展开策略会导致布局崩溃）
              const isStickyOrFixed = cs.position === 'sticky' || cs.position === 'fixed';
              // 检测是否有 CSS height 约束（如 flex 子元素的固定高度）——展开可能破坏布局
              const hasCSSHeight = cs.height && cs.height !== 'auto' && el.style.height === '';
              return {
                type: hasCanvas ? 'canvas' : (isDingTalk ? 'dingtalk' : (isNativeScroll ? 'native' : 'other')),
                hasCanvas: hasCanvas,
                isNativeScroll: isNativeScroll,
                isStickyOrFixed: isStickyOrFixed,
                hasCSSHeight: hasCSSHeight,
                scrollH: el.scrollHeight,
                clientH: el.clientHeight
              };
            })()`,
            returnByValue: true
          });
          const elType = typeRes.result && typeRes.result.value || { type: 'other' };
          console.log('[SS-DIAG] 元素类型检测:', JSON.stringify(elType));

          // 逐段滚动策略适用条件：
          // 1. Canvas 或钉钉类应用（展开策略不适用）
          // 2. 无限滚动区域
          // 其他所有情况走展开策略（已包含 sticky/fixed 保护和 CSS height 恢复逻辑）
          const useScrollStrategy = elType.type === 'canvas' || elType.type === 'dingtalk' ||
                                    (scrollRounds > 0);
          console.log('[SS-DIAG] 策略选择:', useScrollStrategy ? '逐段滚动' : '展开(含回退)', 'scrollRounds=', scrollRounds);

          if (useScrollStrategy) {
            // ── 逐段滚动拼接策略 ──
            if (isVirtualScrollCanvas || (elType.type === 'canvas' && scrollH <= clientH + 5)) {
              // 虚拟滚动 Canvas（如钉钉文档）：scrollH == clientH，没有标准滚动容器
              console.log('[SS-DIAG] 使用虚拟滚动 Canvas 逐帧截图策略');
              dataUrl = await captureCanvasVirtualScroll(tabId, effectiveSelector, elX, elY, elW, clientH, dpr, format, quality, isCancelled);
            } else {
              dataUrl = await captureRegionWithScrolling(tabId, effectiveSelector, elX, elY, elW, clientH, scrollH, dpr, pageW, format, quality, isCancelled);
            }
          } else {
            // ── 展开策略 ──
            try {
              dataUrl = await captureRegionWithExpansion(tabId, effectiveSelector, elX, elY, elW, clientH, scrollH, dpr, pageW, format, quality);
            } catch (e) {
              // 展开策略无效（如 Canvas/JS 虚拟滚动的在线文档），自动回退到逐段滚动
              if (e.message === 'EXPANSION_INEFFECTIVE') {
                dataUrl = await captureRegionWithScrolling(tabId, effectiveSelector, elX, elY, elW, clientH, scrollH, dpr, pageW, format, quality, isCancelled);
              } else {
                throw e;
              }
            }
          }
        }
      } finally {
        try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride'); } catch (_) {}
        // 区域滚回原始位置
        try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: `(function(){var el=document.querySelector(${JSON.stringify(effectiveSelector)});if(el){el.scrollTop=${origScroll.top};el.scrollLeft=${origScroll.left}}})()`
        }); } catch (_) {}
      }

      await safeDetachDebugger(tabId);
      return { dataUrl };

    } catch (e) {
      await safeDetachDebugger(tabId);
      throw e;
    }
  } catch (error) {
    console.error('区域截图失败:', error);
    throw error;
  } finally {
    if (captureSessionId === sessionId) isCapturing = false;
    if (cancelledSessionId === sessionId) cancelledSessionId = null;
  }
}

function injectPreviewOverlay(dataUrl) {
  const OVERLAY_ID = '__ss_preview_overlay__';

  // 防止重复注入
  if (document.getElementById(OVERLAY_ID)) {
    document.getElementById(OVERLAY_ID).remove();
  }

  /* ── 创建样式 ── */
  const style = document.createElement('style');
  style.id = OVERLAY_ID + '_style';
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(0, 0, 0, 0.92);
      display: block;  /* 改为 block，imgWrap 用 absolute 定位 */
      overflow: hidden;
      animation: __ss_fadein 0.22s cubic-bezier(0.16,1,0.3,1);
    }
    @keyframes __ss_fadein {
      from { opacity: 0; transform: scale(0.97); }
      to   { opacity: 1; transform: scale(1); }
    }

    /* ── 工具栏 ── */
    #${OVERLAY_ID} .__ss_toolbar {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 52px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      background: linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, transparent 100%);
      z-index: 10;
      transition: opacity 0.3s ease;
      gap: 10px;
    }
    #${OVERLAY_ID} .__ss_toolbar.__ss_hidden {
      opacity: 0;
      pointer-events: none;
    }

    #${OVERLAY_ID} .__ss_title {
      color: rgba(255,255,255,0.85);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0.02em;
      flex: 1;
    }

    #${OVERLAY_ID} .__ss_zoom_info {
      color: rgba(255,255,255,0.6);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      min-width: 48px;
      text-align: center;
    }

    #${OVERLAY_ID} .__ss_btn {
      background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 8px;
      color: white;
      cursor: pointer;
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-weight: 500;
      padding: 6px 13px;
      transition: background 0.15s, transform 0.15s;
      white-space: nowrap;
      line-height: 1.4;
    }
    #${OVERLAY_ID} .__ss_btn:hover {
      background: rgba(255,255,255,0.22);
      transform: translateY(-1px);
    }
    #${OVERLAY_ID} .__ss_btn.__ss_close_btn {
      background: rgba(255,59,48,0.75);
      border-color: rgba(255,59,48,0.5);
      padding: 6px 12px;
      font-size: 16px;
      line-height: 1;
    }
    #${OVERLAY_ID} .__ss_btn.__ss_close_btn:hover {
      background: rgba(255,59,48,0.95);
    }

    /* ── 图片容器 ── */
    #${OVERLAY_ID} .__ss_img_wrap {
      position: absolute;
      inset: 52px 0 0 0;  /* 顶部留工具栏高度，其余铺满 */
      overflow: auto;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 16px;
      box-sizing: border-box;
      cursor: grab;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.2) transparent;
    }
    #${OVERLAY_ID} .__ss_img_wrap:active {
      cursor: grabbing;
    }
    #${OVERLAY_ID} .__ss_img_wrap::-webkit-scrollbar { width: 6px; height: 6px; }
    #${OVERLAY_ID} .__ss_img_wrap::-webkit-scrollbar-track { background: transparent; }
    #${OVERLAY_ID} .__ss_img_wrap::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.2);
      border-radius: 3px;
    }

    #${OVERLAY_ID} .__ss_img {
      display: block;
      /* width/height 由 JS 直接设置，不用 transform scale */
      flex-shrink: 0;
      border-radius: 6px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.6);
      transition: width 0.25s cubic-bezier(0.16,1,0.3,1), height 0.25s cubic-bezier(0.16,1,0.3,1);
      user-select: none;
      -webkit-user-drag: none;
    }

    /* ── 提示 toast ── */
    #${OVERLAY_ID} .__ss_toast {
      position: absolute;
      bottom: 28px;
      left: 50%;
      transform: translateX(-50%) translateY(10px);
      background: rgba(30,30,30,0.88);
      border: 1px solid rgba(255,255,255,0.12);
      backdrop-filter: blur(12px);
      color: white;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      padding: 8px 16px;
      border-radius: 20px;
      white-space: nowrap;
      opacity: 0;
      transition: opacity 0.2s, transform 0.2s;
      pointer-events: none;
    }
    #${OVERLAY_ID} .__ss_toast.__ss_toast_show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  `;
  document.head.appendChild(style);

  /* ── 创建弹窗 DOM（使用 DOM API，避免 innerHTML） ── */
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;

  // 工具栏
  const toolbar = document.createElement('div');
  toolbar.className = '__ss_toolbar';
  toolbar.id = '__ss_toolbar';

  const title = document.createElement('span');
  title.className = '__ss_title';
  title.textContent = '📸 截图预览';

  const zoomInfo = document.createElement('span');
  zoomInfo.className = '__ss_zoom_info';
  zoomInfo.id = '__ss_zoom_info';
  zoomInfo.textContent = '100%';

  const btnZoomOut = document.createElement('button');
  btnZoomOut.className = '__ss_btn';
  btnZoomOut.id = '__ss_zoom_out';
  btnZoomOut.textContent = '－ 缩小';

  const btnReset = document.createElement('button');
  btnReset.className = '__ss_btn';
  btnReset.id = '__ss_zoom_reset';
  btnReset.textContent = '适应';

  const btnZoomIn = document.createElement('button');
  btnZoomIn.className = '__ss_btn';
  btnZoomIn.id = '__ss_zoom_in';
  btnZoomIn.textContent = '＋ 放大';

  const btnClose = document.createElement('button');
  btnClose.className = '__ss_btn __ss_close_btn';
  btnClose.id = '__ss_close';
  btnClose.textContent = '✕';

  toolbar.appendChild(title);
  toolbar.appendChild(zoomInfo);
  toolbar.appendChild(btnZoomOut);
  toolbar.appendChild(btnReset);
  toolbar.appendChild(btnZoomIn);
  toolbar.appendChild(btnClose);

  // 图片容器
  const imgWrap = document.createElement('div');
  imgWrap.className = '__ss_img_wrap';
  imgWrap.id = '__ss_img_wrap';

  const img = document.createElement('img');
  img.className = '__ss_img';
  img.id = '__ss_img';
  img.src = dataUrl;
  img.alt = '截图预览';
  img.draggable = false;

  imgWrap.appendChild(img);

  // Toast
  const toast = document.createElement('div');
  toast.className = '__ss_toast';
  toast.id = '__ss_toast';

  overlay.appendChild(toolbar);
  overlay.appendChild(imgWrap);
  overlay.appendChild(toast);

  document.documentElement.appendChild(overlay);

  /* ── 状态 ── */
  let scale = 1;
  let toolbarTimer = null;

  // toolbar, imgWrap, img, zoomInfo, toast 已在上方 DOM 构建时创建，直接使用

  /* ── 计算适应缩放：让图片宽/高铺满 imgWrap 容器（留 padding），不限上限 ── */
  function fitScale() {
    const vw = window.innerWidth  - 32;   // 左右各 16px padding
    const vh = window.innerHeight - 52 - 32;  // 工具栏 52px + 上下各 16px padding
    const iw = img.naturalWidth  || img.width  || 1280;
    const ih = img.naturalHeight || img.height || 900;
    // 宽高都适配，取较小比例确保完整显示
    const byW = vw / iw;
    const byH = vh / ih;
    return Math.min(byW, byH);
  }

  /* ── 应用缩放：直接设置 width/height，滚动区域正确响应 ── */
  function applyScale(s, animate) {
    scale = Math.max(0.05, Math.min(5, s));
    const iw = img.naturalWidth  || 1280;
    const ih = img.naturalHeight || 900;
    if (!animate) {
      img.style.transition = 'none';
    } else {
      img.style.transition = 'width 0.25s cubic-bezier(0.16,1,0.3,1), height 0.25s cubic-bezier(0.16,1,0.3,1)';
    }
    img.style.width  = Math.round(iw * scale) + 'px';
    img.style.height = Math.round(ih * scale) + 'px';
    img.style.transform = '';
    zoomInfo.textContent = Math.round(scale * 100) + '%';
  }

  /* ── 图片加载后设初始缩放 ── */
  function initScale() {
    const s = fitScale();
    applyScale(s, false);
    // 滚动到顶部
    imgWrap.scrollTop = 0;
  }

  if (img.complete && img.naturalWidth > 0) { initScale(); }
  else { img.addEventListener('load', initScale, { once: true }); }

  /* ── 工具栏自动隐藏 ── */
  function showToolbar() {
    toolbar.classList.remove('__ss_hidden');
    clearTimeout(toolbarTimer);
    toolbarTimer = setTimeout(() => toolbar.classList.add('__ss_hidden'), 2500);
  }
  overlay.addEventListener('mousemove', showToolbar);
  overlay.addEventListener('touchstart', showToolbar, { passive: true });
  showToolbar();

  /* ── Toast ── */
  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('__ss_toast_show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('__ss_toast_show'), 2000);
  }

  /* ── 缩放按钮 ── */
  btnZoomIn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyScale(scale * 1.25, true);
  });
  btnZoomOut.addEventListener('click', (e) => {
    e.stopPropagation();
    applyScale(scale / 1.25, true);
  });
  btnReset.addEventListener('click', (e) => {
    e.stopPropagation();
    applyScale(fitScale(), true);
    showToast('已适应屏幕');
  });

  /* ── 双击切换：适应 / 100% ── */
  imgWrap.addEventListener('dblclick', () => {
    const fit = fitScale();
    if (Math.abs(scale - fit) < 0.02) {
      applyScale(1, true);
      showToast('100%');
    } else {
      applyScale(fit, true);
      showToast('适应屏幕');
    }
  });

  /* ── 滚轮缩放 ── */
  imgWrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    applyScale(scale * delta, false);
  }, { passive: false });

  /* ── 拖拽滚动（鼠标） ── */
  let isDragging = false, startX = 0, startY = 0, scrollLeft = 0, scrollTop = 0;
  imgWrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    scrollLeft = imgWrap.scrollLeft;
    scrollTop  = imgWrap.scrollTop;
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    imgWrap.scrollLeft = scrollLeft - (e.clientX - startX);
    imgWrap.scrollTop  = scrollTop  - (e.clientY - startY);
  });
  document.addEventListener('mouseup', () => { isDragging = false; });

  /* ── 关闭 ── */
  function closeOverlay() {
    overlay.style.animation = 'none';
    overlay.style.opacity = '0';
    overlay.style.transform = 'scale(0.97)';
    overlay.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
    setTimeout(() => {
      overlay.remove();
      style.remove();
      document.removeEventListener('keydown', onKeyDown);
    }, 180);
    // 通知 background 重新打开 popup（恢复截图完成状态）
    chrome.runtime.sendMessage({ action: 'restorePopup' });
  }

  btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeOverlay();
  });

  /* 点击背景（非图片、非工具栏）也关闭 */
  imgWrap.addEventListener('click', (e) => {
    if (e.target === imgWrap) closeOverlay();
  });

  /* ── 键盘快捷键 ── */
  function onKeyDown(e) {
    if (!document.getElementById(OVERLAY_ID)) return;
    if (e.key === 'Escape') { closeOverlay(); return; }
    if (e.key === '=' || e.key === '+') { applyScale(scale * 1.25, true); e.preventDefault(); }
    if (e.key === '-')                  { applyScale(scale / 1.25, true); e.preventDefault(); }
    if (e.key === '0')                  { applyScale(fitScale(), true);   e.preventDefault(); }
    if (e.key === '1')                  { applyScale(1, true);            e.preventDefault(); }
  }
  document.addEventListener('keydown', onKeyDown);

  /* ── 阻止弹窗内滚动冒泡到页面 ── */
  overlay.addEventListener('wheel', (e) => e.stopPropagation(), { passive: false });
}
