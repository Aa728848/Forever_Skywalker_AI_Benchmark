import Type from 'typebox';
import Schema from 'typebox/schema';
import Value from 'typebox/value';

export const difficulties = ['easy', 'medium', 'hard', 'extreme'] as const;
export const difficultyLabels = { easy: '简单', medium: '中等', hard: '困难', extreme: '极度困难' } as const;
export const functionalWeights = { behavior: 20, boundary: 10, state: 10, regression: 5, resources: 5 } as const;
// 代码质量维度。性能维度已移除：本项目的受控验证成本配对实测只测量「验证链路耗时」，
// 并不度量候选代码本身的性能，用它给 performance 打分名不副实；而题目没有独立性能负载时
// 该维必然缺证据，使总分永远待定。移除后质量分由三维满分 50 分构成。
export const qualityWeights = { simplicity: 0.4, maintainability: 0.3, decoupling: 0.5 } as const;
/** 代码质量总分满分：与可用验证各占 50，两者相加才是 100 分制。 */
export const qualityTotalPoints = 50;
/** 每维在质量分中的满分数。由维度个数推导，增删维度时总分口径自动保持 50。 */
export const qualityPointsPerDimension = qualityTotalPoints / Object.keys(qualityWeights).length;
export const rubricVersion = '0.1.0';

const text = Type.String({ minLength: 1, maxLength: 2000 });
const id = Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9_.:-]+$' });
const score = Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]);
const evidenceRefs = Type.Array(id, { maxItems: 100, uniqueItems: true });
const dimension = Type.Object({ score, evidence: evidenceRefs }, { additionalProperties: false });
const qualityDimension = Type.Object({ objective: dimension, review: dimension }, { additionalProperties: false });
export const DifficultySchema = Type.Union([Type.Literal('easy'), Type.Literal('medium'), Type.Literal('hard'), Type.Literal('extreme')]);

const trackSchema = Type.Union([Type.Literal('core'), Type.Literal('integration')]);
const runtimeSchema = Type.Union([Type.Literal('typescript'), Type.Literal('python'), Type.Literal('fsharp'), Type.Literal('mixed')]);

