/**
 * ============================================================================
 *  summarizer.js —— 把一条长提问压成一行短标题（第 8 章）
 * ============================================================================
 *  ★ 2026-09-28 按用户要求**大幅简化**：压缩规则只剩一条 ——
 *
 *      **清洗（去掉 markdown 记号、折叠空白）之后，截取前面 maxLen 个字符。**
 *
 *  之前那套东西全删了，一共四样：
 *    · 剥开头寒暄（你好 / 请问 / 我现在想 / 怎么在 …）
 *    · 剥结尾客套（谢谢 / 麻烦了 …）
 *    · 只取第一句（"怎么装 node？我用的 windows" → 只留前半句）
 *    · 给标题打类型标签（[报错] [代码] [路线] [方案] [原理]）
 *    · 在标点处"智能断句"再截断
 *
 *  删掉它们的理由（比"省代码"重要得多，值得记住）：
 *    ① **收益是"好看一点"，代价是一整类误伤。** 每多一条剥前缀的规则，
 *       就多一次咬到别人词头的机会 —— 实测咬过"对比"→"比"、"那么"→"么"、
 *       "还有没有"→"没有"。修完一圈，规则表越修越长，还是不断有新反例。
 *    ② **标签最糟**：它是"我替你判断了这条在问什么"。判错了（把"讲讲 python
 *       的 GIL"标成 [代码]）比不判更烦人；而且 `[报错] ` 这 5 个字符本身也占标题宽度。
 *       "每条提问前面挂个标签"在目录里是纯噪音 —— 用户要的是"能认出来是哪条"。
 *    ③ 规则越多，"为什么这条标题长这样"越难解释。目录标题只要**能一眼分辨**
 *       就够，不需要优雅。
 *
 *  判据：**能用一句话说清的规则，别写成六张表。**
 *
 *  ⚠️ 留下的是 `normalize`，但它**不是"压缩"，是"清洗"** ——
 *     它做的事是"把 markdown 记号折成空白、把换行折叠成一个空格"。
 *     没有它，标题里会原样出现 ``` 和换行符 —— 那不是"简单"，那是坏掉。
 *     （判据：**"少做事"和"做错事"是两回事**，简化要砍的是"主观加工"，
 *       不是"必要的搬运"。）
 *
 *  这是本项目**唯一的纯函数模块**：
 *    · 不认识 DOM，不认识 chrome API，不认识 ChatGPT 页面
 *    · 输入是字符串，输出是字符串，没有任何副作用
 *  → 所以它**不需要浏览器**就能测：`node tools/test-summarizer.mjs`，一秒跑几百遍。
 *    判据：**能用纯函数的，就别上浏览器。**
 *
 *  ── 对外只暴露四个方法 ──
 *    CW_Summarizer.title(raw, opt)      → 一条提问 → 一个短标题
 *    CW_Summarizer.titleAll(list, opt)  → 一批提问 → 一批短标题（顺带处理重名）
 *    CW_Summarizer.normalize(text)      → 只做清洗（不截断）
 *    CW_Summarizer.needsTooltip(raw, rendered) → UI 该不该"悬停浮出全文"
 * ============================================================================
 */

