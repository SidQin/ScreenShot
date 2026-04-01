# ScreenShot - Full Page Capture

一键截取完整网页长图的 Chrome 扩展，支持 PNG 下载和复制到剪切板。

> Capture full-length screenshots of any webpage in one click. Supports PNG download and clipboard copy.

## ✨ 功能特点

- 📸 **全页截图**：使用 Chrome DevTools Protocol，一次性截取完整网页，无拼接错位
- 🔍 **全屏预览**：截图完成后可放大预览，支持滚轮缩放、拖拽平移、键盘快捷键（ESC/+/-/0/1）
- 🦥 **懒加载支持**：截图前自动预滚动，触发懒加载内容，确保页面底部内容完整显示
- ♾️ **无限滚动支持**：检测到无限滚动页面时，可选择额外加载轮次再截图
- 📥 **高清下载**：保存为高质量 PNG，文件名自动带时间戳
- 📋 **一键复制**：复制到剪切板，方便直接粘贴
- 🎨 **双主题 UI**：支持液态玻璃 / 经典渐变 / 跟随系统三种界面风格
- ⚡ **快速处理**：基于 CDP `Emulation.setDeviceMetricsOverride`，无需分段拼接

## 安装方法

### Chrome Web Store（推荐）

> 即将上架，敬请期待

### 开发者模式手动安装

1. 下载本项目（点击右上角 Code → Download ZIP，解压）
2. 打开 Chrome，访问 `chrome://extensions/`
3. 开启右上角**开发者模式**
4. 点击**加载已解压的扩展程序**，选择解压后的文件夹
5. 扩展图标出现在浏览器工具栏，安装完成

## 使用方法

1. 打开需要截图的网页，等待页面加载完成
2. 点击浏览器工具栏的 **ScreenShot** 图标
3. 点击 **🎯 开始截图**
4. 截图完成后，选择：
   - **🔍 放大预览**：在当前页面全屏预览，支持缩放、拖拽（关闭后自动恢复截图面板）
   - **📥 下载图片**：保存到本地，自动命名为 `ScreenShot_YYYY-MM-DD_HH-MM-SS.png`
   - **📋 复制到剪切板**：直接粘贴到其他应用

## 文件结构

```
ScreenShot/
├── manifest.json       # 扩展配置
├── background.js       # Service Worker（CDP 截图核心）
├── popup.html          # 弹出界面
├── popup.js            # 界面逻辑 + 图片处理
└── images/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 权限说明

| 权限 | 用途 |
|------|------|
| `activeTab` | 获取当前标签页信息 |
| `scripting` | 注入脚本控制页面滚动、隐藏 fixed 元素 |
| `downloads` | 保存截图到本地 |
| `debugger` | 使用 CDP `Page.captureScreenshot` 和 `Emulation.setDeviceMetricsOverride` 实现全页截图 |
| `storage` | 记住用户的主题偏好设置 |

## 注意事项

- `chrome://` 开头的系统页面无法截图（Chrome 限制）
- 截图过程中请勿切换标签或最小化窗口
- 超大页面（高度 > 10000px）截图时间较长，请耐心等待
- 部分网站有严格 CSP 策略，可能影响脚本注入

## 常见问题

**Q: 截图底部内容是骨架屏 / 空白？**  
A: 已内置懒加载预滚动机制，截图前会自动滚动全页触发内容加载。如仍有问题，等页面完全加载后再截图。

**Q: 是无限滚动页面，想截更多内容？**  
A: 检测到无限滚动时会弹出选择弹层，可选 3 / 5 / 10 轮额外加载后再截图。

**Q: 复制失败？**  
A: 部分网站限制剪切板访问，请改用下载功能。

**Q: 下载的文件名不对？**  
A: 文件名格式为 `ScreenShot_YYYY-MM-DD_HH-MM-SS.png`，请确保扩展已重新加载。

## 更新日志

### v1.1.1
- 修复全屏预览可重复打开，关闭预览后可稳定恢复截图结果页
- 修复从预览返回后 `currentTab` 丢失导致首次再次预览无响应的问题
- 修复切换到其他标签页后仍误恢复上一次截图结果的问题
- 清理无效的旧预览注入实现，发版包保持更干净

### v1.1.0
- 新增全屏预览功能：点击缩略图在当前页面全屏查看，支持滚轮缩放、拖拽平移、双击切换适应/原始尺寸
- 支持键盘快捷键：ESC 关闭、`+`/`-` 缩放、`0` 恢复适应、`1` 原始尺寸
- 修复预览弹窗层级遮挡问题（popup 独立 WebView 始终置顶）
- 修复预览关闭后截图面板自动恢复（chrome.storage.session 保存现场）

### v1.0.0
- 基于 Chrome DevTools Protocol 实现完整网页截图
- 支持懒加载预滚动 + 无限滚动多轮加载
- 液态玻璃 / 经典渐变双主题 UI
- 支持 PNG 下载（带时间戳文件名）和复制到剪切板

## 许可证

MIT License
