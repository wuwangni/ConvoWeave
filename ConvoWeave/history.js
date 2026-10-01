/**
 * ============================================================================
 *  history.js —— ConvoWeave 的"完整提问列表"数据源（第 8.5 章）
 * ============================================================================
 *  为什么需要这个文件（2026-09-28 真机实测，别按直觉写）：
 *
 *    这个会话里有 **13 条**提问，而 DOM 里只挂着 **6 条** —— 而且那 6 条正好是
 *    完整列表里的第 3~8 条，是一段**连续窗口**。往上/往下滚动，窗口就跟着平移。
 *    → ChatGPT 把视口外的消息**卸载**了（虚拟滚动）。
 *    → 只看 DOM 的目录**天生不完整**：进会话只看到 6 条，滚两下又变成 4 条或 8 条。
 *
 *  想要"进会话就把这一次会话的所有提问都加载好"，DOM 这条路走不通 ——
 *  只能问 ChatGPT 自己要一份完整会话，也就是它自己的接口：
 *
 *     GET /api/auth/session                      → { accessToken, ... }
 *     GET /backend-api/conversation/<chatId>     → { title, mapping, current_node, ... }
 *         ⚠️ 必须带 Authorization: Bearer <accessToken>（实测不带 = 404「请登录以查看此对话」）
 *
 *  ⚠️ 隐私与权限，必须写在明处：
 *    · 两个请求都是**同源**请求（打给 chatgpt.com 自己），带的是用户**已有的**登录态；
 *      没有第三方、没有多余数据出浏览器 —— 它就是把用户自己那段会话再读一遍。
 *    · 因此 manifest **一个权限都不用加**（同源请求不需要 host_permissions）。
 *      "加功能没加权限"是可以做到的事，判据是：**这个能力浏览器是否已经给了页面自己。**
 *
 *  ⚠️ 这一章的取舍：接口是**别人的私有实现**，会变、可能某天 404。
 *    所以它必须**可以整段失效而不影响主功能**：
 *      拿不到 → 返回 ok:false → 调用方退回"只用页面已加载的那几条"（第 0~8 章的老行为）。
 *    判据：**新增的数据源必须是"锦上添花"，不能是"没了就瘫"。**
 *
 *  ⚠️ 这个文件与 ChatGPT 的 DOM **完全无关**：一个页面选择器都没有。
 *    它只认识 JSON。所以它和 sidebar.js 一样，是"改版也不用动"的那一类文件。
 * ============================================================================
 */
