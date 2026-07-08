/**
 * Galgame 剧本写作系统 - 核心类型定义
 *
 * 将 QMAI 的小说章节引擎改造为 Galgame 视觉小说节点图写作器。
 * 核心概念：节点 (Node) 替换章节 (Chapter)，线路 (Route) 替换卷 (Volume)，
 *          选项 (Choice) 替换续写 (Continue)，分支检查替换章节审查。
 *
 * ponytail: 类型定义保持最小但完整，不引入未使用的抽象。
 */

// ─── 项目层级 ───────────────────────────────────────────────

export interface GalProject {
  id: string
  title: string
  /** 总设定 / 世界观前提，注入到每个节点的上下文 */
  premise: string
  /** 不可违背的全局规则（对应 Canon） */
  globalRules: string
  /** 剧本变量（亲密度、恋爱度、flag 等） */
  variables: GalVariable[]
  /** 线路列表 */
  routes: GalRoute[]
  /** CG 列表 */
  cgs: GalCg[]
  /** 线索列表（替代伏笔） */
  clues: GalClue[]
  /** 创建时间 */
  createdAt: string
  /** 最后修改时间 */
  updatedAt: string
}

export interface GalRoute {
  id: string
  /** 线路名称，如 "主线路"、"巫女服线" */
  title: string
  /** 线路主题 / 基调描述 */
  theme: string
  /** 基于主线树节点拼接出来的线路路径。主线路为空，分线路保存节点 id 组合。 */
  nodeIds?: string[]
  /** 入口节点 ID */
  entryNodeId: string
  /** 结局节点 ID 列表 */
  endingNodeIds: string[]
  /** 该线路下的所有节点 */
  nodes: GalNode[]
  /** 该线路级变量默认值 */
  variableDefaults?: Record<string, number | string | boolean>
}

// ─── 节点层级 ───────────────────────────────────────────────

export type GalNodeType =
  | "entry"    // 入口节点（线路起点）
  | "daily"    // 日常节点
  | "choice"   // 选择节点（含多个选项）
  | "common"   // 共同节点（多条分支汇合）
  | "clue"     // 线索节点（获得线索）
  | "cg"       // CG 节点（触发 CG）
  | "ending"   // 结局节点

export type GalNodeStatus =
  | "card"     // 卡片状态（仅有概要，未生成正文）
  | "draft"    // 草稿（已生成正文，未确认）
  | "final"    // 终稿（已确认保存）

export interface GalNode {
  id: string
  /** 所属线路 ID */
  routeId: string
  /** 节点标题 */
  title: string
  type: GalNodeType
  status: GalNodeStatus
  /** 父节点 ID 列表（入口节点为空数组） */
  parents: string[]
  /** 子节点 ID 列表 */
  children: string[]
  /** 节点剧情目标 */
  goal: string
  /** 节点概要（card 状态下由 AI 生成） */
  summary: string
  /** 线路画布中的手动布局位置 */
  boardPosition?: {
    x: number
    y: number
  }
  /** 节点正文存储路径（相对于项目根目录） */
  scriptPath: string
  /** 进入节点前的状态快照 */
  incomingState: GalStateSnapshot
  /** 离开节点后的状态快照 */
  outgoingState?: GalStateSnapshot
  /** 该节点的选项列表（choice 类型必有） */
  choices: GalChoice[]
  /** 记忆作用域 */
  memoryScope: GalMemoryScope
  /** 节点出场人物 */
  characters: string[]
  /** 场景描述 */
  scene: string
  /** 本节点 AI 正文生成的补充提示词 */
  aiPrompt?: string
  /** 本节点 AI 选项生成的补充提示词 */
  choicePrompt?: string
  /** 关联的 CG ID */
  cgId?: string
  /** 本章获得的线索 ID */
  clueIds: string[]
  /** 章节号（自动编号，用于排序） */
  sequence: number
  /** 创建时间 */
  createdAt: string
  /** 最后修改时间 */
  updatedAt: string
}

// ─── 选项 ──────────────────────────────────────────────────

export interface GalChoice {
  id: string
  /** 选项展示文本 */
  text: string
  /** 选项的情感意图（帮助 LLM 理解语气） */
  emotionalIntent: string
  /** 选择条件（满足所有条件才显示） */
  condition?: GalCondition[]
  /** 选择后的效果 */
  effects: GalEffect[]
  /** 指向的下一个节点 ID（可选，card 阶段可为空） */
  nextNodeId?: string
  /** 下一个节点的建议标题（card 阶段使用） */
  nextNodeTitle?: string
  /** 下一个节点的剧情目标（card 阶段使用） */
  nextNodeGoal?: string
}

export interface GalCondition {
  /** 变量名 */
  variable: string
  /** 比较操作符 */
  op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "has_clue" | "not_has_clue"
  /** 比较值 */
  value: number | string | boolean
}

export interface GalEffect {
  /** 变量名 */
  variable: string
  /** 操作：set 直接设置，add 增减 */
  op: "set" | "add"
  /** 值 */
  value: number | string | boolean
}

// ─── 状态快照 ──────────────────────────────────────────────

export interface GalStateSnapshot {
  /** 变量键值对 */
  variables: Record<string, number | string | boolean>
  /** 角色认知状态 */
  characterCognition: Record<string, GalCharacterCognition>
  /** 已获得线索 ID 列表 */
  acquiredClueIds: string[]
  /** 已触发 CG ID 列表 */
  seenCgIds: string[]
  /** 已访问节点 ID 列表（去重后的路径顺序） */
  visitedNodeIds: string[]
  /** 当前场景 */
  currentScene: string
  /** 各角色当前情绪状态 */
  characterMoods: Record<string, string>
}