export const TaskSchema = Type.Object({
  id, version: Type.String({ pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$' }), title: text, domain: text,
  difficulty: DifficultySchema,
  track: trackSchema,
  // 题目执行状态：设计规格 → 已有可执行夹具 → 校准中 → 可发布。
  status: Type.Union([
    Type.Literal('designed'),
    Type.Literal('fixture-ready'),
    Type.Literal('calibrating'),
    Type.Literal('ready'),
  ]),
  runtime: runtimeSchema,
  sources: Type.Array(text, { minItems: 1, uniqueItems: true }),
  sourcePaths: Type.Array(text, { minItems: 1 }),
  problem: text,
  acceptance: Type.Array(text, { minItems: 3 }),
  publicChecks: text, hiddenChecks: text, oracle: text,
}, { additionalProperties: false });
export type Task = Type.Static<typeof TaskSchema>;
export type Difficulty = Type.Static<typeof DifficultySchema>;
export const taskValidator = Schema.Compile(TaskSchema);

export const AssessmentSchema = Type.Object({
  schemaVersion: Type.Literal('0.1.0'),
  mode: Type.Literal('preview'),
  taskId: id,
  candidateHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  execution: Type.Union([Type.Literal('complete'), Type.Literal('incomplete'), Type.Literal('infra-error')]),
  functional: Type.Object({ behavior: dimension, boundary: dimension, state: dimension, regression: dimension, resources: dimension }, { additionalProperties: false }),
  quality: Type.Object({ simplicity: qualityDimension, maintainability: qualityDimension, decoupling: qualityDimension }, { additionalProperties: false }),
  criticalChecks: Type.Array(Type.Object({ id, passed: Type.Union([Type.Boolean(), Type.Null()]), evidence: evidenceRefs }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
  evidence: Type.Array(Type.Object({
    id,
    kind: Type.Union([Type.Literal('test'), Type.Literal('static'), Type.Literal('benchmark'), Type.Literal('review')]),
    summary: text,
  }, { additionalProperties: false }), { minItems: 1, maxItems: 500 }),
}, { additionalProperties: false });
export type Assessment = Type.Static<typeof AssessmentSchema>;
export const assessmentValidator = Schema.Compile(AssessmentSchema);

export const ScoreResultSchema = Type.Object({
  mode: Type.Literal('preview'), rubricVersion: Type.Literal('0.1.0'),
  functional: score, quality: score, total: score,
  dimensions: Type.Object({ simplicity: score, maintainability: score, decoupling: score }, { additionalProperties: false }),
  readiness: Type.Union([Type.Literal('complete'), Type.Literal('pending'), Type.Literal('infra-error')]),
  thresholdMet: Type.Union([Type.Boolean(), Type.Null()]),
  reasons: Type.Array(text),
}, { additionalProperties: false });
export type ScoreResult = Type.Static<typeof ScoreResultSchema>;
export const PreviewReportSchema = Type.Object({ id, createdAt: text, assessment: AssessmentSchema, result: ScoreResultSchema }, { additionalProperties: false });
export type PreviewReport = Type.Static<typeof PreviewReportSchema>;
export const reportValidator = Schema.Compile(PreviewReportSchema);
export const reportsValidator = Schema.Compile(Type.Array(PreviewReportSchema));
export const tasksValidator = Schema.Compile(Type.Array(TaskSchema));

const checkId = Type.String({ minLength: 1, maxLength: 200, pattern: '^[a-zA-Z0-9_.:/-]+$' });
const relativePath = Type.String({ maxLength: 200 });
const argv = Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 32 });

/**
 * 题目包执行 manifest：平台侧维护的运行时、固定命令、检查清单与资源预算。
 * workspace.entries 是导出候选工作区的唯一白名单，隐藏资产不在此列。
 */
export const TaskManifestSchema = Type.Object({
  schemaVersion: Type.Literal('0.1.0'),
  taskId: id,
  taskVersion: text,
  title: text,
  runtime: runtimeSchema,
  runtimeRange: text,
  workspace: Type.Object({
    entries: Type.Array(Type.Object({ from: text, to: relativePath }, { additionalProperties: false }), { minItems: 1, maxItems: 64 }),
  }, { additionalProperties: false }),
  commands: Type.Object({ public: argv, hidden: argv }, { additionalProperties: false }),
  grader: Type.Object({
    checks: text,
    referencePatch: text,
    alternative: text,
    defectDetectors: Type.Array(checkId, { minItems: 1, uniqueItems: true }),
  }, { additionalProperties: false }),
  limits: Type.Object({
    timeoutMs: Type.Integer({ minimum: 1000, maximum: 3_600_000 }),
    memoryMb: Type.Integer({ minimum: 64, maximum: 65_536 }),
    cpus: Type.Integer({ minimum: 1, maximum: 64 }),
    network: Type.Literal(false),
  }, { additionalProperties: false }),
  checks: Type.Array(Type.Object({
    id: checkId,
    kind: Type.Union([Type.Literal('public'), Type.Literal('hidden')]),
    group: Type.Union([Type.Literal('behavior'), Type.Literal('boundary'), Type.Literal('state'), Type.Literal('regression'), Type.Literal('resources')]),
    weight: Type.Number({ minimum: 0, maximum: 100 }),
    critical: Type.Boolean(),
    summary: text,
  }, { additionalProperties: false }), { minItems: 1, maxItems: 200 }),
}, { additionalProperties: false });
export type TaskManifest = Type.Static<typeof TaskManifestSchema>;
export const taskManifestValidator = Schema.Compile(TaskManifestSchema);

const treeHash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const revisionId = Type.String({ minLength: 7, maxLength: 64, pattern: '^[a-f0-9]+$' });
const idempotencyKey = Type.String({ minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9_.:-]+$' });
const submissionReason = Type.Union([Type.Literal('agent-completed'), Type.Literal('operator-submit'), Type.Literal('patch-import')]);

/**
 * 提交信封：由 worker 完成事件、宿主适配器或显式提交命令产生，平台只接受已校验的信封。
 * candidateTreeHash 与 baseCommit 都是候选自报值，平台必须自己重算后再采信。
 */
export const SubmissionEnvelopeSchema = Type.Object({
  schemaVersion: Type.Literal('0.1.0'),
  runId: id,
  attemptId: id,
  taskId: id,
  taskVersion: text,
  baseCommit: revisionId,
  candidateTreeHash: treeHash,
  idempotencyKey,
  reason: submissionReason,
}, { additionalProperties: false });
export type SubmissionEnvelope = Type.Static<typeof SubmissionEnvelopeSchema>;
export const submissionEnvelopeValidator = Schema.Compile(SubmissionEnvelopeSchema);

/** 冻结记录：实际收取并复算过的候选快照，不是候选自报摘要。 */
export const FrozenAttemptSchema = Type.Object({
  schemaVersion: Type.Literal('0.1.0'),
  runId: id,
  attemptId: id,
  taskId: id,
  taskVersion: text,
  idempotencyKey,
  baseCommit: revisionId,
  reason: submissionReason,
  submittedBy: text,
  submittedAt: text,
  frozenAt: text,
  selfReportedTreeHash: treeHash,
  treeHash,
  directory: text,
  excluded: Type.Array(text, { maxItems: 32 }),
  fileCount: Type.Integer({ minimum: 0 }),
  bytes: Type.Integer({ minimum: 0 }),
  files: Type.Array(Type.Object({
    path: text,
    sha256: treeHash,
    bytes: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }), { maxItems: 5000 }),
}, { additionalProperties: false });
export type FrozenAttempt = Type.Static<typeof FrozenAttemptSchema>;
export const frozenAttemptValidator = Schema.Compile(FrozenAttemptSchema);

/**
 * 执行 manifest：题目包 manifest 加上这一次 attempt 真正固定的环境、命令与快照摘要。
 * 冻结之后 manifest 不再变化；环境或题目变化必须产生新的 attempt。
 */
export const ExecutionManifestSchema = Type.Object({
  schemaVersion: Type.Literal('0.1.0'),
  runId: id,
  attemptId: id,
  ruleVersion: Type.Literal('0.1.0'),
  task: TaskManifestSchema,
  environment: Type.Object({
    profile: Type.Union([Type.Literal('local'), Type.Literal('linux-container')]),
    runtimeRange: text,
    image: Type.Union([text, Type.Null()]),
    imageDigest: Type.Union([Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }), Type.Null()]),
    network: Type.Literal(false),
    workingDirectory: text,
  }, { additionalProperties: false }),
  candidate: Type.Object({
    directory: text,
    treeHash,
    taskPackageHash: treeHash,
    fileCount: Type.Integer({ minimum: 0 }),
    bytes: Type.Integer({ minimum: 0 }),
    excluded: Type.Array(text, { maxItems: 32 }),
  }, { additionalProperties: false }),
  envelope: SubmissionEnvelopeSchema,
}, { additionalProperties: false });
export type ExecutionManifest = Type.Static<typeof ExecutionManifestSchema>;
export const executionManifestValidator = Schema.Compile(ExecutionManifestSchema);

/** 幂等索引：幂等键到已冻结 attempt 的映射。 */
export const RunIndexSchema = Type.Object({
  schemaVersion: Type.Literal('0.1.0'),
  entries: Type.Array(Type.Object({
    idempotencyKey,
    taskId: id,
    runId: id,
    attemptId: id,
    treeHash,
    frozenAt: text,
  }, { additionalProperties: false }), { maxItems: 10_000 }),
}, { additionalProperties: false });
export type RunIndex = Type.Static<typeof RunIndexSchema>;
export const runIndexValidator = Schema.Compile(RunIndexSchema);

const checkStatus = Type.Union([Type.Literal('passed'), Type.Literal('failed'), Type.Literal('not-run')]);

/** 执行结论：基础设施故障与被测失败必须分开，取消与超时也不能混为一类。 */
export const ExecutionClassificationSchema = Type.Union([
  Type.Literal('passed'),
  Type.Literal('check-failed'),
  Type.Literal('timeout'),
  Type.Literal('memory-exceeded'),
  Type.Literal('cancelled'),
  Type.Literal('infrastructure-error'),
]);
export type ExecutionClassification = Type.Static<typeof ExecutionClassificationSchema>;

export const ExecutionArtifactSchema = Type.Object({
  id: checkId,
  path: text,
  sha256: treeHash,
  bytes: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type ExecutionArtifact = Type.Static<typeof ExecutionArtifactSchema>;

export const ExecutionCheckSchema = Type.Object({
  id: checkId,
  kind: Type.Union([Type.Literal('public'), Type.Literal('hidden')]),
  group: Type.Union([Type.Literal('behavior'), Type.Literal('boundary'), Type.Literal('state'), Type.Literal('regression'), Type.Literal('resources')]),
  critical: Type.Boolean(),
  status: checkStatus,
  durationMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
}, { additionalProperties: false });
export type ExecutionCheck = Type.Static<typeof ExecutionCheckSchema>;

export const ExecutionPhaseSchema = Type.Object({
  kind: Type.Union([Type.Literal('public'), Type.Literal('hidden')]),
  declaredCommand: argv,
  // 容器包装会添加资源、挂载和隔离参数；题目原始命令仍受上面的32项限制。
  argv: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 128 }),
  cwd: text,
  timeoutMs: Type.Integer({ minimum: 1000 }),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Union([Type.String({ maxLength: 100 }), Type.Null()]),
  timedOut: Type.Boolean(),
  cancelled: Type.Boolean(),
  outputLimitExceeded: Type.Optional(Type.Boolean()),
  durationMs: Type.Integer({ minimum: 0 }),
  resource: Type.Object({
    peakRssBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    userCpuMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    systemCpuMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    sampler: text,
  }, { additionalProperties: false }),
  missing: Type.Array(checkId, { maxItems: 200 }),
  artifacts: Type.Array(checkId, { maxItems: 16 }),
}, { additionalProperties: false });

/** 一次 attempt 的执行结果：检查结论、退出原因、原始资源数据、候选哈希与证据引用。 */
export const ExecutionResultSchema = Type.Object({
  schemaVersion: Type.Literal('0.1.0'),
  runId: id,
  attemptId: id,
  taskId: id,
  taskVersion: text,
  candidateTreeHash: treeHash,
  classification: ExecutionClassificationSchema,
  isolation: Type.Union([Type.Literal('none'), Type.Literal('container')]),
  startedAt: text,
  finishedAt: text,
  durationMs: Type.Integer({ minimum: 0 }),
  environment: Type.Object({
    profile: Type.Union([Type.Literal('local'), Type.Literal('linux-container')]),
    imageDigest: Type.Union([Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }), Type.Null()]),
    platform: text,
    platformVersion: text,
    candidateRuntimes: Type.Array(text, { minItems: 1, maxItems: 8 }),
    containerRuntime: Type.Union([text, Type.Null()]),
    image: Type.Union([text, Type.Null()]),
    cpus: Type.Integer({ minimum: 1 }),
    totalMemoryMb: Type.Integer({ minimum: 1 }),
    network: Type.Boolean(),
  }, { additionalProperties: false }),
  phases: Type.Array(ExecutionPhaseSchema, { minItems: 1, maxItems: 8 }),
  checks: Type.Array(ExecutionCheckSchema, { minItems: 1, maxItems: 200 }),
  artifacts: Type.Array(ExecutionArtifactSchema, { maxItems: 64 }),
  evidenceRefs: Type.Array(checkId, { maxItems: 64 }),
  notes: Type.Array(text, { maxItems: 32 }),
}, { additionalProperties: false });
export type ExecutionResult = Type.Static<typeof ExecutionResultSchema>;
export type ExecutionPhase = Type.Static<typeof ExecutionPhaseSchema>;
export const executionPhaseValidator = Schema.Compile(ExecutionPhaseSchema);
export const executionResultValidator = Schema.Compile(ExecutionResultSchema);

