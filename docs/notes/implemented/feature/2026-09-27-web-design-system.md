# Agent Note: 网页界面设计系统与七页签统一改版

Status: implemented

## Problem

`apps/web/src/style.css` 是历次功能增量堆叠的产物：先是一份单行长压缩样式，随后按页签追加了报告中心、配置、发起测评、供应商四段各自的规则。结果是同一个界面里存在多套视觉语言——边框色有五六种近似值，面板圆角在 5/6/8/9/10px 之间摇摆，状态徽标（`.state-tag` / `.phase` / `.badge` / `.easy` 等）各自定义颜色且没有统一的语义色体系，按钮只有 `.primary` / `.secondary` 两种形态，禁用态只靠 `opacity: .6` 表达。功能上没有问题，但新增页签时无处复用，页与页之间观感割裂，窄屏下 `.report-layout` 与 `.config-grid` 的断点也各写一套。

改版必须在不触碰任何展示语义的前提下完成：页面上大量文案是**诚实性提示**（「作答完成 · 质量分待定」与「还没跑完」的区分、清理按钮的禁用理由、只读项原因、遮蔽警告），e2e 逐条钉住它们；任何为「好看」而合并口径、隐藏原因或新增前端推断的做法都会同时破坏测试与安全语义。

## Decision

### 1. 只改外观：样式集中到一处，语义留在 .tsx

改版只动 `apps/web/src/style.css` 与页签外壳 `apps/web/src/main.tsx`，并且最终连 `main.tsx` 也未改动。全部既有类名（`.report-item`、`.task-row`、`.state-tag`、`.phase`、`.warn`、`.notice`、`.checks-table`、`.provider-*` 等）逐个保留，只重写它们的样式声明，因此 e2e 的选择器与断言文本零改动。业务判断（`verdict` / `reportOutcome` 映射、残留三态、待定 vs 0 分、清理闸门文案）全部留在原组件里，本文件一行都没碰。

### 2. 设计令牌集中在 `:root`

一族自定义属性构成唯一事实来源，各页签规则只引用令牌、不再写字面色值：

- 表面与描边：`--bg` / `--bg-soft` / `--panel` / `--panel-2..4`、`--line` / `--line-soft` / `--line-strong`；
- 文字四级：`--text` / `--text-2` / `--text-3` / `--text-4`；
- 语义色各配浅底与描边：`--ok|--warn|--danger|--info` + `-soft` + `-line`，另有深色导航轨专用的 `--rail-*`；
- 尺度：`--sp-1..7`（4px 刻度）、`--r-xs..lg` 与 `--r-pill`、`--sh-1..3`、`--fs-xs..3xl`；
- 动效：`--t-fast: 120ms`、`--t-base: 180ms`，全部 ≤ 200ms。

### 3. 统一组件基元

- **按钮**：`.primary`（渐变实底）`.secondary`（描边浅底）`.ghost`（无边框）`.danger`（危险浅底）四形态；禁用态统一 `cursor: not-allowed` + `opacity`，并**单独重置渐变为实色回退**；`aria-busy="true"` 时指针为 progress，配合组件里已有的「正在…」文案。
- **输入与下拉**：统一的边框、圆角、hover 与 focus 描边；`disabled` 用凹陷底色 + 禁用指针。
- **卡片/面板**：`.detail`、`.provider-form`、`.artifact`、`.cleanup-block`、`.stats article` 共用同一套底色/描边/圆角/阴影。
- **表格**：`.checks-table` 自带滚动容器与圆角边框、斑马纹、hover 高亮、表头吸顶、末行去边；`.rows-table` 保持 nowrap 但在自己的容器里横向滚动。
- **状态标签**：`.state-tag.ok|warn|bad|idle`、`.phase.pending|solving|grading|done|stopped|error`、`.badge.easy|medium|hard|extreme` 全部改为「色 + 形 + 文字」双通道（浅底 + 同色描边 + 文字），不靠纯色块区分。
- **提示条**：`.error`（危险）/ `.warn`（警告，含 `.broken` 危险变体）/ `.notice`（信息）/ `.notice-inline` 与 `.ok-note`（成功）/ `.planned-answers`（强调）统一为左侧 3px 语义色条 + 浅底。
- **模态框**：`.modal-backdrop` 加半透明深色底与 `backdrop-filter: blur(4px)`，`.modal` 居中限宽并带大阴影。
- **空状态**：`.empty` 统一为虚线框 + 居中标题与说明。

### 4. 布局、导航与排版

- 页签导航保留「深色轨 + 亮色内容」的结构（既有观感），只重做细节：品牌标记换成渐变方块，当前项用左侧主色竖条 + 渐变底 + 更高对比的文字，计数徽标改为胶囊。
- 内容区限宽 `--content-max: 1520px`；`.topbar` 改为吸顶 + 半透明毛玻璃。
- 数字一律 `font-variant-numeric: tabular-nums`（`.stats strong`、`.metric b`、`.score-hero strong`、`.summary-grid b`、表格单元格、徽标等）；长路径/ID 用 `overflow-wrap: anywhere` **整段换行显示**，不截断、不加省略号，因此无需新增 `title` 属性，也就不需要改动任何 `.tsx`。
- 响应式只保留三档（1320 / 1180 / 900 / 760 之中按语义合并）：≤900px 时列表与明细上下堆叠、左侧列表转为横向滚动条；≤760px 时导航改为顶部横向可滚动的标签条，表格横向滚动而非溢出页面。

