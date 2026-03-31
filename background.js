// Service Worker 启动日志
console.log('网页截长图工具 - Background Service Worker 已启动');

// ── IndexedDB 常量 ──
const IDB_NAME    = 'ss_store';
const IDB_VERSION = 1;
const IDB_STORE   = 'screenshots';
const IDB_KEY     = 'current';

// 监听截图和下载请求
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background 收到消息:', request.action);

  // ── 在被截图的标签页注入全屏预览弹窗 ──
  if (request.action === 'openPreview') {
    const { tabId, dataUrl } = request;
    if (!tabId || !dataUrl) { sendResponse({ success: false, error: '缺少参数' }); return false; }

    chrome.scripting.executeScript({
      target: { tabId },
      func: injectPreviewOverlay,
      args: [dataUrl]
    }).then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // ── 预览关闭后恢复 popup ──
  if (request.action === 'restorePopup') {
    // 设置恢复标记，popup 打开后会检测并自动显示结果页
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

    captureFullPageScreenshot(tabId, scrollRounds)
      .then(async ({ dataUrl, cssWidth, cssHeight, dpr }) => {
        // 把 dataUrl 切块存入 storage，消息只返回元信息
        await storeDataUrl(dataUrl);
        console.log('截图已存入 storage');
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
    const req   = store.put(dataUrl, IDB_KEY);
    req.onsuccess = () => resolve();
    req.onerror   = (e) => reject(e.target.error);
  });
  db.close();
  console.log(`dataUrl 已存入 IndexedDB，总长: ${dataUrl.length}`);
}

// ══════════════════════════════════════════
// 检测页面是否具有无限滚动特征
// ══════════════════════════════════════════
async function detectInfiniteScroll(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
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
    await chrome.debugger.detach({ tabId });

    const isInfinite = afterH > beforeH + 50;
    console.log(`无限滚动检测：before=${beforeH}, after=${afterH}, isInfinite=${isInfinite}`);
    return { isInfinite, beforeH, afterH };
  } catch (e) {
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    throw e;
  }
}

// ══════════════════════════════════════════
// 截取完整页面（返回拼接完成的 dataUrl）
// ══════════════════════════════════════════
async function captureFullPageScreenshot(tabId, scrollRounds = 0) {
  console.log('开始截图，tabId:', tabId, 'scrollRounds:', scrollRounds);

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    console.log('调试器已附加');

    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');

      // 获取 DPR
      const dprRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: 'window.devicePixelRatio', returnByValue: true
      });
      const dpr = dprRes.result && dprRes.result.value ? dprRes.result.value : 1;
      console.log('DPR:', dpr);

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

      console.log(`预滚动：页面高=${initH}，视口高=${initVpH}`);
      const step = Math.floor(initVpH * 0.8);
      let preY = 0;
      while (preY < initH) {
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
      console.log('预滚动完成');

      // ── 步骤0b：无限滚动额外加载轮次 ──
      if (scrollRounds > 0) {
        console.log(`无限滚动额外加载：${scrollRounds} 轮`);
        for (let r = 0; r < scrollRounds; r++) {
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: 'window.scrollTo(0, document.body.scrollHeight)'
          });
          await sleep(1000);
          await waitImagesLoad(tabId, 1500);
          console.log(`无限滚动第 ${r + 1} 轮完成`);
        }
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: 'window.scrollTo(0, 0)'
        });
        await sleep(300);
        console.log('无限滚动额外加载完成');
      }

      // ── 步骤1：隐藏 fixed/sticky 元素 ──
      const hideScript = `(function() {
        var saved = [];
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          var pos = window.getComputedStyle(el).position;
          if (pos === 'fixed' || pos === 'sticky') {
            saved.push({ el: el, display: el.style.display, priority: el.style.getPropertyPriority('display') });
            el.style.setProperty('display', 'none', 'important');
          }
        }
        window.__ssFixed = saved;
        return saved.length;
      })()`;
      const hideRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: hideScript, returnByValue: true
      });
      console.log(`隐藏 fixed/sticky: ${hideRes.result && hideRes.result.value} 个`);
      await sleep(300);

      const restoreScript = `(function() {
        var saved = window.__ssFixed || [];
        for (var i = 0; i < saved.length; i++) {
          var item = saved[i];
          if (item.display === '') { item.el.style.removeProperty('display'); }
          else { item.el.style.setProperty('display', item.display, item.priority || ''); }
        }
        delete window.__ssFixed;
      })()`;

      // ── 步骤2：获取页面尺寸 ──
      const lm = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
      const cs = lm.cssContentSize || lm.contentSize;
      if (!cs || cs.width === 0 || cs.height === 0) throw new Error('无法获取页面尺寸');

      const totalWidth  = Math.ceil(cs.width);
      const totalHeight = Math.ceil(cs.height);
      console.log(`页面尺寸(CSS px): ${totalWidth} x ${totalHeight}`);

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
            format: 'png', fromSurface: true, captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: totalWidth, height: totalHeight, scale: 1 }
          });
          dataUrl = 'data:image/png;base64,' + res.data;
          console.log('整页截图完成');

        } else {
          // ── 超长页面：分段截图后用 OffscreenCanvas 拼接 ──
          console.log(`页面过高 (${totalHeight}px)，分段截图，每段最高 ${maxCssSegH}px`);

          // 先把视口高度设为 maxCssSegH，宽度不变
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
            width: totalWidth, height: maxCssSegH,
            deviceScaleFactor: dpr, mobile: false
          });
          await sleep(200);

          const segments = []; // { data: base64, w: physW, h: physH }
          let segY = 0;
          while (segY < totalHeight) {
            const segH = Math.min(maxCssSegH, totalHeight - segY);
            const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
              format: 'png', fromSurface: true, captureBeyondViewport: true,
              clip: { x: 0, y: segY, width: totalWidth, height: segH, scale: 1 }
            });
            const physW = Math.round(totalWidth * dpr);
            const physH = Math.round(segH * dpr);
            segments.push({ data: res.data, w: physW, h: physH });
            console.log(`分段截图 y=${segY} h=${segH} 完成`);
            segY += segH;
          }

          // 用 OffscreenCanvas 拼接（Service Worker 支持）
          const totalPhysW = Math.round(totalWidth  * dpr);
          const totalPhysH = Math.round(totalHeight * dpr);
          const canvas = new OffscreenCanvas(totalPhysW, totalPhysH);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, totalPhysW, totalPhysH);

          let drawY = 0;
          for (const seg of segments) {
            const imgBlob = base64ToBlob(seg.data, 'image/png');
            const bitmap  = await createImageBitmap(imgBlob);
            ctx.drawImage(bitmap, 0, 0, seg.w, seg.h, 0, drawY, seg.w, seg.h);
            bitmap.close();
            drawY += seg.h;
          }

          const blob = await canvas.convertToBlob({ type: 'image/png' });
          dataUrl = await blobToDataUrl(blob);
          console.log('分段拼接完成');
        }

      } finally {
        try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride'); } catch (_) {}
        try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: restoreScript, returnByValue: true }); } catch (_) {}
        try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: 'window.scrollTo(0, 0)' }); } catch (_) {}
      }

      await chrome.debugger.detach({ tabId });
      console.log('调试器已分离');

      return { dataUrl, cssWidth: totalWidth, cssHeight: totalHeight, dpr };

    } catch (e) {
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
      throw e;
    }
  } catch (error) {
    console.error('截图失败:', error);
    throw error;
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
    console.log('下载任务已创建，ID:', downloadId);
    return downloadId;
  } catch (error) {
    console.error('下载失败:', error);
    throw error;
  }
}