/** 正式运行入口的请求体：候选目录必须在平台配置的提交根目录之内。 */
export const RunSubmissionSchema = Type.Object({
  taskId: id,
  candidateDirectory: text,
  idempotencyKey,
  submittedBy: text,
  reason: submissionReason,
}, { additionalProperties: false });
export type RunSubmission = Type.Static<typeof RunSubmissionSchema>;

/** 运行状态查询：当前阶段、已知失败、可重试原因与已有证据；评审未接入时总分待定。 */
export const RunStatusSchema = Type.Object({
  schemaVersion: Type.Literal('0.1.0'),
  runId: id,
  attemptId: id,
  taskId: id,
  taskVersion: text,
  phase: Type.Union([Type.Literal('frozen'), Type.Literal('verified')]),
  classification: Type.Union([ExecutionClassificationSchema, Type.Null()]),
  candidateTreeHash: treeHash,
  frozenAt: text,
  verifiedAt: Type.Union([text, Type.Null()]),
  knownFailures: Type.Array(Type.Object({
    id: checkId,
    kind: Type.Union([Type.Literal('public'), Type.Literal('hidden')]),
    critical: Type.Boolean(),
  }, { additionalProperties: false }), { maxItems: 200 }),
  missingChecks: Type.Array(checkId, { maxItems: 200 }),
  retryable: Type.Object({
    allowed: Type.Boolean(),
    reason: Type.Union([ExecutionClassificationSchema, Type.Null()]),
    sameSnapshotOnly: Type.Boolean(),
  }, { additionalProperties: false }),
  scoring: Type.Object({
    mode: Type.Union([Type.Literal('formal'), Type.Literal('local'), Type.Literal('rehearsal'), Type.Literal('pending')]),
    functional: score,
    quality: score,
    total: score,
    reason: text,
  }, { additionalProperties: false }),
  evidenceRefs: Type.Array(checkId, { maxItems: 64 }),
  artifacts: Type.Array(ExecutionArtifactSchema, { maxItems: 64 }),
  updatedAt: text,
}, { additionalProperties: false });
export type RunStatus = Type.Static<typeof RunStatusSchema>;
export const runStatusValidator = Schema.Compile(RunStatusSchema);
export const runStatusesValidator = Schema.Compile(Type.Array(RunStatusSchema));

