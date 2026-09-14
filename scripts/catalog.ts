import { readFileSync, writeFileSync } from 'node:fs';
import { tasks } from '../packages/catalog/src/index.ts';
import { difficultyLabels } from '../packages/contracts/src/index.ts';

const statusLabels: Record<string, string> = {
  designed: '设计完成，夹具未实现',
  'fixture-ready': '已有可执行夹具，尚未校准',
  calibrating: '校准中',
  ready: '已就绪',
};

const sections = tasks.map(task => `### ${task.id} · ${task.title}\n\n- 难度：${difficultyLabels[task.difficulty]}；题型：${task.track === 'core' ? '独立核心题' : '原仓库集成题'}；状态：${statusLabels[task.status] ?? task.status}。\n- 能力域：${task.domain}；题目运行时：${task.runtime}。\n- 来源：${task.sources.join('、')}。\n- 任务：${task.problem}\n\n验收不变量：\n\n${task.acceptance.map(line => `- ${line}`).join('\n')}\n\n公开检查：${task.publicChecks}\n\n隐藏检查：${task.hiddenChecks}\n\n判定依据：${task.oracle}\n\n来源定位：\n\n${task.sourcePaths.map(path => `- \`${path}\``).join('\n')}\n`);
const document = `# 测试集设计目录\n\n由 \`catalog/tasks.json\` 生成；请修改元数据后运行 \`pnpm catalog:docs\`。\n\n已制作真实题目包的任务在 \`tasks/core/<ID>/\` 下有 manifest.json、缺陷 starter 与随工作区分发的公开检查；参考补丁、替代实现与隐藏检查位于 \`graders/<ID>/\`，不随候选工作区导出。题目状态字段仍只表示设计阶段，不代表夹具已实现。\n\n共 55 道题：48 道核心题覆盖 12 个能力域的四个等级，7 道原仓库集成题单独报告。标注“已有可执行夹具”的题目在 \`tasks/core/<ID>/\` 下有真实题目包（缺陷起始版本、公开检查）与受信资产（\`graders/<ID>/\`：隐藏检查、参考补丁、替代实现）；其余题目仍是制作规格。所有题目发布前必须补齐环境摘要、难度与阈值校准结果。\n\n难度由状态空间、故障交错、跨模块影响和验证成本决定，不能通过增加相似断言数量提升等级。隐藏检查只隐藏数据与交错，不隐藏需求。补充覆盖的认证隔离、持久化、可访问性、Unicode、跨平台和故障恢复分布在对应能力域。\n\n## 题目总览\n\n| ID | 能力域 | 难度 | 题目 | 题型 |\n| --- | --- | --- | --- | --- |\n${tasks.map(task => `| ${task.id} | ${task.domain} | ${difficultyLabels[task.difficulty]} | ${task.title} | ${task.track === 'core' ? '核心' : '集成'} |`).join('\n')}\n\n## 题目规格\n\n${sections.join('\n')}\n`;
const target = new URL('../docs/task-catalog.md', import.meta.url);
if (process.argv[2] === '--write') {
  writeFileSync(target, document);
  console.log('已生成 55 道题目目录。');
} else if (process.argv[2] === '--check') {
  if (readFileSync(target, 'utf8') !== document) throw new Error('题目目录与元数据不一致，请运行 pnpm catalog:docs。');
  console.log('55 道题的协议、唯一性、四级覆盖和 Markdown 一致性检查通过。');
} else throw new Error('用法：catalog.ts --write | --check');