window.CW_History = (function () {
  "use strict";

  /* ────────────────────────────────────────────────────────────────────────
     一、常量
     ──────────────────────────────────────────────────────────────────────── */

  /** 会话信息所在的接口（同源） */
  const SESSION_URL = "/api/auth/session";
  const CONVERSATION_URL = "/backend-api/conversation/";

  /**
   * 同一段会话多久之内不重复拉。
   *
   * 为什么需要：切会话、手动刷新、以及"页面变化触发的重建"都可能要求刷新，
   * 不做缓存的话一个 40 条的长会话会被反复拉，既慢又白耗流量。
   * 5 分钟是"用户不会察觉过期、但足以摊掉重复请求"的量级。
   */
  const CACHE_MS = 5 * 60 * 1000;

  /** 取不到文字时的占位符（与 parser.js 的口径保持一致） */
  const PLACEHOLDER_IMAGE = "[图片消息]";
  const PLACEHOLDER_FILE = "[附件消息]";

  /* ────────────────────────────────────────────────────────────────────────
     二、模块内部状态
     ──────────────────────────────────────────────────────────────────────── */

  /* ★ 2026-09-30 十五补 · 缓存改造（性能）──────────────────────────────────
   *  原来只有一个**单槽**缓存 `{ chatId, at, list }`，一切会话就被覆盖。
   *  代价：来回切会话（A→B→A）每次都要重新走两趟网络 —— 而"切会话"正是
   *  这个插件最常发生的动作（左侧导航点来点去）。
   *
   *  改成**多槽 Map**（插入序 = 使用序，超容量丢最旧）：切回最近看过的会话
   *  可以**同步**命中（见 peek）→ 面板一帧就正确，不必等网络。
   *
   *  另外把 token 单独缓存：`/api/auth/session` 的返回在一次登录里是稳定的，
   *  每个会话都重新问一遍纯属浪费 —— 它让每次拉取多付**一趟串行 RTT**。
   *  （这两条都不改变对外契约：拿不到仍然返回 ok:false，只是更快。）
   */
  const CACHE_MAX = 8;

  /** 会话列表缓存：chatId → { at, list }（Map 保插入序，超容量丢最旧的） */
  const cacheMap = new Map();

  /** accessToken 缓存（同一个浏览器会话里可复用；401/403 时强制换一次） */
  const TOKEN_MS = 5 * 60 * 1000;
  let tokenCache = { token: "", at: 0 };

  /** 正在飞的请求：{ chatId, promise } —— 防止同一个会话并发拉两次 */
  let inflight = { chatId: "", promise: null };

  function cacheGet(chatId) {
    const e = cacheMap.get(chatId);
    if (!e) return null;
    if (Date.now() - e.at >= CACHE_MS) { cacheMap.delete(chatId); return null; }
    return e.list;                       // 可能是 null（拉过但失败）
  }

  function cacheSet(chatId, list) {
    if (cacheMap.has(chatId)) cacheMap.delete(chatId);      // 先删再插 = 挪到"最新"
    cacheMap.set(chatId, { at: Date.now(), list: list });
    while (cacheMap.size > CACHE_MAX) {                     // 淘汰最旧的一条
      cacheMap.delete(cacheMap.keys().next().value);
    }
  }

  /**
   * 同步看一眼"这个会话的完整列表在不在手边"（新鲜才算）。
   * content.js 切会话时先问它 —— 命中就**当场**把面板画对，再去后台校正。
   * 返回：Array | null（null = 没缓存 / 过期 / 上次失败）
   */
  function peek(chatId) {
    if (!chatId) {                                          // 无参 = 最近一条（兼容老语义）
      let last = null;
      cacheMap.forEach(function (e) { last = e; });
      return last && last.list && last.list.length ? last.list : null;
    }
    const list = cacheGet(chatId);
    return list && list.length ? list : null;
  }

  /* ────────────────────────────────────────────────────────────────────────
     三、卡 1 · 把一条 message 变成纯文本
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 从 message.content 里抠出"用户写下的那句话"。
   *
   * ⚠️ 实测两个坑（2026-09-28）：
   *   ① `content.parts` 是**数组**，里面**不全是字符串** ——
   *      带图的那两条 content_type 是 "multimodal_text"，parts 里混着
   *      `{ content_type: "image_asset_pointer", ... }` 这种对象。
   *      直接 join 会得到 "[object Object]" 混进标题里。
   *      → 只取 typeof === "string" 的片段。
   *      （实测：这样取出来的文本与页面 DOM 的 innerText **逐字符一致**。）
   *   ② 只有图、没打字的那种提问，抠出来是空串 —— 得给占位符，
   *      否则目录里会出现一行**空白条目**（比"缺少标题"更难查）。
   *
   * 入参：msg —— 接口返回的 message 对象（可能为 null / 缺字段）
   * 返回：string（永远不返回 null / undefined）
   *
   * ⚠️ 契约里有两档"空的"，别混：
   *    · 压根没有这条消息（null）→ **空串** —— 跟 parser.extractText(null) 同口径。
   *      它会在 content.js 的 decorate() 里被兜成「未命名提问」，不会是空白条目。
   *    · 有这条消息、但里面一个字都没有（纯图/纯附件）→ **占位符**。
   *    判据：**"没有数据"和"数据是空的"是两件事，别用同一个值表示。**
   */
  function messageText(msg) {
    if (!msg) return "";
    const content = msg.content || {};
    const parts = Array.isArray(content.parts) ? content.parts : null;

    let text = "";
    if (parts) {
      const strs = parts.filter(function (p) { return typeof p === "string"; });
      text = strs.join("\n").trim();
      if (!text) {
        // 没有任何字符串片段 → 判断它是"图"还是"文件"
        const hasImage = parts.some(function (p) {
          return p && (p.content_type === "image_asset_pointer" ||
                       String(p.content_type || "").indexOf("image") >= 0);
        });
        return hasImage ? PLACEHOLDER_IMAGE : PLACEHOLDER_FILE;
      }
    } else if (typeof content.text === "string") {
      text = content.text.trim();          // 老格式（纯 text 字段）
    }
    return text || PLACEHOLDER_FILE;
  }

  /* ────────────────────────────────────────────────────────────────────────
     四、卡 2 · load(chatId) —— 问接口要一份完整会话
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 拉取某段会话的**全部提问**（按时间正序）。
   *
   * 入参：chatId —— 会话 id（地址栏 /c/<id> 里那一段）
   *      force  —— true = 跳过缓存强制重拉
   * 返回：Promise<{ ok:boolean, list:Array|null, reason:string }>
   *      · ok=true  → list = [{ key, text }]（key 就是 message id，与页面的 key 同源）
   *      · ok=false → list=null、reason 说明原因；调用方**必须**能照常工作
   *
   * ⚠️ 这里**绝不 reject**：失败也是返回值的一部分。
   *    判据：**调用方要写 catch 的 API，等于把"错误处理"变成可选项**，
   *    迟早有人忘；改成返回值就不可能忘。
   */
  function load(chatId, force) {
    if (!chatId) return Promise.resolve({ ok: false, list: null, reason: "没有会话 id" });

    // ── 缓存命中（只在成功过的时候；失败不缓存 → 允许下次重试）
    if (!force) {
      const hit = cacheGet(chatId);
      if (hit && hit.length) return Promise.resolve({ ok: true, list: hit, reason: "cache" });
    }
    // ── 同一个会话已经在飞 → 复用同一个 promise（并发去重）
    if (inflight.chatId === chatId && inflight.promise) return inflight.promise;

    const p = getToken(false)
      .then(function (token) { return fetchConv(chatId, token); })
      .catch(function (err) {
        // ★ 2026-09-30：token 可能刚过期（缓存 5 分钟）。401/403 时**强制换一次**再试，
        //   只试一次 —— 判据同第 8.5 章：别人的私有接口，永远不许打成重试风暴。
        if (!isAuthErr(err)) throw err;
        return getToken(true).then(function (t) { return fetchConv(chatId, t); });
      })
      .then(function (conv) {
        const list = matchListFrom(conv);
        cacheSet(chatId, list);
        inflight = { chatId: "", promise: null };
        return { ok: true, list: list, reason: "ok" };
      })
      .catch(function (err) {
        inflight = { chatId: "", promise: null };
        return { ok: false, list: null, reason: String((err && err.message) || err) };
      });

    inflight = { chatId: chatId, promise: p };
    return p;
  }

  /**
   * 拿 accessToken（有缓存就不走网络）。
   * forceFresh=true → 跳过缓存（401/403 之后用）。
   */
  function getToken(forceFresh) {
    if (!forceFresh && tokenCache.token && Date.now() - tokenCache.at < TOKEN_MS) {
      return Promise.resolve(tokenCache.token);
    }
    return fetchJSON(SESSION_URL).then(function (session) {
      const token = session && session.accessToken;
      if (!token) throw new Error("没有 accessToken（未登录？）");
      tokenCache = { token: token, at: Date.now() };
      return token;
    });
  }

  /**
   * ★ 2026-09-30 十五补：**空闲时预热 token**。
   *   切会话时省掉的那一趟 RTT 就是它换来的 —— 页面加载完之后提前把
   *   `/api/auth/session` 打掉，用户第一次点会话时 loadSpine 只剩一趟请求。
   *   全程静默：拿不到就算了（真的切会话时再要也一样）。
   */
  function warmToken() {
    return getToken(false).then(function () { return true; }, function () { return false; });
  }

  function fetchConv(chatId, token) {
    return fetchJSON(CONVERSATION_URL + encodeURIComponent(chatId), {
      headers: { "Authorization": "Bearer " + token }
    });
  }

  function isAuthErr(err) {
    return /HTTP (401|403)\b/.test(String((err && err.message) || ""));
  }

  /** 一个薄薄的 fetch 封装：同源带上登录态、非 2xx 一律当失败 */
  function fetchJSON(url, opts) {
    const o = Object.assign({ credentials: "include", cache: "no-store" }, opts || {});
    return fetch(url, o).then(function (res) {
      if (!res.ok) throw new Error(url.split("?")[0] + " → HTTP " + res.status);
      return res.json();
    });
  }

  /**
   * 从会话 JSON 里抽出"当前这条分支上的全部用户提问"。
   *
   * ★★ 为什么要沿 `current_node` 一路往回走（`parent` 指针），而不是遍历整个 mapping：
   *    `mapping` 是一棵**树**，里面装着这段会话的**全部历史** ——
   *    包括用户编辑过的旧版本、被分支甩掉的那些回答。
   *    直接遍历会把"已经不在对话里的提问"也算进来（目录里会冒出用户早就删掉的句子）。
   *    只有从 current_node 沿 parent 回溯，得到的才是**此刻屏幕上正在显示的这条线**。
   *    （实测这段会话 mapping 82 个节点 / 用户消息 13 条，恰好等于当前分支的用户消息数；
   *      也就是说这次会话没有被编辑过，但**不能靠运气**。）
   *
   * 入参：conv —— 接口返回的会话对象
   * 返回：Array<{ key, text }>
   */
  function matchListFrom(conv) {
    const map = (conv && conv.mapping) || {};
    const chain = [];
    let cur = (conv && conv.current_node) || null;
    let guard = 0;

    // guard：万一 parent 指针成环（数据坏了），别把页面转死
    while (cur && map[cur] && guard++ < 5000) {
      chain.push(cur);
      cur = map[cur].parent;
    }
    chain.reverse();                     // 回溯出来是倒序，翻正 = 时间正序

    // ★ 2026-09-29 四改：收集**全部消息正文**（回答 + 用户提问，chain 已是时间正序，
    //   下标先后 = 时间先后），供「文本出处」查父用 —— 见 hostUserOf 的说明。
    //   ⚠️ 不能只收回答：真机实测用户也会**选中自己早先提问里的文字**再提问
    //   （子提问「真的吗」的选中文「给我提供一个 markdown 文件」全文只出现在
    //    用户自己的第 11 条提问里，一条回答里都没有）—— 只搜回答必然漏。
    const bodies = [];
    chain.forEach(function (nodeId, idx) {
      const node = map[nodeId];
      const msg = node && node.message;
      const author = msg && msg.author;
      if (!author || !msg.id) return;
      const t = messageText(msg);
      if (!t) return;                                     // 空文本（工具节点等）没有搜索价值
      bodies.push({
        idx: idx,
        id: nodeId,
        msgId: String(msg.id),
        role: author.role,
        text: flat(t)
      });
    });

    const out = [];
    chain.forEach(function (nodeId, idx) {
      const node = map[nodeId];
      const msg = node && node.message;
      const author = msg && msg.author;
      if (!author || author.role !== "user") return;      // 只要用户提问
      // 用户看不见的消息（系统注入之类）不该进目录
      const meta = msg.metadata || {};
      if (meta.is_visually_hidden_from_conversation === true) return;
      if (!msg.id) return;                                 // 没有 id 就没法跟页面上的节点对上
      const text = messageText(msg);
      const sel = selectionOf(text);
      out.push({
        key: String(msg.id),
        text: text,
        // ★ 子提问 → 用「选中文出自哪条消息」查真父（树指针会说谎，见 hostUserOf）；
        //   普通提问 / 查不到出处 → 消息树上溯（老规则兜底）。
        parentUser: (sel && hostUserOf(bodies, idx, sel, map))
                    || parentUserOf(map, nodeId)
      });
    });
    return out;
  }

  /** 折叠所有空白为单空格 —— 选中文与回答正文里的换行/缩进经常对不上。 */
  function flat(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

  /**
   * ★ 2026-09-28 三改 · 从「选中文字继续提问」的模板原文里抠出选中文。
   * 模板固定形如 `# Selected text:\n\n## Selection 1\n<选中文>\n\n## My request:\n…`
   * （第 11 章 parseSelected 的孪生 —— 这里是数据模块，不带 summarizer 依赖，就地写一份最小的。）
   */
  function selectionOf(text) {
    const t = String(text || "");
    if (!/^#\s*Selected text:/i.test(t)) return "";
    const seg = t.split(/##\s*Selection\s*\d+/)[1];
    if (!seg) return "";
    return seg.split(/##/)[0].trim();
  }

  /**
   * ★ 2026-09-28 三改 · 用「选中文出自哪条回答」查真父。
   *
   * ★★ 为什么消息树的 parent 不可信（真机取证 2026-09-29，用户第三次反馈后钉死）：
   *   ChatGPT 把「选中提问」的新消息挂在**发送那一刻的当前节点**下，
   *   **不是**你选中的那条回答下！取证（10 条子提问逐条用选中文全文匹配所有回答）：
   *   · 「"知识树 UI"已经有人做」的选中文**只出自**最早那篇大回答（8 号提问的回答），
   *     消息树却把它挂在链尾第 9 条子提问下 —— 用户看到的正是"子提问全排在下面"。
   *   · 也有真链：「最容易先做出…」的选中文确实只出自上一条子提问的回答。
   *   —— 树指针是"发送位置"，文本出处才是"阅读位置"。**归属跟阅读位置走。**
   *
   * 规则：在时间上**早于本条**的消息里（idx 比较即可，chain 已正序），
   *   找**最早**一条正文包含选中片段的 —— 最早 = 原始出处，后面的都是引用/复述。
   *   找到：
   *     · 出自**回答** → 那条回答归属的提问（沿树上溯第一条 user）；
   *     · 出自**用户提问** → 那条提问**自己**就是父（选的是它自己写下的句子，
   *       追问自然归在它名下）；
   *   找不到 → null（调用方退回树上溯）。
   *
   * @param {Array} bodies [{idx,id,msgId,role,text}]  时间正序的全部消息正文
   * @param {number} kidIdx   本条子提问在 chain 里的下标
   * @param {string} sel      选中文原文
   */
  function hostUserOf(bodies, kidIdx, sel, map) {
    let probe = flat(sel).slice(0, 14);
    // 太短的选中文（如"什么"）哪条消息都可能有 → 文本判据失去区分度，别用
    if (probe.length < 4) return null;
    let hit = findHost(bodies, kidIdx, probe);
    if (!hit) {
      // 尾部标点可能造成"明明有却匹配不上"（实测「目前的最新情况，」），去掉再试一次
      probe = probe.replace(/[，。！？…、）】》"'.,!?]+$/, "");
      if (probe.length < 4) return null;
      hit = findHost(bodies, kidIdx, probe);
    }
    if (!hit) return null;
    // 选中文出自用户自己的提问 → 那条提问就是父；出自回答 → 该回答归属的提问
    return hit.role === "user" ? hit.msgId : parentUserOf(map, hit.id);
  }

  /** 在早于 kidIdx 的消息里找最早一条包含 probe 的。 */
  function findHost(bodies, kidIdx, probe) {
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.idx >= kidIdx) break;              // 只看早于本条的消息
      if (b.text.indexOf(probe) >= 0) return b;
    }
    return null;
  }

  /**
   * 沿消息树的 `parent` 指针往上找**第一条用户消息**的 id。
   *
   * ★★ 2026-09-29 降级为**兜底**：真机取证发现树指针是"发送位置"——
   *   ChatGPT 把「选中提问」挂在发送那一刻的当前节点下，不是被选中的回答下
   *   （见 hostUserOf 的取证记录）。现在只有**文本出处查不到**时才走这里。
   *
   * 返回：父提问的 message id（String）；一路没有 user 就 null。
   */
  function parentUserOf(map, nodeId) {
    let cur = map[nodeId] && map[nodeId].parent;
    let guard = 0;                                  // 防 parent 成环把页面转死
    while (cur && map[cur] && guard++ < 5000) {
      const msg = map[cur].message;
      const author = msg && msg.author;
      if (author && author.role === "user" && msg.id) {
        const meta = msg.metadata || {};
        if (meta.is_visually_hidden_from_conversation !== true) return String(msg.id);
      }
      cur = map[cur].parent;
    }
    return null;
  }

  /* ────────────────────────────────────────────────────────────────────────
     五、卡 3 · merge(spine, dom) —— 把两个来源合成一份
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 合并：以**完整列表**为骨架，把页面此刻挂着的**活节点**接上去。
   *
   * 入参：spine —— 接口来的完整列表 [{ key, text }]（可能为 null = 没拿到）
   *      dom   —— CW_Parser.getUserMessages() 的返回值（可能为空数组）
   * 返回：Array —— 与 spine 同序的完整列表；命中的条目**原样换成 dom 里那一个对象**
   *               （于是拿到活的 el / turn），没命中的 el = null
   *
   * ★ 为什么是"原样换进来"而不是"把 el 拷过去"：
   *   这条规则**不需要枚举任何字段名** —— parser 将来多给一个 turn 之外的字段
   *   （或者改名字），这里一行都不用改。判据：
   *   **两个模块之间传递的耦合面越小，其中一个改版时另一个越安全。**
   *
   * ★★ 但 `text` 一栏例外，**必须以骨架为准**（2026-09-28 真机实测逼出来的）：
   *   实测同一条提问（key 完全一致）：
   *     接口给的  = "# Selected text:\n\n## Selection 1\nGraph Navigator\n\n## My request:"
   *     页面给的  = "[附件消息]"
   *   因为那是"选中一段文字再提问"的消息，**页面上根本没有气泡**，
   *   而 parser 的判据是"没气泡 → 附件消息"（第 2 章定的，对普通附件是对的）。
   *   → 也就是说：**页面上的文字是"渲染结果"，可能只是占位符；
   *      接口给的文字才是"用户真正写下的内容"。**
   *   另外它顺带解决一件事：如果谁挂载/卸载就换一份文字，标题会跟着抖
   *   （同一条提问，滚上去显示"A"、滚下来显示"B"）。以骨架为准就不会抖。
   *   判据：**同一份数据有多个来源时，让"更接近原始输入"的那个说了算。**
   *
   * ★ 为什么还要处理"dom 里有、spine 里没有"的条目：
   *   用户刚发出下一条提问时，接口那份还是旧的（我们进会话时拉的），
   *   但页面上它已经在了。这类条目必须补进列表 —— 否则"发了消息目录不动"，
   *   而这恰恰是第 6 章已经做好、不能在这里弄丢的能力。
   *   位置：按**页面上的先后**插到"它的下一条在骨架里"的那条前面；
   *        找不到这样的邻居（它在最末尾）就放末尾。
   *
   * ★ 接口不可用（spine 为 null / 空）时：
   *   直接返回 dom 的副本 —— 也就是第 0~8 章的老行为（只画页面上已加载的）。
   */
  function merge(spine, dom) {
    const domList = dom || [];
    if (!spine || !spine.length) return domList.slice();

    // 骨架里 key → 序号
    const at = {};
    spine.forEach(function (m, i) { at[m.key] = i; });

    // ① 先按骨架铺一份（全是"没有活节点"的条目）
    const out = spine.map(function (m, i) {
      // parentUser 是**接口消息树**给的，页面上没有 → 只能由骨架带出来（第 11 章父归属）
      return { key: m.key, text: m.text, parentUser: m.parentUser || null, order: i, el: null, turn: null };
    });

    // ② 把 dom 里命中的接上去：**文字用骨架的**，其余字段（el / turn / …）全用页面上的
    domList.forEach(function (d) {
      const i = at[d.key];
      if (i !== undefined) {
        out[i] = Object.assign({}, d, { text: spine[i].text, parentUser: spine[i].parentUser || null });
      }
    });

    // ③ 把 dom 独有的按页面顺序插进正确位置
    //    从后往前扫：反向扫的时候"插入位置"是单调不增的，锚点一旦定下就不用回头改。
    let anchor = out.length;
    for (let i = domList.length - 1; i >= 0; i--) {
      const d = domList[i];
      const own = at[d.key];
      if (own !== undefined) {
        anchor = own;                       // 骨架里的：它前面就是插入位置
      } else {
        out.splice(anchor, 0, d);           // 插到 anchor **之前**；下一次的锚点仍是 anchor
      }
    }

    // ④ order 一律以最终位置为准（骨架上的 order 是"画这张单子时它在第几位"）
    out.forEach(function (m, i) { m.order = i; });
    return out;
  }

  /**
   * ★ 2026-09-28 补丁：merged 里有哪些 key 是骨架没有的（骨架落后于页面的信号）。
   *
   * 背景：merge 第 ③ 步会把这些"骨架里还没有"的条目补进目录 ——
   * 但它们**只在此刻挂载着**时存在（虚拟滚动一卸载就没了），
   * 于是目录条数跟着挂载状态抖（实测 14 ↔ 15）。content.js 拿这份清单
   * 去触发"骨架自动刷新"；刷新落地后这些消息就是骨架的正式成员，不再抖。
   *
   * 入参：spine  —— 接口骨架（null / 空 = 没有骨架 → 谈不上"落后"，返回 []）
   *        merged —— merge 的产物（页面条目已接上）
   *        ignore —— { key: 1 } 已知无法匹配的 key（刷新过也没有的，别再报）
   * 返回：Array<key>（保持 merged 里的出现顺序）
   *
   * 纯函数：不碰 DOM / fetch，跟 merge 一样可以离线单测。
   */
  function foreignKeys(spine, merged, ignore) {
    if (!spine || !spine.length || !merged || !merged.length) return [];
    const have = {};
    spine.forEach(function (m) { have[m.key] = 1; });
    const skip = ignore || {};
    return merged.filter(function (m) { return !have[m.key] && !skip[m.key]; })
                 .map(function (m) { return m.key; });
  }

  /**
   * ★ 第 11 章：给扁平列表挂 `parentKey`（子提问 → 它所属的主提问）。
   *
   * 规则（两级封顶，再深拍平）：
   *   · 主提问（!isChild）→ parentKey = null，并成为"最近的主提问"。
   *   · 子提问（isChild）→ parentKey = "最近的主提问"。
   *     一条子提问的回答里再选中提问（孙级）→ 它**还是** isChild，
   *     于是也挂到"最近的主提问"下 —— 自动拍平成两级，不需要额外判断。
   *
   * ★ 兜底（覆盖父归属，决策 ④）：
   *   content.js 在用户"选中某回答的文字"时捕获到"这条新子提问该挂到哪"，
   *   通过 `override = { parent, childKeys }` 传进来 —— 捕获优先于"前一条主提问"。
   *   纯函数：override 只是参数，不碰 DOM / 时间，离线可单测。
   *
   * @param {Array} list      扁平列表（每项至少 { key, isChild }），就地补 parentKey
   * @param {Object} [override] { parent: string, childKeys: {key:1} } 捕获修正，可缺省
   * @returns {Array} 同一个数组
   */
  function buildTree(list, override) {
    const arr = list || [];
    const ov = override || {};
    const ovKeys = ov.childKeys || {};

    // 候选父 = 列表里的**任何**条目（主项或子项都行）
    // ★ 2026-09-28 二改：原来只认主项当父，结果"在子提问的回答里再选中"形成的
    //   追问链（kid1 → kid2 → kid3，真机实测有 8 层）全部被拍平/回落到最后一条
    //   主提问 —— 用户看到的正是"全挂在最后一个父提问下面"。
    //   真父就是真父，**哪怕它自己也是个子项**；拍平是渲染层的事（缩进封顶），
    //   不是数据层该撒的谎。判据：**数据层只说事实，视觉层才做取舍。**
    const have = {};
    arr.forEach(function (m) { have[m.key] = 1; });

    let lastParent = null;
    arr.forEach(function (m) {
      if (m.isChild) {
        // 优先级：① 选中捕获（刚发生、接口还没写进时唯一的信息源）
        //        ② parentUser（接口消息树 = 持久的真父，打开旧会话也准）★ 2026-09-28
        //        ③ lastParent（前一条主提问，老兜底）
        if (ovKeys[m.key] && ov.parent) {
          m.parentKey = ov.parent;
        } else if (m.parentUser && m.parentUser !== m.key && have[m.parentUser]) {
          m.parentKey = m.parentUser;
        } else {
          m.parentKey = lastParent;
        }
      } else {
        m.parentKey = null;
        lastParent = m.key;
      }
    });
    return arr;
  }

  /**
   * ★ 2026-09-28（用户实测反馈）：把子项**移到父项正下方**，形成
   * Word 导航窗格那种「主提问大标题 → 子提问小标题紧跟」的层次。
   *
   * 为什么需要它：目录本来按**时间序**排 —— 用户从很早的回答里选中文字提问时，
   * 这条子提问按时间排在**会话最末尾**，离它归属的父项隔了几十条，
   * parentKey 算得再对屏幕上也看不出来。渲染层要的是"分组后"的顺序。
   *
   * 规则（纯函数，**返回新数组**，不动入参顺序）：
   *   · 主项按原时间序输出；每输出一个主项，紧跟它的全部子项
   *     （parentKey 命中，兄弟之间仍按时间序）；
   *   · 孙级已被 buildTree 拍平到最近主项（parentKey 指向主项）→ 自然跟在主项下；
   *   · 「开头即子」的孤儿（parentKey 为空）保持在**最前面**，相对顺序不变。
   *
   * ⚠️ 必须在 buildTree **之后**调用（依赖它算好的 parentKey）。
   */
  function arrangeUnderParent(list) {
    const arr = list || [];
    const kidsOf = {};      // parentKey → [子项...]（保持时间序）
    const orphans = [];     // isChild 但没有 parentKey（开头即子）
    arr.forEach(function (m) {
      if (m.isChild && m.parentKey && m.parentKey !== m.key) {
        (kidsOf[m.parentKey] = kidsOf[m.parentKey] || []).push(m);
      } else if (m.isChild) {
        orphans.push(m);
      }
    });

    const out = [];
    const used = {};        // 防环 / 防重复输出（坏数据时 parentKey 可能成环）

    // ★ 深度优先：输出自己 → 紧跟它的**全部后代**（不只直接子项）。
    //   追问链 kid1→kid2→kid3 因此会渲染成逐级缩进的一条链，各自紧跟真父。
    //   depth 交给渲染层做缩进封顶（视觉取舍），这里只如实标注层级。
    function emit(m, depth) {
      if (!m || used[m.key]) return;
      used[m.key] = 1;
      m.depth = depth;
      out.push(m);
      const kids = kidsOf[m.key];
      if (kids) kids.forEach(function (k) { emit(k, depth + 1); });
    }

    orphans.forEach(function (m) { emit(m, 1); });   // 开头即子的孤儿排最前
    arr.forEach(function (m) { if (!m.isChild) emit(m, 0); });
    // 兜底：父不在列表里（理论上不会）→ 没输出过的补到末尾，保证一条不丢
    arr.forEach(function (m) { if (!used[m.key]) emit(m, 1); });
    return out;
  }

  /* ────────────────────────────────────────────────────────────────────────
     六、对外暴露
     ──────────────────────────────────────────────────────────────────────── */

  return {
    load: load,           // 拉完整列表（异步，永不 reject）
    merge: merge,         // 合并（纯函数，可单测）
    foreignKeys: foreignKeys,   // 骨架落后检测（纯函数，可单测）★ 2026-09-28
    buildTree: buildTree,       // 父归属（纯函数，可单测）★ 第 11 章
    arrangeUnderParent: arrangeUnderParent,  // 子项重排到父项正下方（纯函数）★ 2026-09-28
    peek: peek,                                 // ★ 十五补：同步看缓存（切会话"秒出"用）
    warmToken: warmToken,                       // ★ 十五补：空闲预热 token（省一趟 RTT）
    clear: function () { inflight = { chatId: "", promise: null }; },

    /* 下面两个是**纯函数**，单独放出来是为了让它们能被离线单测
       （tools/test-history.mjs）—— 它们是这一章里唯一"不依赖浏览器"的部分：
         · messageText   只吃一个 message 对象
         · matchListFrom 只吃一份会话 JSON（可以手搓 fixture，含废弃分支）
       判据：**能脱开环境测的逻辑，就不要放到环境里测。** */
    messageText: messageText,
    matchListFrom: matchListFrom
  };
})();