// ══════════════════════════════════════════
// 注入到目标页面的全屏预览弹窗函数
// （此函数通过 chrome.scripting.executeScript 注入，运行在页面上下文中）
// ══════════════════════════════════════════
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

  /* ── 创建弹窗 DOM ── */
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;

  overlay.innerHTML = `
    <div class="__ss_toolbar" id="__ss_toolbar">
      <span class="__ss_title">📸 截图预览</span>
      <span class="__ss_zoom_info" id="__ss_zoom_info">100%</span>
      <button class="__ss_btn" id="__ss_zoom_out">－ 缩小</button>
      <button class="__ss_btn" id="__ss_zoom_reset">适应</button>
      <button class="__ss_btn" id="__ss_zoom_in">＋ 放大</button>
      <button class="__ss_btn __ss_close_btn" id="__ss_close">✕</button>
    </div>
    <div class="__ss_img_wrap" id="__ss_img_wrap">
      <img class="__ss_img" id="__ss_img" src="${dataUrl}" alt="截图预览" draggable="false" />
    </div>
    <div class="__ss_toast" id="__ss_toast"></div>
  `;
  document.documentElement.appendChild(overlay);

  /* ── 状态 ── */
  let scale = 1;
  let toolbarTimer = null;

  const toolbar   = overlay.querySelector('#__ss_toolbar');
  const imgWrap   = overlay.querySelector('#__ss_img_wrap');
  const img       = overlay.querySelector('#__ss_img');
  const zoomInfo  = overlay.querySelector('#__ss_zoom_info');
  const toast     = overlay.querySelector('#__ss_toast');

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
  overlay.querySelector('#__ss_zoom_in').addEventListener('click', (e) => {
    e.stopPropagation();
    applyScale(scale * 1.25, true);
  });
  overlay.querySelector('#__ss_zoom_out').addEventListener('click', (e) => {
    e.stopPropagation();
    applyScale(scale / 1.25, true);
  });
  overlay.querySelector('#__ss_zoom_reset').addEventListener('click', (e) => {
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

  overlay.querySelector('#__ss_close').addEventListener('click', (e) => {
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
