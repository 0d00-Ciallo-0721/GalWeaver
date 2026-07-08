/**
 * Galgame 剧本写作系统 - 模块入口
 *
 * ponytail: barrel export，不引入额外逻辑。
 */

// 类型
export type {
  GalProject,
  GalRoute,
  GalNode,
  GalNodeType,
  GalNodeStatus,
  GalChoice,
  GalCondition,
  GalEffect,
  GalStateSnapshot,
  GalCharacterCognition,
  GalMemoryScope,
  GalGlobalMemory,
  GalCharacterProfile,
  GalRouteMemory,
  GalTimelineEntry,
  GalNodeMemory,
  GalVariable,
  GalClue,
  GalCg,
  MergeContract,
  BranchLintResult,
  BranchLintSeverity,
  BranchLintType,
  NodeSnapshot,
  GalExportMarkdown,
  GalExportNode,
} from "./gal-types"

// 存储
export {
  initGalDirectory,
  isGalProject,
  saveGalProject,
  loadGalProject,
  saveGalRoute,
  loadGalRoute,
  saveNodeScript,
  loadNodeScript,
  deleteNodeScript,
  saveGlobalMemory,
  loadGlobalMemory,
  saveRouteMemory,
  loadRouteMemory,
  saveNodeMemory,
  loadNodeMemory,
  saveNodeSnapshot,
  loadNodeSnapshot,
  listRouteNodeIds,
  saveClues,
  loadClues,
  saveVariables,
  loadVariables,
  getNodeScriptPath,
} from "./gal-storage"

// 项目初始化
export { initGalProject } from "./gal-project-init"
export type { GalInitParams } from "./gal-project-init"

// 提示词
export {
  buildGalInitPrompt,
  buildEntryNodePrompt,
  buildChildNodeCardPrompt,
  buildNodeGenerationPrompt,
  buildNodeReviewPrompt,
  buildBranchLintPrompt,
} from "./gal-prompts"

// 上下文引擎
export {
  buildGalContextPack,
  galContextPackToPrompt,
} from "./gal-context-engine"
export type { GalContextPack } from "./gal-context-engine"

// 节点生成
export {
  generateNodeScript,
  expandChildNodeCard,
} from "./gal-node-generation"
export type {
  GenerateNodeParams,
  GenerateNodeResult,
  ExpandChildNodesParams,
  ChildNodeCardResult,
} from "./gal-node-generation"

// 节点摄取
export {
  ingestNode,
} from "./gal-node-ingest"
export type { IngestNodeParams, IngestNodeResult } from "./gal-node-ingest"

// 分支检查
export { lintBranchGraph } from "./gal-branch-lint"

// 任务路由
export {
  detectGalLonglineRange,
} from "./gal-longline-range"
export type {
  GalLonglineDirection,
  GalLonglineRange,
  GalLonglineRangeWarning,
  GalLonglineStop,
  GalLonglineStopReason,
} from "./gal-longline-range"

export {
  reviewGalLongline,
} from "./gal-longline-review"
export type {
  GalLonglineContinuityBreak,
  GalLonglineIssue,
  GalLonglineReviewNodeInput,
  GalLonglineReviewParams,
  GalLonglineReviewReport,
  GalLonglineRewriteTarget,
  GalLonglineSuggestedInsertion,
} from "./gal-longline-review"

export {
  generateGalLonglineOptimizationPlan,
} from "./gal-longline-optimization"
export type {
  GalLonglineNodeOptimization,
  GalLonglineOptimizationParams,
  GalLonglineOptimizationPlan,
  GalLonglineOptimizeMode,
  GalLonglineOptimizeSuggestion,
  GalLonglineSuggestedNodeInsertion,
} from "./gal-longline-optimization"

export {
  routeGalTask,
  buildGalTaskDirective,
} from "./gal-task-router"
export type { GalTaskIntent, GalTaskRouteResult } from "./gal-task-router"

// 图谱适配器
export {
  galProjectToGraph,
  snapshotToGalGraph,
  GAL_RELATION_LABELS,
  GAL_NODE_TYPE_LABELS,
  GAL_NODE_TYPE_COLORS,
} from "./gal-graph-adapter"
export type { GalGraphNodeType, ExtendedNodeType, GalGraphNode } from "./gal-graph-adapter"
