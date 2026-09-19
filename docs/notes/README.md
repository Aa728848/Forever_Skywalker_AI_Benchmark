# Agent Notes

记录本项目非平凡变更的原因、决定、备选方案、后果与验证证据。参考 cwtools-vscode 与 DeepSeek Harness 的 Agent Notes 体系。

---

## 1. 核心哲学与信息归属（One Home Per Fact）

- **`docs/requirements.md` / `docs/judge-providers.md`**：评测规格与裁判协议约定。
- **`AGENTS.md`**：编码代理每次会话必读的硬性命令与常驻约定（Standing orders）。
- **Agent Notes（本目录）**：**技术决策的唯一归宿**。承载代码与规格文档无法承载的设计原因（Why）、权衡与放弃的备选方案（What we gave up）。

---

## 2. 路径与封闭分类

所有笔记遵循双轴路径拓扑：
```text
docs/notes/{lifecycle}/{class}/YYYY-MM-DD-slug.md
```

- **生命周期（Lifecycle）**：`proposed`（提议）、`implemented`（已交付）、`rejected`（否决）、`archived`（已完全取代/冻结）。
- **封闭 6 分类（Class）**：`feature`、`bug-fix`、`simplification`、`architecture`、`process`、`testing`。不得自行扩充分类，禁止建立全局集中式 INDEX 文件。

---

## 3. 决策所有权（Owning Note）与修改前查阅

1. **修改前查阅（Pre-edit Review）**：修改题目包结构、评分核心协议、容器执行边界或评审流程前，必须先在 `docs/notes/implemented/` 检索对应的历史笔记，重点审阅 `Alternatives considered` 与 `Consequences`，避免重走弯路。
2. **决策所有权（The Owning Note Rule）**：
   - 每次非平凡变动必须在同一变更中新增或更新 Note。
   - **更新已有 Note 优先**：如果已有 Note 拥有该项决策，直接原地更新其路径、符号与机制陈述以匹配实际交付代码，**严禁新建同质化重复 Note**。
   - 仅在无 Note 拥有该决策或做出颠覆性重大新决策时才新建 Note，并建立相对链接交叉引用。

---

## 4. 模板与生命周期骨架

所有 Agent Note 头部三行必须严格一致：

```markdown
# Agent Note: 中文标题

Status: <proposed | implemented | rejected — <一句话原因> | archived>
```

### 4.1 `proposed/` 结构（方案设计态）
```markdown
## Problem
问题、任务范围与必要性。

## Proposal
设计提案；可使用未来时态。

## Alternatives considered
比较过的方案及未采用原因，必填。

## Acceptance criteria
验收标准与可观测行为。

## Risks
潜在风险与已知权衡。
```

### 4.2 `implemented/` 结构（交付事实态）
```markdown
## Problem
问题、背景与改动动机。

## Decision
设计决定；交付态只写已实现事实（现在时），禁入规格腔（禁用 ## Proposal / ## Plan / ## Acceptance criteria）。

## Alternatives considered
比较过的方案及未采用原因，必填。

## Consequences
收益、约束与明确限制。

## Verification
实际运行的命令、测试结果及验收证据。
```

---

## 5. 核心纪律

1. **同变更交付**：代码修改与 Note 变更同提交，不得事后脱节补录。
2. **交付态写事实并实时保鲜**：代码变更符号、配置或路径时，原地修正已交付笔记，保持与真实代码基线一致。
3. **强制备选方案（Alternatives considered）**：技术决策必须有对比，明确记录被否决方案及理由。
4. **规范中文书写**：标题与正文使用规范简体中文。
