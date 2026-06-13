# Tabby PWA · iOS 底部"带子"渲染 Bug 诊断文档

> 给排查者：这是一个 iOS Safari / 主屏 PWA 独有的渲染 bug。Android / 桌面 Chrome 一切正常。
> 已尝试约 9 个版本（v41–v49）都没解决。下面是完整前因后果、像素证据、所有失败尝试。

---

## 一、症状

在"记录"页点某一天，会从**底部弹出一张滑卡（bottom sheet）**。滑卡无论处于
**半屏**还是**上滑后的全屏**状态，**屏幕最底部都有一条横贯整宽的"带子"**，颜色和滑卡
主体略有差异，看起来像没铺满 / 漏了一条边。

- 只在 **iPhone（Safari 或添加到主屏的 PWA，standalone）** 出现。
- Android Chrome、桌面浏览器、Playwright(Chromium) 模拟**全部正常**，无带子。
- 带子高度目测约等于 **iPhone 底部安全区 / Home Indicator 区域（~34px）**。

## 二、像素级证据（关键）

用 PIL 对用户真机全屏截图（1125×2436，iPhone）逐像素扫描，**两次不同版本结论一致**：

```
屏幕 0% ───────────────────────────
  ... 日历（被遮罩压暗）...
54% ┌─ 滑卡顶 "6/11 周四"
  │  滑卡内容区，颜色 = 渐变图，约 (206, 229, 253)  ← 杏花粉→碧落蓝 渐变
93% ├─────────────────────────────  ← 突变边界
  │  带子：整宽、均匀，颜色精确 = (200, 217, 236)
98% │  ▇▇▇ 黑色 Home Indicator 小药丸 ▇▇▇
100%└─ 屏幕底
```

**决定性事实：带子颜色精确等于 `(200,217,236)`，即 CSS 变量 `--bg-base`（`#c8d9ec`）的纯色值。**
而带子正上方的滑卡内容是 `background-image`（渐变）的颜色。

→ 即：**`background-image`（渐变）没有画到屏幕最底那一截（安全区），那截只剩
`background-color`（`--bg-base` 纯色）**。两者有色差，就成了"带子"。

主页（home）不出现，是因为主页底部正好被**底栏 tabbar 盖住**了这截安全区；滑卡打开时
tabbar 被隐藏，安全区就裸露出来。

## 三、环境与关键代码

- 纯前端 PWA，无框架。`<meta name="viewport" content="...viewport-fit=cover">`，
  `apple-mobile-web-app-status-bar-style=black-translucent`，standalone 模式。
- 弥散渐变背景定义：
  ```css
  :root { --bg-base: #c8d9ec; --bg-image:
      radial-gradient(...粉/蓝光晕...),
      linear-gradient(175deg, #fadce9 0%, #d8d4ee 55%, #aed0ed 100%); }
  body {
    background-color: var(--bg-base);
    background-image: var(--bg-image);
    background-attachment: fixed;   /* ← 注意：body 用了 fixed 背景 */
    background-size: cover;
    padding-top: env(safe-area-inset-top);
    min-height: 100vh;
  }
  ```
- 滑卡打开时锁滚动（iOS 经典方案，把 body 变成 fixed）：
  ```css
  body.no-scroll { position: fixed; left: 0; right: 0; overflow: hidden; }
  /* JS 另外设置 body.style.top = `-${scrollY}px` */
  body.no-scroll .tabbar { display: none; }  /* 滑卡盖住时隐藏底栏 */
  ```
- 滑卡当前样式（v49，定位全程用 top、零 transform）：
  ```css
  .day-sheet {
    position: fixed; left: 0; right: 0;
    top: 58dvh;                                    /* 半屏 */
    bottom: calc(-1 * env(safe-area-inset-bottom) - 2px);  /* 顶出安全区，但没用 */
    z-index: 61;
    background-color: var(--bg-base);
    background-image: var(--bg-image);
    background-repeat: no-repeat;
    background-size: cover;
    background-position: center;
    transition: top 0.36s ...;                     /* 只有 top 过渡，无 transform */
  }
  .day-sheet.full { top: 0; }
  ```
  滑卡 DOM：`#sheet-backdrop`(z60, position:fixed inset:0) + `#day-sheet`(z61)。

## 四、所有尝试与结果（全部失败）

