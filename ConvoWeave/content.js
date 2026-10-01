console.log("[CW] content.js 已加载");

/**
 * ============================================================================
 *  content.js —— 启动脚本（把 parser 和 sidebar 接起来）
 * ============================================================================
 *  数据流从头到尾只有一条线：
 *
 *      CW_Parser.getUserMessages()      ← 读 ChatGPT 页面，产出数组
 *              │
 *              ▼
 *      CW_Sidebar.setItems(list)        ← 把数组画成卡片里的列表
 *
 *  这个文件自己只负责三件事：
 *     · 第 3~6 章：**决定"什么时候"再去读一遍**（从定时器 → MutationObserver）
 *     · 第 4 章：把"点击第 n 条"翻译成"滚到那一页"
 *     · 第 7 章：**当前读到哪一条**（滚动同步 + 点击临时锁定）
 * ============================================================================
 */
(function () {
  "use strict";

  // 防止脚本被重复注入时启动两次（SPA 页面导航时有可能会发生）
  if (window.__CW_BOOTED__) return;
  window.__CW_BOOTED__ = true;

  /* ────────────────────────────────────────────────────────────────────────
     一、配置
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 防抖窗口（第 6 章）。
   *
   * ⚠️ 为什么不能"DOM 一变就重建"：ChatGPT 流式输出时 DOM 每秒变几十次，
   *    每一次都重建列表 = 列表在回答的过程中疯狂闪 + CPU 空转。
   *    等"安静 320ms"再处理，一串抖动就被合并成一次。
   *
   * 为什么是 320ms 而不是 0 或者 1000：
   *   太短（0~100ms）挡不住流式输出的连续抖动，列表会闪；
   *   太长（800~1000ms）用户发完消息会明显感觉"目录怎么慢半拍"。
   *   320ms 约等于"人眨一下眼"，既合并得掉抖动，又基本感觉不到延迟。
   *
   * ★ 2026-09-30 十五补：320 → **160ms**。
   *   这个数字**只管"重画晚多久"**，它不再是"切会话检测"的延迟 ——
   *   路由检测已经提到 observer 回调的第一行**同步**做（见 syncRoute），
   *   于是缩短它纯粹是让"新消息进目录"更快，不再有"切会话要陪跑一个防抖"的代价。
   *   （160 仍足以把 ChatGPT 一次渲染吐出的一串 mutation 合并成一次重画。）
   */
  const SCAN_DEBOUNCE = 160;

  /**
   * 当前阅读位置的判定基线（第 7 章）。
   *
   * 定义：**视口顶部往下 32% 处**那条横线，滚过它的最后一条就是"当前在读的那条"。
   * 为什么不取 0（视口最上沿）：正在读的句子通常在中上部，
   *   用最上沿会让"当前项"永远慢半拍（要等它完全贴顶才算）。
   * 为什么不取 0.5：那又太靠下，高亮会"提前"跳到还没读到的条目。
   */
  const SCROLL_ANCHOR_RATIO = 0.32;

  /**
   * ★ 点击后的"当前项"锁定（第 7 章；2026-09-29 二次返工：**锁到用户亲手操作为止**）。
   *
   * 为什么还必须有这个锁 —— 落位几何已经修好了（parser.js 已改成"顶到顶端"：
   *   目标 top ≈ 吸顶栏高度，落在锚线 0.32*vh **之上**，锚线规则算出的就是目标自己；
   *   实测见 tools/probes/p75-landing-geom.js）。所以锁不再是"几何矛盾"的创可贴，
   *   它现在挡的是**落位过程本身**的竞态：跳转分几步完成
   *   （instant 到位 → 倒回 → smooth 滑入 → verifyLater 后验），
   *   中途任意一次 observer → rebuild 都可能读到"还没滚到位"的矩形，
   *   于是把高亮按锚线规则改到别处 —— 即"页面还在动，高亮已经飘了"。
   *
   * ★★ 2026-09-29 返工（起因：用户实测反馈"跳转后过一会儿，页面没动，
   *    高亮自己变回上一个提问"）：
   *   旧版锁是"2 秒后自动过期"—— 那是按"跳转动画最长 ~1.6s"设计的，
   *   但**偷高亮的不是动画，是动画之后**的某一次 DOM 变动
   *   （流式回答收尾 / 图片加载 / 虚拟滚动装卸 → observer → rebuild →
   *    syncActiveFromScroll）。它什么时候来没法预料，2 秒一过锁就是空的，
   *   下一次 rebuild 必然把高亮按锚线规则"改回"上一条。
   *   正解：**锁的释放只认用户输入**（wheel / touchstart / pointerdown /
   *   keydown，见 lockActive 里的 release 监听）—— 用户不动，高亮就停在
   *   他点的那条上；用户一动，锁立刻放开、滚动同步接管。时间不再参与。
   *
   * ⚠️ 配套纪律：凡是"乐观上锁之后目标最终没跳成"的出口（reveal 失败、
   *    中途切会话），必须**主动把锁放掉**（activeLockUntil = 0），
   *    否则高亮会永远卡住、滚动同步再也不工作。
   */

  /**
   * 目录条目的标题长度上限（第 8 章）—— "截取前面指定数量字符"里的那个"指定数量"。
   *
   * ⚠️ 2026-09-28 简化后，这个数字**就是标题的实际字数上限**：
   *    标题里不再有 [报错] 这类标签，所以没有"标签占掉几个字"这回事了。
   *    （省略号也算在这个数里面 —— 说好 26 就是 26，见 summarizer.js 的 truncate。）
   *
   * 26 是怎么来的：面板条目区宽约 260px、字号 13px 时一行大约放得下 13 个汉字。
   *    之所以给到 26（也就是两行的量），是因为条目是**单行截断**（CSS ellipsis）的，
   *    **宁可让它在 CSS 层被切掉，也不要在这里切得过狠**：
   *    CSS 切开时用户还能悬停看全文，在这里切掉就真没了。
   */
  const TITLE_MAX_LEN = 26;

  /**
   * 悬停提示（tooltip）里最多放多少个字（第 8 章）。
   * 原始提问可能上千字，原样塞进 title 属性会让提示框长得没法看。
   */
  const TOOLTIP_MAX = 300;

  /* ────────────────────────────────────────────────────────────────────────
     二、状态
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 当前目录快照：[{ order, key, text, el, turn }]。
   *
   * ★ 第 7 章之前，list 是"读完就扔"的；第 7 章必须**留着**：
   *   滚动时要反复用里面的 el 去量它们在屏幕上的位置。
   *   ⚠️ el / turn 是**易耗**节点引用 —— ChatGPT 重渲染会换掉节点，
   *     所以每次 rebuild 都要顺手把它们刷新一遍（见 rebuild 里的注释）。
   *
   * ★★ 第 8.5 章起，这份快照**比页面上的消息多**：它是"这一次会话的全部提问"，
   *    而其中只有**此刻挂着的**那几条才有 el（其余 el === null，正躺在虚拟列表外面）。
   *    于是下游必须能容忍 el 为 null：
   *      · syncActiveFromScroll 跳过 el 为空/失联的条目（已经在做）
   *      · jumpTo 发现目标没有 el 时，先把它**搜出来**再跳（第 8.5 章新增）
   *    判据：**数据结构变了，先问"谁会读到这个新出现的空值"。**
   */
  let items = [];

  /**
   * 完整列表的骨架（第 8.5 章）：接口给的 `[{ key, text }]`，只在"进会话 / 切会话"时拉一次。
   *
   * 语义（别混淆，只有这两种）：
   *   · null      → 没有骨架：接口没拿到 / 还没回来 / 这是个空会话
   *                 → rebuild 退回第 0~8 章的老行为：只画页面上已加载的那几条
   *   · 数组      → 权威的完整顺序表；页面上挂着的活节点由 merge 接上去
   *
   * ⚠️ 它**不是**缓存"用户数据"（提问原文本来就显示在用户自己屏幕上），
   *    放在内存里随着页面一起消失，不落盘、不外发。
   */
  let spine = null;

  /** 骨架对应的会话 id（切会话时用它判断"这份骨架是不是已经过期"） */
  let spineChatId = "";

  /** 正在飞的拉取（同一段会话不重复拉） */
  let spineLoading = null;

  /* ★ 2026-09-28 补丁 · 骨架自动刷新（治"条数在 14/15 之间抖"）─────────────
   *
   * 症状（用户实测）：发一条新提问后，目录条数一会儿 14、一会儿 15。
   * 机理：骨架是**进会话时**拉的（缓存 5 分钟），不含这条新消息；
   *       merge 的第 ③ 步只能把"此刻挂载着的"新单元补进目录 ——
   *       于是 滚到底（单元挂载）→ 15、滚开（虚拟卸载）→ 14，来回抖；
   *       抖动还连带重画（签名变了）和标题抖（dom-only 用页面占位符
   *       「附件消息」，刷新后才是接口给的权威文字）。
   *
   * 治法：rebuild 时发现「页面里有、骨架里没有」的 key = 骨架落后了，
   *       自动强制重拉一次。拉回来之后新消息就是骨架的**正式成员** ——
   *       挂不挂载都在，条数和标题都稳了。
   *
   * 三道闸（判据：**自动打接口的行为必须自带刹车，而且刹车要有"记住"的能力**）：
   *   ① 冷却 30s：连续触发时只排一次；
   *   ② "连续多次刷新成功、骨架里仍然没有"的 key 放弃重拉（spineMiss 计数，
   *      SPINE_MISS_MAX 次）—— 那说明它多半本来就不属于这份会话（解析兜底的杂条目），
   *      为它每 30s 打一次接口没有意义；**一次没有就放弃是错的**（2026-09-28
   *      真机取证：发消息瞬间刷新，后端可能还没写进去，一次竞态不该判死刑）；
   *   ③ 已有拉取在飞就不排（history.js 内部还有并发去重兜底）。
   */
  let spineRefreshTimer = 0;
  let lastSpineRefresh = 0;
  const SPINE_REFRESH_COOLDOWN = 30 * 1000;
  /* ★ 2026-09-28 二补 · 拉黑改计数（治"刚发出去就被永久拉黑"）─────────────
   *
   * 用户实测：选中文字继续提问的新消息，一直没变成子标题。
   * 根因：发消息 → 检测到骨架落后 → 400ms 后立刻强制重拉 —— 此时后端**可能
   *       还没把这条消息写进会话接口** → 拉回来的骨架仍然没有这个 key →
   *       旧逻辑当场记进 unmatchableKeys（永久）→ 再也不为它重拉。
   *       而接口里明明有它的完整模板（真机取证：load(force) 一拉就有）。
   * 治法：unmatchableKeys 从"一次未命中就永久拉黑"改成**连续未命中计数**——
   *       · 只有"这次刷新真的成功拿到新骨架"才 +1（拉取失败 ≠ 后端说没有）；
   *       · 连续 SPINE_MISS_MAX 次都没有 → 才放弃（防解析杂条目打死接口，
   *         刹车还在，只是给了后端 30s×N 的追平窗口）；
   *       · 中途任一次刷新里出现了 → 计数清零。
   */
  const SPINE_MISS_MAX = 3;
  const SPINE_BACKOFF = [400, 1500, 6000, 20000];   // ★ 追赶退避（见 maybeRefreshSpine）
  let spineMiss = {};               // key → 连续"刷新成功但仍没有"的次数
  let spineGeneration = 0;          // 每次成功拿到新骨架 +1（用来判断"这次刷新成没成功"）

  /* ★ 第 11 章 · 选中捕获（父归属的"精确值"来源）─────────────────────────
   *
   * 用户在**某条回答里选中一段文字、点「向 ChatGPT 提问」**时，这条新子提问
   * 该挂到哪个主提问下，最准的答案是"选区所在的那条回答属于哪个提问" ——
   * 因为用户**可能往上翻到很早的一条回答**去选中，而不是选最近的那条。
   *
   * 于是监听 mouseup：选区非空 → 顺 anchor 节点找到所在的轮（[data-turn-key]）
   * → 在 items 里按该轮 key 定位 → 记下它的"主提问 key"（它自己是子提问就取它
   * 的 parentKey）。记进 capturedParentKey，TTL 60s：
   *   · TTL 内新子提问出现 → buildTree 用捕获值覆盖父归属；
   *   · 超时 / 重开会话 → 退回"前一条主提问"兜底。
   *
   * ⚠️ 为什么**只存内存、不持久化**：这是"本次会话里刚发生的选中"的瞬时上下文；
   *   重开后没有它，兜底规则（前一条主提问）在绝大多数场景下本来就是对的结果。
   *   ★ 判据：**兜底要覆盖"没有捕获"的完整路径，捕获只是让罕见场景更准。**
   */
  let capturedParentKey = null;
  let capturedUntil = 0;
  const CAPTURE_TTL = 60 * 1000;

  /**
   * 取"选中捕获"（若有效且这条新子提问还没消费过）→ 转成 buildTree 的 override。
   * 返回 null = 没有捕获 / 已过期 / 还没有新子提问（捕获继续挂着等）。
   */
  function takePendingParent(list) {
    if (!capturedParentKey || Date.now() > capturedUntil) {
      capturedParentKey = null;
      return null;
    }
    // 找"新出现的子提问"（上一次 items 快照里还没有的）—— 那才是捕获该作用的对象
    const prev = {};
    items.forEach(function (m) { prev[m.key] = 1; });
    const fresh = list.filter(function (m) { return m.isChild && !prev[m.key]; });
    if (!fresh.length) return null;

    const parent = capturedParentKey;
    capturedParentKey = null;               // 消费一次：一次捕获只归一条子提问
    return { parent: parent, childKeys: (function () {
      const o = {};
      fresh.forEach(function (m) { o[m.key] = 1; });
      return o;
    })() };
  }

  /**
   * 挂"选中捕获"监听（mouseup，第 11 章）。
   */
  function observeSelection() {
    document.addEventListener("mouseup", function () {
      let sel = null;
      try { sel = window.getSelection(); } catch (e) { return; }
      if (!sel || sel.isCollapsed) return;

      const node = sel.anchorNode;
      if (!node) return;
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el || !el.closest) return;
      const turn = el.closest("[data-turn-key]");
      if (!turn) return;

      const tk = turn.getAttribute("data-turn-key");
      const hit = items.find(function (m) { return m.key === tk; });
      if (hit) {
        capturedParentKey = hit.isChild ? (hit.parentKey || hit.key) : hit.key;
      } else {
        /* ★ 2026-09-28 修正：这里原来是"退回最后一个主提问"—— 那是**错的**，
           它把每条子提问都塞到目录最后一条主提问底下（用户实测反馈："是要放在
           对应父提问下面，不是最后一个父提问下面"）。
           匹配不到就**什么都不设**：把决定权交回 buildTree，它依次用
           ① parentUser（接口消息树的持久真父）② 前一条主提问。
           判据：**兜底只能退到"更弱但不含错误断言"的规则，不能退到"错的规则"。**
           "最后一个主提问"不是"弱"，是"错"。 */
        capturedParentKey = null;
      }
      if (capturedParentKey) capturedUntil = Date.now() + CAPTURE_TTL;
    });
  }

  /**
   * 跳转的"代"（第 8.5 章新增）。
   *
   * 为什么需要：未挂载的目标要**异步**搜（可能几百毫秒），和以前"点了就跳完"不同。
   * 于是"连点两次"会出现两个在飞的搜索，谁后写完 scrollTop 谁说了算 ——
   * 用户点 A 又点 B，最后可能落在 A 上。
   * 每次点击 +1，异步回调开工先比代号，对不上就直接退出：
   * **只有最后一次点击的搜索结果算数。**
   * （parser.js 里 scrollTo 的 jumpToken 是同一个套路 —— 这类 bug 的通用解法。）
   */
  let jumpSeq = 0;

  /** 当前高亮的是第几条；-1 = 还没有当前项 */
  let activeIndex = -1;

  /** 上次渲染时的"签名"（第 6 章）：用它判断"目录到底变了没有" */
  let signature = "";

  /** 上次见到的地址（第 6 章）：切会话靠比它发现 —— popstate 实测是一次都不触发的 */
  let lastHref = location.href;
  /** ★ 2026-09-29 二补：切会话的"真正判据"是会话 ID（/c/<id>），不是整串 href。
   *   同一次会话里 ChatGPT 改 URL（加 ?model=、去 ?temporary-chat 等）也会让 href 变，
   *   但会话 ID 不变 —— 那种情况绝不能当切会话处理（否则会清高亮 + 放锁 → 漂移）。 */
  let lastChatId = CW_Parser.getChatId();

  /** 防抖计时器句柄 */
  let scanTimer = 0;

  /** 滚动同步的 rAF 句柄（0 = 当前没有排队的帧回调） */
  let rafId = 0;

  /** > Date.now() 表示"当前项被点击锁住"，滚动同步不许改 */
  let activeLockUntil = 0;

  /**
   * ★ 2026-09-30 十三补：**DOM 里的条目此刻可不可信**（切会话过渡期专用）。
   *
   * 真机实测（`tools/probes/p87-switch-count.js`，点左侧导航从 B 切到 A）：
   *   t=1~3s  地址已经是 A，但页面上挂着的 5 个 user 单元**仍是 B 的**（A 还没渲染出来）；
   *   t=4s    接口的 25 条已经到手，而那 5 条 B 残骸**此刻还看得见**
   *           —— 所以第 8.5 章那套"没有盒子 = 残骸"的几何过滤**挡不住它**
   *           → merge 在 spine 里找不到这 5 条 → 当成"5 条新提问"接在后面 → **面板 30 条**；
   *   t≥5s   残骸终于不再渲染 → 面板回到 25 条（所以它是"闪一下"就正常，
   *           但用户点得快、或会话短的时候，会停在错的那一帧上）。
   *
   * 判据：**"这条会话的 DOM"不是靠地址栏认出来的，是靠"它里面有权威列表也认识的东西"认出来的。**
   *   恢复条件见 resolveDomTrust()。
   */
  let domTrusted = true;

  /**
   * ★ 十三补：切会话之后"初始高亮还没定下来"。
   *   清掉的时机 = 第一次真的定下了高亮（几何算得出 or 兜底给了末条），见 syncActiveFromScroll。
   */
  let pendingSelectLast = false;

  /** 解锁监听只挂一次 */
  let lockArmed = false;

  /* ────────────────────────────────────────────────────────────────────────
     三、第 6 章 · 签名（"这目录到底变没变"的指纹）
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 算一个能把"目录内容"唯一表示的字符串。
   *
   * 必须三层，少任何一层都会漏判：
   *   ① chatId —— 防的是**兜底路径**撞车：key 读不到时会退化成 "turn-0"/"turn-1"，
   *      两个不同会话的第 ③ 层会长得**一模一样**，光比 ③ 认不出"会话换了"。
   *      （✅ 实测：正常路径 key 全是全局 uuid，跨会话 0 撞车 ——
   *        所以这一层不是正常路径必需，而是防"message-id 读不到那一天"的便宜保险。）
   *   ② 条数 —— 最便宜的粗筛。
   *   ③ 每条 key —— 不能省：只比条数的话，改了一条消息的文字你发现不了。
   *
   * 入参：list —— getUserMessages() 的返回值；空数组时必须得到 `chatId|0|`，
   *       而不是 `chatId|0|undefined`（map 空数组 join 出来本来就是空串，天然满足）
   *
   * ★ 第 8 章特意**没有**把 title 并进签名（参考实现是并进去的），这是个取舍：
   *   并进去的好处是"消息文字变了、key 没变"时目录也能跟着更新；
   *   代价是签名变成四层，且每一条的摘要都要参与字符串比较。
   *   而 title 是 `key` 对应的 `text` **派生**出来的 —— key 稳定则文本稳定
   *   （message-id 是全站 uuid，实测跨会话 0 撞车）。
   *   ⚠️ 前提如果变了（哪天发现"编辑同一条消息后 key 不变"），就把 title 加到
   *      第三层后面 —— 改一行的事，但必须有证据再改，别凭感觉加。
   *   （判据：**签名的每一层，都应该是"我自己看不出来的变化"的兜底，而不是冗余。**）
   */
  function getSignature(list) {
    return CW_Parser.getChatId() + "|" + list.length + "|" +
      list.map(function (m) { return m.key; }).join(",");
  }

  /* ────────────────────────────────────────────────────────────────────────
     三·五、第 8 章 · 加工（把原文变成目录里显示的短标题）
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 给每条消息补上两个**只用于显示**的字段：
   *   · title   —— 目录条目里显示的那行短标题
   *   · tooltip —— 悬停时浮出的原文（标题没压缩多少时留空 = 不设提示）
   *
   * 就地改（`m.title = ...`）而不是 `Object.assign({}, m)` 造新对象：
   *   parser 的契约是"每次调用都返回全新对象"（见 parser.js 里 getUserMessages
   *   的说明），所以就地加字段不会污染任何人，还省掉一次全量复制。
   *   ⚠️ 这条捷径的**前提是那个契约**；哪天 parser 改成返回缓存对象了，这里就得改。
   *
   * ⚠️ 为什么放在 content.js 而不是 sidebar.js 里做：
   *   sidebar 的设计前提是"它只认识一个数组，不认识页面、也不认识文本处理"。
   *   让它去调 CW_Summarizer，就把"摘要"和"画列表"两件事粘成一件了 ——
   *   将来第 9 章做搜索时要按标题过滤，那时候摘要逻辑在谁手上就很关键。
   *   在这里加工一次，sidebar 拿到的就是"画图需要的一切"。
   *
   * @param {Array} list CW_Parser.getUserMessages() 的返回值（会被就地加工）
   * @returns {Array} 同一个数组
   */
  function decorate(list) {
    // ★ 第 11 章：一次调用把标题 + "谁是子提问"都算完。
    //   普通消息走「清洗 + 截前 26 字」；子提问（选中文字继续提问）走两段式
    //   「选中片段 › 问题」。重名加序号这件事只有拿到整批才能做，也在这里一并做。
    const r = CW_Summarizer.summarizeAll(list, {
      maxLen: TITLE_MAX_LEN
    });

    list.forEach(function (m, i) {
      m.title = r.titles[i] || "未命名提问";

      // ── 标记子提问 + 记下选中文/问题（第 11 章）──
      const parsed = r.parsed[i];
      if (parsed) {
        m.isChild = true;
        m.selection = parsed.selection;
        m.request = parsed.request;
      }

      // ── 悬停看全文 ──
      //    子提问：气泡 = 分行标注的「选中片段：… / 提问：…」（2026-09-28 用户实测反馈：
      //    标题把两段挤一行靠 " › " 分，分不清哪段是选中文、哪段是提问）。
      //    普通消息：气泡 = 原文（title 是它的截断前缀，照旧）。
      if (parsed) {
        m.tooltip = CW_Summarizer.childTooltip(parsed, { maxLen: TOOLTIP_MAX });
      } else {
        const raw = m.text == null ? "" : String(m.text);
        if (CW_Summarizer.needsTooltip(raw, m.title)) {
          m.tooltip = raw.length > TOOLTIP_MAX ? raw.slice(0, TOOLTIP_MAX) + "…" : raw;
        } else {
          m.tooltip = "";
        }
      }
    });

    return list;
  }

  /* ────────────────────────────────────────────────────────────────────────
     四、第 6 章 · 重建（唯一一处调用 setItems 的地方）
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 组出"此刻的完整目录" = 完整列表（骨架）+ 页面此刻挂着的活节点。
   *
   * ★ 第 8.5 章：这里是数据流的**唯一汇合点** ——
   *   上面那条链从此变成：
   *
   *     CW_History.load(chatId)   → spine   [{ key, text }]        完整、稳定、不含节点
   *     CW_Parser.getUserMessages()→ dom    [{ key, text, el, turn }] 只有挂着的、含活节点
   *              │
   *              └─ CW_History.merge(spine, dom) ─→ 完整列表 + 活节点
   *                        │
   *                        └─ decorate() ─→ 补上 title / tooltip ─→ setItems()
   *
   *   ⚠️ 没有骨架时 merge 直接退回 dom —— 所以"接口挂了"这件事**只影响完整性，
   *      不影响可用性**：目录照样有、照样能点，只是只有页面上已加载的那几条。
   */
  /**
   * ★ 2026-09-30 十三补：切会话过渡期里，DOM 到底可不可信？（见 domTrusted 的实测说明）
   *
   *   · 手上**有**权威列表（spine）→ 要求 DOM 至少有一条 key 对得上。
   *     对得上 = "页面已经渲染成这个会话了"。切过去的头几秒，页面上还是上一个会话的
   *     5 条（它们一条都对不上）→ 继续不信 → merge 只用 spine → 条数天然正确。
   *   · 手上**没有**权威列表、也没有拉取在飞 → 没有可比对的东西，退回老行为
   *     （"页面有什么就画什么"）——否则接口一挂，面板会永远空白。
   *     ⚠️ 这一条成立的前提是**切会话时先发请求、再重画**（loadSpine 排在 rebuild 之前）：
   *        否则刚切开的那一瞬间就满足"没有在飞"，会把旧会话照单全收。
   *
   * @param {Array} domAll    刚抓到的全部 DOM 条目
   * @param {boolean} wasTrue 上一轮的可信度（一旦可信就不回头，除非再次切会话）
   * @returns {boolean}
   */
  function resolveDomTrust(domAll, wasTrue) {
    if (wasTrue) return true;
    if (!domAll || !domAll.length) return false;
    if (spine && spine.length) {
      const keys = spineKeysOf();
      return domAll.some(function (m) { return keys.has(m.key); });
    }
    return !spineLoading;      // 权威列表拿不到 → 退回"看页面有什么"
  }

  /**
   * ★ 十五补：spine 的 key 集合（**按数组引用缓存**）。
   *   resolveDomTrust 是热路径（每次 rebuild 都跑），而 spine 平时不动 ——
   *   每次重建一遍 Set 是白付的。用"引用相同就复用"来自动失效：
   *   任何对 spine 的赋值（新列表 / null）都会让缓存作废，不需要在每个赋值点手写清理。
   */
  let spineKeySetCache = null;
  function spineKeysOf() {
    if (spineKeySetCache && spineKeySetCache.for === spine) return spineKeySetCache.set;
    const set = new Set(spine ? spine.map(function (m) { return m.key; }) : []);
    spineKeySetCache = { for: spine, set: set };
    return set;
  }

  /**
   * ★ 2026-09-30 十五补：同步"加载中"占位（见 sidebar.setLoading）。
   *
   * 判据：**正在拉取 + DOM 不可信 + 手上一条都没有** —— 三者同时成立才叫"没东西可看"。
   *   缺任何一条都有东西可以显示（缓存列表 / 页面已渲染的，哪怕是空的「还没有提问」），
   *   这时候亮占位反而把真实数据挡住了。
   *
   * 为什么不需要超时兜底：loading 的生命周期完全由 `spineLoading` 决定，
   *   而它**必然**会落下来（loadSpine 的 p.then 保证，成功失败都落）。
   *   判据：**能用状态推出来的东西，就别再设一个钟去管它。**
   */
  function syncLoading() {
    CW_Sidebar.setLoading(!domTrusted && !!spineLoading && !(spine && spine.length));
  }

  function currentList() {
    // ★ 十三补：过渡期里的 DOM 可能是**上一个会话**的 → 不可信时只信 spine
    // ★★ 十五补（性能）：**过渡期不做全量解析**。
    //   getUserMessages() 每条消息都要 clone 节点 + 读 innerText（会强制布局），
    //   而过渡期解析出来的东西**马上就被丢掉**（不可信）—— 纯浪费。
    //   改用便宜的"挂载 key 探测"先判可信度：
    //     · 探测到了 key（页面确实有消息）→ 只拿 key 跟 spine 比对；
    //       一条都对不上 = 页面还是上一个会话 → **跳过全量解析**（省下最贵的那步）；
    //     · 一个 key 都探测不到（环境量不了 / 页面真没消息）→ 退回完整解析再判（老路径）。
    //   判据：**"要不要相信它"和"要读它的内容"是两件事 —— 先判前者，再决定做不做后者。**
    let domAll;
    if (domTrusted) {
      domAll = CW_Parser.getUserMessages();
    } else {
      const probe = CW_Parser.getMountedKeys ? CW_Parser.getMountedKeys() : null;
      if (probe && probe.length) {
        domTrusted = resolveDomTrust(probe, false);
        domAll = domTrusted ? CW_Parser.getUserMessages() : [];
      } else {
        domAll = CW_Parser.getUserMessages();
        domTrusted = resolveDomTrust(domAll, false);
      }
    }
    // ⚠️ 无论走哪条路，**只有可信时** DOM 才允许进 merge —— 判据统一放在这一句上，
    //    不要在分支里各写一份（本轮就把 `domAll` 忘了清空一次，真机表现为面板 25+5=30）。
    const merged = CW_History.merge(spine, domTrusted ? domAll : []);
    const list = decorate(merged);
    // ★ 第 11 章：父归属 —— 先取"选中捕获"（若有且未过期），再 buildTree 兜底
    const override = takePendingParent(list);
    // ★ 2026-09-28：子项移到父项正下方（Word 导航式层次）——
    //   渲染顺序 = 分组顺序，不然从早期回答里选中提问的子项会孤零零挂在会话末尾
    return CW_History.arrangeUnderParent(CW_History.buildTree(list, override));
  }

  /**
   * 读一遍数据源；**签名没变就什么都不做**。
   *
   * @param {boolean} [force] true = 跳过签名比较，无条件重画（切会话 / 骨架到达 / 手动刷新用）
   * @returns {void}
   *
   * 为什么"签名没变也要刷新 el 引用"（第 7 章追加）：
   *   ChatGPT 会在流式输出 / 重渲染时把消息节点整个换掉，而我们 items 里
   *   存的是**旧节点**。旧节点 isConnected === false，量它的 rect 全是 0 ——
   *   第 7 章的滚动同步会因此彻底失灵（而且不报错，只是永远不亮）。
   *
   * ★ 第 8.5 章的一个白赚的好处：签名从"页面上挂着谁"变成了"这次会话有哪几条"
   *   —— 于是**滚动再也不会改签名**。以前向上滚出一屏新消息就会全量重画一次面板，
   *   现在滚动期间面板一行都不重画，只刷新 el 引用。
   */
  function rebuild(force) {
    const list = currentList();
    syncLoading();             // ★ 十五补：currentList 之后 domTrusted 已定 → 顺手同步"加载中"占位
    maybeRefreshSpine(list);   // ★ 放在签名比较**之前**：骨架落后这件事在"没重画"的路径上也要被看到
    const sig = getSignature(list);

    if (!force && sig === signature) {
      // ── 同一批提问：面板不重画，但**必须**把节点引用刷新到最新。
      //    这里直接换成刚组好的那份，不再逐个 Object.assign：
      //      · 顺序、条数、key 都一模一样（签名相同就是证据）
      //      · title / tooltip 是 text 的派生物，重算一遍结果完全相同
      //      · 面板上的行 DOM 还是老的 —— 那正是我们要的（不红不闪）
      //    判据：**"数据要新、DOM 要旧"的时候，换数据、别碰 DOM。**
      items = list;
      syncActiveFromScroll();     // 节点换了位置，当前项可能也变了
      return;
    }

    // ── 签名变了（或 force）：全量重画 ──
    //    重画会把高亮清掉，所以先记下"重画之前是哪一条"，重画完再认回来
    const prevKey = items[activeIndex] ? items[activeIndex].key : null;

    signature = sig;
    items = list;
    CW_Sidebar.setItems(items);

    // ★ 锁内（用户刚点完跳转、还没自己滚动）：全量重画也绝不偷走高亮。
    //   先按稳定身份 prevKey 认领；认领不到（目标真不在列表了）也保持旧 activeIndex，
    //   绝不回退 syncActiveFromScroll——锁着它本就该被挡，且会算出"上一条"。
    //   （第 8.5 章：getChatId 抖动成空会让签名变 → 走全量路径，这条守卫挡住"误清高亮"。）
    if (Date.now() < activeLockUntil) {
      if (prevKey) {
        const idx = items.findIndex(function (m) { return m.key === prevKey; });
        if (idx >= 0) {
          activeIndex = idx; CW_Sidebar.setActive(idx, true);
          console.log("[CW][active] rebuild·锁内认领 prevKey=" + String(prevKey).slice(0, 10) + " → idx=" + idx);
        } else {
          console.log("[CW][active] rebuild·锁内认领失败 prevKey=" + String(prevKey).slice(0, 10) + "，保持 idx=" + activeIndex);
        }
      } else {
        console.log("[CW][active] rebuild·锁内无 prevKey，保持 idx=" + activeIndex);
      }
      return;   // 锁住：保持蓝条在当前项
    }

    activeIndex = -1;
    if (prevKey) {
      // 按 key（稳定身份）认领，而不是按 index（位置会被新消息挤走）
      const idx = items.findIndex(function (m) { return m.key === prevKey; });
      if (idx >= 0) {
        activeIndex = idx;
        CW_Sidebar.setActive(idx, true);
        console.log("[CW][active] rebuild·认领 → idx=" + idx);
        return;
      }
    }
    console.log("[CW][active] rebuild·回退 sync（未锁）");
    syncActiveFromScroll();
  }

  /* ────────────────────────────────────────────────────────────────────────
     四·五、第 8.5 章 · 拉"这一次会话的全部提问"
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 去接口要一份完整列表，回来之后**强制重画一次**。
   *
   * 时序上为什么是"先画一版、再补全量"（而不是等全量到了再画）：
   *   接口实测要 0.5~1.5 秒。等它回来再画，用户会经历"打开会话，右侧空白一秒多"；
   *   而先用页面上已经挂着的画一版，**目录立刻就在**，一秒后自己长全。
   *   判据：**首屏先给"现在有什么"，再补"应该有什么"。**
   *
   * ⚠️ 两个必须的守卫：
   *   ① 回来的时候会话已经切了 → 结果直接作废（否则会把上一个会话的目录贴到新会话上）
   *   ② 失败时 **spine 置 null**（不是保留旧的）→ 退回"只看页面已加载的"老行为。
   *      留着旧骨架会让用户看到一段**不属于这个会话**的目录，比"少几条"糟糕得多。
   *
   * @param {boolean} [force] true = 跳过缓存强制重拉（切会话时用）
   * @returns {Promise<void>}
   */
  function loadSpine(force) {
    const chatId = CW_Parser.getChatId();
    if (!chatId) return Promise.resolve();

    const p = CW_History.load(chatId, force).then(function (res) {
      // 守卫①：中途切了会话，这次的结果不要了
      if (CW_Parser.getChatId() !== chatId) return;

      spine = res.ok ? res.list : null;
      // ★ 2026-09-30 十二补：**归属只在成功时认领**。老写法把 spineChatId 在发起请求前就赋值，
      //   于是"拉失败"也记成"这段会话的骨架已经有了" —— 一个自相矛盾的状态（spine 是 null、
      //   归属却是它）。ensureSpine 就是靠这个字段判"手上这份属于谁"，语义必须诚实。
      spineChatId = res.ok ? chatId : "";
      if (res.ok) spineGeneration++;           // ★ 刷新成功与否，maybeRefreshSpine 要靠它区分
      if (!res.ok) {
        console.warn(
          "[CW] 没拿到完整提问列表（" + res.reason + "）：目录退回「只显示页面上已加载的那几条」。"
        );
      }
    });

    spineLoading = p;
    // ⚠️ 2026-09-28 补丁：拉完要把"在飞"标记放下来（原来只赋值从不清空 ——
    //    没人读过它所以没炸；现在 maybeRefreshSpine 的闸③要读它，不清就会永远"在飞"）。
    //    `=== p` 是防止把**新一轮**拉取的标记误清掉。
    // ★★ 2026-09-30 十三补：**重画必须排在"把在飞标记放下来"之后**（成功、失败都要）。
    //    因为 resolveDomTrust 是靠 spineLoading 区分两种状态的：
    //      · 还在飞        → 现在下结论太早，DOM 一律不可信（过渡期）；
    //      · 拉完但没有    → 没有可比对的东西 → 退回"看页面有什么"（否则接口一挂面板永远空白）。
    //    顺序反了的话，失败路径永远进不了第二种状态 —— 这正是本轮回归测试 [5] 抓到的坑。
    p.then(function () {
      if (spineLoading === p) spineLoading = null;
      rebuild(true);
    });
    return p;
  }

  /* ★ 2026-09-30 十二补 · 全量列表的「归属校验 + 有界补拉」───────────────────────
   *
   * 症状（用户实测）：**从 ChatGPT 首页 SPA 点进一个会话**之后，目录条数只有虚拟滚动里
   *   此刻挂着的那几条（真机实测：真实 24 条，面板只显示 3 条），而且**再等也不会变对**；
   *   按 F5 重新加载才慢慢正确。
   *
   * 根因（真机取证，链条三步）：
   *   ① boot() 的 loadSpine(false) 里 `if (!chatId) return` —— 首页地址是 `/`，
   *      getChatId() 兜底返回空串 → 这次全量拉取**直接跳过**（当时也确实无从拉起）；
   *   ② 之后 SPA 换到 `/c/<id>`，observer 拿到第一个真会话 id，走的却是
   *      "**首次建基准 → 对齐，绝不误清高亮**"这条分支（上版为防"getChatId 抖动成空
   *      被误判成切会话"而加的）—— 那条分支**只对齐身份，不补拉全量**；
   *   ③ 于是 spine 永远是 null，`merge(null, dom)` 原样返回 DOM 那份 → 条数只能是
   *      "页面上这会儿挂着的"。F5 之后是新文档，注入时地址已是 `/c/<id>`，
   *      boot 的拉取正常 → 才慢慢变对。
   *
   * 判据：**"高亮属于哪个会话"和"全量列表属于哪个会话"是两件事，不能共用一条判据。**
   *   前者要"宁可不动"（空值忽略、别误清高亮）；后者要"**必须有**"（缺了就补）。
   *   混在一起的代价就是这条 bug：为了修高亮漂移，顺手把全量加载也一起漏掉了。
   *
   * 治法：把"补全量"独立成一次归属校验 —— 任何时候只要"手上的 spine 不属于当前会话"就补拉。
   *   为什么要有界（SPINE_TRIES_MAX）＋ 冷却（SPINE_RETRY_MS）：它是**别人的私有接口**，
   *   永远不该被打成重试风暴；而"进会话那一刻接口还没就绪"这种竞态又确实要能自愈。
   *   上限用完就安静退回老行为（少几条，但目录和跳转照常工作）。
   */
  let spineTries = 0;          // 当前会话已尝试补拉的次数（拉成功 / 换会话时清零）
  let spineRetryAt = 0;        // 下次允许再试的时刻（冷却，防"每次页面抖动都打一遍"）
  const SPINE_TRIES_MAX = 4;
  const SPINE_RETRY_MS = 4000;

  /** 保证"手上有一份属于当前会话的全量列表"（没有就有界地补一次）。 */
  function ensureSpine() {
    const id = CW_Parser.getChatId();
    if (!id) return;                                                // 还不知道在哪个会话（首页）→ 下一轮
    if (spine && spineChatId === id) { spineTries = 0; return; }    // 本会话的全量已经在手上
    if (spineLoading) return;                                       // 已有拉取在飞 → 不并发
    if (spineTries >= SPINE_TRIES_MAX) return;                      // 有界：不给接口无限重试
    if (Date.now() < spineRetryAt) return;                          // 冷却
    spineRetryAt = Date.now() + SPINE_RETRY_MS;
    spineTries++;
    loadSpine(spineTries > 1);      // 第一次可以吃缓存；之后的每一条重试都强制重拉
  }

  /**
   * ★ 2026-09-28 补丁：骨架落后于页面时自动强制重拉（见文件顶部"骨架自动刷新"块）。
   *
   * 入参 merged —— rebuild 刚组好的完整列表（decorate 之前/之后都行，key 不受影响）。
   * 全程静默：这是"锦上添花"的数据源，拿不到就退回老行为，绝不报错打扰用户。
   */
  function maybeRefreshSpine(merged) {
    if (!spine || !spine.length || !merged || !merged.length) return;

    // 页面里有、骨架里没有（且没被"连续未命中"放弃的）→ 骨架落后了
    const giveUp = {};
    Object.keys(spineMiss).forEach(function (k) {
      if (spineMiss[k] >= SPINE_MISS_MAX) giveUp[k] = 1;
    });
    const foreign = CW_History.foreignKeys(spine, merged, giveUp);
    if (!foreign.length) return;

    if (spineLoading) return;                    // 闸③：已经有拉取在飞

    // ★ 2026-09-29：追赶窗口**先快后慢**。
    //   老写法是"没进冷却就 400ms，进了冷却就等满 30s" —— 新消息刚发出时接口
    //   常常要几秒才写进会话，第一次扑空（miss=1）就得干等 30s，目录上这条
    //   子提问要错挂半分钟。改成按 miss 次数退避：0.4s → 1.5s → 6s → 20s，
    //   再用老的 30s 冷却兜住上限（防杂条目把接口打死）。
    const miss = foreign.reduce(function (n, k) { return Math.max(n, spineMiss[k] || 0); }, 0);
    const backoff = SPINE_BACKOFF[Math.min(miss, SPINE_BACKOFF.length - 1)];
    const wait = Math.min(Math.max(0, lastSpineRefresh + SPINE_REFRESH_COOLDOWN - Date.now()), backoff);
    clearTimeout(spineRefreshTimer);
    spineRefreshTimer = setTimeout(function () {
      lastSpineRefresh = Date.now();
      const genBefore = spineGeneration;
      const p = loadSpine(true);
      if (!p) return;
      p.then(function () {
        // ★ 只在"这次刷新真的成功拿到新骨架"时才计 miss —— 拉取失败（断网/404）
        //   不能算"后端说没有"，否则断网一次就把所有 foreign key 全拉黑了。
        if (spineGeneration === genBefore) return;
        foreign.forEach(function (k) {
          const inSpine = spine && spine.some(function (m) { return m.key === k; });
          if (inSpine) delete spineMiss[k];      // 追平了：计数清零
          else spineMiss[k] = (spineMiss[k] || 0) + 1;
        });
      });
    }, wait || 400);      // 没进冷却就稍等一拍：把防抖窗口里的连续变更合并成一次拉取
  }

  /* ────────────────────────────────────────────────────────────────────────
     五、第 6 章 · 监听页面变化（替代第 3 章的 setInterval）
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 用 MutationObserver 盯着页面，页面一变（防抖后）就重建目录。
   *
   * 它一次管三件事：
   *   · 发新消息        → DOM 里多一个 user 单元 → 目录自动多一条
   *   · 切会话（SPA）   → 地址栏变、页面不刷新、脚本也不重新注入 → 按 href 判出来
   *   · 流式输出        → 抖动被防抖合并，列表不闪
   *
   * ⚠️ 为什么"自己画列表"不会把自己咬死：
   *   我们往 #cw-root 里插节点**也会**触发这个 observer（实测：插 1 个节点 = 1 条 record）。
   *   但防抖到期后第一件事是算签名，而"画列表"并不改变提问数组的签名
   *   → rebuild 直接 return。**用签名去重，比判断"这次变化是谁干的"更省心且更不容易漏。**
   *
   * ⚠️ 为什么要比 location.href（实测推翻"监听 popstate"那条路）：
   *   ChatGPT 切会话走的是 pushState / replaceState，而**这两个都不触发 popstate**
   *   （实测 0 次，hashchange 也是 0 次）。所以"监听 popstate 就知道切了会话"
   *   是错的，真正管用的是"observer 回调里发现 href 变了"。
   */
  /**
   * ★ 2026-09-30 十五补：**切会话的唯一入口**。
   *
   * 为什么把它从 observer 回调里抽出来单独成一个函数：
   *   ① **不再等防抖**。observer 的防抖是给"页面内容变了要重画"用的，
   *      而"切了会话"这件事决定了我们要不要**立刻**去拉新列表 —— 它不该陪跑一个防抖周期。
   *      现在 observer 回调**第一行**就同步调它（只读 location.pathname，很便宜）：
   *      真切会话 → 当场复位 + 发请求 + 亮"加载中"，把等待砍掉一个防抖周期。
   *   ② **同一套判据只写一份**。将来加分支（比如 popstate）时直接复用，
   *      不必再抄一遍复位代码 —— 抄一份就意味着改一处漏一处。
   *   ③ **幂等**：判据是 lastChatId 真的变了，第二次调用什么都不做。
   *
   * 判据（一条都不能少）：
   *   · `getChatId()` 为空 → **忽略**（SPA 抖动成空；空值 `"" !== lastChatId` 永远成立，
   *     不守卫就会每次 observer 都误判切会话 → 清高亮 + 放锁）；
   *   · 首次建基准（`lastChatId` 还空）→ 只对齐，不算切会话；
   *   · 只有「非空 **且** 确实变了」才是真切会话。
   *
   * @returns {boolean} 是否真切了会话（true = 已复位 + 已发请求 + 已重画）
   */
  function syncRoute() {
    const nowId = CW_Parser.getChatId();
    if (!nowId) return false;                                // 抖动成空 → 忽略
    if (nowId === lastChatId) return false;                  // 同会话
    if (!lastChatId) { lastChatId = nowId; return false; }   // 首次建基准 → 只对齐

    // ── 真切会话：lastChatId 已建立基准且 id 真的变了 ──
    //    清签名不是省事，是避开"新旧会话签名恰好相同"的撞车
    lastHref = location.href;
    lastChatId = nowId;
    signature = "";
    activeIndex = -1;
    activeLockUntil = 0;   // ★ 锁不跨会话（配合"锁到用户输入为止"的新语义）
    console.log("[CW][active] 切会话 → -1（锁释放）");
    // ★ 第 8.5 章：旧会话的骨架**立刻作废**（它是一条不属于新会话的目录）
    spine = null;
    spineChatId = "";                  // ★ 十三补：归属也要诚实（原先漏了这句）
    CW_History.clear();
    clearTimeout(spineRefreshTimer);   // ★ 旧会话排着的"骨架刷新"作废
    spineMiss = {};                    // ★ key 是会话内的身份，换会话全部作废
    spineTries = 0;                    // ★ 十二补：换会话 → 补拉预算重置（新会话有自己的额度）
    spineRetryAt = 0;
    capturedParentKey = null;          // ★ 第 11 章：捕获是会话内的瞬时上下文，换会话作废
    // ★ 十三补：过渡期的两条守则（都有真机实测背书，见 domTrusted / pendingSelectLast）
    domTrusted = false;                //   · 页面还挂着上一个会话 → DOM 不可信
    pendingSelectLast = true;          //   · 初始高亮还没定 → 定的时候按"打开会话看最新"来
    CW_Sidebar.setActive(-1, true);

    // ★ 十五补：**缓存命中就当场画对（"秒出"）** —— 切回刚刚看过的会话时，
    //   列表同步就有了，连"加载中"都不必出现；下面那趟请求只是后台校正。
    const cached = CW_History.peek(nowId);
    if (cached && cached.length) { spine = cached; spineChatId = nowId; }

    // ★★ 顺序很重要：**先发请求 → 再判"要不要显示加载中" → 最后重画**。
    //   · loadSpine 把"在飞"标记置上，resolveDomTrust 里"没有在飞就退回老行为"
    //     那一条全靠它；顺序反了，rebuild 会以为"没人拉 → 看页面有什么"，把旧会话收进来。
    //   · syncLoading 要读"在飞"标记，所以必须排在 loadSpine **之后**。
    loadSpine(true);
    syncLoading();
    rebuild(true);
    return true;
  }

  function observeDom() {
    if (!document.body) return;

    const observer = new MutationObserver(function () {
      // ★ 十五补：**先同步看一眼路由**（不等防抖）—— 真切会话就当场复位 + 发请求 + 亮"加载中"。
      syncRoute();
      clearTimeout(scanTimer);
      scanTimer = setTimeout(function () {
        syncRoute();      // 幂等：防抖期间路由又变、或首次建基准，都在这里兜住
        // ★ 十二补：与"切会话判定"**无关**的一次归属校验 ——
        //   首次拿到会话 id（首页 SPA 进会话）、或手上的 spine 不属于这里，就补拉全量。
        //   放在这儿是因为 observer 是"页面变了"的唯一入口：会话地址变了它一定被叫醒。
        ensureSpine();
        rebuild(false);
      }, SCAN_DEBOUNCE);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ────────────────────────────────────────────────────────────────────────
     五·五、第 8.5 章补 · 悬停预取（把"没看过的会话"提前变成"看过的"）
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * ★ 2026-09-30 十五补：**悬停预取**。
   *
   * 为什么值得做 —— 真机实测（`tools/probes/p88-loading-cache.js`，切到一个没看过的会话）：
   *     过渡态生效（loading 亮）  t ≈ 280ms
   *     权威列表到手              t ≈ 2450ms   ← ★ 这 2.2 秒**全是那趟接口**的耗时
   *     条数稳定                  t ≈ 2950ms
   *   而"看过的会话"因为有多槽缓存，**第一帧就正确**（同探针 [B] 段测到了）。
   *   所以**唯一能把那 2.2 秒砍掉的办法，就是在用户点击之前把列表取回来** ——
   *   把当前动作做快有上限，提前做没有。
   *   （判据：**"让下一个动作更快"的正解是提前做，而不是把当前动作做快。**）
   *
   * 手段：鼠标在左侧导航的会话链接上**停留 150ms** → 静默拉一次（走缓存，不 force）。
   *   ① 只进缓存、**不碰 UI** —— 预取结果永远不会"提前显示出来"，就算取错也看不见；
   *   ② 150ms 的停留阈值：扫过列表不会触发（人移到某条再点击通常远超 150ms）；
   *   ③ `peek` 已有就不拉、`load` 内部自带并发去重与 5 分钟缓存 → 连点同一条不会重复请求；
   *   ④ 失败**完全静默**（load 永不 reject），真切过去时照常走网络。
   */
  const PREFETCH_MS = 150;

  /** ★ 诊断计数（探针用：区分"事件没到监听器"和"到了但被守卫挡掉"） */
  const prefetchStats = { hover: 0, fired: 0, skipped: 0 };

  /** 从链接 href 里抠出会话 id（`/c/<id>`）。注意 href 可能是相对的。 */
  function chatIdOfHref(href) {
    const m = String(href || "").match(/\/c\/([^/?#]+)/);
    return m ? m[1] : "";
  }

  function observePrefetch() {
    let hoverTimer = 0;
    let hoveredHref = "";
    document.addEventListener("mouseover", function (e) {
      prefetchStats.hover++;
      const a = e.target && e.target.closest ? e.target.closest('a[href*="/c/"]') : null;
      const href = a ? String(a.getAttribute("href") || "") : "";
      if (href === hoveredHref) { prefetchStats.skipped++; return; }   // 同一条链接内移动
      hoveredHref = href;
      clearTimeout(hoverTimer);
      if (!href) { prefetchStats.skipped++; return; }
      const id = chatIdOfHref(href);
      if (!id || id === CW_Parser.getChatId()) { prefetchStats.skipped++; return; }  // 当前会话
      if (CW_History.peek(id)) { prefetchStats.skipped++; return; }                  // 已在手边
      hoverTimer = setTimeout(function () {
        prefetchStats.fired++;
        console.log("[CW][prefetch] " + id.slice(0, 8));
        CW_History.load(id);                             // 静默预取：结果只进缓存
      }, PREFETCH_MS);
    }, true);
  }

  /* ────────────────────────────────────────────────────────────────────────
     六、第 7 章 · 滚动同步"当前阅读位置"
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 挂滚动监听。
   *
   * ⚠️ 为什么不用 `window.addEventListener("scroll")`：
   *   实战里真正在滚的是页面内部那个 div（第 4 章 getScrollContainer 找到的那层），
   *   它的滚动**不冒泡**，所以在 window 上（冒泡阶段）根本收不到。
   *
   * ★ 这里用「document + capture:true」而不是直接监听那个容器：
   *   捕获阶段是从 window → document → ... → 目标一路下来的，
   *   所以任何一层滚动都能收到；而且**容器被 React 换掉也不会失效**
   *   （直接监听容器的话，容器一换，监听就挂在一个已经不在树上的旧节点上，
   *    症状是"滚了但高亮再也不动"）。
   */
  function observeScroll() {
    document.addEventListener("scroll", onAnyScroll, true);
    window.addEventListener("resize", onAnyScroll, { passive: true });
  }

  /**
   * 滚动事件的节流：一帧最多算一次。
   *
   * 滚动每秒能触发几十次，而同步逻辑里要读 getBoundingClientRect()
   * （会强制浏览器重新布局）。不做节流的话，滚动会明显发涩。
   *
   * ★★ 2026-09-28 修正：**忽略来自我们面板内部的滚动**。
   *    监听挂在 document 的捕获阶段，是**不分来源**的 ——
   *    滚我们自己的 `.cw-list` 也会走一遍全页 syncActive（白读几十个 rect）。
   *    而且"当前项"的判断依据是**页面消息的位置**，跟面板列表滚到哪毫无关系，
   *    所以那些计算全都是白做的。判据：事件的 target 在 #cw-root 里 → 直接不管。
   */
  function onAnyScroll(e) {
    if (e && e.target && e.target.nodeType === 1 && e.target.closest &&
        e.target.closest("#cw-root")) return;      // 面板自己的滚动，不算页面滚动
    if (rafId) return;                 // 本帧已经排过队了
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      syncActiveFromScroll();
    });
  }

  /**
   * 算出"当前在读哪一条"，需要的话更新高亮。
   *
   * ⚠️ 隐藏标签页里 rAF 会被挂起（第 4 章、第 5 章都踩过同一个坑），
   *    所以**别在后台标签页里测这个函数有没有被调用** —— 挂载是好的，只是帧不动。
   */
  function syncActiveFromScroll() {
    if (!items.length) return;

    // ★ 点击后的临时锁定：锁内不许动高亮，否则会跟"刚点的那个目标"抢当前项
    if (Date.now() < activeLockUntil) return;

    const anchor = window.innerHeight * SCROLL_ANCHOR_RATIO;
    let idx = -1;
    let bestTop = -Infinity;
    let firstVisible = -1;

    // ★ 第 11 章回归修复（添加子提问后"当前项高亮卡错"的根因）：
    //   items 已经**不是**页面视觉顺序——arrangeUnderParent 把子提问挪到父项正下方，
    //   于是"从上往下扫、遇到第一个 top>锚点 就 break"会提前停（被提前的子提问
    //   它的页面真实位置还在会话末尾，top 很大，一遇到它就 break，漏掉它下面真正的当前项）。
    //   改法：不再假设 items 与"屏幕从上到下"同序，直接在"所有 top<=锚点 的条目里
    //   取 top 最大者"（即离锚点最近、且在它上方的那条 = 当前阅读项）。
    for (let i = 0; i < items.length; i++) {
      const el = items[i].el;
      if (!el || !el.isConnected) continue;      // 易耗引用：失效就跳过
      const top = el.getBoundingClientRect().top;
      if (top > -window.innerHeight && firstVisible < 0) firstVisible = i;
      if (top <= anchor && top > bestTop) { bestTop = top; idx = i; }
    }

    // ── 兜底一：一条都没滚过锚线（全在视口下方）→ 取第一个在屏幕上的 ──
    if (idx === -1) {
      if (firstVisible >= 0) {
        idx = firstVisible;
      } else if (pendingSelectLast && items.length) {
        // ── 兜底二（十三补）：**一条都量不到** + 刚切过会话 → **选最后一条**。
        //    什么时候会这样：骨架已经到手（面板有 N 条），但页面的消息节点还没挂上
        //    （el 全是 null / 已游离）→ 几何量不出任何东西。
        //    这时按"打开一个会话是在看最新内容"来定，比默认第 0 条合理得多 ——
        //    用户报的就是"切换之后默认选中的应该是当前会话的最后一个提问"。
        idx = items.length - 1;
      } else {
        // ── 老实现这里写的是 `: 0` —— **量不出来却下结论说"当前是第 1 条"**。
        //    真机实测（p87）：切会话过渡期它给出 activeIdx=0，正是用户看到的"选错了"。
        //    判据：**量不出来的时候不要下结论。** 保持现状（不清、也不乱给）。
        return;
      }
    }
    pendingSelectLast = false;   // 初始高亮已经定下来了（无论靠几何还是靠兜底）

    if (idx !== activeIndex) {
      activeIndex = idx;
      CW_Sidebar.setActive(idx);
      console.log("[CW][active] scroll → idx=" + idx);
    }
  }

  /**
   * 给"当前项"上锁：锁内滚动同步一律不动高亮。
   *
   * 提前解锁的信号 = **用户亲手操作**（滚轮 / 触屏 / 键盘 / 按下鼠标）。
   *
   * ⚠️ 刻意**不**监听 scroll 事件 —— 跳转动画自己就会触发 scroll，
   *    挂上去的话锁在动画第一帧就被自己解掉了，等于没锁。
   *    **只有用户输入才是"用户想自己读"的可靠信号。**（"事件源 = 自己"的经典坑）
   *
   * ★★ 2026-09-28 补 pointerdown（实测逼出来的缺口）：
   *    上面三类信号漏了**拖动滚动条** —— 拖滚动条走的是 pointerdown + scroll，
   *    **一次 wheel 都不发**。实测（tools/probes/p64-latency-trace.js）：
   *    跳转后锁未过期时拖滚动条滚过 2.2 个视口，高亮纹丝不动，
   *    activeLocked 仍是 true —— 用户眼里就是"我滚了它不跟"，也就是"响应慢"。
   *    加 pointerdown 是安全的：触发跳转的那次点击，它的 pointerdown
   *    发生在 lockActive() **之前**，不会自己把自己的锁解掉。
   */
  function lockActive(why) {
    activeLockUntil = Infinity;   // ★ 2026-09-29：不再按时间过期，释放只认下面的用户输入
    console.log("[CW][lock] ON" + (why ? " <- " + why : ""));   // ★ 诊断：锁被谁上的
    if (lockArmed) return;
    lockArmed = true;
    const release = function (e) {
      activeLockUntil = 0;
      console.log("[CW][lock] OFF <- " + (e && e.type));       // ★ 诊断：锁被哪个输入放掉
    };
    window.addEventListener("wheel", release, { passive: true, capture: true });
    window.addEventListener("touchstart", release, { passive: true, capture: true });
    window.addEventListener("pointerdown", release, { passive: true, capture: true });
    window.addEventListener("keydown", release, true);
  }

  /* ────────────────────────────────────────────────────────────────────────
     七、第 4 / 5 章 · 点击跳转（+ 高亮 + 锁定当前项）
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 点目录条目 → 跳到那条提问。
   *
   * ★ 第 4 章返工（v0.4.2）的核心修正 —— 起因是用户实测反馈
   *   「点击面板里那条『?』会失灵，而且还是卡」。
   *
   * 过去这里做的是：「拿 index 去索引**刚刚重新解析出来的**列表」。
   * 听起来没错，但**目录是一张快照，会话内容却在变**：
   *   · SPA 切换会话、向上滚时补挂载更老的消息、编辑 / 切分支……
   *   任何一次变化都会让 index 的含义**整体位移**。
   * 实测（tools/probes/p39-index-mismatch-quick.js）：
   *   面板第 4 条写着「？」，而实时 list[3] 是另一条消息，**6 条全部对不上**。
   * 于是同一次点击有两种坏结果：
   *   · 指到一条很远的老消息 → 白跨几万像素的整屏重排 → **卡**
   *   · 指到一条**已经在屏幕上**的消息 → scrollTo 走"已在好位置就不动"
   *     那条分支、直接返回 → 用户看到 **点了没反应 = 失灵**
   *
   * 修法：以 `key`（data-message-id，**跨重渲染稳定**）为准，index 只当兜底。
   *
   * ★★ 第 8.5 章：目录里现在有"页面上根本没挂载"的条目，于是这里分成两条路 ——
   *   · 目标挂着（有 el）      → 老路径，**同步完成**，点下去那一刻就走
   *   · 目标没挂（el === null）→ 新路径：先乐观高亮 + 上锁（让蓝条**立刻**到位），
   *                              再让 parser.reveal 把那条搜出来，找到了才滚过去 + 闪
   *   判据：**"马上能做到"和"要等一会儿才能做到"必须分开写** ——
   *        否则慢路径的等待会把快路径的即时感一起拖没（用户会以为"整个都变慢了"）。
   */
  function jumpTo(index, key) {
    console.log("[CW][jump] click index=" + index + " key=" + String(key).slice(0, 10));   // ★ 诊断
    // ── ① 先定目标：按稳定身份 key 在**完整列表**里找；没有 key 才退回 index
    //
    //    第 8.5 章起这里不再重新解析页面：`items` 本来就是"这一次会话的全部提问"，
    //    它比页面上的 DOM 更权威。少一次解析 = 少一次强制布局 = 点下去更干脆。
    let target = null;
    let how = "";
    if (key) {
      target = items.find(function (m) { return m.key === key; }) || null;
      if (target) how = "key";
    }

    // ── ② key 明确给了、但完整列表里没有它 = 这份目录确实过期了 ──
    //    （会话被编辑 / 切了分支 / 我们手上的骨架还是上一版）
    //    ★ 此时**绝不能退回去按 index 猜**：index 已经整体位移，
    //      猜的结果就是"跳去一条不相干的消息"（远则白跨几万像素 = 卡，
    //      近则已经在屏幕上 = 点了没反应），正是第 4 章要修的那个 bug。
    if (!target && key) {
      console.warn(
        "[CW] 目录已过期：第 " + index + " 条「" + String(key).slice(0, 8) + "…」" +
        "已不在会话里（会话可能被编辑/切过分支）。已重建目录，请再点一次。"
      );
      rebuild(true);
      loadSpine(true);        // 顺手强制重拉一次 —— 也可能是我们手上的骨架旧了
      return;
    }

    // ── ③ 这条压根没有 key（解析兜底出来的）→ 只能按位置猜，说清楚 ──
    if (!target) {
      target = items[index] || null;
      how = "index（这条没有 key，只能按位置）";
    }
    if (!target) {
      console.warn("[CW] 第 " + index + " 条拿不到目标。已重建目录，请再点一次。");
      rebuild(true);
      return;
    }

    // ── ④ 目标就挂在页面上 → 老路径（同步，即时）
    if (target.el && target.el.isConnected) {
      land(target.el, target, how);
      return;
    }

    // ── ⑤ 目标没挂载 → 乐观高亮 + 上锁，然后去搜
    //    "乐观"的意思是：不等搜索结果，先把蓝条放到用户点的那一条上。
    //    否则用户点完要盯着一个**没反应**的面板等 0.3~3 秒（那正是"响应慢"）。
    markActive(target.key);
    lockActive("jumpTo");
    jumpSeq++;
    const my = jumpSeq;
    const chatId0 = CW_Parser.getChatId();

    CW_Parser.reveal(target.key, items, function () { lockActive("reveal"); }).then(function (el) {
      if (my !== jumpSeq) return;                       // 用户又点了别的条目，这次作废（新点击已自己上锁）
      const nowId0 = CW_Parser.getChatId();
      if (nowId0 && nowId0 !== chatId0) {               // 中途切了会话（getChatId 抖动成空不算）
        activeLockUntil = 0;                            // ★ 别把锁带进新会话（2026-09-29）
        console.log("[CW][lock] OFF <- reveal·切会话");
        return;
      }
      if (!el || !el.isConnected) {
        console.warn(
          "[CW] 第 " + (target.order + 1) + " 条没能在页面上找出来" +
          "（整段搜遍仍然没挂载）。目录是对的，这条暂时点不过去。"
        );
        // ★★ 2026-09-29：跳失败**不再放锁** —— 锁的语义已是"锁到用户亲手操作为止"。
        //   保持锁 → 高亮停在用户点的那一条（乐观 markActive 已认领），直到用户滚动才交还跟随。
        //   旧代码"失败就放锁"是给 2 秒定时锁写的：新语义下一放锁，滚动同步立刻把高亮偷回
        //   "锚线上一条" —— 正是"点了子提问、过几秒（reveal 搜完失败）高亮自己跳到上面某条"。
        console.log("[CW][lock] 保持锁（跳失败但高亮停在用户点的那条）");
        return;
      }
      land(el, target, how || "seek");
    });
  }

  /**
   * 落位：滚过去 → 闪一圈 → 认领当前项 → 上锁。
   *
   * @param {Element} el     —— 目标气泡（活节点）
   * @param {Object}  target —— 完整列表里那一条（用来报"第几条/什么内容"）
   * @param {string}  how    —— 怎么找到的（key / index / seek），只用于日志
   */
  function land(el, target, how) {
    if (!CW_Parser.scrollTo(el)) {
      console.warn("[CW] 第 " + (target.order + 1) + " 条拿不到可用节点。");
      return;
    }

    // ★ 第 5 章：跳过去之后闪一圈，让用户的眼睛立刻找到落点
    CW_Parser.flash(el);

    // ★ 第 7 章的顺序讲究（别调换）：
    //   ① 先把数据对齐 —— 刚搜出来的目标此刻才有 el，不刷新的话
    //      下一次 syncActiveFromScroll 还是找不到它（高亮会莫名其妙丢）
    //   ② 再认领当前项
    //   ③ 最后上锁 —— 锁的是"之后的滚动"，不是这一次
    rebuild(false);
    markActive(target.key);
    lockActive("land");

    // 把"到底跳到了哪一条"打出来 —— 这是排查"跳错/没反应"最快的线索
    console.log(
      "[CW] 跳到第 " + (target.order + 1) + " 条（按 " + how + "）：" +
      JSON.stringify(String(target.text || "").replace(/\s+/g, " ").slice(0, 20))
    );
  }

  /**
   * 把"当前项"认领到某个 key 上（-1 = 没有找到）。
   *
   * 为什么按 key 而不是按 index：完整列表的 index 是稳定的，
   * 但点击时手上那份 items 可能已经被"新消息插入"挤过位 —— key 不会。
   */
  function markActive(key) {
    const idx = items.findIndex(function (m) { return m.key === key; });
    if (idx < 0) {
      console.log("[CW][active] markActive 失败：key 不在 items（" + String(key).slice(0, 10) + "）");
      return;
    }
    activeIndex = idx;
    CW_Sidebar.setActive(idx, true);
    console.log("[CW][active] markActive key=" + String(key).slice(0, 10) + " → idx=" + idx);
  }

  /* ────────────────────────────────────────────────────────────────────────
     七·B · 第 13 章 · 「回到刚才」
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 「回到刚才」把片段端到视口高度的哪一档。
   *
   * ★ 为什么是 0.38，**故意不等于**第 7 章的锚线 0.32：
   *   锚线（0.32）用来"判断用户正在读哪一条"，它是**判据**；
   *   落位线（0.38）用来"把目标端到眼前"，它是**动作**。
   *   两者是两件事，硬凑成一个数只会两头都不讨好 —— 判据要略微靠上（先于视线换条），
   *   落位要略微居中（看得到上下文）。
   */
  const BACK_ANCHOR_RATIO = 0.38;

  /**
   * 按 key 找"此刻真正挂在页面上"的那条消息（活节点）；找不到返回 null。
   *
   * ⚠️ 为什么不直接用 items[i].el：
   *   ChatGPT 是虚拟滚动，滚动/重渲染随时把节点换掉。items 里存的那份可能已经
   *   游离（isConnected === false），量它 rect 全是 0 —— 而且**不报错**，只是永远不对。
   *   ★ 纪律：**凡是要动节点，先按 key 现场重取**，别信跨帧存下来的引用。
   */
  function liveElOf(key) {
    const arr = CW_Parser.getMountedKeys ? CW_Parser.getMountedKeys() : [];
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].key === key && arr[i].el && arr[i].el.isConnected) return arr[i].el;
    }
    return null;
  }

  /**
   * 「← 回到刚才」：当前项是子提问时，回到它**父提问回答里的那段原文**并高亮它。
   *
   * 它其实是 jumpTo 的"更精确版本"：同一台机器（上锁 / 乐观高亮 / reveal 步进搜索 /
   * 失败如实日志），只在"拿到父提问的活节点之后"分岔 ——
   *   有选中文 → 找片段、滚到它、高亮它；
   *   没选中文 → 退回第 4 章老路径（落到父提问本身并闪它）。
   *
   * @param {string} parentKey 父提问的稳定 key（由面板交过来）
   */
  function backToParent(parentKey) {
    const child = items[activeIndex];
    const selection = (child && child.selection) || "";      // 子提问的"返回点坐标"
    const pi = items.findIndex(function (m) { return m.key === parentKey; });
    if (pi < 0) { console.warn("[CW] 回到刚才：父提问不在当前目录里，放弃"); return; }
    const parent = items[pi];

    // ⚠️ 不用在这里收气泡：面板的按钮点击处理里已经收过了（sidebar.bindActions）。
    //    本文件里 jumpTo 也不管气泡 —— 保持同一条分工：**面板的自身体验，面板自己收拾。**
    lockActive("backToParent");   // 先上锁：落位期间不许滚动同步把高亮抢走
    markActive(parent.key);       // 乐观高亮：点完立刻看到"当前项"换到父提问
    jumpSeq++;                    // 让"上一次还在飞的跳转"作废（同 jumpTo 的套路）
    const my = jumpSeq;
    const chatId0 = CW_Parser.getChatId();

    /** 已经拿到父提问的活节点之后的落位 */
    const settle = function (el) {
      if (my !== jumpSeq) return;                              // 期间又点了别的
      const nowId = CW_Parser.getChatId();
      if (nowId && nowId !== chatId0) {                        // 中途切了会话（抖动成空不算）
        activeLockUntil = 0;
        console.log("[CW][lock] OFF <- back·切会话");
        return;
      }
      // ★ 再认领一次活节点：调用方手里的 el 可能是上一帧拿的（虚拟滚动随时会换）
      el = liveElOf(parent.key) || el;
      if (!el || !el.isConnected) {
        console.warn("[CW] 回到刚才：父提问的节点已经不在页面上了。");
        return;
      }

      // ① 找那段原文（findFragment 内部自己走"回答区优先 + 逐级降级"）
      const hit = selection ? CW_Parser.findFragment(el, selection) : null;
      if (hit) {
        // ★★ 落位 = **有界闭环**：滚 → 等停稳 → 重新量 → 差得远就再来一轮。
        //    为什么不能"滚一次就完"（十六补真机取证）：
        //      平滑滚动期间 React 会重建滚动窗口上方的内容 → 内容总高变了 →
        //      `scrollTop` 的原点跟着漂。于是"滚动前读到的那个矩形"作废，
        //      停下时片段可能停在 719px，而不是我们想要的 277px。
        //      （实测：一次滚 → top=719；补一次 → top=278，精确到位。）
        //    这正是那条"估距离：整体平均起步、**局部测量修正**"的落点版：
        //      先滚一步（用当时的测量），停下后**再量一次**、把残差补掉。
        //    ⚠️ 每一轮都要**重新认领节点 + 重新定位**，绝不复用旧 Range ——
        //      跨帧/跨动画持有节点引用，是本项目反复栽过的那条纪律。
        const want = (window.innerHeight || 600) * BACK_ANCHOR_RATIO;
        let round = 0;
        const arrive = function (seed) {
          round++;
          CW_Parser.scrollRangeTo(seed.range, BACK_ANCHOR_RATIO);
          // 读的是"片段此刻在屏幕上的位置"：它不动了 = 到地方了。
          // （比读 scrollTop 更贴意图 —— scrollTop 会因为上方内容重建而变，
          //   屏幕位置才是用户真正看到的东西。）
          const readTop = function () {
            const f = liveElOf(parent.key) || el;
            if (!f || !f.isConnected) return null;
            const h = CW_Parser.findFragment(f, selection);
            if (!h) return null;
            try {
              const r = h.range.getBoundingClientRect();
              return (r && (r.width || r.height)) ? r.top : null;
            } catch (e) { return null; }
          };
          CW_Parser.whenSettled(readTop, { minMs: 320, maxMs: 1400 }).then(function (steady) {
            if (my !== jumpSeq) return;
            const fresh = liveElOf(parent.key) || el;
            const again = fresh && fresh.isConnected ? CW_Parser.findFragment(fresh, selection) : null;
            const range = (again && again.range) || seed.range;
            let top = null;
            try {
              const r = range.getBoundingClientRect();
              if (r && (r.width || r.height)) top = r.top;
            } catch (e) { top = null; }
            // 残差还大 且 没超轮次 → 补一轮（有界：最多 3 轮）
            if (top != null && Math.abs(top - want) > 24 && round < 3) {
              arrive(again || seed);
              return;
            }
            if (!CW_Parser.flashRange(range)) {
              console.warn("[CW][back] 片段定位成功但没能画出高亮（滚动期间节点被重建？）");
            } else {
              // ★ 靠"没等稳 / 补了一轮"救回来的绿要如实报出来（不隐藏、也不伪装成一次过）
              console.log("[CW][back] 命中片段（mode=" + seed.mode + " used=" + seed.used + " 字" +
                "；落位轮次 " + round + (steady ? "" : "，⚠️ 本轮未在 1.4s 内停稳，是兜底点亮的") + "）");
            }
          });
        };
        arrive(hit);
        rebuild(false);
        markActive(parent.key);
        lockActive("back-land");       // 续锁：落位期间不许滚动同步抢走高亮
        return;
      }

      // ②③ 没有"可回去的片段" → 落到父提问本身并闪它（第 4 章那条老路径）
      if (selection) {
        console.warn(
          "[CW][back] 没能在父提问里找回那段原文（\"" + selection.slice(0, 18) +
          "…\"）→ 退回到父提问本身。目录是对的，只是这次落点不够精确。"
        );
      }
      land(el, parent, "back");
    };

    // 父提问就挂在页面上 → 同步走（绝大多数点击）
    if (parent.el && parent.el.isConnected) { settle(parent.el); return; }

    // 父提问被虚拟滚动卸了 → 先搜出来（乐观高亮已经上去了，面板不会"没反应"）
    CW_Parser.reveal(parent.key, items, function () { lockActive("back-reveal"); }).then(function (el) {
      if (my !== jumpSeq) return;
      if (!el || !el.isConnected) {
        console.warn("[CW] 回到刚才：父提问没能在页面上找出来（整段搜遍仍然没挂载）。");
        // ★ 跳失败**不放锁**：高亮停在用户点的那条（同 jumpTo 的语义，2026-09-29 定案）
        return;
      }
      settle(el);
    });
  }

  /* ────────────────────────────────────────────────────────────────────────
     八、启动
     ──────────────────────────────────────────────────────────────────────── */

  function boot() {
    // 挂卡片。★ 只在这一处调 mount() —— 见 sidebar.js 里关于"回调会被覆盖"的说明。
    CW_Sidebar.mount({ onJump: jumpTo, onBack: backToParent });

    rebuild(true);      // ① 先用"页面上已加载的几条"画一版 —— 目录立刻就在（不等网络）
    ensureSpine();      // ② 再去要完整列表（★ 十二补改：走"归属校验"，首页无 chatId 时也能在
                        //    进入会话后被 observer 再叫一次；回来之后自己会 rebuild(true) 补全）
    observeDom();       // 第 6 章：之后转入"页面有变就响应"模式
    observeScroll();    // 第 7 章：滚动时同步当前项
    observeSelection(); // 第 11 章：选中回答文字时捕获"这条子提问该挂哪"
    observePrefetch();  // ★ 十五补：悬停左侧导航时预取那份列表（切过去就能"秒出"）
    // ★ 十五补：空闲时**预热 accessToken**（页面稳定后就打掉那趟 /api/auth/session）。
    //   效果：用户第一次切会话时，loadSpine 只剩**一趟**请求 —— 过渡时间随之变短。
    //   用 setTimeout 而不是立刻，是为了不跟首屏渲染抢资源；拿不到也不影响任何功能。
    setTimeout(function () { CW_History.warmToken(); }, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  /* ────────────────────────────────────────────────────────────────────────
     九、给探针 / 控制台留的入口（第 4 章之后加的，方便自动化验收）
     ──────────────────────────────────────────────────────────────────────── */

  window.__CW_DEBUG__ = {
    get items() { return items; },
    get activeIndex() { return activeIndex; },
    get signature() { return signature; },
    get activeLocked() { return Date.now() < activeLockUntil; },
    get spine() { return spine; },                 // ★ 第 8.5 章：接口给的完整列表本体
    get spineChatId() { return spineChatId; },
    // ★ 十三补回归/探针用：切会话过渡期的两个状态
    get domTrusted() { return domTrusted; },          // DOM 条目此刻可不可信
    get pendingSelectLast() { return pendingSelectLast; }, // 初始高亮还没定？
    get loading() { return CW_Sidebar.isLoading ? CW_Sidebar.isLoading() : false; }, // ★ 十五补
    get prefetch() { return prefetchStats; },     // ★ 十五补：悬停预取计数（诊断用）
    get spineTries() { return spineTries; },       // ★ 十二补回归测试用：补拉已用掉的预算
    ensureSpine: ensureSpine,                      // ★ 十二补回归测试用：手动跑一次归属校验
    loadSpine: loadSpine,                          // ★ 探针用它强制重拉 / 验兜底
    currentList: currentList,                      // ★ 探针用它单测"骨架 + 活节点"的合并结果
    rebuild: rebuild,
    syncActive: syncActiveFromScroll,
    jump: jumpTo,
    back: backToParent,            // ★ 第 13 章：「回到刚才」（回到父提问的那段原文）
    lockActive: lockActive,        // ★ 2026-09-29 回归测试用：模拟"点击后上锁"
    // ★ 第 11 章回归测试用：直接喂一组 items（每条带 mocked el），跑一遍
    //   syncActiveFromScroll 并返回最终 activeIndex。不改生产路径。
    setItemsForTest: function (arr) { items = arr; syncActiveFromScroll(); return activeIndex; }
  };
})();