### 5. 可访问性与克制

焦点环：`button` / `a` / `summary` / `input` / `select` 在 `:focus-visible` 下有 2px 主色轮廓 + 2px 偏移。`prefers-reduced-motion: reduce` 下所有过渡与动画时长归零。正文/次要文字色按 WCAG AA 量级选取（`--text` `#1b2440`、`--text-2` `#46516e`、`--text-3` `#5f6a85` 在白底与 `--panel-2` 上均在 4.5:1 以上）。不引入任何运行时依赖、网络字体或构建期插件，纯 CSS。

## Alternatives considered

- **引入 UI 框架（Tailwind / 组件库）**：需要新的构建期依赖与迁移面，且组件里已写死的语义类名会被重写，e2e 选择器随之失效。改为纯 CSS + 令牌，改动面收在单文件内。
- **给每个页签各写一套新样式**：正是这次要消除的问题；且四处断点会继续漂移。改为统一基元 + 页签只做容器级调整。
- **为「更统一」合并状态语义（例如把「待定」并入「未完成」、把清理闸门原因收进 title）**：会直接推翻页面上的诚实性提示与 e2e 断言。改为一律保留原文字与原因，样式只负责让它们更易读。
- **长 ID 用 `text-overflow: ellipsis` 截断**：会隐藏完整值，需要再加 `title` 属性，也就必须改 `.tsx`（超出本次写范围）。改为整段换行，完整值始终可见。
- **导航改成顶部横向顶栏**：会丢掉七个页签的计数徽标空间，且移动端仍要做一次折叠。改为保留侧栏结构、只在 ≤760px 折叠成横向标签条。
- **深色主题整体铺到底**：报告中心与配置页有大量长文本表格，深色底会降低长文可读性。改为沿用「深色导航 + 亮色内容」的既有分工。

## Consequences

- 七个页签（题目目录 / 评分预览 / 运行记录 / 报告中心 / 发起测评 / 配置 / 供应商）现在共用一套令牌与组件基元；新增页签只需引用令牌，不再复制颜色与间距。
- `style.css` 从 154 行（含单行 9.2KB 压缩样式与 50 行 `.provider-*`）变为按节编号的单一设计系统文件；供应商页签的临时 `.provider-*` 规则被整体吸收进设计系统，不再是「追加在文件末尾的例外」。
- 明确限制（如实记录）：
  1. `.ghost` / `.danger` 两个按钮形态与 `.modal` 的 Esc 关闭目前**没有组件在用**：现有页面只有 primary/secondary，配置页的确认弹窗也没有实现键盘关闭。它们作为基元先备好，是否接线由后续改动决定——本次不新增交互，因此没有「按 Esc 关闭」这种行为。
  2. 表格在窄屏是「容器内横向滚动」，不是重新排版的移动端卡片视图；12 列的逐条作答表在 390px 下需要横向拖动。
  3. 复用浏览器的 `backdrop-filter`，在极老的浏览器上会退化为纯色半透明遮罩（不影响可读性）。
  4. 页面仍是浅色单主题，没有深色模式切换。
- 本改版不触碰任何业务判断、文案与诚实性提示；`LaunchPanel.tsx` / `ReportCenter.tsx` / `ConfigPanel.tsx` / `ProviderPanel.tsx` 的 `.tsx` 一行未改。

## Verification

- `pnpm check`：`tsc --noEmit` 通过、目录一致、423 项测试通过（29 个测试文件）、`vite build` 成功（CSS 35.12 kB / gzip 6.91 kB）。
- `pnpm test:e2e`：12 项全部通过（配置面板 3、取消链路 1、报告中心 4、报告清理 2、工作台 2），与改版前基线完全一致——说明改版没有动到任何被断言的选择器或文案。
- 截图验收（playwright 自带 webServer 起真实 API 与 Vite，不触碰用户的 4317/4318）：七个页签各一张全页截图（1440 宽）+ 题目目录 390px 移动端一张，逐一目视检查。改前/改后原图见 `data/web-redesign/before|after/`，并排对比图见 `data/web-redesign/compare-*.png`（`data/` 为已忽略目录，这些是验收证据而非交付产物）。
- 窄屏验收：七个页签 × 五个宽度（1440 / 1180 / 900 / 760 / 390）共 35 组，断言 `document.documentElement.scrollWidth - window.innerWidth ≤ 1` 并列出越界元素，全部通过。
- 改版过程中由截图发现并修掉两处真实缺陷（均在截图里可见，修完重跑全绿）：(1) 全局 `:focus-visible` 规则误给所有元素加 `border-radius`，会让被聚焦的元素变形，改为只对交互元素加轮廓；(2) `background-image: none` 在禁用态把 `.primary` 的渐变一并清空导致按钮不可见，改为渐变用 `background-image`、底色另给实色回退。