| 版本 | 思路 | 结果 |
|---|---|---|
| v40 | 滑卡背景改近实色 `rgba(...,.97)` | ❌ 仍有带 |
| v41 | 全屏时给背后**遮罩** `inset:0` 铺**纯实色**兜底 | ❌ 仍有带 |
| v42 | 全屏页背景换成 body **同款渐变** | ❌ 仍有带 |
| v43 | 滑卡打开期间 **`display:none` 隐藏底栏**（疑 backdrop-filter 合成层穿透） | ❌ 仍有带 |
| v44 | **彻底改架构**：上滑不再是 fixed 浮层，改成**普通文档流的独立页面** | ✅ 全屏页**无带**（但用户嫌切页不丝滑），半屏滑卡仍有带 |
| v46 | 退回滑卡；定位**从 `transform: translateY` 全改为 `top`**（消除 transform 合成层 bug，且 `bottom:0` 不再参照布局视口） | ❌ 仍有带 |
| v47 | 去掉滑卡背景的 `background-attachment: fixed`（iOS 几乎不支持） | ❌ 仍有带 |
| v48 | 背景 `background-size: 100vw 100dvh; position:bottom` → 改 `cover` | ❌ 仍有带，像素复测颜色**仍精确 = --bg-base** |
| v49 | 滑卡 `bottom: calc(-1*env(safe-area-inset-bottom) -2px)`，把元素底边**压到屏幕外**，让 cover 背景盖满安全区 | ❌ **仍有带**（最反常的一点，见下） |

### 最反常的事实（v44 与 v49）

1. **v44**：把内容从"fixed 浮层"改成"普通文档流页面"后，**全屏页的带子消失了**。
   → 强烈暗示问题出在 **`position: fixed` 浮层**本身，而非颜色/背景。
2. **v49**：把滑卡 `bottom` 设为负值、元素底边明明已经**延伸到屏幕外**，理论上 `cover`
   背景必然盖满安全区，**但带子还在**。
   → 如果元素+背景真的盖过了那截，带子不该存在。它还在，说明要么元素并未如预期延伸，
   要么带子根本**不在滑卡的绘制层里**（可能是 body / 某个合成层 / iOS PWA 系统区）。

## 五、当前最可能的几个怀疑方向（供排查）

1. **`body.no-scroll { position: fixed }` + body 的 `background-attachment: fixed`**：
   滑卡打开时 body 变 fixed 且 top 为负，body 自身的 fixed 渐变背景在 iOS 上可能渲染异常，
   安全区只剩 `--bg-base`；而滑卡（即便 z-index 更高）因某种合成/裁剪原因没盖住它。
   → 带子可能是 **body 透上来的**，不是滑卡自己的。
2. **iOS 对 `position: fixed` 元素在底部安全区的合成裁剪**：fixed 浮层（尤其叠加
   `backdrop-filter` 的兄弟节点 `.sheet-backdrop`、或祖先 fixed body）在 Home Indicator
   区域有独立合成层，导致最后一截不被该层覆盖。v44 改普通文档流后消失，吻合此怀疑。
3. **`100dvh` / `env(safe-area-inset-bottom)` 在 standalone PWA 下的取值**：若 dvh 不含
   安全区、或 fixed 元素的 `bottom` 参照的是"安全视口"而非"物理视口"，则 `bottom:负值`
   的换算也会偏，导致没真正盖到物理屏底。

## 六、建议排查者用 Safari 远程调试取这些数（我们无 iOS 设备，无法自测）

带子出现时，在 Safari Web Inspector 控制台执行：

```js
const s = document.getElementById('day-sheet').getBoundingClientRect();
console.log({
  innerHeight: window.innerHeight,
  visualVP: window.visualViewport && window.visualViewport.height,
  screenH: window.screen.height,
  sheetTop: s.top, sheetBottom: s.bottom, sheetHeight: s.height,
  // 读 env(safe-area-inset-bottom)
  safeBottom: getComputedStyle(document.documentElement)
    .getPropertyValue('--probe') || '(需加探针)',
});
// 探针：读安全区数值
const p = document.createElement('div');
p.style.cssText = 'position:fixed;bottom:0;padding-bottom:env(safe-area-inset-bottom)';
document.body.appendChild(p);
console.log('safe-area-inset-bottom =', getComputedStyle(p).paddingBottom);
```

判读：
- 若 `sheetBottom < visualViewport.height` → 滑卡确实没盖到底（高度/定位问题）。
- 若 `sheetBottom >= visualViewport.height` 但仍有带 → 是 **Safari 合成层渲染 bug**，
  带子来自其下方图层（很可能是那个 fixed + attachment:fixed 的 body）。

## 七、附：复现该 bug 的最小信息

- 一个 `position: fixed; bottom:0` 且带渐变背景的 bottom sheet，
- 祖先 body 在打开时变 `position: fixed` 且自身 `background-attachment: fixed`，
- standalone PWA + `viewport-fit=cover`，
- 底部安全区不被任何更高层稳定覆盖时，安全区露出 body 的 `background-color`。

> 线上可复现地址：https://cyanusay.github.io/Tabby/ → 底栏"记录" → 点任意有记录的日期。