/** 独立评审判决：三维分数必须各自引用证据，并记录模型、提示版本与调用成本。 */
export const ReviewVerdictSchema = Type.Object({
  schemaVersion: Type.Literal('0.1.0'),
  runId: id,
  attemptId: id,
  taskId: id,
  rubricVersion: text,
  model: text,
  promptVersion: text,
  // 维度分允许 null：提示词要求「无法从材料判断时拒绝输出判决，不能猜分」，模型必须能声明
  // 某一维不可判。null 不产生分数——下游 composeQuality 见到 null 即让该维保持待定。
  dimensions: Type.Object({
    simplicity: Type.Object({ score, evidence: Type.Array(id, { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
    maintainability: Type.Object({ score, evidence: Type.Array(id, { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
    decoupling: Type.Object({ score, evidence: Type.Array(id, { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  notes: Type.Array(text, { maxItems: 32 }),
  cost: Type.Object({
    calls: Type.Integer({ minimum: 0 }),
    inputTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    outputTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  }, { additionalProperties: false }),
  reviewedAt: text,
}, { additionalProperties: false });
export type ReviewVerdict = Type.Static<typeof ReviewVerdictSchema>;
export const reviewVerdictValidator = Schema.Compile(ReviewVerdictSchema);
export const HumanReviewSchema = Type.Object({
  reviewer: text,
  reason: text,
  verdict: ReviewVerdictSchema,
}, { additionalProperties: false });
export type HumanReview = Type.Static<typeof HumanReviewSchema>;
export const humanReviewValidator = Schema.Compile(HumanReviewSchema);

/** 评审适配器配置：令牌只从环境读取，绝不写入配置或运行档案。 */
export const JudgeConfigSchema = Type.Object({
  provider: text,
  model: text,
  endpoint: text,
  promptVersion: text,
  maxCalls: Type.Integer({ minimum: 1, maximum: 1000 }),
  maxInputTokens: Type.Integer({ minimum: 1 }),
  maxOutputTokens: Type.Integer({ minimum: 1 }),
  api: Type.Optional(Type.Union([Type.Literal('chat-completions'), Type.Literal('responses'), Type.Literal('messages'), Type.Literal('generate-content')])),
  reasoningEffort: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('minimal'), Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max')])),
  reasoningMode: Type.Optional(Type.Union([Type.Literal('standard'), Type.Literal('pro')])),
  thinking: Type.Optional(Type.Union([Type.Literal('enabled'), Type.Literal('disabled'), Type.Literal('adaptive')])),
  thinkingBudget: Type.Optional(Type.Integer({ minimum: -1 })),
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  topP: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
  topK: Type.Optional(Type.Integer({ minimum: 1 })),
  seed: Type.Optional(Type.Integer()),
  verbosity: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
  maxTokensPerCall: Type.Optional(Type.Integer({ minimum: 1 })),
  outputFormat: Type.Optional(Type.Union([Type.Literal('json-object'), Type.Literal('prompt-json')])),
  stream: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type JudgeConfig = Type.Static<typeof JudgeConfigSchema>;
export const judgeConfigValidator = Schema.Compile(JudgeConfigSchema);


/** 可用验证分组：权重与 docs/scoring.md 一致（20/10/10/5/5，合计 50）。 */
export const ExecutionScoreGroupSchema = Type.Union([
  Type.Literal('behavior'), Type.Literal('boundary'), Type.Literal('state'), Type.Literal('regression'), Type.Literal('resources'),
]);

export const ExecutionGroupScoreSchema = Type.Object({
  group: ExecutionScoreGroupSchema,
  weight: Type.Number({ minimum: 0, maximum: 50 }),
  score: Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
  weightPassed: Type.Number({ minimum: 0 }),
  weightTotal: Type.Number({ minimum: 0 }),
  passed: Type.Array(checkId, { maxItems: 200 }),
  failed: Type.Array(checkId, { maxItems: 200 }),
  notRun: Type.Array(checkId, { maxItems: 200 }),
}, { additionalProperties: false });

/**
 * 正式评分：可用验证分项只来自受控执行结果；代码质量证据缺失时保持 null，总分待定。
 * local / rehearsal 不属于正式成绩；formal 还需要经校准的任务和完整可信证据链。
 */
export const ExecutionScoreSchema = Type.Object({
  schemaVersion: Type.Literal('0.1.0'),
  mode: Type.Union([Type.Literal('formal'), Type.Literal('local'), Type.Literal('rehearsal')]),
  rubricVersion: Type.Literal('0.1.0'),
  runId: id,
  attemptId: id,
  taskId: id,
  taskVersion: text,
  candidateTreeHash: treeHash,
  classification: ExecutionClassificationSchema,
  functional: score,
  quality: score,
  total: score,
  groups: Type.Array(ExecutionGroupScoreSchema, { minItems: 1, maxItems: 5 }),
  dimensions: Type.Object({ simplicity: score, maintainability: score, decoupling: score }, { additionalProperties: false }),
  criticalPassed: Type.Boolean(),
  readiness: Type.Union([Type.Literal('complete'), Type.Literal('pending'), Type.Literal('infra-error')]),
  thresholdMet: Type.Union([Type.Boolean(), Type.Null()]),
  reasons: Type.Array(text, { maxItems: 32 }),
  evidenceRefs: Type.Array(checkId, { maxItems: 64 }),
  scoredAt: text,
}, { additionalProperties: false });
export type ExecutionScore = Type.Static<typeof ExecutionScoreSchema>;
export const executionScoreValidator = Schema.Compile(ExecutionScoreSchema);


/** 控制面事件：由可信侧按顺序追加到 attempt 的 events.jsonl，候选只能产生被采集的日志。 */
export const RunEventSchema = Type.Object({
  schemaVersion: Type.Literal('0.1.0'),
  id: checkId,
  seq: Type.Integer({ minimum: 1 }),
  at: text,
  type: Type.Union([
    Type.Literal('run.created'),
    Type.Literal('submission.frozen'),
    Type.Literal('execution.started'),
    Type.Literal('check.finished'),
    Type.Literal('execution.finished'),
    Type.Literal('execution.reused'),
    Type.Literal('score.finalized'),
    Type.Literal('static.analyzed'),
    Type.Literal('review.finished'),
  ]),
  actor: text,
  candidateHash: treeHash,
  payload: Type.Record(Type.String(), Type.Unknown()),
  evidenceRefs: Type.Array(checkId, { maxItems: 64 }),
}, { additionalProperties: false });
export type RunEvent = Type.Static<typeof RunEventSchema>;
export const runEventValidator = Schema.Compile(RunEventSchema);

export const RunDetailSchema = Type.Object({
  status: RunStatusSchema,
  execution: Type.Union([ExecutionResultSchema, Type.Null()]),
  score: Type.Union([ExecutionScoreSchema, Type.Null()]),
  events: Type.Array(RunEventSchema),
}, { additionalProperties: false });
export type RunDetail = Type.Static<typeof RunDetailSchema>;
export const runDetailValidator = Schema.Compile(RunDetailSchema);

/** 显式选择每题的一次作答；服务端不自动挑最高分或混入未选择的历史记录。 */
export const RunSelectionSchema = Type.Array(Type.Object({ runId: id, attemptId: id }, { additionalProperties: false }), { minItems: 1, maxItems: 55 });
export type RunSelection = Type.Static<typeof RunSelectionSchema>;
export const runSelectionValidator = Schema.Compile(RunSelectionSchema);
export const SuiteReportSchema = Type.Object({
  generatedAt: text,
  mode: Type.Union([Type.Literal('local'), Type.Literal('rehearsal'), Type.Literal('formal'), Type.Literal('pending')]),
  environmentKey: Type.Union([text, Type.Null()]),
  levels: Type.Array(Type.Object({ difficulty: DifficultySchema, expected: Type.Integer(), completed: Type.Integer(), score, passed: Type.Boolean() }, { additionalProperties: false })),
  weightedTotal: score,
  highestConsecutiveLevel: Type.Union([DifficultySchema, Type.Null()]),
  selected: Type.Array(Type.Object({ runId: id, attemptId: id, taskId: id, taskVersion: text, track: trackSchema, scoreRevision: Type.Union([text, Type.Null()]), scoredAt: Type.Union([text, Type.Null()]), total: score, thresholdMet: Type.Union([Type.Boolean(), Type.Null()]) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type SuiteReport = Type.Static<typeof SuiteReportSchema>;
export const suiteReportValidator = Schema.Compile(SuiteReportSchema);


/**
 * DSH 自动比较（experiment.json）的只读出口协议。
 * 报告目录由 CLI 直接落盘，这里只描述读取侧的事实：损坏的报告必须仍然出现在列表里并带原因，
 * 不允许被静默隐藏；不透明 reportId 由 API 生成，不是磁盘上的目录名。
 */
export const ProgressEntrySchema = Type.Object({
  at: text,
  message: text,
}, { additionalProperties: false });
export type ProgressEntry = Type.Static<typeof ProgressEntrySchema>;

export const ExperimentPhaseCountsSchema = Type.Object({
  pending: Type.Number({ minimum: 0 }),
  solving: Type.Number({ minimum: 0 }),
  grading: Type.Number({ minimum: 0 }),
  done: Type.Number({ minimum: 0 }),
  solverStopped: Type.Number({ minimum: 0 }),
  error: Type.Number({ minimum: 0 }),
}, { additionalProperties: false });
export type ExperimentPhaseCounts = Type.Static<typeof ExperimentPhaseCountsSchema>;

/** 一次作答的编排记录；solver 与 evaluation 原样透传，其协议由 @fsa/evaluation 拥有。 */
export const ExperimentRowSchema = Type.Object({
  taskId: id,
  taskVersion: text,
  preset: text,
  mode: text,
  repetition: Type.Number({ minimum: 1 }),
  sessionId: text,
  phase: Type.Union([
    Type.Literal('pending'), Type.Literal('solving'), Type.Literal('grading'),
    Type.Literal('done'), Type.Literal('solver-stopped'), Type.Literal('error'),
  ]),
  solver: Type.Unknown(),
  evaluation: Type.Unknown(),
  finishReason: Type.Union([text, Type.Null()]),
  durationMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  classification: Type.Union([text, Type.Null()]),
  runId: Type.Union([id, Type.Null()]),
  attemptId: Type.Union([id, Type.Null()]),
  total: score,
}, { additionalProperties: false });
export type ExperimentRow = Type.Static<typeof ExperimentRowSchema>;

const experimentEvidence = Type.Object({
  filename: text,
  sha256: treeHash,
  fileCount: Type.Number({ minimum: 0 }),
}, { additionalProperties: false });

const experimentCleanup = Type.Object({
  state: text,
  directory: Type.Union([text, Type.Null()]),
  reason: Type.Union([text, Type.Null()]),
}, { additionalProperties: false });

const experimentSummaryFields = {
  reportId: Type.String({ minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' }),
  root: text,
  directoryName: text,
  modifiedAt: text,
  // unreadable：experiment.json 缺失、损坏或不符合本协议；error 必须写明原因。
  status: Type.Union([Type.Literal('ok'), Type.Literal('unreadable')]),
  error: Type.Union([text, Type.Null()]),
  id: Type.Union([id, Type.Null()]),
  startedAt: Type.Union([text, Type.Null()]),
  finishedAt: Type.Union([text, Type.Null()]),
  state: Type.Union([text, Type.Null()]),
  provider: Type.Union([text, Type.Null()]),
  model: Type.Union([text, Type.Null()]),
  presets: Type.Array(text, { maxItems: 16, uniqueItems: true }),
  modes: Type.Array(text, { maxItems: 32, uniqueItems: true }),
  taskCount: Type.Number({ minimum: 0 }),
  planned: Type.Number({ minimum: 0 }),
  phaseCounts: ExperimentPhaseCountsSchema,
  evidence: Type.Union([experimentEvidence, Type.Null()]),
  cleanup: Type.Union([experimentCleanup, Type.Null()]),
};

export const ExperimentSummarySchema = Type.Object(experimentSummaryFields, { additionalProperties: false });
export type ExperimentSummary = Type.Static<typeof ExperimentSummarySchema>;

/** 明细在列表字段之上补充原报告设置与逐条记录；settings 是 CLI 写入的宽松对象。 */
export const ExperimentDetailSchema = Type.Object({
  ...experimentSummaryFields,
  settings: Type.Record(Type.String(), Type.Unknown()),
  rows: Type.Array(ExperimentRowSchema, { maxItems: 40_000 }),
  issues: Type.Array(text, { maxItems: 1000 }),
  progress: Type.Array(ProgressEntrySchema, { maxItems: 500 }),
}, { additionalProperties: false });
export type ExperimentDetail = Type.Static<typeof ExperimentDetailSchema>;

export const ExperimentListSchema = Type.Array(ExperimentSummarySchema, { maxItems: 5000 });
export type ExperimentList = Type.Static<typeof ExperimentListSchema>;

export const progressEntryValidator = Schema.Compile(ProgressEntrySchema);
export const experimentSummaryValidator = Schema.Compile(ExperimentSummarySchema);
export const experimentDetailValidator = Schema.Compile(ExperimentDetailSchema);
export const experimentListValidator = Schema.Compile(ExperimentListSchema);

/** 报告出口校验失败时的字段路径；损坏报告要出现在列表里并写明原因，不允许只报一句协议错误。 */
export function explainExperimentSummary(input: unknown): string[] {
  return Value.Errors(ExperimentSummarySchema, input).map(error => `${error.instancePath || '/'}：${error.message}`);
}

export function explainExperimentDetail(input: unknown): string[] {
  return Value.Errors(ExperimentDetailSchema, input).map(error => `${error.instancePath || '/'}：${error.message}`);
}


/** 校验失败时给出可定位的字段路径，避免只报一句“不符合协议”。 */
export function explainExecutionResult(input: unknown): string[] {
  return Value.Errors(ExecutionResultSchema, input).map(error => `${error.instancePath || '/'}：${error.message}`);
}

/** 评审判决校验失败时的字段路径；评分 Agent 输出的排障依赖它，不允许只报一句协议错误。 */
export function explainReviewVerdict(input: unknown): string[] {
  return Value.Errors(ReviewVerdictSchema, input).map(error => `${error.instancePath || '/'}：${error.message}`);
}