export interface GalCharacterCognition {
  /** 角色已知的信息 */
  knows: string[]
  /** 角色不知道的信息 */
  doesNotKnow: string[]
  /** 读者知道但角色不知道的信息 */
  readerKnowsButCharacterDoesNot: string[]
}

// ─── 记忆层级 ──────────────────────────────────────────────

export type GalMemoryScope = "global" | "route" | "path" | "node"

export interface GalGlobalMemory {
  projectId: string
  /** 正史设定：不随线路变化 */
  canonRules: string
  /** 角色基本信息（不依赖线路） */
  characterProfiles: Record<string, GalCharacterProfile>
  /** 世界观设定 */
  worldSettings: string
  lastUpdated: string
}

export interface GalCharacterProfile {
  name: string
  aliases: string[]
  identity: string
  personality: string
  appearance: string
  background: string
}

export interface GalRouteMemory {
  routeId: string
  /** 该线路内成立的全局事件 */
  routeEvents: string[]
  /** 该线路的时间线 */
  timeline: GalTimelineEntry[]
  lastUpdated: string
}

export interface GalTimelineEntry {
  nodeId: string
  nodeTitle: string
  sequence: number
  event: string
}

export interface GalNodeMemory {
  nodeId: string
  routeId: string
  /** 节点摘要 */
  summary: string
  /** 节点结尾（末段内容，用于下一节点衔接） */
  endingText: string
  /** 节点内变量变化 */
  variableChanges: GalEffect[]
  /** 节点内角色状态变化 */
  characterStateChanges: string[]
  /** 节点内关系变化 */
  relationshipChanges: string[]
  /** 节点内的选择（仅 choice 类型） */
  choices: GalChoice[]
  lastUpdated: string
}

/** 路径记忆不持久化，运行时从 DAG 实时计算 */

// ─── 变量 ──────────────────────────────────────────────────

export interface GalVariable {
  id: string
  name: string
  /** 变量类型 */
  type: "intimacy" | "love" | "flag" | "custom"
  /** 初始值 */
  defaultValue: number | string | boolean
  /** 最小值（仅数值类型） */
  min?: number
  /** 最大值（仅数值类型） */
  max?: number
  /** 描述 */
  description: string
}

// ─── 线索（替代伏笔）─────────────────────────────────────────

export interface GalClue {
  id: string
  name: string
  description: string
  type: "normal" | "special" | "true_ending"
  status: "hidden" | "discovered" | "advanced" | "resolved"
  /** 埋设节点 ID */
  plantedNodeId?: string
  /** 发现该线索的节点 ID 列表 */
  discoveredNodeIds: string[]
  /** 解锁结局所需要该线索的状态 */
  requiredForEnding?: string[]
}

// ─── CG ───────────────────────────────────────────────────

export interface GalCg {
  id: string
  name: string
  description: string
  /** 触发该 CG 的节点 ID */
  triggerNodeId?: string
  /** 触发条件 */
  triggerConditions?: GalCondition[]
  /** 图片路径（相对于项目目录） */
  imagePath?: string
}

// ─── 合流契约 ──────────────────────────────────────────────

export interface MergeContract {
  /** 共同节点 ID */
  nodeId: string
  /** 被接受的父节点 ID 列表 */
  acceptedParentNodes: string[]
  /** 进入共同节点前必须满足的状态 */
  requiredState: GalCondition[]
  /** 进入共同节点后的状态标准化 */
  normalizeEffects: GalEffect[]
  /** 禁止的矛盾点 */
  forbiddenContradictions: string[]
}

// ─── 分支检查结果 ──────────────────────────────────────────

export type BranchLintSeverity = "blocking" | "high" | "medium" | "low"

export interface BranchLintResult {
  severity: BranchLintSeverity
  type: BranchLintType
  nodeId?: string
  routeId?: string
  message: string
  detail: string
  suggestion: string
}

export type BranchLintType =
  | "orphan_entry"           // 无入口节点
  | "broken_child"            // 子节点断开
  | "choice_target_missing"    // 选项指向不存在的节点
  | "ending_unreachable"       // 结局不可达
  | "cg_unlockable"            // CG 无法解锁
  | "condition_impossible"     // 条件永远不可能满足
  | "variable_out_of_range"    // 变量超范围
  | "clue_unused"              // 特殊线索未被使用
  | "merge_conflict"           // 共同节点合流冲突
  | "cognition_boundary"       // 角色认知越界
  | "dead_end"                 // 死胡同（非结局节点无子节点）

// ─── 节点摄取快照 ──────────────────────────────────────────

export interface NodeSnapshot {
  nodeId: string
  routeId: string
  nodeTitle: string
  nodeType: GalNodeType
  summary: string
  characters: string[]
  locations: string[]
  scenes: string[]
  events: string[]
  characterStateChanges: string[]
  relationshipChanges: string[]
  cognitionChanges: string[]
  clueChanges: string[]
  variableChanges: GalEffect[]
  endingHook: string
  choices: GalChoice[]
  graphNodes: string[]
  graphEdges: string[]
  sourceRevision: number
  snapshotId: string
  memorySyncedAt?: string
}

// ─── 导出格式 ──────────────────────────────────────────────

export interface GalExportMarkdown {
  projectTitle: string
  routeTitle: string
  nodes: GalExportNode[]
  variables: GalVariable[]
  clues: GalClue[]
}

export interface GalExportNode {
  nodeId: string
  title: string
  type: GalNodeType
  summary: string
  script: string
  choices: GalChoice[]
  outgoingState?: GalStateSnapshot
}
