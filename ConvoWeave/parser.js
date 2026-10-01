/**
 * parser.js —— 页面解析层
 * 职责：从 ChatGPT 页面 DOM 里提取"用户发送的提问"，以及滚动/高亮需要的节点。
 * 原则：不改页面的**结构**。唯一会动页面的两处都在文件末尾：
 *       scrollTo()（第 4 章，只改滚动位置）、flash()（第 5 章，只挂一个临时环）。
 */
window.CW_Parser = (function () {
  "use strict";

  /**
   * "一条用户消息的**整块**"选择器。
   *
   * ★ 单独提成常量，是因为它有**两个消费者，而它们必须指着同一个东西**：
   *   · USER_SELECTORS[0]（抓提问用）
   *   · jumpAnchor()（第 4 章跳转锚点用，见该函数上面的说明）
   *   同一个知识写两份的代价不是多打几个字，而是**将来改一份忘一份** ——
   *   症状是"抓到了却跳不到"，两边各自看起来都正常。
   */
  const MSG_UNIT_SELECTOR = '[data-chatgpt-search-unit-key$=":user"]';

  /** 用户消息选择器：**顺序 = 优先级**，第一个"命中数 > 0"的候选就用它 */
  const USER_SELECTORS = [
    MSG_UNIT_SELECTOR,                            // 2026-09 新版首选：每条用户消息恰好一个（含"只挂附件"那种）
    '[data-user-message-bubble]',                 // 2026-09 新版备选：气泡本身（会漏掉没有气泡的附件轮）
    '[data-message-author-role="user"]',          // 旧版（2026-09 起实测已失效，留作兜底）
    'div[data-message-author-role="user"]'
  ];

  /** "一整轮对话"的容器选择器，第 4 章跳转、第 5 章高亮要用 */
  const TURN_SELECTORS = [
    '[data-turn-key]',                            // 2026-09 新版：每轮容器（值 = 该轮用户消息 id）
    'article[data-testid^="conversation-turn"]',  // 旧版（2026-09 起失效，留作兜底）
    '[data-testid^="conversation-turn"]',
    'article'
  ];

  /* ================================================================
   * 下面 5 个函数是**第 2 章**写的。
   * 每张卡的完整版见《第2章-把提问捞出来.md》第 4.5.3 节。
   *
   * 建议写作顺序（不是这里的排列顺序！）：
   *   ① getChatId → ② extractText → ③ getScrollContainer
   *   → ④ hasConversation → ⑤ getUserMessages
   * 为什么 getUserMessages 放最后：它的 text 字段要用 extractText 的成果。
   *
   * 第 4 章在文件末尾又加了 scrollTo()，它复用下面的 getScrollContainer()。
   * ================================================================ */

  /**
   * 【卡 2】把一条消息节点变成"用户真正写下的那句话"的纯文本。
   *
   * 入参：el —— 一个 Element（一条用户消息节点），可能是 null
   * 返回：string（永远不返回 null / undefined）
   */
  function extractText(el) {
    if (!el) return "";                                         // 边界①：绝不对 null 取属性
    const t = (el.innerText || el.textContent || "").trim();    // || 是给 jsdom 兜底的
    if (!t) return el.querySelector("img") ? "[图片消息]" : "";  // 边界②：只有图没有字
    return t;
  }

  /**
   * 【卡 5】抓出页面上所有"用户提问"，打包成数组。（最难的一个，放最后写）
   *
   * 入参：无
   * 返回：Array<{ order, key, text, el, turn }>；页面没有对话时返回 []
   *
   * ★ 契约（第 8 章明确下来的）：**每次调用都返回全新的数组和全新的对象。**
   *   所以调用方可以放心地往这些对象上加自己的字段（比如 content.js 加的
   *   `title` / `tooltip`），不会污染到下一个人拿到的结果。
   *   —— 反过来说：**谁都不许把这里的对象存起来当缓存**，它下一次就是新的了。
   */
  /**
   * 【内部小工具】从"一个单元"里读出**稳定身份** key。
   *
   * ⚠️ 为什么要抽成函数：第 8.5 章的 getMountedKeys() 也要读同一个东西。
   *    "同一个知识写两份"的代价不是多打几个字，而是**将来改一份忘一份** ——
   *    症状是"面板上的 key 和搜索用的 key 对不上"，两边各自看起来都正常。
   *
   * ⚠️ 实测（2026-09-28）两个属性长得很像，别拿错：
   *    · data-chatgpt-search-unit-key = "fallback-turn-2:0:user" —— **位置式**的，会随重排变
   *    · data-chatgpt-search-message-ids = "62847886-1aa2-..."    —— 真正的 message id
   *      它挂在**单元**那一层；在 turn 容器上读出来是 null，别在那取。
   *    （实测：它与接口返回的 message.id 完全一致 ——
   *      这正是"目录的 key"能和"接口的完整列表"对上号的唯一依据。）
   */
  function unitKey(unit, el) {
    const keyEl = el.closest('[data-chatgpt-search-message-ids]');
    let key = keyEl ? (keyEl.getAttribute('data-chatgpt-search-message-ids') || '') : '';
    if (!key) key = unit.getAttribute('data-message-id') || el.getAttribute('data-message-id') || '';
    return key;
  }

  /**
   * ★ 2026-09-30 十三补：这一条"消息单元"此刻**真的在渲染**吗？
   *
   * 症状（用户实测）：**切换会话**之后，右侧目录的条数比真实提问数多
   *   （真机实测：本会话真实 5 条，面板显示 14 条）。多出来的 9 条属于**上一个会话**。
   *
   * 根因：ChatGPT 的 SPA 切会话**不卸载旧会话的消息 DOM** —— 旧消息还在文档里，
   *   只是整棵子树不再渲染。真机实测（`tools/probes/p85-ghost-units.js`）：
   *     · 残骸：`getClientRects().length === 0`、`offsetParent === null`、`rect = 0x0`；
   *     · 真消息：三个值都正常（哪怕它滚在视口外很远，rect.top 是 -31230 也照样有盒子）。
   *   而且**结构上认不出来**：残骸的父链 class 与真消息一模一样，也没有
   *   `hidden` / `aria-hidden` / `inert` 之类的标记（`p86` 逐层爬到
   *   `div.flex.flex-col.gap-3` 那层就是"没有盒子"而已）。
   *   → 于是"页面上有几条"这个数字被旧会话的残骸灌大了。
   *
   *   ⚠️ 它还会**偷走高亮**：残骸的 rect 全是 0，`top(0) <= 锚线` 恒成立，
   *      第 7 章"取锚线之上最靠下的那条"于是选中了一条**看不见的残骸**
   *      —— 这就是"切会话后默认选中的不是这条会话的最后一条"的另一半原因。
   *
   * 判据：**没有盒子 = 没在渲染 = 它不是"页面上的提问"。**
   *   ⚠️ 量的必须是**消息单元本身**，不能往上找祖先：`display:contents` 的容器
   *      天然 `getClientRects().length === 0`（它不生成盒子，盒子由子元素生成），
   *      拿它当判据会把正常消息全部误杀。
   */
  function isRenderedUnit(node) {
    if (!node || typeof node.getClientRects !== "function") return true;  // 量不了 → 不妄下结论
    return node.getClientRects().length > 0;
  }

  /**
   * 丢掉"已经不在渲染"的残骸。
   *
   * ⚠️ **只在"确实量出了可见单元"时才过滤**（`alive.length` 非空）：
   *   jsdom 不排版，所有元素 `getClientRects()` 都是空数组 ——
   *   若无条件过滤，全部离线回归测试会被一次清空。
   *   一个都量不出来时，认为"这个环境量不了布局"，保持老行为（照单全收）。
   *   判据：**量不出来的时候不要下结论。**
   */
  function dropGhostUnits(nodes) {
    if (!nodes || !nodes.length) return nodes || [];
    const alive = nodes.filter(function (n) { return isRenderedUnit(jumpAnchor(n)); });
    const ghost = nodes.length - alive.length;
    if (ghost > 0 && alive.length > 0) {
      console.log("[CW] 抓取：丢弃 " + ghost + " 个未渲染的消息单元（上个会话的残骸）");
      return alive;
    }
    return nodes;
  }

  function getUserMessages() {
    // ── 1. 选选择器：逐个试，第一个"命中数 > 0"的候选就用它，后面不再试
    let nodes = null;
    for (const sel of USER_SELECTORS) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) { nodes = Array.from(found); break; }
    }
    // 全部命中 0（首页 / 空会话）→ 返回空数组，不抛错
    if (!nodes) return [];

    // ── 1.5 ★ 十三补：丢掉上个会话留在 DOM 里的残骸（见 dropGhostUnits 的判据说明）
    nodes = dropGhostUnits(nodes);

    const out = [];
    const seen = new Set();              // 去重：记下已经见过的 turn

    // ── 2. 按文档顺序遍历（就是屏幕从上到下的顺序，天然正确，不用排序）
    for (const unit of nodes) {
      // 每条先找气泡 —— "只挂附件、没打字"的那种没有气泡
      const bubble = unit.querySelector('[data-user-message-bubble]');

      // ── 3. el：读文字、闪一下用的节点
      //     ⚠️ el 是**气泡**（读文字 / 闪环挂在它上面）。
      //     **跳转时滚的不是它** —— 是 jumpAnchor(el)（整条消息，含气泡上方的药丸/卡片）。
      //     两者刻意分开：气泡是"用户读的那段文字"，整条消息是"这条消息在屏幕上的边界"。
      const el = bubble || unit;

      // ── 4. turn：包住"一问一答"整轮的容器（第 4 章滚动定位用它）
      //      closest 从元素自身开始找，所以候选必须逐个试
      let turn = null;
      for (const sel of TURN_SELECTORS) {
        const hit = el.closest(sel);
        if (hit) { turn = hit; break; }
      }
      if (!turn) turn = el;              // 兜底：找不到容器就先拿自己顶上

      // ── 5. 去重：同一个"轮"只留一条（判断依据用 turn，不是 el）
      if (seen.has(turn)) continue;
      seen.add(turn);

      // ── 6. key：跨重渲染稳定的身份（取法见上面的 unitKey）
      let key = unitKey(unit, el);
      if (!key) key = "turn-" + out.length;   // 最后兜底

      // ── 7. text：有气泡取正文；没气泡（只挂附件）直接给占位符
      //      ⚠️ 没气泡时别调 extractText —— 会拿到按钮的 UI 文案"1 个已选文本片段"
      const text = bubble ? extractText(bubble) : "[附件消息]";

      // ── 8. order：用"最终数组的长度"算，保证从 0 起连续、不跳号
      out.push({ order: out.length, key: key, text: text, el: el, turn: turn });
    }

    return out;
  }

  /**
   * 【第 8.5 章】页面上**此刻挂着的**提问单元，只要 key 和 el。
   *
   * 为什么不直接拿 getUserMessages()：
   *   那个函数会为每条消息抽一次 innerText —— 在动辄上万像素的长会话里
   *   这是一笔实打实的开销。而这个函数被 **搜索定位** 每 60ms 调用一次，
   *   只需要"谁在、谁能点"，一个字都不用读。
   *   判据：**热路径上的函数，只做它必须做的那一件事。**
   *
   * 返回：Array<{ key, el }>（文档顺序 = 屏幕从上到下）
   *   ⚠️ key 走兜底路径（"turn-N"）的条目在这里**直接丢掉** ——
   *      位置式的 key 没法跟完整列表对上号，留着只会误导方向判断。
   */
  function getMountedKeys() {
    let nodes = null;
    for (const sel of USER_SELECTORS) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) { nodes = Array.from(found); break; }
    }
    if (!nodes) return [];

    const out = [];
    const seen = new Set();
    for (const unit of nodes) {
      const bubble = unit.querySelector('[data-user-message-bubble]');
      const el = bubble || unit;
      const key = unitKey(unit, el);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ key: key, el: el });
    }
    return out;
  }

  /**
   * 【卡 1】从地址栏取出"这次会话的编号"，第 6 章拿它当存储分区键 cw:chat:<chatId>。
   */
  function getChatId() {
    const m = location.pathname.match(/\/c\/([^/?#]+)/);
    if (m) return m[1];                                   // /c/<id> 和 /g/g-xxx/c/<id> 都走这支
    return location.pathname.replace(/^\/+|\/+$/g, "");   // 兜底：去首尾斜杠（"/" 在这里自然变 ""）
  }

  /**
   * 【卡 4】回答"这个页面现在有没有真正的对话"。
   * 消费者：第 6 章用它决定"要不要渲染面板"（新会话不画，免得一个空卡片飘在输入框旁）。
   *
   * 入参：无
   * 返回：boolean
   *
   * 实现：getUserMessages().length > 0（外面包一层 try/catch）
   */
  function hasConversation() {
    // 判据 = "能不能抓到提问"，而不是"页面上有没有输入框"
    try {
      return getUserMessages().length > 0;
    } catch (e) {
      // 它决定"要不要画面板"：抛错会让面板整个不渲染，
      // 所以出错时宁可保守地当作"没有对话"
      return false;
    }
  }

  /**
   * 【卡 3】给一个节点，往上找出"真正在滚的那一层"。
   * 为什么需要它：第 0 章第 ④ 题 —— 滚动页面时 window.scrollY 一直是 0，
   * 说明滚的不是 window，而是页面里某个 <div> 自己在滚。
   *
   * 入参：el —— 一个 Element（一般传第一条提问的气泡 / 单元，或者它的 turn）
   * 返回：Element（真能滚的那层；找不到就兜底 scrollingElement || documentElement）
   */
  function getScrollContainer(el) {
    // 兜底值：一路找不到时返回它（实测是 <html class="chatgpt-theme">）
    function fallback() {
      return document.scrollingElement || document.documentElement;
    }

    // ── 0. 入参保护：null / 文本节点 / document 都不是"元素"
    //      实测：传 null、undefined、document、文本节点，四个都不抛错，全部走兜底
    if (!el || el.nodeType !== 1) return fallback();

    // ── 1. 第一段：便宜的路径 —— 直接问"你是不是那个已知容器"
    //      closest 从元素自身开始往祖先链上找，命中就是它
    const known = el.closest(".thread-scroll-container");
    if (known) {
      const oy = getComputedStyle(known).overflowY;
      // 光有 class 还不够，它必须真是个"可滚容器"才认
      if (oy === "auto" || oy === "scroll") return known;
    }

    // ── 2. 第二段：按物理性质往上爬（class 改名了这条也能活）
    const cands = [];                 // 先收集，不急着 return
    let n = el.parentElement;         // 从父节点起，不包含自己
    while (n && n !== document.body && n !== document.documentElement) {
      const oy = getComputedStyle(n).overflowY;
      // ⚠️ 必须是 === "auto" || === "scroll"，不能写 !== "visible"
      if (oy === "auto" || oy === "scroll") cands.push(n);
      n = n.parentElement;
    }

    // ── 3. 优先返回"真的在滚"的那个
    for (const c of cands) {
      if (c.scrollHeight > c.clientHeight) return c;
    }

    // ── 4. 一个都不滚（内容没超出的极短会话）→ 返回第一个合规的
    if (cands.length) return cands[0];

    // ── 5. 链上压根没有合规层 → 兜底
    return fallback();
  }

  /* ================================================================
   * 第 4 章 · 跳转
   * ================================================================ */

  // ── 跳转的"代"：每调一次 scrollTo 就 +1。
  //    任何异步的验收回调开工第一件事就是比对代号，对不上就立刻退出 ——
  //    这样"连点 3 次"时，只有最后一次的验收生效，前两次不会反过来把页面拽走。
  let jumpToken = 0;
  // ── 用户自己滚过吗？滚过就不再替他纠正（不能跟用户抢滚动条）
  let jumpUserMoved = false;
  // ── 用户滚动意图的监听只挂一次
  let jumpGuardArmed = false;

  /** 挂"用户自己滚了"的监听：只认**滚动意图**，不认点击 */
  function armUserScrollGuard() {
    if (jumpGuardArmed) return;
    jumpGuardArmed = true;
    const bail = function () { jumpUserMoved = true; };
    // 只监听"想滚动"的三类事件。刻意**不监听 pointerdown/click**：
    // 触发跳转的那次点击本身就是 pointerdown，会把标记立刻打脏。
    window.addEventListener("wheel", bail, { passive: true, capture: true });
    window.addEventListener("touchstart", bail, { passive: true, capture: true });
    window.addEventListener("keydown", bail, true);
  }

  /**
   * ★ 第 4 章 · 跳转的**锚点**：该把"哪一个元素"顶到视口最上面。
   *
   * 答案：**整条用户消息那一块**（`[data-chatgpt-search-unit-key$=":user"]`），
   * 而不是里面的**文字气泡**。两者只有在"气泡上方什么都没有"时才重合。
   *
   * ── 为什么（2026-09-30 用户实测反馈逼出来的）──
   *   子提问（选中一段回答、点「向 ChatGPT 提问」）在气泡**上方**还压着一行
   *   「1 个已选文本片段」的**药丸**。只把气泡顶到视口顶端，药丸就被顶到
   *   吸顶栏后面去了 —— 用户看到的是"跳到蓝色提示词上，看不出这条是从哪段话问的"。
   *   他要的是"选择片段的上面"，也就是**整条消息的顶边**。
   *
   * ── 真机实测（tools/probes/p80-subq-anchor.js / p81-unit-top-struct.js / p82-topper.js）──
   *   单元结构是 flex 竖排：`[顶部那一行] + [气泡行]`，顶部那行可以是
   *      · 选中片段药丸（子提问）    实测高 34px，加 8px 间距 → 气泡比单元顶边低 **42px**
   *      · 链接/附件卡片（普通消息） 实测高 60px，加 8px 间距 → 低 **68px**
   *      · 什么都没有                实测 `unit.top === bubble.top`（Δ=0）
   *   量到的第三种情况是关键：**没有顶部行时，"用单元"和"用气泡"是同一个位置**
   *   → 于是这条统一规则在普通消息上**自动退化成老行为**，不需要任何分支。
   *   吸顶栏实测高 52px：`气泡+start` 量到药丸 top=10 → 整片药丸被吸顶栏盖住（看不见）；
   *                    `单元+start` 量到药丸 top=52 → 正好贴在吸顶栏下方（图二的期望样子）。
   *
   * ── 兜底 ──
   *   选择器哪天失效（closest 找不到单元）→ **原样返回传入的 el**，
   *   也就是安静退回老行为，不会抛错、不会跳丢。判据：**新增的兜底永远只能"更弱"，不能"更错"。**
   *
   * 入参：el —— 气泡（或单元、或任何一个消息内部的节点），可为 null
   * 返回：Element —— 拿它去 scrollIntoView / 量 rect；入参无效时原样返回
   */
  function jumpAnchor(el) {
    if (!el || el.nodeType !== 1 || !el.closest) return el;
    return el.closest(MSG_UNIT_SELECTOR) || el;   // 找不到单元 = 老契约，退回气泡
  }

  /**
   * ★ 落位几何的判据线：目标**顶边**要落在视口这个比例以内 = "顶到顶端了"。
   *
   * 必须 ≤ content.js 里的 SCROLL_ANCHOR_RATIO（0.32）—— 两个数是一对：
   *   落位把目标顶边放在 [0, 0.32*vh] 里 → 第 7 章锚线规则算出的"当前项"
   *   就一定是**它自己**（详见 isLanded 的说明）。
   * ⚠️ 改这个数之前先看 tools/probes/p75-landing-geom.js 的实测。
   */
  const LAND_TOP_RATIO = 0.32;

  /**
   * 当前位置算不算"落好了"。
   *
   * ★ 2026-09-29 几何定案：跳转把目标**顶边贴到视口顶端**（`block:"start"`），
   *   所以"落好"的判据是「目标顶边落在视口上部（≤ 0.32*vh）」，不是"在视口正中"。
   *
   * 为什么从"居中"改成"顶端"（真机实测 tools/probes/p75-landing-geom.js，6 条消息）：
   *   第 7 章滚动同步的判据是「top <= 0.32*vh 的最靠下一条 = 当前项」。
   *   · 落位 center → 目标 top ≈ 0.5*vh（实测 308px）**在锚线(234px)之下**
   *     → 同步逻辑算出的"当前项"天然是**上一条**（实测 5/5 漂到上一条）；
   *   · 落位 start  → 目标 top ≈ 吸顶栏高度（实测 52px）**在锚线之上**
   *     → 锚线规则算出的正好是**它自己**（实测 5/5 一致）。
   *   ★ 一句话：**让落位几何服从锚线规则，而不是靠"点击锁"去掩盖两者的矛盾。**
   *
   * 入参：r    —— 目标元素的 rect（getBoundingClientRect 的结果）
   *       vh   —— 视口高度
   *       cont —— 滚动容器（可为 null；用来判"已经贴到滚动尽头"这个物理上限）
   */
  function isLanded(r, vh, cont) {
    if (!vh) return true;
    // 目标比视口还高（超长回答的气泡）：只要求它的顶边已经进入视口上部
    if (r.height > vh) return r.top <= vh * LAND_TOP_RATIO && r.bottom >= 0;
    // ★ 先判"完全可见" —— 这是底线要求，任何情况都不能让步
    const fullyVisible = r.top >= -2 && r.bottom <= vh + 2;
    if (!fullyVisible) return false;
    // ★ 边缘豁免（2026-09-28 第二轮返工加）：
    //   容器已经贴到滚动尽头时，"把目标顶到顶端"物理上做不到（下面没有内容可滚了）——
    //   如果还坚持要求顶端，isLanded 会**永远返回 false**，自愈层就会每次点击都白补
    //   2 次整屏重排，然后在 console 里 warn。这正是"点某几条特别卡"的一个隐藏来源。
    //   判据：已经贴在尽头 + 目标完全可见 = 这就是能达到的最好结果，算落位。
    if (cont) {
      const bottomLimit = -(cont.scrollHeight - cont.clientHeight);
      if (cont.scrollTop <= bottomLimit + 1 || cont.scrollTop >= -1) return true;
    }
    // 常规：目标顶边已经落在锚线及以上（与第 7 章的 SCROLL_ANCHOR_RATIO 对齐）
    return r.top <= vh * LAND_TOP_RATIO;
  }

  /**
   * 跳转之后的**验收 + 自愈**。
   *
   * 为什么必须有这一层（第 4 章实测逼出来的）：
   *   长距离 smooth 会**间歇性失效** —— 压力测试（tools/probes/p32-jump-stress.js）
   *   5 次长跳里有 1 次跑满了 1.8 秒，却停在距目标 39223px 的地方，
   *   用户看到的就是"点了没反应"。这类中止没有稳定复现路径
   *   （用户一滚轮、页面一重排、动画被别的滚动顶掉，都可能触发）。
   *
   *   与其去追每一种中止原因，不如**不信任动画**：
   *   跳完过一会儿回头看，没到位就用瞬时滚动硬修一次，最多修 2 次。
   *   于是"失灵"在结构上不可能发生。
   *
   * ⚠️ 2026-09-28 第二轮返工重写了实现（起因：用户反馈"还是卡"）：
   *   旧版**每 160ms 读一次 `el.getBoundingClientRect()`** 来判断"它还在动吗"。
   *   但读 rect 会**强制浏览器重新布局** —— 在一个 3~12 万像素高的滚动容器里，
   *   这等于在平滑动画进行中反复打断它，正是"越修越卡"。
   *   新版改成：**先只读 `scrollTop`（便宜、不强制布局）等滚动自己停下来，
   *   静止之后才读一次 rect 做判定。** 动画期间一次布局都不强制。
   *
   * 入参：token    —— 跳转的"代"（对不上就说明这次验收已过时）
   *       target   —— 目标元素。★ 传的是 jumpAnchor() 算出来的**锚点**（整条消息），
   *                  不是气泡 —— 否则"落好了没有"和"该滚到哪"会跟 scrollTo 不一致。
   *       triesLeft —— 还能硬修几次
   *       cont     —— 滚动容器（readWindow 用；可为 null）
   *
   * 两个必须的退出条件：
   *   ① 代号变了 → 用户又点了别的条目，这次验收已经过时
   *   ② 用户自己滚过 → 不能跟用户抢滚动条
   */
  function verifyLater(token, target, triesLeft, cont) {
    const POLL_MS = 120;
    const SETTLE_SAMPLES = 3;   // 连续 3 次 scrollTop 不变 → 认为滚动停了
    const MAX_WAIT_MS = 1600;
    let waited = 0;
    let still = 0;
    let lastTop = null;

    function step() {
      if (token !== jumpToken || jumpUserMoved) return;
      if (!target || !target.isConnected) return;

      // ── ① 便宜的一步：只看 scrollTop，不读 rect（读 rect 会强制布局）──
      const top = cont ? cont.scrollTop : null;
      if (top !== null && lastTop !== null && Math.abs(top - lastTop) < 0.5) still++;
      else still = 0;
      lastTop = top;
      waited += POLL_MS;

      // 还在动 → 继续等（**绝不在动画中途下结论**，也绝不在动画中途强制布局）
      if (still < SETTLE_SAMPLES && waited < MAX_WAIT_MS) {
        setTimeout(step, POLL_MS);
        return;
      }

      // ── ② 滚动停了，这时才读 rect 做判定 ──
      const vh = window.innerHeight;
      if (isLanded(target.getBoundingClientRect(), vh, cont)) return;   // ✔ 落位

      if (triesLeft <= 0) {
        console.warn("[CW] 跳转未能落到目标（已重试到上限）");
        return;
      }
      // 不动了、又没到位 → 用瞬时滚动硬修一次（几何与 scrollTo 一致：顶到顶端）
      target.scrollIntoView({ block: "start", behavior: "instant" });
      lastTop = null; still = 0; waited = 0;
      verifyLater(token, target, triesLeft - 1, cont);
    }

    // 先给 smooth 一点起步时间再开始观察
    setTimeout(step, 200);
  }

  /**
   * 【第 4 章】把某个元素滚到**视口顶端**（点目录跳转用它）。
   *
   * ── 为什么用 scrollIntoView，而不是自己算 container.scrollTop ──
   * ChatGPT 的滚动容器是 `flex-direction: column-reverse`（实测：Chrome 154，
   * div.thread-scroll-container）。它的滚动轴是**反的**：
   *     scrollTop === 0  意思是"在**底部**"，不是"在顶部"
   *     往上滚要写**负数**，合法区间是 [-(scrollHeight-clientHeight), 0]
   * scrollIntoView 是浏览器自己算的**相对位移**，不关心轴朝哪边，跨改版更稳。
   *
   * ── 为什么滚 el（气泡），而不是 turn（整轮）──
   * 三个方案在真页面各跑一遍（tools/probes/p27-scroll-methods.js，5 条消息）：
   *     气泡   + block:"center"  → 5/5 完全可见
   *     轮容器 + block:"start"   → 5/5 完全可见，但气泡贴在最上沿
   *     轮容器 + block:"center"  → **0/5 完全可见** ✗
   * 最后一行是个很值得记住的陷阱：一整轮的高度可能是视口的 **18 倍**。
   * "把一个 12000px 高的东西居中" = 把它的**中点**对到视口中点 =
   * 提问被推到视口上方 -5640px 处，恰好完全看不见。
   * **目标元素比视口大得多的时候，`block:"center"` 不能用。**
   * → 结论：**永远在气泡上滚，不动轮容器**。
   *
   * ── 为什么是 block:"start"（顶端），不是 block:"center"（居中）──
   * ★ 2026-09-29 定案（真机实测 tools/probes/p75-landing-geom.js，6 条消息）。
   *   这**不是审美选择，是几何一致性要求**：
   *     · 第 7 章滚动同步的判据 = 「top <= 0.32*vh 的最靠下一条 = 当前项」；
   *     · 落位 center → 目标 top ≈ 0.5*vh（实测 308px），**在锚线(234px)之下**
   *       → 同步逻辑算出的"当前项"天然是**上一条**（实测 5/5 漂到上一条）；
   *     · 落位 start  → 目标 top ≈ 吸顶栏高度（实测 52px），**在锚线之上**
   *       → 锚线规则算出的正好是**它自己**（实测 5/5 一致）。
   *   于是"点了 A 却高亮 B"在几何上就不成立了 —— 不必再靠"点击锁"去掩盖矛盾
   *   （锁仍然保留，但它挡的是落位动画期间/之后的竞态，不再是唯一防线）。
   *
   * ── ⚠️ 为什么不能"一路 smooth 滑过去"（2026-09-28 实测，本轮改动的起因）──
   * 用户反馈"跳转很卡、还会失灵"。实测数据（tools/probes/p31-jump-perf2.js）：
   *
   *   方案                       时长     丢帧(>33ms)  最长帧间隔
   *   全程 smooth（改前）        1733ms       7          360ms
   *   instant                    367ms        1          180ms
   *   两段式（改后）              400ms        1          190ms
   *
   * 原因很朴素：这个会话的滚动容器 **scrollHeight = 121241px**，
   * 而视口只有 682px —— 一次跳转要跨越 **177 个视口高**。
   * 让动画"一帧一帧地"经过这 12 万像素，浏览器每帧都在重绘这个巨型容器，
   * 于是掉帧、长任务（实测单帧最长 403ms 的同步长任务）。
   *
   * 解法：**把动画距离钉死在一个视口以内**。
   *   ① 先用 instant 一步**精确到位**（同步，只付一次布局代价）
   *   ② 看这次真实走了多少（读 scrollTop 的前后差，不猜方向）
   *   ③ 如果走得很远，就**倒回去一小段**，让最后的 smooth 只负责这一小段
   *   → 无论目标多远，"会动的部分"永远是同一个量级，耗时和掉帧都不再随距离增长。
   *
   * 入参：el       —— 目标元素（一条提问的气泡/单元），可能为 null 或已游离
   *       behavior —— 省略 = 自动（远距离走"瞬移 + 短滑"，近距离直接 smooth）
   *                   "instant" = 完全不动画，**验收探针必须用这个**
   * 返回：boolean —— 是否真的发出了滚动（false = 目标无效）
   *
   * ★★ 2026-09-30：**滚的是 jumpAnchor(el)，不是 el 本身** ——
   *    传进来的是气泡，但真正被顶到视口顶端的必须是"整条消息"（含气泡上方的
   *    选中片段药丸/附件卡片）。理由与实测见 jumpAnchor() 上面的长注释。
   *    调用方不用改：只管把气泡传进来，锚点在这里统一算。
   *
   * ⚠️ 为什么验收必须传 "instant"：
   *    smooth 由 requestAnimationFrame 驱动，而**隐藏标签页的 rAF 会被完全挂起**。
   *    实测（tools/probes/p28-smooth-in-bg.js）：hidden=true 时 2.5 秒内 rAF 只触发 1 次，
   *    气泡位置从头到尾停在 -26730 **一动不动**。
   *    拿 smooth 做断言，在后台标签页上就是 100% 的假失败。
   *    （新代码里 verifyLater 会把这种情况兜住 —— 但它有自己的延迟，
   *      探针不该去等它，直接传 "instant" 最干净。）
   */
  function scrollTo(el, behavior) {
    // ── 入参保护：游离节点滚不了。
    //    页面重渲染会把旧节点摘下来，此时 getBoundingClientRect() 全是 0、
    //    滚它也毫无效果 —— 必须问 isConnected。
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;

    // ★ 锚点 = 整条用户消息（含"选中片段"药丸/附件卡片），不是气泡本身。见 jumpAnchor()。
    const target = jumpAnchor(el);
    if (!target || target.nodeType !== 1 || !target.isConnected) return false;

    const instant = behavior === "instant";
    const vh = window.innerHeight || 0;
    const token = ++jumpToken;          // 作废上一次的验收（连点时的关键）
    jumpUserMoved = false;
    armUserScrollGuard();

    const cont = getScrollContainer(el);

    // ── 已经在好位置就别动它。
    //    实测过"点了抖一下"：目标本来就完全可见、还大致居中时，
    //    再滚一次纯属多余（而且会打断用户正在读的那一段）。
    if (!instant && isLanded(target.getBoundingClientRect(), vh, cont)) return true;

    // ★ 隐藏标签页的 rAF 被完全挂起 → `behavior:"smooth"` 一步都不会动
    //   （实测 2.5 秒内 rAF 只触发 1 次）。这时走两段式纯属白干：
    //   倒回去之后动画不开始，白付一次重排，然后还要等自愈层把它修回来。
    //   所以**只在"能动画"的时候才做动画**，隐藏时直接瞬时到位。
    const canAnimate = !document.hidden;

    const st0 = cont ? cont.scrollTop : 0;

    // ── ① 瞬时精确到位（同步完成，读得到最终位置）──
    //    ★ block:"start" = 目标顶边贴视口顶端（见 isLanded 的几何说明），
    //      不是居中：居中会让锚线规则算出"上一条"。
    try {
      target.scrollIntoView({ block: "start", behavior: "instant" });
    } catch (e) {
      target.scrollIntoView();              // 只认无参版本的老实现
    }

    if (!instant && cont && canAnimate) {
      // ── ② 走了多远？读出来的，不是算出来的 ──
      //    为什么不去算"该走多少"：容器是 column-reverse，符号关系反直觉；
      //    而 scrollIntoView 已经替我们算好了，前减后就是它真实走的值。
      const moved = cont.scrollTop - st0;

      // ── ③ 距离太远就倒回去一截，把 smooth 的动画距离钉在上限内 ──
      //    GLIDE_MAX 取 ~0.7 个视口：短到不卡（实测 400ms / 1 丢帧），
      //    又长到人眼能看出"它在移动"。
      const GLIDE_MAX = Math.max(160, Math.min(vh * 0.7, 480));
      if (Math.abs(moved) > GLIDE_MAX) {
        const back = cont.scrollTop - Math.sign(moved) * GLIDE_MAX;
        try {
          cont.scrollTo({ top: back, behavior: "instant" });
        } catch (e) {
          cont.scrollTop = back;         // 老实现兜底
        }
        try {
          target.scrollIntoView({ block: "start", behavior: "smooth" });
        } catch (e) {
          target.scrollIntoView();
        }
      }
    }

    // ── ④ 无论走哪条路，最后都验一次收 ──
    //    到位的（比如 instant 跳转）这里会静默通过，不会有多余动作。
    verifyLater(token, target, 2, cont);
    return true;
  }

  /* ================================================================
   * 第 8.5 章 · 把"还没挂载"的那一条搜出来（reveal）
   *
   * 背景（2026-09-28 真机实测）：会话里有 13 条提问，DOM 只挂 6 条 ——
   * 是完整列表里**连续的一段窗口**，而且随滚动平移。于是"点目录里第 3 条"
   * 这件事有两种情况：
   *   · 它正挂在那儿 → 老路径（scrollTo 直接过去）
   *   · 它已经被卸载了 → 整段代码里根本没有它的节点，无从下手
   *
   * 这个函数解决第二种：**把页面滚到"那一条被挂载出来"为止**。
   *
   * ★ 定位思路（第二版，2026-09-28 被实测推翻过一版，过程记在下面）：
   *
   *   **第一版（错）**：把 scrollTop 当数轴、消息占 1/N 的高度，按比例猜 + 二分。
   *     错误的原因只有一个，但致命：**scrollHeight 不是常数** ——
   *     实测底部只挂 5 条时容器高 61054，往上滚、挂出更多条之后变成 **73620**。
   *     也就是说"内容的长度"会随着挂载本身变化，坐标系每步都在动。
   *     于是按比例算出来的 -58087 实际只落到窗口 3..7，之后每步只挪几百像素，
   *     窗口纹丝不动，六步白跑。
   *     → 判据：**用"全局比例"推坐标，前提是那个全局量是恒定的；先量它是不是恒定。**
   *
   *   **第二版（现在这版）**：只用**眼前这段已挂载内容的局部几何**，每步重新量。
   *     ① 当前挂载窗口在完整列表里是**连续**的一段 [a, b]（实测永远是连续的）
   *     ② 用窗口里首尾两条的真实像素差，算出"这一段里一条平均多少像素"：
   *          pxPer = (最后一条的 top − 第一条的 top) / (b − a)
   *     ③ 目标离窗口有 dist 条 → 一阶估计要挪 dist × pxPer 像素
   *     ④ 至少有半个视口的保底步长（否则可能原地不动、永远挂不出新内容）
   *     ⑤ 方向不对/跨过去了 → 下一把把步子收小（gain × 0.4）；原地不动 → 步子放大（×2.5）
   *
   *   这套的好处：**它只依赖"刚刚亲眼看到的像素"，不依赖任何全局假设**，
   *   所以容器高度怎么变都不影响它 —— 每一步都在重新测量。
   *   判据：**能自校正的近似，胜过看起来精确的假设。**
   *
   * ★ 为什么敢直接写 scrollTop（第 4 章明明说过"绝不手算 scrollTop"）：
   *   第 4 章那条纪律针对的是**瞄准**（算出一个精确落点）；
   *   这里是**步进搜索** —— 每次写入只是"往那个方向挪一挪"，
   *   落点对不对由**下一轮读到的窗口**裁决，写过头会被浏览器自动夹紧。
   *   判据：**用坐标当探针可以，用坐标当结论不行。**
   * ================================================================ */

  /** 搜索定位的节奏：单步最多等多久、最多搜几步 */
  const REVEAL_POLL_MS = 60;     // 轮询间隔（只读属性，不抽文本，很便宜）
  const REVEAL_WAIT_MS = 900;    // 单步最多等挂载多久（实测 128~656ms）
  const REVEAL_MAX_TRIES = 8;    // 长会话里跨很多屏也够用

  /**
   * 把某一条"还没挂载"的提问滚出来。
   *
   * 入参：key     —— 目标的稳定身份（message id）
   *      order   —— **按真实顺序排好的完整列表**（[{ key }] 就够，用它算序号）
   *      onStep  —— 可选；每一步动手之前调一次（调用方用它续"当前项"的锁）
   * 返回：Promise<Element|null> —— 找到的节点；null = 搜遍了也拿不到
   *
   * ⚠️ 找不到时**返回 null，不抛错**：调用方（content.js）要如实告诉用户
   *    "这条没滚出来"，而不是假装成功。判据：**失败必须能被上层看见。**
   */
  /** ★ 第 11 章回归修复（添加子提问后"跳转错乱"的根因）：
   *   reveal 把"序号"当成**滚动坐标**（序号 ↔ scrollTop 线性内插，见 secant）。
   *   这个坐标必须与"页面从上到下的时间序"一致；不能是"目录里的显示顺序"。
   *   arrangeUnderParent 会把子提问挪到父项正下方，于是"显示顺序的下标"
   *   ≠"时间序下标"—— 用显示顺序当坐标，点一条还没挂载的子提问，
   *   步进搜索会把页面滚到完全错误的位置。
   *   正解：优先用每条自带的 order（时间序坐标，merge 里定好的），
   *   没有再退回数组下标。 */
  function coordOf(m, i) {
    if (m && m.chrono != null) return m.chrono;
    if (m && m.order != null) return m.order;
    return i;
  }

  async function reveal(key, order, onStep) {
    const list = order || [];
    const table = new Map();
    list.forEach(function (m, i) { table.set(m.key, coordOf(m, i)); });
    const target = table.get(key);
    if (target === undefined || target === null) return null;

    const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    const mountedEl = function () {
      const hit = getMountedKeys().find(function (d) { return d.key === key; });
      return hit && hit.el.isConnected ? hit.el : null;
    };

    // ── 0. 已经挂着了就别折腾（绝大多数点击走这条）
    const immediate = mountedEl();
    if (immediate) return immediate;

    // ── 1. 准备工作：容器 + 视口高度
    const mounted0 = getMountedKeys();
    if (!mounted0.length) return null;              // 一条都没挂，连方向都判不出来
    const cont = getScrollContainer(mounted0[0].el);
    if (!(cont.scrollHeight - cont.clientHeight > 0)) return null;   // 内容不超一屏，没什么可滚
    const vh = window.innerHeight || 600;

    /**
     * 量一次"当前挂载窗口"：它在完整列表里的序号区间 + 局部像素密度。
     * 返回 null = 窗口里一条都对不上号（拿不到方向）。
     */
    function readWindow() {
      const arr = getMountedKeys();
      const idx = [];
      const els = [];
      for (const d of arr) {
        const v = table.get(d.key);
        if (v !== undefined) { idx.push(v); els.push(d.el); }
      }
      if (!idx.length) return null;

      let iFirst = 0, iLast = 0;
      for (let i = 1; i < idx.length; i++) {
        if (idx[i] < idx[iFirst]) iFirst = i;
        if (idx[i] > idx[iLast]) iLast = i;
      }
      const a = idx[iFirst], b = idx[iLast];

      // 局部像素密度：窗口首尾两条在屏幕上的真实距离 ÷ 它们之间隔了几条
      let pxPer = vh;
      if (b > a) {
        const rFirst = els[iFirst].getBoundingClientRect();
        const rLast = els[iLast].getBoundingClientRect();
        const gap = rLast.top - rFirst.top;
        if (gap > 0) pxPer = gap / (b - a);
      }
      return {
        a: a, b: b, pxPer: pxPer,
        sig: arr.map(function (d) { return d.key; }).join("|"),
        st: cont.scrollTop
      };
    }

    /** 等"窗口换人"或"目标出现"；最多 ms 毫秒 */
    async function waitChange(prevSig, ms) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        await sleep(REVEAL_POLL_MS);
        const el = mountedEl();
        if (el) return { el: el, win: null };
        if (Date.now() - t0 >= REVEAL_POLL_MS * 2) {
          const w = readWindow();
          if (w && w.sig !== prevSig) return { el: null, win: w };
        }
      }
      return { el: null, win: readWindow() };
    }

    let win = readWindow();
    if (!win) return null;

    // ── 搜索状态
    //    tooOld / tooNew：分别记下"窗口比目标旧"和"窗口比目标新"的一次观测。
    //    两边都有了 = 目标被**夹住**了，这一步之后剩下的只是内插。
    let tooOld = null;
    let tooNew = null;
    const minStep = vh * 0.5;      // 保底步长：太小可能原地不动，一整轮白等
    const clampSt = function (v) {
      const sp = cont.scrollHeight - cont.clientHeight;
      return Math.min(0, Math.max(-sp, v));
    };

    for (let tries = 1; tries <= REVEAL_MAX_TRIES; tries++) {
      if (typeof onStep === "function") onStep(tries);

      // 序号已经落在窗口区间里 → 它没理由不在（窗口是连续的），再确认一次
      if (win.a <= target && target <= win.b) {
        const el = mountedEl();
        if (el) return el;
      }

      const dir = (target > win.b) ? 1 : -1;      // +1 = 目标更新（scrollTop 往 0 走），-1 = 更旧
      if (dir > 0) tooOld = { st: win.st, b: win.b };
      else tooNew = { st: win.st, a: win.a };

      const span = cont.scrollHeight - cont.clientHeight;
      let stNext = null;

      if (tooOld && tooNew) {
        // ── ① 已经夹住了 → 割线内插（假位法）
        //    把"序号 ↔ scrollTop"这一段当成线性的：b 随 scrollTop 单调增，
        //    于是过两个观测点画一条直线，就能直接算出"b = target 时 scrollTop 该是多少"。
        //    它比二分快得多，而且**天然不会乱跑**（永远落在两个观测点之间）。
        const db = tooNew.b - tooOld.b;
        if (db > 0 && tooNew.st !== tooOld.st) {
          stNext = tooOld.st + (target - tooOld.b) * (tooNew.st - tooOld.st) / db;
        }
      }

      if (stNext === null) {
        // ── ② 只有单边 → 一阶估计：一条提问平均占多少像素
        //
        //    ★★ 基准要用**全局平均**（可滚高度 ÷ 总条数），不能只用窗口里那几段的局部密度。
        //    为什么（2026-09-28 实测）：窗口停在底部时，那几条提问都很短，
        //    局部密度算出"一条才几百像素"，于是每一步只挪几千像素 ——
        //    要横跨六万多像素就得走十几步，实测**点一次等 3.2 秒**。
        //    换成全局平均后同一场景一步到位。
        //    判据：**估距离时，用"整体平均"起步、用"局部测量"修正，别反过来。**
        const unit = Math.max(span / Math.max(1, list.length), win.pxPer);
        const dist = dir > 0 ? (target - win.b) : (win.a - target);
        stNext = win.st + dir * Math.max(dist * unit, minStep);
      }

      // ── ③ 保底步长：内插出来"挪一小步"时，如果两步之内就到不了，
      //      会一直原地打转（一进一出各等 900ms）。所以只要挪得太少，就按保底步长走。
      if (Math.abs(stNext - win.st) < minStep * 0.5) stNext = win.st + dir * minStep;

      cont.scrollTop = clampSt(stNext);          // 写下探点（越界会被自动夹紧）

      const r = await waitChange(win.sig, REVEAL_WAIT_MS);
      if (r.el && r.el.isConnected) return r.el;
      if (!r.win) return null;
      win = r.win;
    }
    return null;
  }

  /* ================================================================
   * 第 5 章 · 脉冲高亮
   *
   * 目标：跳过去之后，目标那条**气泡**闪一圈蓝边 + 淡蓝底，约 1.8 秒后自己消失。
   *
   * 为什么这一章值得单独写（每一条都由实测逼出来，别按直觉写）：
   *   ① 闪的是**气泡 el**，不是整轮 turn —— turn 是 el 的 12~195 倍高
   *      （实测最高 19082px vs 气泡 98px），闪它只能看到两条不知在哪里的竖线。
   *   ② ★ 环挂在 **body** 上，不挂在气泡里（2026-09-28 性能返工改的）。
   *      旧版挂进气泡，能白拿 overflow 裁剪和 border-radius:inherit；
   *      但气泡埋在 74000px 高的虚拟滚动容器里，插一个节点 = 整篇重排 76ms
   *      （实测见下面 flash 上方那段表）。改挂 body 后 4ms。
   *   ③ 环的颜色**只能写死**，不能写 var(--cw-accent) ——
   *      那个变量定义在 #cw-root 上，而环挂在 body 上，不在 #cw-root 里，取不到。
   *
   * ⚠️ 旧版还有一条实测结论现在**已作废**（别照抄）：
   *      "环的 inset 不能为负，因为气泡 overflow:hidden 会把负的边裁掉"。
   *      那是"环挂在气泡里"才有的约束。现在环在 body 上，页面怎么裁都裁不到它。
   * ================================================================ */

  // 正在闪的那一个环的全部信息；null = 现在没有环。
  // 用**一个**变量记住"当前这一轮"，是为了让"连点"和"换目标"都能被正确处理：
  // 新的一轮开工第一件事就是把旧的收干净。
  let flashState = null;

  /**
   * ★★ 2026-09-28 性能返工（起因：用户实测反馈"高亮的响应速度太慢"）
   *
   * 旧版把环 `el.appendChild(ring)` 挂进**页面气泡**里，好处是能白拿
   * 气泡的 `overflow:hidden` 裁剪和 `border-radius: inherit`。代价直到这次才量出来：
   *
   *   tools/probes/p68-insert-cost.js（真 Chrome 154，容器 scrollHeight 74326px）
   *     插入位置                    插完到"下一帧"要等
   *     什么都不插（基线）              11.6ms
   *     ★ 插进页面气泡（旧实现）        76.1ms   ← 每次点击白付 ~65ms
   *     插进 #cw-root                  16.9ms
   *     ★ 插进 body（新实现）            4.1ms
   *
   *   为什么插进气泡这么贵：气泡深埋在 74000px 高的虚拟滚动容器里（实测第 39 层），
   *   往它身上插一个节点会让整篇文档布局失效 —— 那一帧要重排 74k 像素的内容。
   *   而且 p67 证明"把 rect 读取推迟到下一帧"**救不了**（到下一帧仍是 76.9ms）：
   *   布局反正要算，推迟只是换个地方付钱。**唯一的解法是别插进那个容器。**
   *
   * 新实现：环改成挂在 `document.body` 上的 `position: fixed` 覆盖层，
   *   按目标气泡的**视口矩形**定位，并在存活期每帧跟随（跳转动画 / 用户滚动时都不脱位）。
   *
   * 顺带消掉的三样复杂度（都是第 5 章最容易出错的地方）：
   *   · 不再给宿主打 `position: relative` 补丁 → 没有"style 属性逐字符还原"这件事
   *   · 不再需要 `border-radius: inherit`（圆角改成读一次写死）
   *   · "闪完之后页面 HTML 一个字符都没变"从"要小心维护"变成**结构上不可能违反**
   */

  /**
   * 按宿主的当前位置摆放环；已经离开视口就把环藏起来（别让它飘到别的地方）。
   *
   * ⚠️ 只写 `transform` / `width` / `height`，**不读不写任何会牵动页面布局的东西**。
   *    尺寸只在真的变了才写（写 width/height 会让这个 fixed 元素自己重排，虽然便宜）。
   */
  function placeRing(s) {
    const el = s.host;
    if (!el || !el.isConnected) { s.ring.style.display = "none"; return; }

    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;

    // 完全滚出视口 → 收起来。跳转动画途中目标还在屏外时，这一段是常态。
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || !r.width || !r.height) {
      s.ring.style.display = "none";
      return;
    }
    s.ring.style.display = "";

    if (Math.abs(r.width - s.w) > 0.5 || Math.abs(r.height - s.h) > 0.5) {
      s.w = r.width; s.h = r.height;
      s.ring.style.width = r.width + "px";
      s.ring.style.height = r.height + "px";
    }
    // 位移只走 transform —— 合成层属性，不参与布局，每帧写都不心疼
    const x = Math.round(r.left), y = Math.round(r.top);
    if (x !== s.x || y !== s.y) {
      s.x = x; s.y = y;
      s.ring.style.transform = "translate3d(" + x + "px," + y + "px,0)";
    }
  }

  /** 存活期里每帧跟随一次（跳转是平滑滚动，不跟就会"环留在原地"） */
  function trackRing(s) {
    if (flashState !== s) return;
    placeRing(s);
    s.raf = requestAnimationFrame(function () { s.raf = 0; trackRing(s); });
  }

  /**
   * 把"当前这一轮高亮"彻底收干净。
   *
   * 幂等：没有环的时候调用，什么都不做（所以可以在任何地方放心调）。
   */
  function endFlash() {
    const s = flashState;
    if (!s) return;

    // ★ 先清空"当前这一轮"的登记，再动手收尾。
    //   顺序反了的话：清理过程中若有别的一轮进来（连点），
    //   它会被这个正在收尾的旧轮次误伤（症状："环闪一半突然没了"）。
    flashState = null;

    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.tOut);
    clearTimeout(s.tRemove);

    // 只删"我自己加的那个节点"（现在它挂在 body 上，页面里本来什么都没有）
    if (s.ring.parentNode) s.ring.parentNode.removeChild(s.ring);
  }

  /**
   * 【第 5 章】在目标元素上闪一圈高亮，约 1.8 秒后自己消失。
   *
   * 入参：el —— 目标元素（**气泡**，不是整轮容器），可能为 null / 已游离
   * 返回：boolean —— 是否真的挂上了环（false = 目标无效）
   *
   * ⚠️ 隐藏标签页里 rAF 被完全挂起（第 4 章同款环境问题）：
   *    此时环会"挂上但永远不亮"，也不会跟随。这不是代码 bug，切到前台即正常。
   */
  function flash(el) {
    // ── 入参保护：游离节点挂不了环（挂了也没人看得见，还留一地残骸）
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;

    // ── 先收干净上一轮：连点 5 次也只会留 1 个环
    endFlash();
    // ★ 第 13 章：两套高亮（整条消息的环 / 一段文字的碎片盒子）**不同时存在**。
    //   它们都挂在 body 上、都靠"读矩形 → 摆盒子"活着；同时开着会互相盖住，
    //   用户看到的是两团叠在一起的光斑。所以开新之前先把另一种收掉。
    flashCleanup();

    // ── ★★ 先把几何**读完**，再去动 DOM。
    //   顺序不能反：往里插东西会把布局弄脏，之后任何一次 rect 读取都会
    //   "强制同步布局"（实测这一下能到 70ms）。先读后写，读取就是免费的。
    const r = el.getBoundingClientRect();
    const br = getComputedStyle(el).borderRadius;   // 圆角跟着气泡走（读一次就够）

    // ── 造环、挂到 **body** 上（不是气泡里！原因见本节开头那段实测）
    const ring = document.createElement("div");
    ring.className = "cw-flash-ring";
    if (br && br !== "0px") ring.style.borderRadius = br;
    ring.style.width = r.width + "px";
    ring.style.height = r.height + "px";
    ring.style.transform = "translate3d(" + Math.round(r.left) + "px," + Math.round(r.top) + "px,0)";
    document.body.appendChild(ring);

    const s = {
      ring: ring, host: el,
      w: r.width, h: r.height, x: Math.round(r.left), y: Math.round(r.top),
      raf: 0, tOut: 0, tRemove: 0
    };
    flashState = s;

    trackRing(s);

    // ── 下一帧再加 --on。
    //    不隔一帧的话，浏览器"第一次渲染就是 opacity:1"，transition 根本不会播。
    //    ⚠️ 回调里先确认"还是我这一轮"，免得被后来者抢了还去动它。
    requestAnimationFrame(function () {
      if (flashState === s) ring.classList.add("cw-flash-ring--on");
    });

    // ── 1.4s 淡出（CSS transition 0.22s）→ 再等 0.4s 让过渡走完才摘节点
    s.tOut = setTimeout(function () {
      ring.classList.add("cw-flash-ring--out");
      s.tRemove = setTimeout(function () {
        if (flashState === s) endFlash();
      }, 400);
    }, 1400);

    return true;
  }

  /* ================================================================
   * 【第 13 章】「回到刚才」的落点 —— 精确到"段"，不是"条"
   * ================================================================
   *
   * 需求：子提问（= 在父提问的**回答里选中一段话**再追问）顶部有一个
   *   「← 回到刚才」，点了要**精确回到父提问回答里的那一小段原文**，并高亮它。
   *
   * 为什么"跳到父提问那一条"不算完成：
   *   父提问的回答可以很长（本次真机实测：这一轮 8543 字、2050px 高，滚 1.7 万像素）。
   *   把整条消息顶到屏幕顶端，用户看到的是回答的**开头**，看不到他当初选的那句话 ——
   *   而他要的正是"刚才那个地方"。
   *   ★ 判据：**返回点必须精确到"段"，不是"条"。**
   *
   * ★★ 匹配算法的关键取舍（真机取证，别按直觉写）：
   *   直觉写法是"把这一轮的文本全拼起来，找选中文这个子串"。**实测会失败**：
   *   选中文来自一张表格时，原文里的分隔是制表符 `\t`（`innerText` 视角），
   *   而 `textContent` 把各单元格的文本节点**首尾直接相连、中间一个字符都没有** ——
   *   于是 `"Graph Navigator\t图谱…"` 在拼接串里变成 `"Graph Navigator图谱…"`，对不上。
   *   → 正解：**两边都去掉全部空白再比**（见 stripWsWithMap）。
   *     选中文是"用户眼睛看到的一段"，DOM 是"浏览器排出来的一堆盒子"，
   *     两者之间**只有非空白字符的顺序是可靠的**。
   *
   * ★ 为什么优先只看「回答区」：
   *   被选中的文字通常出自**回答**；而同一句话完全可能也出现在用户自己的提问里（更靠前）
   *   → 会先被匹配到，指错地方。所以默认只搜"轮容器里**不在** user 单元内部的文本"，
   *   找不到再放开到整轮（选中文也可能出自用户自己的提问，第 11 章实测过）。
   *
   * ★ 降级链（搜索必须有上界，而且要**越搜越弱**）：
   *   原文全长 → 前 24 字 → 前 12 字 → 前 6 字。全失败返回 null（调用方退回"闪父提问气泡"
   *   并如实打日志），**绝不抛错**。
   * ================================================================ */

  /** 选中文短于这个长度就不去定位 —— 太短会满篇乱命中（与第 11 章"文本出处"判据同口径） */
  const MIN_FRAGMENT = 4;

  /**
   * 从一个节点往上找它所属的「轮」容器。
   *
   * ⚠️ 第 13 章新加这个函数，是因为要**反复**问"这段文字属于哪一轮"
   *    （findFragment 里、探针里、落位复核里都要问）。第 2 章那段是内联的，
   *    这里提成函数，TURN_SELECTORS 只留一份。
   */
  function turnOf(el) {
    if (!el) return null;
    for (const sel of TURN_SELECTORS) {
      const hit = el.closest ? el.closest(sel) : null;
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 收集锚点所在"轮"里、符合模式的文本节点，并记下每个节点在拼接串中的起点。
   * @param {Element} turnEl
   * @param {"assistant"|"user"|"any"} mode
   */
  function textSegments(turnEl, mode) {
    const segs = [];
    let total = 0;
    if (!turnEl || !turnEl.ownerDocument) return segs;
    const walker = turnEl.ownerDocument.createTreeWalker(turnEl, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        // 纯空白节点没有意义（它们只会把下标算乱）
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        // 按钮文案（复制 / 朗读 / 展开）不是"回答正文"，混进来会指错地方
        if (p && p.closest && p.closest("button, svg, script, style, [aria-hidden='true']")) {
          return NodeFilter.FILTER_REJECT;
        }
        const inUser = !!(p && p.closest && p.closest('[data-chatgpt-search-unit-key$=":user"]'));
        if (mode === "assistant" && inUser) return NodeFilter.FILTER_REJECT;   // 回答区 = 不在 user 单元里
        if (mode === "user" && !inUser) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n = null;
    while ((n = walker.nextNode())) {
      segs.push({ node: n, start: total });
      total += n.nodeValue.length;
    }
    return segs;
  }

  /**
   * 去掉全部空白字符，并保留"第 i 个非空白字符原本在原文的哪个下标"。
   *
   * 返回 `{text, map}`：`text` 是压缩后的串，`map[i]` 是它在原串里的位置。
   * 这样"在压缩串里找到了"就能**翻译回**原来的下标 → 再翻译成"第几个文本节点 + 节点内偏移"。
   * 没有 map 就只能知道"找到了"，却没法在 DOM 上圈出它。
   */
  function stripWsWithMap(s) {
    const text = String(s == null ? "" : s);
    let out = "";
    const map = [];
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) continue;
      out += text[i];
      map.push(i);
    }
    return { text: out, map: map };
  }

  /** 把一个"拼接串下标"翻译回"第几个文本节点 + 节点内偏移" */
  function locateInSegs(segs, off) {
    // 从后往前找第一个 start ≤ off 的段（段是按顺序追加的）
    for (let i = segs.length - 1; i >= 0; i--) {
      if (off >= segs[i].start) return { node: segs[i].node, offset: off - segs[i].start };
    }
    return segs.length ? { node: segs[0].node, offset: 0 } : null;
  }

  /** 在某个模式内，用"忽略空白"的规则找第一个 needle；返回 DOM Range 或 null */
  function locateInMode(turnEl, needle, mode) {
    const segs = textSegments(turnEl, mode);
    if (!segs.length) return null;

    const raw = segs.map(function (s) { return s.node.nodeValue; }).join("");
    const hay = stripWsWithMap(raw);
    const nee = stripWsWithMap(needle);
    if (nee.text.length < MIN_FRAGMENT) return null;

    const at = hay.text.indexOf(nee.text);
    if (at < 0) return null;

    // 起点 = 第 at 个非空白字符；终点 = 最后一个字符**再往后一格**（Range 的 end 是开区间）
    const a = locateInSegs(segs, hay.map[at]);
    const b = locateInSegs(segs, hay.map[at + nee.text.length - 1] + 1);
    if (!a || !b) return null;

    const r = document.createRange();
    try {
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
    } catch (e) {
      return null;                                  // 跨节点区间非法（理论上到不了这里）
    }
    return r;
  }

  /**
   * 在 `anchorEl` 所在的**轮**里找 `text` 那段原文。
   *
   * @param {Element} anchorEl 父提问的活节点（气泡即可，内部自己找轮容器）
   * @param {string}  text     子提问记录下来的选中文
   * @returns {{range:Range, mode:string, used:number}|null}
   *          null = 没找到（**不抛错**：调用方要能看见"没找到"并退回老行为）
   */
  function findFragment(anchorEl, text, opt) {
    const needle = String(text == null ? "" : text);
    if (!needle || stripWsWithMap(needle).text.length < MIN_FRAGMENT) return null;

    const turnEl = turnOf(anchorEl) || anchorEl;
    if (!turnEl) return null;

    // 降级链：原文全长 → 前 24 → 前 12 → 前 6（去重、保持递减）
    const nw = stripWsWithMap(needle);
    const steps = [nw.text.length];
    [24, 12, 6].forEach(function (n) {
      if (n < nw.text.length && n >= MIN_FRAGMENT && steps.indexOf(n) < 0) steps.push(n);
    });

    // 模式：先只看回答区（见本节开头的取证），找不到再放开到整轮
    const modes = ["assistant", "any"];
    for (let m = 0; m < modes.length; m++) {
      for (let s = 0; s < steps.length; s++) {
        const part = nw.text.slice(0, steps[s]);
        const range = locateInMode(turnEl, part, modes[m]);
        if (range) return { range: range, mode: modes[m], used: steps[s] };
      }
    }
    return null;
  }

  /** 把 Range 的每一个矩形读出来（已过滤"没有面积的"）；返回 null = 宿主已经不在文档里了 */
  function rangeRects(range) {
    if (!range) return [];
    const start = range.startContainer;
    if (!start || (start.isConnected === false)) return null;      // ★ null 和 [] 含义不同，别混
    try {
      return Array.prototype.slice.call(range.getClientRects())
        .filter(function (r) { return r.width > 0.5 && r.height > 0.5; });
    } catch (e) {
      return [];
    }
  }

  /* ── 片段高亮：和第 5 章 flash() 同一套打法（挂 body、fixed、transform、rAF 跟随），
   *    区别只有"目标"：从"一个元素"变成"一段文字"。
   *    一段文字会断成**好几个矩形**（跨行、跨表格单元格），所以这里是**一组**盒子，
   *    一个矩形一个。
   *
   *    ⚠️ 三条纪律一条都不能破：
   *      ① 绝不往页面里插节点（性能铁律：插进那个 74k 像素高的虚拟滚动容器 = 整篇重排）；
   *      ② 不改动原始聊天内容（高亮结束要恢复原样，此处本来就没动过任何页面节点）；
   *      ③ 和整条消息的环**互斥**（见 flash() 里那句 flashCleanup） */
  let fragState = null;
  const FRAG_ON_MS = 1700;      // 保持高亮多久
  const FRAG_OUT_MS = 380;      // 淡出时长

  /** 收干净片段高亮：先把登记销号，再摘盒子（顺序同 endFlash，防连点误伤新的一轮） */
  function endFlashRange() {
    const s = fragState;
    if (!s) return;
    fragState = null;
    if (s.raf) cancelAnimationFrame(s.raf);
    clearTimeout(s.tOut);
    clearTimeout(s.tRemove);
    s.boxes.forEach(function (b) { if (b.parentNode) b.parentNode.removeChild(b); });
  }

  /** 按当前布局摆放所有小盒子；盒子数不够就现补，多余就藏起来 */
  function placeFrags(s) {
    const rects = rangeRects(s.range);
    if (rects === null) { endFlashRange(); return; }               // 宿主没了 → 整体收工
    while (s.boxes.length < rects.length) {
      const d = document.createElement("div");
      d.className = "cw-flash-frag" + (s.on ? " cw-flash-frag--on" : "");
      document.body.appendChild(d);
      s.boxes.push(d);
    }
    s.boxes.forEach(function (b, i) {
      const r = rects[i];
      if (!r) { b.style.display = "none"; return; }
      if (b.style.display === "none") b.style.display = "";
      // ⚠️ 只有"尺寸/坐标真的变了"才写样式：每帧瞎写也会逼浏览器重排
      const w = Math.round(r.width), h = Math.round(r.height);
      if (b._w !== w || b._h !== h) { b._w = w; b._h = h; b.style.width = w + "px"; b.style.height = h + "px"; }
      const x = Math.round(r.left), y = Math.round(r.top);
      if (b._x !== x || b._y !== y) { b._x = x; b._y = y; b.style.transform = "translate3d(" + x + "px," + y + "px,0)"; }
    });
  }

  /** 每帧重摆一次：页面滚动 / 布局变化时高亮要跟着那段文字走 */
  function trackFrags(s) {
    if (fragState !== s) return;
    placeFrags(s);
    s.raf = requestAnimationFrame(function () { s.raf = 0; trackFrags(s); });
  }

  /**
   * 高亮一段文字（约 1.7s 后自动消失）。
   * @returns {boolean} 是否真的画出来了（false = 宿主已失效 / 量不出矩形）
   */
  function flashRange(range) {
    const rects = rangeRects(range);
    if (!rects || !rects.length) return false;
    endFlashRange();                                   // 连点只留最新那一轮

    const s = { range: range, boxes: [], raf: 0, tOut: 0, tRemove: 0, on: false };
    fragState = s;
    placeFrags(s);
    // ── 下一帧再加 --on：不隔一帧，浏览器"第一次渲染就是亮的"，transition 根本不播
    requestAnimationFrame(function () {
      if (fragState !== s) return;
      s.on = true;
      s.boxes.forEach(function (b) { b.classList.add("cw-flash-frag--on"); });
    });
    trackFrags(s);

    s.tOut = setTimeout(function () {
      s.boxes.forEach(function (b) {
        b.classList.remove("cw-flash-frag--on");
        b.classList.add("cw-flash-frag--out");
      });
      s.tRemove = setTimeout(function () { if (fragState === s) endFlashRange(); }, FRAG_OUT_MS + 80);
    }, FRAG_ON_MS);
    return true;
  }

  /** 给 flash() 用的小钩子（让"整条消息的环"能把"文字碎片"收掉，不用关心它内部叫啥） */
  function flashCleanup() { return endFlashRange(); }

  /**
   * 把一段文字滚到视口高度的 ratio 处（默认 0.38，略高于正中 —— 既在视线焦点上，
   * 又给吸顶栏和上方内容留出上下文，用户能看到"这句话在什么上下文里"）。
   *
   * ⚠️ 为什么这里可以写 scrollTop：这不是"手算落点"，而是**读当前矩形 → 补差值**
   *    （和第 4 章 scrollTo 里那句 340ms 后的修正完全同一个公式）。
   *    第 4 章"绝不手算 scrollTop"针对的是"凭空算出一个绝对坐标"。
   *
   * @returns {boolean} 是否真的执行了滚动（false = 已经在那儿了 / 量不到）
   */
  function scrollRangeTo(range, ratio) {
    const start = range && range.startContainer;
    if (!start || !start.parentElement) return false;
    const r = range.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return false;

    const cont = getScrollContainer(start.parentElement);
    const isDoc = cont === document.scrollingElement || cont === document.documentElement || cont === document.body;
    const vh = window.innerHeight || 600;
    const want = vh * (typeof ratio === "number" ? ratio : 0.38);
    const delta = r.top - want;
    if (Math.abs(delta) < 6) return false;                 // 已经在那儿了，别抖一下

    if (isDoc) {
      window.scrollTo({ top: Math.max(0, (window.scrollY || 0) + delta), behavior: "smooth" });
      return true;
    }
    try {
      cont.scrollTo({ top: cont.scrollTop + delta, behavior: "smooth" });
    } catch (e) {
      cont.scrollTop += delta;                             // 老浏览器不支持 smooth 就硬跳
    }
    return true;
  }

  /**
   * 【第 13 章】等"动画停"再测量 / 再落笔（**有界**）。
   *
   * 为什么需要（本轮真机错案的根因）：
   *   `scrollRangeTo` 用的是 `behavior:"smooth"` —— 它是一段**动画**。
   *   动画期间 React 会持续重建滚动窗口里的那一轮内容 → 之前量好的那个 `Range`
   *   指向的文本节点被换掉（`rangeRects` 判 `isConnected===false`）→ `flashRange`
   *   当场静默放弃。真机日志实证：`[CW][back] 命中片段` 明明打了，盒子却在
   *   <50ms 内被 `placeFrags → rangeRects===null → endFlashRange` 清掉。
   *   ⚠️ 这和全项目那条"状态切换带动画时，测量与算坐标都必须等动画停"是同一件事。
   *
   * 判据（第 7 章锚线那套，两条**缺一不可**）：
   *   ① 连续两次读数一致（间隔 step、差 < 0.5）
   *   ② 至少已过 minMs
   *   只满足 ① 不算数：Chrome 在窗口被遮挡时会**冻结动画时间线**，读数会
   *   "稳定地停在起点"。所以还要 ② 兜底，并且**调用方仍要自己复核几何**。
   *
   * @param {Function} read —— 返回一个数值读数；返回 null/undefined 视为"此刻没得量"
   * @param {Object} [opt]  —— { step=90, minMs=320, maxMs=1400 }
   * @returns {Promise<boolean>} true = 确实稳定了；false = 超时（有界退出，不抛错）
   */
  function whenSettled(read, opt) {
    const o = opt || {};
    const step = o.step || 90;
    const minMs = o.minMs || 320;
    const maxMs = o.maxMs || 1400;
    const t0 = Date.now();
    return new Promise(function (resolve) {
      let last = null, same = 0;
      (function tick() {
        let v = null;
        try { v = read(); } catch (e) { v = null; }
        const elapsed = Date.now() - t0;
        if (v != null && last != null && Math.abs(v - last) < 0.5) same++; else same = 0;
        last = v;
        const ok = same >= 1 && elapsed >= minMs;
        if (ok || elapsed >= maxMs) { resolve(ok); return; }
        setTimeout(tick, step);
      })();
    });
  }

  /* ============ 对外暴露 ============ */

  return {
    extractText: extractText,
    getUserMessages: getUserMessages,
    getChatId: getChatId,
    hasConversation: hasConversation,
    getScrollContainer: getScrollContainer,
    scrollTo: scrollTo,             // 第 4 章新增
    flash: flash,                   // 第 5 章新增
    endFlash: endFlash,             // 第 5 章新增（探针/调试用，正常流程不需要）
    getMountedKeys: getMountedKeys, // 第 8.5 章新增（谁在页面上挂着 + 它们的活节点）
    reveal: reveal,                 // 第 8.5 章新增（把没挂载的那条搜出来）
    _coordOf: coordOf,              // ★ 第 11 章回归测试用：暴露"时间序坐标"选择逻辑
    _jumpAnchor: jumpAnchor,        // ★ 第 4 章回归测试用：暴露"跳转锚点"（整条消息 vs 气泡）
    _isRenderedUnit: isRenderedUnit, // ★ 十三补回归测试用：暴露"这条消息此刻在不在渲染"
    _isLanded: isLanded,            // ★ 第 4/7 章回归测试用：暴露"落位判定"（顶部几何）
    LAND_TOP_RATIO: LAND_TOP_RATIO, // ★ 落位判据线（必须 ≤ content.js 的 SCROLL_ANCHOR_RATIO）
    // ── 第 13 章 · 「回到刚才」（精确到"段"的落点）────────────────────────────
    turnOf: turnOf,                 // 节点 → 它所属的"轮"容器（含回答）
    findFragment: findFragment,     // 在某一轮里找一段原文 → Range | null
    flashRange: flashRange,         // 高亮一段原文（挂 body 的覆盖层，约 1.7s）
    endFlashRange: endFlashRange,   // 收干净（探针/调试用）
    scrollRangeTo: scrollRangeTo,   // 把一段原文滚到视口某个高度比例处
    whenSettled: whenSettled,       // ★ 十六补：等"动画停"再测量（有界）
    _stripWsWithMap: stripWsWithMap // ★ 离线单测用：暴露"忽略空白匹配"的底层件
  };
})();


