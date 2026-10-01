/**
 * ============================================================================
 *  sidebar.js —— ConvoWeave 的浮层目录卡片
 * ============================================================================
 *  职责（只有这一件）：把 CW_Parser 交上来的数组，画成一张可点击的列表。
 *
 *  这个文件与 ChatGPT 的页面**完全无关**：
 *    它不认识 <article>、不认识 data-turn-key、一个页面选择器都不查。
 *    它只认识「一个数组」和「自己造出来的 DOM」。
 *  → 所以 OpenAI 无论怎么改版，这个文件一行都不用改。
 *    （第 2 章的 parser.js 是"读别人的页面"，会失效；
 *      这里是"画自己的元素"，永不失效。这就是本章难度反而下降的原因。）
 *
 *  对外暴露的方法（第 4~11 章都按这个契约写，只**追加**、不改旧的）：
 *    ── 第 3 章 ──────────────────────────────────────────────
 *    CW_Sidebar.mount(handlers)      → 挂载卡片，返回 #cw-root 元素
 *    CW_Sidebar.setItems(list)       → 把数据渲染成条目列表
 *    ── 第 7 章 ──────────────────────────────────────────────
 *    CW_Sidebar.setActive(i, force)  → 设"当前阅读的是第几条"（-1 = 都不亮）
 *    ── 第 9 章（搜索过滤）────────────────────────────────────
 *    CW_Sidebar.toggleSearch(force?) → 展开/收起搜索框，返回展开后的布尔值
 *    CW_Sidebar.setQuery(text)       → 直接设过滤词（供脚本/测试用；等价于打字）
 *    ── 第 10 章（短横线列）──────────────────────────────────
 *    CW_Sidebar.setCollapsed(flag)   → true 收成短横线列 / false 固定展开
 *    CW_Sidebar.isCollapsed()        → 是否处于"收起"态
 *    CW_Sidebar.isRevealed()         → 是否处于"鼠标扫过临时展开"态
 * ============================================================================
 */