window.CW_Summarizer = (function () {
  "use strict";

  /* ══════════════════════════════════════════════════════════════════════
     一、清洗
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * 把 markdown 记号、代码块、链接、图片清掉，折叠空白。
   *
   * ⚠️ 本函数**最容易写错的地方**：记号不能无脑删（见下面标 ★ 的那几行）。
   *
   * @param {string} text
   * @returns {string}
   */
  function normalize(text) {
    let t = (text == null ? "" : String(text));

    // 零宽字符（从网页复制粘贴时特别容易混进来，肉眼完全看不见，但会占宽度）
    t = t.replace(/\u200b/g, "");

    // 成对的代码围栏 → 统一替换成"代码块"三个字
    t = t.replace(/```[\s\S]*?```/g, " 代码块 ");
    // ★ 兜底：只有开头没有结尾的围栏（流式输出中途被截、或用户只贴了开头）。
    //   上面的成对替换对它是无效的，围栏符号会原样留在标题里。
    t = t.replace(/```/g, " ");

    // 行内代码：只脱掉反引号，里面的字要留下
    t = t.replace(/`([^`\n]+)`/g, "$1");

    // 图片：整个去掉（它的"文字"是替代文本，对标题没意义）
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
    // 链接：留下链接文字，去掉地址
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    // 裸链接（没有 markdown 语法的那种）
    t = t.replace(/https?:\/\/\S+/g, " ");

    /* ★★★ 陷阱（本章第一大坑）：只处理**成对**的强调记号。
       如果像网上常见写法那样用 `replace(/[#>*_~`]+/g, " ")` 无脑删单个符号：
         "A*算法怎么用"    → "A 算法怎么用"    ← 星号没了，导航算法变成乱码
         "max_rounds"      → "max rounds"      ← 变量名被劈开
         "3DOF 是什么意思"  → "DOF 是什么意思"  ← 直接改了意思
       所以下面每一行都要求"**成对**"才动手。 */
    t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1");               // **粗体**
    t = t.replace(/__([^_\n]+)__/g, "$1");                   // __粗体__
    t = t.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1$2");   // *斜体*（要求前后是空白/边界）

    // markdown 的块级记号（标题 # / 列表 - * + / 引用 >），只删行首那一小段
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, " ");
    t = t.replace(/^\s{0,3}[-*+]\s+/gm, " ");
    t = t.replace(/^\s{0,3}>\s?/gm, " ");

    // 折叠所有空白：换行 / 制表符 / 连续空格 → 一个空格
    t = t.replace(/[\r\n\t]+/g, " ");
    t = t.replace(/\s{2,}/g, " ");
    return t.trim();
  }

  /* ══════════════════════════════════════════════════════════════════════
     二、截断 —— 压缩的全部
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * 截取前 max 个字符，超长就在末尾加一个省略号。
   *
   * ★ 唯一的讲究：**省略号也算在 max 之内**。
   *   先 `slice(0, max)` 再补一个 "…" 会得到 max + 1 个字 ——
   *   标题上限被悄悄突破一位。这种"差一位"的 bug 不会有人报错，
   *   只会让布局在边界上偶尔换行。
   *   判据：**说好 N，就是 N。**
   *
   * ⚠️ 已知的小瑕疵（**故意不修**）：这里按 JS 的 `String.length` 数数，
   *   emoji 会被算成 2 个字符，极端情况下可能从代理对中间切开、显示成乱码方块。
   *   要修就得改成按码点遍历（`for (const ch of s)`），多一层循环；
   *   而"提问标题里出现 emoji"本来就少见 —— 不值得为此让热路径慢一点。
   *   写注释说明取舍，比默默留个坑好。
   *
   * @param {string} text
   * @param {number} max
   * @returns {string}
   */
  function truncate(text, max) {
    if (text.length <= max) return text;
    return text.slice(0, Math.max(1, max - 1)) + "…";
  }

  /* ══════════════════════════════════════════════════════════════════════
     三、去重 · dedupe —— 同名标题加序号
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * ★ 同一条问题会被问两遍。
   *   最常见的是"改了错别字重发"，两条消息的文字几乎一样，
   *   算出来的标题完全相同 —— 目录里就出现两个一模一样的条目，根本分不清点了哪个。
   *   给重复的加 `(2)` `(3)` 即可。
   *
   * ⚠️ 注意：这一层**不是压缩规则**，所以简化时它留了下来。
   *   它解决的是"两条长得一样的标题没法区分"，跟"标题怎么生成"无关。
   *   判据：**简化要砍的是"主观加工"，不是"必要的区分"。**
   *
   * @param {string[]} titles
   * @returns {string[]} 长度与入参一一对应
   */
  function dedupe(titles) {
    const count = new Map();
    const out = [];
    titles.forEach(function (t) {
      const base = t || "未命名提问";
      const n = (count.get(base) || 0) + 1;
      count.set(base, n);
      out.push(n === 1 ? base : base + " (" + n + ")");
    });
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════════
     四、主函数 · title
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * 一条提问 → 一个短标题。
   *
   * 全部逻辑就是两行：**清洗 → 截断**。（第三行是空值兜底。）
   *
   * @param {string} raw 原始提问文本
   * @param {Object} [opt]
   * @param {number} [opt.maxLen=26] 标题总长上限（**含末尾的"…"**）
   * @returns {string} 永远返回非空字符串（兜底"未命名提问"）
   *
   * 为什么下界是 6：设置面板的滑块最小值是 12，6 只是防呆 ——
   * 万一有人传 0 或者负数进来，别把标题截成一个省略号。
   */
  function title(raw, opt) {
    // "指定数量字符"里那个可调的数（设置面板的滑块）。**下界 6** 只是防呆 ——
    // 万一有人传 0 或者负数进来，别把标题截成一个光秃秃的省略号。
    // ⚠️ 别写成 `(opt.maxLen) || 26`：那样 0 会被当成"没传"而回落到 26，
    //    负数却又真的走 Math.max → 同一个"非法值"两种行为，很难解释。
    const asked = Number(opt && opt.maxLen);
    const maxLen = Math.max(6, Number.isFinite(asked) ? asked : 26);

    const t = normalize(raw);
    if (!t) return "未命名提问";
    return truncate(t, maxLen);
  }

  /* ══════════════════════════════════════════════════════════════════════
     五、批量 · titleAll
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * 一批提问 → 一批短标题（顺带把重名的处理掉）。
   *
   * ⚠️ 为什么"去重"必须在这一层做，不能放进 title()：
   *   重名是**批内**的概念 —— 单独看一条标题，它永远不重复。
   *   只有拿到整批才能知道谁和谁撞了。
   *
   * @param {Array<string|{text:string}>} list
   * @param {Object} [opt] 同 title 的 opt
   * @returns {string[]}
   */
  function titleAll(list, opt) {
    const arr = list || [];
    const titles = arr.map(function (item) {
      const raw = item && item.text != null ? item.text : (item == null ? "" : String(item));
      return title(raw, opt);
    });
    return dedupe(titles);
  }

  /* ══════════════════════════════════════════════════════════════════════
     五·B · 第 11 章 · 选中文字继续提问（子提问）
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * 解析「选中一段回答里的文字、点『向 ChatGPT 提问』」产生的消息。
   *
   * ChatGPT 的接口（同源）给这类消息的原文是固定模板（真机实测）：
   *
   *     # Selected text:
   *
   *     ## Selection 1
   *     <选中的原文>
   *
   *     ## My request:
   *     <用户输入的问题>
   *
   * ⚠️ `My request:` 可以是**空**的 —— ChatGPT 允许"只选中、不打字"直接发送
   *   （实测 5 条全是这种）。所以本函数不能假设 request 一定有。
   *
   * ★ 判据（为什么看模板、不看 DOM）：这类消息在页面上**根本没有气泡**，
   *   只有一个「1 个已选文本片段」的附件药丸，选中文和问题都收在弹层里。
   *   而接口模板**不依赖消息挂载** —— 打开旧会话就能直接认出来。结构判据 > 文案判据。
   *
   * @param {string} text 接口给的原始消息文字
   * @returns {{selection:string, request:string}|null} 不是这个模板返回 null
   */
  function parseSelected(text) {
    const t = (text == null ? "" : String(text));
    if (!/^#\s*Selected text:/i.test(t)) return null;

    // 按「## 行」分节：sections[0] = "# Selected text:"，其余是 Selection N / My request
    const sections = t.split(/\n\s*##\s*/);
    let selection = "";
    let request = "";
    for (let i = 1; i < sections.length; i++) {
      const s = sections[i];
      if (/^Selection\s*\d+/i.test(s)) {
        selection = s.replace(/^Selection\s*\d+/i, "").trim();
      } else if (/^My request:/i.test(s)) {
        request = s.replace(/^My request:/i, "").trim();
      }
    }
    return { selection: selection, request: request };
  }

  /**
   * 子提问的两段式标题：`选中片段 › 问题`（决策 ② 已定）。
   *
   * 预算分配（省略号各段独立计）：
   *   · 选中片段 ≤ 12 字（超长加 …）
   *   · 分隔符 " › " 3 字符，**不计入**任一段预算
   *   · 问题占剩余预算（26 − 片段 − 3）
   *
   * 退化：
   *   · request 空 → 只显示选中片段单段（实测最常见）
   *   · 两段都空 → 兜底「未命名提问」（交给上层和普通条目同款兜底）
   *
   * ★ 最强断言（沿用第 8 章那条，只是取材段变了）：
   *   标题永远是「清洗后素材」的**确定性函数** —— 同样的 parsed 永远产出同样标题，
   *   且每个 `seg` 自身满足"清洗后前缀"，无任何主观加工。
   *
   * @param {{selection:string, request:string}} parsed parseSelected 的返回值
   * @param {Object} [opt] { maxLen } 总长上限，默认 26
   * @returns {string}
   */
  function subtitle(parsed, opt) {
    const asked = Number(opt && opt.maxLen);
    const maxLen = Math.max(6, Number.isFinite(asked) ? asked : 26);

    const sel = normalize(parsed && parsed.selection);
    const req = normalize(parsed && parsed.request);
    if (!sel && !req) return "未命名提问";
    if (!req) return truncate(sel, maxLen);            // 只选中、没打字 → 单段
    if (!sel) return truncate(req, maxLen);            // 理论上不出现，纯兜底

    const SEL_MAX = 12;
    const SEP = " › ";                                  // 空格 + › + 空格 = 3 字符
    const seg = truncate(sel, SEL_MAX);
    const reqBudget = Math.max(1, maxLen - seg.length - SEP.length);
    return seg + SEP + truncate(req, reqBudget);
  }

  /**
   * 子提问的悬停文案（★ 2026-09-28 补）：两段**分行标注**——
   *   选中片段：xxx
   *   提问：yyy
   * 为什么不和标题共用一套：标题把两段挤在一行、靠 " › " 分隔还各自截断，
   * 用户分不清哪段是选中的原文、哪段是自己打的问题；气泡里有空间，
   * 就该把两段**各自标清楚**。（用户实测反馈：要能区分。）
   *
   * @param {{selection:string,request:string}|null} parsed parseSelected 的结果
   * @param {Object} [opt] { maxLen } 每段上限，默认 60
   * @returns {string} 空串 = 不是子提问（调用方照常走普通气泡逻辑）
   */
  function childTooltip(parsed, opt) {
    if (!parsed) return "";
    const asked = Number(opt && opt.maxLen);
    const maxLen = Math.max(10, Number.isFinite(asked) ? asked : 60);
    const sel = normalize(parsed && parsed.selection);
    const req = normalize(parsed && parsed.request);
    if (!sel && !req) return "";
    return "选中片段：" + (sel ? truncate(sel, maxLen) : "（无）") +
      "\n提问：" + (req ? truncate(req, maxLen) : "（未输入提问）");
  }

  /**
   * 批量生成标题的「智能」入口：逐条判断是不是子提问，是则走两段式，否则走普通标题，
   * 最后统一去重（重名加序号）。返回两份东西：去重后的标题数组 + 每条对应的解析结果。
   *
   * 为什么单独一个函数、而不是让 content.js 自己拼：
   *   "标题该长什么样"（包括"子提问走两段式"）是**摘要语义**，属于这个模块的职责；
   *   content.js 只该拿到结论（titles + 谁是子提问），不该在这里写一遍模板判断。
   *   判据：把判断放在"最懂这件事的那个模块"里。
   *
   * @param {Array<string|{text:string}>} list
   * @param {Object} [opt]
   * @returns {{titles:string[], parsed:Array<{selection,request}|null>}}
   */
  function summarizeAll(list, opt) {
    const arr = list || [];
    const titles = [];
    const parsed = [];
    arr.forEach(function (item) {
      const raw = item && item.text != null ? item.text : (item == null ? "" : String(item));
      const p = parseSelected(raw);
      parsed.push(p);
      titles.push(p ? subtitle(p, opt) : title(raw, opt));
    });
    return { titles: dedupe(titles), parsed: parsed };
  }

  /* ══════════════════════════════════════════════════════════════════════
     六、给 UI 的一个小判断 · needsTooltip
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * 标题被压缩得比原文短时，UI 应该给个"悬停看全文"的出口。
   *
   * ⚠️ 为什么要这个函数、而不是让 sidebar 自己判断：
   *   "压缩到什么程度算需要提示"是**摘要语义**的一部分，
   *   属于这个模块的职责；sidebar 只应该拿到一个 true/false。
   *   （判据：把判断放在"最懂这件事的那个模块"里。）
   *
   * ⚠️ 注意它和"标题是不是真的被 CSS 截断"是两件事，**两者都要有**：
   *   这里是"语义判断"（原文比标题长），真正弹不弹还要问屏幕
   *   （sidebar.js 的 bindTip 会再判一次 `scrollWidth > clientWidth`）。
   *   只留前者 → 短标题也弹一个和行上一模一样的浮层；
   *   只留后者 → 语义上该有提示的条目漏掉了。
   */
  function needsTooltip(text, rendered) {
    if (!text) return false;
    return String(text).replace(/\s+/g, " ").length > (rendered || "").length + 1;
  }

  return {
    title: title,
    titleAll: titleAll,
    normalize: normalize,
    needsTooltip: needsTooltip,
    parseSelected: parseSelected,       // ★ 第 11 章：解析选中提问模板
    subtitle: subtitle,                 // ★ 第 11 章：两段式标题
    childTooltip: childTooltip,         // ★ 第 11 章：子提问悬停文案（分行标注）
    summarizeAll: summarizeAll          // ★ 第 11 章：批量（普通 + 子提问）统一标题 + 去重
  };
})();