window.CW_Sidebar = (function () {
  "use strict";

  /* ────────────────────────────────────────────────────────────────────────
     一、常量
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 面板骨架 —— 固定的、写死的 HTML。
   *
   * ⚠️ 这张字符串里 100% 是死内容，没有任何"从页面读来的东西"，
   *    所以用 innerHTML 是安全的。
   *    判据永远是这一条：**这段字符串里会不会掺进用户数据？**
   *    会 → 必须改用 createElement（见下面 setItems 里的注释）；
   *    不会 → innerHTML 反而更短更清楚。
   *
   * 为什么用 data-role 取子元素，而不是用类名？
   *    类名（cw-list）是给**样式**用的接口，将来改版式可能改名；
   *    data-role 是给**脚本**用的接口，只被 JS 查询，两套互不牵连。
   */
  /**
   * 图标 —— 内联 SVG，不引任何图标库。
   *
   * 为什么不用 <img src="..."> 或者图标字体：
   *   ① 扩展的资源路径在打包后是 chrome-extension://…，写相对路径容易错；
   *   ② 图标字体要额外加载一个文件，还会被页面的 `font-family` 重置影响；
   *   ③ 内联 SVG 天然继承 `currentColor` —— "悬停变灰、点开变蓝"只要改 color 一行。
   */
  const ICONS = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.6"/><path d="M20 20l-3.6-3.6"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 6l6 6-6 6"/></svg>'
  };

  const SKELETON = [
    '<div class="cw-panel" data-role="panel">',
    '  <div class="cw-header">',
    '    <span class="cw-title">我的提问</span>',
    '    <span class="cw-count" data-role="count">0</span>',
    '    <span class="cw-actions">',
    '      <button class="cw-btn" data-act="search" title="搜索提问" aria-label="搜索提问">' + ICONS.search + '</button>',
    '      <button class="cw-btn" data-act="collapse" title="收起为短横线列" aria-label="收起">' + ICONS.collapse + '</button>',
    '    </span>',
    '  </div>',
    // ★ 第 9 章：搜索框是**常驻在 DOM 里**的，靠一个 class 控制展开/收起。
    //   为什么不用 `if (open) 创建 / else 删除`：
    //     删掉再建会让输入框"失焦、丢掉已输入的内容、丢掉光标位置"，
    //     而且每次开合都要重新走一遍「创建 → 插进文档 → 等布局 → focus」。
    //     常驻 + CSS 过渡 = 一次创建，开合零成本，还能顺便做滑出动画。
    '  <div class="cw-search-wrap">',
    '    <div class="cw-search">' + ICONS.search,
    '      <input class="cw-input" type="text" placeholder="搜索提问…" spellcheck="false" autocomplete="off" />',
    '      <button class="cw-clear" data-act="clear" title="清空" aria-label="清空">✕</button>',
    '    </div>',
    '  </div>',
    // ★ 第 13 章：「回到刚才」栏。
    //   只在"当前项是**子提问**、而且它的父提问**在本目录里**"时才展开。
    //   两条缺一不可 —— 父提问不在目录里时，点了没反应比不显示更糟（用户会以为坏了）。
    //   ⚠️ 它是**常驻 DOM**（靠 max-height 过渡开合），和搜索框同一个理由：
    //      删掉再建会丢掉状态，而且开合有动画、看起来才像"栏"而不是"突然冒出来"。
    '  <div class="cw-backbar" data-role="back">',
    '    <button class="cw-back" data-act="back" title="回到父提问的这段原文">',
    '      <span class="cw-back__arrow">←</span>',
    '      <span class="cw-back__label">回到刚才</span>',
    '    </button>',
    '    <div class="cw-back__sub" data-role="backsub"></div>',
    '  </div>',
    '  <div class="cw-list" data-role="list"></div>',
    // ★ 第 8.5 章补（2026-09-30）：**过渡期加载占位**。
    //   切会话时"上一个会话的列表"不能显示（那是错的），而权威列表要等网络；
    //   于是面板会空 2~5 秒。空着好过显示错的，但"什么都不说"仍然像坏了 ——
    //   这块占位就是那句"我在读，稍等"。
    //   ⚠️ 它和 empty（下面那个）**互斥**：同时出现会自相矛盾，
    //      互斥由 updateEmpty 的 loading 守卫保证。
    '  <div class="cw-loading" data-role="loading">',
    '    <span class="cw-loading__sk"></span><span class="cw-loading__sk"></span><span class="cw-loading__sk"></span>',
    '    <span class="cw-loading__text">正在读取本会话的完整提问…</span>',
    '  </div>',
    // ★ 第 9 章：空状态也常驻。它和"列表里一条都没有"是两件事：
    //   列表可能只是被搜索**过滤空**了，数据本身还在。
    '  <div class="cw-empty" data-role="empty"><b>没有找到相关提问</b>换个关键词试试</div>',
    '</div>',
    // ★ 第 10 章：悬停浮出的全文气泡。
    //   ⚠️ 它挂在 #cw-root 这一层（面板**外面**），因为面板有 overflow: hidden，
    //      气泡放在里面会被裁掉。这也正是 style.css 里"绝不加 contain"那条铁律的由来。
    '<div class="cw-tip" data-role="tip"></div>'
  ].join("");

  /* ────────────────────────────────────────────────────────────────────────
     二、模块内部状态（外面看不到，也不该看到）
     ──────────────────────────────────────────────────────────────────────── */

  let root = null;         // #cw-root 元素。挂载后一直留着复用，不重建
  let refs = {};           // 缓存的子元素 { panel, list, count, empty, input, ... }
  let handlers = {};       // 外部传进来的回调表 { onJump }；默认空对象，绝不 undefined
  let boundList = null;    // 已经绑过 click 的那个 list 元素（用来保证"只绑一次"）
  let boundRoot = false;   // ★ 第 9 章：那几个"绑在常驻元素上"的监听只绑一次的闸门
  let itemEls = [];        // ★ 第 7 章：行的 DOM 引用，顺序与 setItems 的 list 一一对应
  let activeIndex = -1;    // ★ 第 7 章：当前高亮第几条；-1 = 没有

  // ★ 第 9 章新增：两份"数据侧"的状态。
  //   ⚠️ 它们必须存在模块级，而不是挂在 DOM 上 —— 因为 setItems() 会整批重建行，
  //      "现在过滤词是什么"不能因为重画而丢掉（否则每来一条新消息，搜索就被清空）。
  let items = [];          // 最近一次 setItems 收到的数组（applyQuery 要靠它取标题）
  let query = "";          // 当前过滤词（已 trim、已转小写）

  // ★ 第 8.5 章补（2026-09-30）：过渡期是否正在显示"加载中"占位。
  //   它是一份**纯视觉**状态，不影响 items / 过滤 的任何行为。
  let loading = false;

  // ★ 第 10 章新增：两个定时器。
  let revealTimer = 0;     // "鼠标移开 → 170ms 后收回"的防抖句柄
  let tipTimer = 0;        // 悬停浮出全文的防抖句柄

  // ★ 第 13 章新增：当前"回到刚才"要回到谁（父提问的 key）。
  //   空串 = 不显示按钮。它由 setActive → syncBack 维护。
  //   ⚠️ 存的是**父提问的 key**，不是下标：面板重画后下标会变，key 不会。
  let backKey = "";

  /* ────────────────────────────────────────────────────────────────────────
     三、卡 1 · mount(userHandlers) —— 把卡片插进页面
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 挂载卡片。**幂等** —— 重复调用不会插出第二张。
   *
   * @param {Object} [userHandlers] 回调表，例如 { onJump: function (index) {} }
   * @returns {HTMLElement} #cw-root
   *
   * ⚠️ 已知行为：这个函数会用入参**覆盖**已有的回调表。
   *    所以 mount() 只应该在启动时调一次；中途调一次不带参数，
   *    卡片会照常在，但点击就没反应了（症状："卡片好好的，就是点不动"）。
   */
  function mount(userHandlers) {
    // [M3] 存回调。不传就给空对象 —— 后面点条目要用，不能让它变成 undefined。
    handlers = userHandlers || {};

    if (document.getElementById("cw-root")) {
      // [M5] 已经挂过了：直接复用，不重建。（重建会丢掉正在显示的数据）
      root = document.getElementById("cw-root");
    } else {
      // [M1] 第一次：造壳子 + 插进页面
      root = document.createElement("div");
      root.id = "cw-root";
      root.innerHTML = SKELETON;   // 见上方 SKELETON 注释：纯死内容，安全

      // 兜底：万一 body 还没解析出来，就退到 <html> 上挂，别抛错
      (document.body || document.documentElement).appendChild(root);

      // ★ 第 7 章：新壳子里一行都没有，旧的 DOM 引用与高亮必须一起作废
      itemEls = [];
      activeIndex = -1;
    }

    // [M2] 缓存高频查询的子元素。
    //      每次都 querySelector 也能跑，但这是热路径，缓存一次更干净。
    refs = {
      panel: root.querySelector('[data-role="panel"]'),
      list: root.querySelector('[data-role="list"]'),
      count: root.querySelector('[data-role="count"]'),
      empty: root.querySelector('[data-role="empty"]'),
      loading: root.querySelector('[data-role="loading"]'),
      tip: root.querySelector('[data-role="tip"]'),
      input: root.querySelector(".cw-input"),
      search: root.querySelector(".cw-search"),
      // ★ 第 13 章：「回到刚才」栏的三个引用（栏 / 按钮 / 副标题）
      back: root.querySelector(".cw-back"),
      backBar: root.querySelector(".cw-backbar"),
      backSub: root.querySelector(".cw-back__sub")
    };

    // [M4] 事件委托：只在 .cw-list 上绑 **一个** click，绝不碰任何 .cw-item。
    //
    //      这里的 boundList 守卫是必须的：
    //      mount() 若是被调第二次、而守卫失效再绑一个监听，
    //      一次点击就会触发两次 onJump —— 第 4 章会表现为"滚一下又弹回来"。
    //      ★ 这种 bug 最难查，因为"回调被调用过"这类断言全都通过。
    //      判据：绑监听的地方，问一句"这个函数会被调几次？"
    if (boundList !== refs.list) {
      refs.list.addEventListener("click", onListClick);
      boundList = refs.list;
    }

    // [M7] 第 9、10 章的静态监听（搜索框、两个按钮、悬停展开）。
    //      和 boundList 同一个道理：它们绑在 root / 常驻元素上，
    //      而这两个元素**重画时不会被替换**（重建的只有 .cw-item）。
    //      → 所以只需要一道"绑没绑过"的闸门，不能用"元素换了没"来判断。
    if (!boundRoot) {
      bindActions();     // 搜索按钮 / 收起按钮 / ✕ 清空
      bindSearch();      // 输入即过滤、Esc
      bindReveal();      // 悬停展开 / 移开收回
      bindTip();         // 悬停浮出全文
      boundRoot = true;
    }

    return root;   // [M6]
  }

  /**
   * 列表的点击处理器（事件委托的唯一入口）。
   *
   * 为什么委托到 .cw-list，而不是给每个 .cw-item 各绑一个 click？
   *   这是由**时序**决定的：
   *     mount() 那一刻      → .cw-item 一个都还不存在
   *     setItems() 之后     → 列表被整批重建，旧的 .cw-item 全部作废
   *   如果逐条绑，每重建一次就得补绑一次；漏一次，那批条目就"点不动"，
   *   而且表现为"看起来一切正常、点下去没反应"——最难查的那一类 bug。
   *   委托只绑一次，活到列表整个生命期结束，与重建无关。
   */
  function onListClick(e) {
    // e.target 是真正被点中的那个元素，可能是一行文字，也可能只是那根 2px 横线。
    // 所以必须用 closest **往上找**，不能直接判断 e.target 自己。
    // （closest 从自身开始找，所以被点中的正好是 .cw-item 时也命中。）
    const item = e.target.closest(".cw-item");
    if (!item) return;   // 点在列表空白处：安静退出，不报错

    e.preventDefault();

    // dataset.index 读出来是**字符串**（"2"），转成数字再交给回调。
    // 第 4 章要拿它当数组下标用，字符串会埋坑。
    const index = Number(item.dataset.index);
    // ★ 第 4 章返工（v0.4.2）：把 key 一起交出去 —— 它是**稳定身份**，
    //   而 index 只是"画这张快照时它在第几位"。快照过期后两者会打架，
    //   这时候必须以 key 为准。参数是"追加"的，老调用方 onJump(index) 照样能用。
    const key = item.dataset.key || "";

    if (typeof handlers.onJump === "function") handlers.onJump(index, key);
  }

  /* ════════════════════════════════════════════════════════════════════════
     三·B · 第 9、10 章的静态事件绑定
     ════════════════════════════════════════════════════════════════════════ */

  /**
   * 标题栏上的两个按钮，以及搜索框里的 ✕。
   *
   * 三个入口共用一个监听 —— 它们都在 `.cw-actions` / `.cw-search` 里，
   * 而且**从挂载到销毁都不会被替换**（重建的只有 .cw-item）。
   * 判据同 onListClick：**先问"这个容器会不会被整批替换"**，会 → 委托 + 守卫；
   * 不会 → 直接绑一次就行，不需要守卫。
   */
  function bindActions() {
    root.querySelector(".cw-actions").addEventListener("click", function (e) {
      const btn = e.target.closest(".cw-btn");
      if (!btn) return;
      e.preventDefault();
      // ⚠️ 这个 stopPropagation 是**必须**的：第 10 章在 root 上还挂了一个
      //    "收起态点一下也能展开"的兜底监听（给触摸屏用）。不拦住的话，
      //    点"收起"按钮会先收起、再被那个兜底立刻展开 —— 表现为"点了没反应"。
      e.stopPropagation();

      if (btn.dataset.act === "search") toggleSearch();

      if (btn.dataset.act === "collapse") {
        // ★ 三态语义，一行说清：
        //     "鼠标扫过临时展开中"（cw-reveal）  → 点按钮 = **固定**展开（pin 住）
        //     其它任何状态                        → 点按钮 = 收起成短横线列
        //   为什么要 pin 这一态：用户看着展开的卡片去点按钮，心里想的是"就停在这"；
        //   若直接收起，他会觉得"我明明点了却没留住"。而"已经固定展开"时再点，
        //   意图才真的是"收起来"。
        const pin = root.classList.contains("cw-reveal");
        setCollapsed(!pin);
        if (typeof handlers.onCollapse === "function") handlers.onCollapse(!pin);
      }
    });

    refs.search.addEventListener("click", function (e) {
      const clear = e.target.closest(".cw-clear");
      if (!clear) return;
      e.preventDefault();
      refs.input.value = "";
      setQuery("");
      refs.input.focus();            // 清空后把光标还回去：用户多半想重新输一个词
      if (typeof handlers.onQuery === "function") handlers.onQuery("");
    });

    // ★ 第 13 章：「回到刚才」按钮。
    //   面板**只负责"按了"**，不负责"回到哪"——回到页面某处是 content.js 的事
    //   （它才认识 parser / 锁 / 滚动）。这里把 backKey 原样交出去。
    //   ⚠️ preventDefault + stopPropagation 都要：按钮长在面板里，
    //      而 root 上还挂着"收起态点一下也能展开"的兜底监听（第 10 章）。
    if (refs.back) {
      refs.back.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        hideTip();
        if (!backKey) return;                              // 没有可回去的父项 → 什么也不做
        if (typeof handlers.onBack === "function") handlers.onBack(backKey);
      });
    }
  }

  /**
   * 搜索框：输入即过滤 + Esc 两段式。
   *
   * ⚠️ 为什么要给键盘事件盖一层 stopPropagation：
   *    我们的输入框**长在 ChatGPT 的页面上**，而页面自己在 document 上
   *    监听按键做快捷键（比如 `/` 聚焦搜索、`Esc` 关弹层）。
   *    不拦住的话，在这里打字会顺手触发页面的快捷键 —— 表现为"输着输着页面跳了"。
   *    这不是过度防御：**给别人的页面加输入框，就欠这一层礼貌。**
   */
  function bindSearch() {
    const stop = function (e) { e.stopPropagation(); };
    ["keydown", "keyup", "keypress", "input"].forEach(function (t) {
      refs.input.addEventListener(t, stop);
    });

    // 输入即过滤 —— 绑的是 input 事件，所以**不需要按回车**。
    // ⚠️ 用 input 而不是 keyup：input 涵盖了粘贴、拖放文字、输入法上屏、
    //    浏览器自动填充……keyup 只认"按键"，输入法选词上屏时它可能一次都不触发。
    refs.input.addEventListener("input", function () {
      refs.search.classList.toggle("has-value", !!refs.input.value);   // ✕ 只在有内容时露出来
      setQuery(refs.input.value);
      if (typeof handlers.onQuery === "function") handlers.onQuery(refs.input.value);
    });

    refs.input.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (refs.input.value) {
        // 第一段：有内容 → 只清空（不收起搜索框）
        refs.input.value = "";
        refs.search.classList.remove("has-value");
        setQuery("");
        if (typeof handlers.onQuery === "function") handlers.onQuery("");
      } else {
        // 第二段：本来就是空的 → 才把搜索框收起来
        // 判据：**"清空"和"收起"是两种意图，别让一次按键同时干掉两件事。**
        toggleSearch(false);
      }
    });
  }

  /**
   * 收起态的悬停自动展开（第 10 章的主交互）。
   *
   * 三个要点：
   *   ① 进入用 pointerenter / 离开用 pointerleave —— 它们**不冒泡**，
   *      所以不会被子元素的进进出出反复触发（换成 mouseover/mouseout 就会疯狂抖动）。
   *   ② 收回要**防抖 170ms**：鼠标从横线列扫到面板上的过程必然短暂离开 root，
   *      不防抖的话卡片会在鼠标还没到之前就收回去，表现为"刚要展开又没了"。
   *   ③ 收回前要问一句"用户的眼睛在哪" —— 正在搜索框里打字就别收
   *      （判定方式见下面的注释）。
   */
  function bindReveal() {
    root.addEventListener("pointerenter", function () {
      if (!root.classList.contains("cw-collapsed")) return;
      reveal();
    });

    // 兜底入口：触摸屏 / 鼠标坏了的场景下，点一下这列横线也能展开。
    // （有鼠标时它基本轮不到 —— 悬停早就把面板展开了。这就是它需要 stopPropagation 的原因。）
    root.addEventListener("click", function (e) {
      if (!root.classList.contains("cw-collapsed")) return;
      e.preventDefault();
      reveal();
    });

    root.addEventListener("pointerleave", function () {
      if (!root.classList.contains("cw-reveal")) return;   // 本来就是固定展开 → 不用收回
      clearTimeout(revealTimer);
      revealTimer = setTimeout(function () {
        // ★ 这两道闸门要写在**定时器里面**：170ms 之内用户可能
        //   刚好点了搜索框（焦点进去）、或者开始拖卡片。计时器外面判断的是"旧状态"。
        if (document.activeElement === refs.input) return;  // 眼睛还在搜索框上，别收
        if (refs.panel.classList.contains("cw-dragging")) return;
        setCollapsed(true);
      }, 170);
    });
  }

  /** 临时展开（只改 class，不写回任何"用户设置"——第 11 章才有设置可写） */
  function reveal() {
    clearTimeout(revealTimer);
    root.classList.remove("cw-collapsed");
    root.classList.add("cw-reveal");
    syncCollapseButton();
  }

  /**
   * 收起 / 固定展开。
   *   setCollapsed(true)  → 收成一列短横线
   *   setCollapsed(false) → 固定展开（并且清掉"临时展开"标记）
   */
  function setCollapsed(flag) {
    const on = flag === true;
    root.classList.toggle("cw-collapsed", on);
    root.classList.remove("cw-reveal");
    if (on) hideTip();
    updateRailGeometry();      // 收起态需要"每条横线多高"这个数
    syncCollapseButton();
  }

  function isCollapsed() { return root.classList.contains("cw-collapsed"); }
  function isRevealed() { return root.classList.contains("cw-reveal"); }

  /** 按钮的提示文字跟着状态走 —— 否则展开时悬停还写着"收起"，用户会以为点错了 */
  function syncCollapseButton() {
    const btn = root.querySelector('.cw-btn[data-act="collapse"]');
    if (!btn) return;
    const revealed = root.classList.contains("cw-reveal");
    btn.title = revealed ? "固定展开" : "收起为短横线列";
    btn.setAttribute("aria-label", btn.title);
  }

  /**
   * 悬停浮出全文（第 10 章）。
   *
   * 第 8 章先用**原生 title 属性**顶了一下，理由是"需求只有一句话时先用系统给的东西"。
   * 第 10 章换成真浮层，两个理由：
   *   ① 原生 title 延迟约 1 秒、样式不可控、超长文本不换行 —— 而这一章的主题
   *      恰恰就是"交互的精细度"；再用它就说不过去了。
   *   ② 这一章本来就在处理几何（横线行高、展开动画），
   *      getBoundingClientRect + 视口夹取这套活儿已经摊开，顺手做掉。
   *
   * ⚠️ 触发条件：「屏幕上看不全」，而"看不全"有**两条路**（2026-09-28 真机实测钉死）：
   *
   *   ① CSS 省略号（`scrollWidth > clientWidth`）—— 行太窄，标题自己的尾巴被裁了；
   *   ② 摘要层的 26 字截断 —— 标题本身就是原文的**前缀**，后半段屏幕上根本不存在。
   *
   *   只查 ① 会漏掉 ②：真机实测（14 条的会话）里 3 条英文混排标题
   *   （`Branch in new chat在哪里，我并没…`、两条 `Selected text: Selection …`）
   *   都被摘要砍到 26 字、以 … 结尾，但拉丁字符窄，**一行放得下** → scrollWidth 不超
   *   → 旧判据下悬停什么都不弹，用户永远看不到后半句。
   *   反过来只查 ② 也会漏：22 字的中文标题（原文同长）撑满行宽被 CSS 裁了尾巴，
   *   但"原文没比标题长"→ 没生成 tooltip → 也弹不出来。
   *   → 两个条件是**或**的关系，缺一不可。
   *
   *   还要排除真噪音：标题 === 全文 且没被 CSS 裁（比如那条只发了「？」的提问）——
   *   弹出的内容和行上一模一样，等于什么都没说。
   */
  function bindTip() {
    refs.list.addEventListener("mouseover", function (e) {
      const item = e.target.closest(".cw-item");
      if (!item) return;
      const data = items[Number(item.dataset.index)] || {};
      const textEl = item.querySelector(".cw-item__text");
      const cut = textEl && textEl.scrollWidth > textEl.clientWidth + 2;   // 路 ①：CSS 裁了
      const compressed = !!data.tooltip && data.tooltip !== data.title;    // 路 ②：摘要砍了
      if (!cut && !compressed) return hideTip();
      const text = data.tooltip || data.text || "";
      if (!text) return hideTip();
      showTip(text, item);
    });

    refs.list.addEventListener("mouseout", function (e) {
      // ⚠️ 只在"真的离开了列表"时才隐藏。
      //    在一行里从文字移到横线上，也会触发 mouseout —— 不过滤的话气泡会一闪一闪。
      const to = e.relatedTarget;
      if (to && refs.list.contains(to)) return;
      hideTip();
    });

    // 列表一滚，行位置就变了，气泡还挂在旧坐标上 → 直接收掉，别让它飘在空气里
    refs.list.addEventListener("scroll", hideTip, { passive: true });
  }

  function showTip(text, itemEl) {
    const tip = refs.tip;
    if (!tip || !text) return;
    clearTimeout(tipTimer);
    tip.textContent = text;           // ⚠️ textContent：这里的 text 是用户提问原文
    tip.classList.add("is-on");

    // ★★ 量之前必须先把 left/top 归零。
    //
    //  .cw-tip 是 `position: fixed` 且**不设 width** → 它的宽度是 shrink-to-fit：
    //        宽度 = min(可用宽度, max-width 300px)
    //        而"可用宽度" = 视口宽 − left
    //  上一次的 left 还挂在元素上（比如上一条提示停在最右侧 left=1398px），
    //  于是这次只剩 1536−1398=138px 可量 → 元素被压窄、文字换行 → offsetWidth 返回 138。
    //  拿这个**假宽度**去算 left（1202.8−138−12=1052.8），再写回 left：
    //  可用宽度一下变大，元素重新撑回 272px 并向右长出去 → 气泡压在面板上。
    //  （真机实测：气泡右边 1324.7 而面板左边 1202.8，重叠 122px。）
    //  归零之后可用宽度 = 整个视口，量到的才是真实宽度。
    tip.style.left = "0px";
    tip.style.top = "0px";

    const ir = itemEl.getBoundingClientRect();
    const pr = refs.panel.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;

    // 优先放在面板**左边**（卡片本身贴右边缘，左边才有空间）
    let left = pr.left - tw - 12;
    if (left < 8) {
      // 左边塞不下（面板被拖到屏幕左侧了）→ 退回面板内侧
      left = Math.min(window.innerWidth - tw - 8, pr.left + 8);
    }
    if (left < 8) left = 8;           // 最后一道兜底：绝不越出左边界

    let top = ir.top + ir.height / 2 - th / 2;
    top = Math.min(Math.max(8, top), window.innerHeight - th - 8);   // 上下都夹进视口

    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function hideTip() {
    if (refs.tip) refs.tip.classList.remove("is-on");
  }

  /* ────────────────────────────────────────────────────────────────────────
     四、卡 2 · setItems(list) —— 把数据画成列表
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 造一行（一条提问）。
   *
   * 为什么单独抽成一个函数？
   *   第 4 章要往行里加"跳转"相关的东西、第 8 章要把原文换成摘要（✅ 已实装，
   *   见下面 `item.title || item.text`）、第 10 章收起态要动那根横线 ——
   *   到时候只需改这一个地方。这一章一次都没白写。
   */
  function makeRow(item, i) {
    const row = document.createElement("div");
    row.className = "cw-item";
    // ★ 第 11 章：子提问（选中文字继续提问）用缩进 + 小字号区分层级，不编号。
    //   层级感只来自「缩进 + 字号」两样，绝不加背景框（第 10 章"去方框"教训）。
    // ★ 2026-09-28：追问链（在子提问的回答里再选中）可以很深 —— 每级多缩一点，
    //   第 3 级起封顶。
    //   ⚠️ `cw-item--child` 由 **isChild**（身份）决定，depth 只管**多缩多少** ——
    //      两者不能混：直接注入的数据没有 depth（没走 arrangeUnderParent），
    //      若用 depth>=1 判身份，那些子项会当场丢掉缩进和小字号。
    //      判据：**"是不是子项"和"第几层"是两个问题，用两个字段。** */
    if (item.isChild) row.classList.add("cw-item--child");
    const d = item.depth || 0;
    if (d >= 2) row.classList.add("cw-item--d2");
    if (d >= 3) row.classList.add("cw-item--d3");
    row.dataset.index = String(i);   // [S2] 第 4 章"跳转"的全部依据
    // ★ [S2.5] 第 4 章返工（v0.4.2）新增：把消息的**稳定身份**也带到 DOM 上。
    //
    // 为什么光有 index 不够（真实事故，见 tools/probes/p39-index-mismatch-quick.js）：
    //   目录是**快照** —— 画完就不再更新。而 ChatGPT 的会话内容会变
    //   （SPA 切换会话、向上滚时补挂载更老的消息、编辑/分支……）。
    //   一旦列表变了，index 的含义就整体位移了：
    //     面板第 4 条写着"？"，index=3 却指向了另一条**已经在屏幕上**的消息，
    //     scrollTo 走"已在好位置就不动"的分支 → 用户看到"点了没反应"。
    //   而 list[key] 里的 key（data-message-id）是**跨重渲染稳定**的，
    //   所以点击时应该"按 key 找"，index 只当兜底。
    row.dataset.key = String(item.key == null ? "" : item.key);   // [S2.5]

    // ★ 第 9 章：序号标签。
    //   ⚠️ 它显示的**不是** data-index！见 applyQuery() 里"过滤后要重排序号"那段。
    //      一句话：**标签是"给眼睛看的第几位"，data-index 是"给跳转用的第几位"**，
    //      过滤一开，这两个数就会不一样，而且**必须**不一样。
    const idx = document.createElement("span");
    idx.className = "cw-item__idx";

    const text = document.createElement("span");
    text.className = "cw-item__text";
    // [S3] ⚠️ 必须是 textContent，绝不能用 innerHTML。
    //      提问里出现 <div>、A*、& 这类字符时：
    //        innerHTML  → 被浏览器当标签解析 → 内容被吞（"A*" 那个星号甚至会变成斜体）
    //                     而且这是一个 XSS 入口
    //        textContent → 原样显示，一个字符都不动
    //      这不是"风格问题"，是正确性问题。
    //
    // ★ 第 8 章：显示 `title`（摘要后的短标题），没有才退回 `text`（原文）。
    //   用 `||` 而不是三元判断 `item.title != null ? ... : ...`：
    //   空串和 undefined 都要退到原文，`||` 一次把两种都兜住了。
    //   ⚠️ 这一层必须有兜底：这个函数的契约是"任何 { text } 数组都行"，
    //      直接读 item.title 的话，测试里传的旧格式数组就会渲染成空行。
    text.textContent = item.title || item.text;

    // ★ 第 8 章写在这里的 `if (item.tooltip) row.title = item.tooltip;` 被**第 10 章撤掉了**。
    //   原因不是它错了，而是它被更好的东西取代了：
    //     原生 title 的延迟约 1 秒、样式不可控、长文不换行；
    //     而第 10 章要做的"悬停浮出全文"（见 bindTip/showTip）没有这些毛病。
    //   判据：**后一版把前一版的权宜之计替换掉时，要顺手把旧的删掉。**
    //        两套提示同时挂着 = 先弹我们的、1 秒后再弹原生的，叠一层脏东西。

    const mark = document.createElement("span");   // [S4] 真实元素，不是 ::after 伪元素
    mark.className = "cw-item__mark";              //      第 10 章收起态要复用这一批横线，
                                                   //      伪元素 JS 够不着（getComputedStyle 只能读不能写）

    row.appendChild(idx);
    row.appendChild(text);
    row.appendChild(mark);
    return row;
  }

  /**
   * 渲染整个列表。每次调用都**全量重建**。
   *
   * @param {Array} list  每项形如 { text, key, title?, tooltip? }
   *   · `key`     —— 稳定身份，点击时交给 onJump 当依据（第 4 章）
   *   · `title`   —— 显示用的短标题；没有就退回 `text`（第 8 章）
   *   · `tooltip` —— 悬停浮出的全文；没有就不设提示（第 8 章）
   *   ⚠️ 三个可选字段都必须有兜底 —— 这个函数的契约是"任何 { text } 数组都行"，
   *      第 1~7 章的调用方（和测试）传的就是只有 text 的数组。
   * @returns {void}
   *
   * 为什么这一章不做增量更新？
   *   全量重建 = 状态永远只有一份（就是 list 本身），
   *   不可能出现"新条目和旧条目叠在一起"这种状态错乱。
   *   唯一代价是重建节点的开销，用 DocumentFragment 摊掉即可。
   *   增量更新等真的卡了再做 —— 过早优化会引入一整类"状态不同步"的 bug。
   */
  function setItems(list) {
    refs.list.textContent = "";          // [S1] 先清空。不清就是新旧叠在一起
    hideTip();                           // ★ 第 10 章：行都没了，气泡必须一起收掉
    itemEls = [];                        // ★ 第 7 章：旧的 DOM 引用全部作废，必须清掉

    const data = list || [];             // [S7] null / undefined 兜底成空数组，不报错
    items = data;                        // ★ 第 9 章：数据侧留一份 —— applyQuery 要按它取标题

    if (activeIndex >= data.length) activeIndex = -1;

    // [S5] 先攒进 DocumentFragment，最后一次性 appendChild。
    //      单个单个 append 的话，每插一个节点都会触发一次页面布局计算；
    //      攒在 fragment 里（它不在文档树上，不触发布局）最后插一次，只有一次。
    //      ⚠️ appendChild(fragment) 之后 fragment **自己会变空** ——
    //         子节点是被"搬走"而不是"复制"。所以它是一次性的，不能反复使用。
    const frag = document.createDocumentFragment();
    data.forEach(function (item, i) {
      const row = makeRow(item, i);
      itemEls.push(row);                 // ★ 第 7 章：顺手记下行的引用
      frag.appendChild(row);
    });
    refs.list.appendChild(frag);

    // ★ 第 10 章：一条提问都没有时，往列表里塞三根**占位横线**。
    //   为什么必须塞：收起态的整张交互就是"鼠标扫过那一列横线"，
    //   一条都没有 → 那一列是空的 → 鼠标扫不到任何东西 → **收起时整个卡片失联**，
    //   用户只会觉得"插件没了"。占位横线不是装饰，是"留一扇能打开的门"。
    if (!data.length) {
      const ghost = document.createElement("div");
      ghost.className = "cw-rail-ghost";
      for (let i = 0; i < 3; i++) ghost.appendChild(document.createElement("span"));
      refs.list.appendChild(ghost);
    }

    updateCount(data.length);            // [S6] 顶部计数
    updateRailGeometry();                // ★ 第 10 章：条数变了，横线行高要重算
    applyQuery();                        // ★ 第 9 章：把当前的过滤词**重新贴到新行上**
                                         //   （不重贴的话，新消息一来，过滤就"悄悄失效"了）
    updateEmpty();                       // ★ 第 9 章：空状态也要重判一次 ——
                                         //   它有两种文案（"本来就没有" / "被搜索过滤空了"），
                                         //   而 setItems 正是"数据条数变了"的那一刻。
                                         //   ⚠️ 漏掉这一行的症状：清空数据后列表空了，提示却还写着
                                         //      "没有找到相关提问"（上次搜索留下的），用户按提示去改关键词，越改越懵。

    // ★ 第 7 章：重画之后把高亮重新贴回去 ——
    //   DOM 是全新的，class 也跟着没了，不补一次就会"高亮突然消失"。
    setActive(activeIndex, true);
  }

  /* ────────────────────────────────────────────────────────────────────────
     四·B · 第 9 章 · 搜索过滤
     ──────────────────────────────────────────────────────────────────────── */

  function updateCount(n) {
    if (refs.count) refs.count.textContent = String(n);
  }

  /**
   * 设过滤词（trim + 转小写后存起来）。
   * ⚠️ 空串要当成"没有过滤"，不能当成"过滤一个空字符串" —— 后者会匹配一切，
   *    看起来结果一样，但只要哪天换成"前缀匹配"之类的规则就会翻车。
   */
  function setQuery(value) {
    query = String(value == null ? "" : value).trim().toLowerCase();
    applyQuery();
    updateEmpty();
    // 反向同步：脚本调 setQuery("cmd") 时，输入框里也得出现 "cmd"，
    // 否则面板显示"过滤后的结果"、输入框却空着，用户完全看不懂发生了什么。
    //
    // ⚠️ 这里**不能**写成 `if (refs.input.value !== value) { ... }` 再顺手改 class ——
    //    调用方（✕ 按钮）会**先**把 input.value 清成 ""、**再**调 setQuery("")，
    //    两次的值正好相等 → 整段被跳过 → `has-value` 留在那里不清 → ✕ 按钮不消失。
    //    判据：**"同步"这件事要无条件做，"已经是目标值"不等于"旁边的状态也对"。**
    if (refs.input) {
      const shown = value == null ? "" : value;
      if (refs.input.value !== shown) refs.input.value = shown;
      refs.search.classList.toggle("has-value", !!refs.input.value);
    }
  }

  /**
   * 把过滤词作用到现有的行上 —— **不重建任何 DOM**，只切一个 class。
   *
   * 为什么不用 `display:none` 删了重建：
   *   重建的代价是"整批节点重新创建 + 重新插入 + 重新布局"，
   *   而过滤是**每敲一个字**都要跑一次的交互。
   *   切 class 只让浏览器重算这一行的样式 —— 这是"输入即过滤"能做到不卡的唯一原因。
   *   ★ 判据：**高频交互只改"值"，不改"结构"。**
   */
  function applyQuery() {
    // ① 先算每条自己的命中（匹配范围 = 短标题 + 原文）
    const hits = items.map(function (item) {
      const hay = ((item.title || "") + " " + (item.text || "")).toLowerCase();
      return !query || hay.indexOf(query) >= 0;
    });

    // ② ★ 第 11 章：父链传播 —— 搜索不能留下"孤儿子项"。
    //    · 子命中 → 它的**整条祖先链**都必须显示（多级追问链：命中 kid3 就得把
    //      kid2、kid1、主提问一起显出来，否则缩进悬在空气里）；
    //    · 父命中 → 它的**全部后代**跟随显示（递归，不只是直接子项）。
    //    ★ 2026-09-28 二改：追问链可以很深，两级传播会漏掉中间层。
    const show = hits.slice();
    const idxOf = {};
    items.forEach(function (it, i) { idxOf[it.key] = i; });

    // 向上传播：命中 → 沿 parentKey 一路点亮祖先（带 guard 防环）
    items.forEach(function (item, i) {
      if (!hits[i]) return;
      let pk = item.parentKey, guard = 0;
      while (pk && guard++ < 200) {
        const pi = idxOf[pk];
        if (pi === undefined || show[pi]) break;   // 父不在列表 / 已点亮 → 停
        show[pi] = true;
        pk = items[pi].parentKey;
      }
    });

    // 向下传播：命中 → 递归点亮全部后代
    const kidsOf = {};
    items.forEach(function (it, i) {
      if (it.parentKey && it.parentKey !== it.key) {
        (kidsOf[it.parentKey] = kidsOf[it.parentKey] || []).push(i);
      }
    });
    function lightDown(i, guard) {
      if (guard > 200) return;
      (kidsOf[items[i].key] || []).forEach(function (j) {
        if (show[j]) return;
        show[j] = true;
        lightDown(j, guard + 1);
      });
    }
    items.forEach(function (item, i) { if (hits[i]) lightDown(i, 0); });

    // ③ 应用（只切 class，不重建 DOM）+ 序号重排（跳过隐藏行递增）
    let shown = 0;
    itemEls.forEach(function (row, i) {
      row.classList.toggle("is-hidden", !show[i]);

      // ★★ 序号重排（本章最容易埋 bug 的一处）
      //   标签是"在**当前可见的这一列**里排第几"，所以必须**跳过被隐藏的行**递增。
      //   ⚠️ 但 `row.dataset.index` **绝对不能动** —— 那是跳转的依据，永远是原始数组下标。
      //      两者混用就是那个经典事故：过滤后点第 1 条，跳到了原来的第 3 条。
      //      判据：**同一个数字有两种含义时，必须用两个字段把它们分开存。**
      if (show[i]) {
        shown++;
        const label = row.querySelector(".cw-item__idx");
        if (label) label.textContent = String(shown);
      }
    });
    updateCount(shown);     // 顶部计数跟着过滤走 —— 否则显示 13 却只列出 2 条，很困惑
  }

  /**
   * ★ 第 8.5 章补（2026-09-30）：**过渡期"加载中"占位**。
   *
   * 只改视觉，不动数据：setItems 照常跑（可能为空），这里只负责把
   * `.cw-loading` 打开/关掉，并且**与 empty 互斥** —— "加载中"和
   * "还没有提问"同时出现会自相矛盾（用户不知道该信哪一句）。
   */
  function setLoading(flag) {
    const was = loading;
    loading = !!flag;
    if (refs.loading) refs.loading.classList.toggle("is-on", loading);
    // ★ 两个方向都要同步：开 → empty 让位；关 → empty 按真实状态回来。
    //   （只写"开"那一半的话，加载结束后面板会**两个都不显示** —— 空着。）
    if (was !== loading) updateEmpty();
  }

  function isLoading() { return loading; }

  /** 空状态：分"本来就没有"和"被搜索过滤空了"两种，文案不同 */
  function updateEmpty() {
    const box = refs.empty;
    if (!box) return;
    // ★ 加载中 → empty 一律让位（两者互斥，见 setLoading）
    if (loading) { box.classList.remove("is-on"); return; }
    if (!items.length) {
      box.innerHTML = "<b>还没有识别到提问</b>发一条消息后目录会自动出现";
      box.classList.add("is-on");
      return;
    }
    const visible = itemEls.filter(function (r) {
      return !r.classList.contains("is-hidden");
    }).length;
    if (query && !visible) {
      box.innerHTML = "<b>没有找到相关提问</b>换个关键词试试";
      box.classList.add("is-on");
    } else {
      box.classList.remove("is-on");
    }
  }

  /**
   * 展开 / 收起搜索框。
   * @param {boolean} [force] true = 一定展开，false = 一定收起，不传 = 切换
   */
  function toggleSearch(force) {
    const open = typeof force === "boolean"
      ? force
      : !root.classList.contains("cw-search-open");
    root.classList.toggle("cw-search-open", open);

    const btn = root.querySelector('.cw-btn[data-act="search"]');
    if (btn) btn.classList.toggle("is-on", open);

    if (open) {
      // ⚠️ 这里必须等一帧再 focus。搜索框的展开是一段 0.2s 的过渡，
      //    在"高度还是 0"的时候 focus() 在部分浏览器上会**静默失败**，
      //    表现为"点了搜索图标但光标没进去，还得再点一下输入框"。
      setTimeout(function () {
        if (root.classList.contains("cw-search-open")) refs.input.focus();
      }, 60);
    } else {
      // 收起搜索框 = 顺便把过滤也撤掉。
      // 不撤的话会留下一个"看不见的筛选器"：列表只有 2 条、搜索框也没了、无从排查。
      if (refs.input.value) {
        refs.input.value = "";
        refs.search.classList.remove("has-value");
        setQuery("");
        if (typeof handlers.onQuery === "function") handlers.onQuery("");
      }
      refs.input.blur();
    }
    return open;
  }

  /* ────────────────────────────────────────────────────────────────────────
     五、第 7 章 · 当前项（滚动同步的落点）
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 把"当前项"设成第 index 条（-1 = 全部取消高亮）。
   *
   * @param {number} index
   * @param {boolean} [force] true = 即使 index 没变也重刷一遍（重画之后必须用）
   *
   * ⚠️ 只动 `class`，**绝不动 font-weight / 尺寸** ——
   *    这是第 3 章 hover 返工换来的教训：条目是 `flex: 1` 的文字区 + 一根 14×2 的横线，
   *    改字重或横线长度会让整行的文字**左右跳一下**（用户会看成"列表在抖"）。
   *    醒目感交给颜色的发光（box-shadow）来做 —— 它不参与布局，怎么加都不会挤别人。
   */
  function setActive(index, force) {
    if (index === activeIndex && !force) return;
    activeIndex = index;
    itemEls.forEach(function (row, i) {
      row.classList.toggle("is-active", i === index);
    });
    // 列表很长、当前项在可视区外时，把它带进来看得见
    if (index >= 0 && itemEls[index]) ensureVisible(itemEls[index]);
    syncBack();                       // ★ 第 13 章：当前项变了 → 重算「回到刚才」栏
  }

  /* ────────────────────────────────────────────────────────────────────────
     五·A · 第 13 章 · 「回到刚才」栏的显隐
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 按"当前项"重算「← 回到刚才」栏要不要显示。
   *
   * 规则（设计文档第 4 节）：
   *   当前项是**子提问** 且 它的**父提问就在本目录里** → 显示
   *   其余一切情况                                        → 收起
   *
   * 为什么要额外要求"父提问在目录里"：
   *   父不在目录里（比如被搜索过滤掉、或者目录还没加载全）时，点了没反应 ——
   *   用户会以为功能坏了。**宁可不显示，也不要显示一个点不动的按钮。**
   *
   * ⚠️ 只在**这里**改 backKey：它和按钮的显隐必须同生共死，
   *    分成两处写迟早会出现"按钮亮着、但点了没反应"。
   */
  function syncBack() {
    if (!refs.back || !refs.backBar) return;
    const it = items[activeIndex];
    let parent = null;
    if (it && it.isChild && it.parentKey) {
      parent = items.find(function (m) { return m.key === it.parentKey; }) || null;
    }
    backKey = parent ? parent.key : "";
    refs.backBar.classList.toggle("is-on", !!parent);
    if (parent && refs.backSub) {
      refs.backSub.textContent = "父提问：" + (parent.title || "未命名提问");
      refs.backSub.title = parent.title || "";
    }
  }

  /** 当前「回到刚才」指向哪个父提问的 key（空串 = 没得回）。探针/回归测试用。 */
  function backTarget() { return backKey; }

  /**
   * 让某一行在**面板自己的列表**里可见（只滚 .cw-list，不碰页面）。
   * 判据都在同一个滚动容器内部算，跟 ChatGPT 页面毫无关系。
   */
  function ensureVisible(row) {
    const lr = refs.list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (rr.top < lr.top + 2) {
      refs.list.scrollTop -= lr.top - rr.top + 8;
    } else if (rr.bottom > lr.bottom - 2) {
      refs.list.scrollTop += rr.bottom - lr.bottom + 8;
    }
  }

  /* ────────────────────────────────────────────────────────────────────────
     五·B · 第 10 章 · 收起态那一列横线的几何
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 收起态最多显示几根横线。
   *
   * ★ 2026-09-28 新增这个上限（用户实测反馈："鼠标没悬停的时候最多有 9 条横线就够"）。
   *
   * 为什么"越多越好"是错的：
   *   收起态存在的意义就是**别挡着聊天内容**。那一列横线越长，盖住的正文越多 ——
   *   20 条提问就撑出 20 根横线（哪怕每根只有 8px），一列灰线从屏幕顶贯到底，
   *   比展开的面板还碍事，等于把这个形态的价值抵消掉了。
   *
   * 为什么是 9：展开态一次恰好显示 9 条（--cw-rows），取同一个数，
   *   收 / 展两种形态的"容量感"就是一致的 —— 用户不会觉得"收起来之后东西变少了"。
   *   ⚠️ 超出的条目**不会消失**：它们还在 DOM 里、还在展开态的列表里，
   *      只是被 `.cw-list` 的 `overflow: hidden` 裁掉；展开就又能看到。
   */
  const RAIL_MAX = 9;

  /**
   * 收起态那一列除了横线之外的固定开销：`.cw-list` 上下各 8px 内边距。
   * ⚠️ 它必须**参与**高度计算：`clientHeight`/`getBoundingClientRect().height` 都是含内边距的，
   *    漏掉这 16px 的后果就是"第 9 根被切掉一截"——
   *    ★ 这和第 8.5 章"九行视窗漏算 8px 内边距"是**同一个坑**，
   *      凡是拿布局尺寸做算术，先把每一层的内边距数一遍。
   */
  const RAIL_PAD = 16;

  /**
   * 算"收起态里每条横线占多高"，写进 CSS 变量 --cw-rail-row。
   *
   * 公式一句话：**把可用高度平均分给"最多 9 条"**，然后限幅到 [8px, 44px]。
   *
   * 为什么必须限幅（这是本章唯一一处真正的算术）：
   *   不限下限 → 条数多时每条只剩几个像素，整列横线变成一根灰糊糊的竖线，
   *              鼠标根本没法定到某一条上。
   *   不限上限 → 3 条提问时每条 160px，一列三根横线撑满整个屏幕，非常怪。
   *   限幅之后的结果是：**条数少时那列是"疏"的，条数多时是"密"的，但永远可点。**
   *
   * ⚠️ 为什么算高度要用 `window.innerHeight` 而不用面板自己的高度：
   *    收起态的面板高度是"由内容撑出来的" —— 它是 0 条还是 40 条，高度完全不同。
   *    拿它当分母 = 自己依赖自己（循环依赖），永远算不稳。
   *    → 判据：**布局里定一个尺寸时，分母必须是"外部给定的量"，不能是自己。**
   */
  function updateRailGeometry() {
    // ★ 分子用 min(条数, 9)：**分母按 9 算**，超出的条目交给 overflow 裁掉。
    //   这样"有 9 条"和"有 40 条"的横线间距完全一样 —— 收起态的样子因此是可预期的。
    const n = Math.min(Math.max(items.length, 1), RAIL_MAX);   // 0 条也要除得动
    const avail = Math.max(120, window.innerHeight * 0.68 - 18); // 68vh 再减掉列表的上下内边距
    const rowH = Math.min(44, Math.max(8, Math.floor(avail / n)));
    root.style.setProperty("--cw-rail-row", rowH + "px");

    /* ★★ 光限"每条多高"是不够的，还要把"那一列总共多高"交给 CSS —— 这是**真机实测**逼出来的：
       只限行高时，条数一多，面板照样会被内容撑着长到 --cw-max-h（730 视口下是 618px），
       于是**看得见 13 根横线**而不是 9 根（探针 p73 的 E 段原话：
       "30 条：★ 看得见的横线仍然是 9 根 → 13 根可见 / DOM 里 30 行"）。
       判据：**"最多 9 条"要同时约束"每条多高"和"总共多高"，只做一半等于没做。** */
    root.style.setProperty("--cw-rail-h", (rowH * RAIL_MAX + RAIL_PAD) + "px");
  }

  /* ────────────────────────────────────────────────────────────────────────
     六、对外暴露
       · 第 3 章：mount / setItems
       · 第 7 章：setActive（content.js 的滚动同步调用它）
       · 第 9 章：toggleSearch / setQuery
       · 第 10 章：setCollapsed / isCollapsed / isRevealed
     ──────────────────────────────────────────────────────────────────────── */

  return {
    mount: mount,
    setItems: setItems,
    setActive: setActive,             // ★ 第 7 章新增
    toggleSearch: toggleSearch,       // ★ 第 9 章新增
    setQuery: setQuery,               // ★ 第 9 章新增
    setCollapsed: setCollapsed,       // ★ 第 10 章新增
    isCollapsed: isCollapsed,         // ★ 第 10 章新增
    isRevealed: isRevealed,           // ★ 第 10 章新增
    setLoading: setLoading,           // ★ 第 8.5 章补：过渡期"加载中"占位
    isLoading: isLoading,
    backTarget: backTarget            // ★ 第 13 章：「回到刚才」此刻指向哪个父提问
  };
})();
