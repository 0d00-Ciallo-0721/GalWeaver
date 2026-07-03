/**
 * Galgame 图谱适配器
 *
 * 将 Galgame 节点数据映射到现有图谱系统（NovelGraphNode/NovelGraphEdge）。
 * 新增 Gal 专用节点类型和关系类型，复用现有 Sigma.js 渲染管线。
 *
 * ponytail: 只做类型映射，不碰渲染代码。
 */

import type { NovelGraphEdge, NovelNodeType } from "@/lib/novel/graph-adapter"
import type {
  GalProject,
  NodeSnapshot,
} from "./gal-types"

// ─── 扩展节点类型 ──────────────────────────────────────────

/** Galgame 专用的图谱节点类型（追加到 NovelNodeType） */
export type GalGraphNodeType =
  | "route"        // 线路
  | "gal-node"     // Gal 节点（对应 chapter）
  | "choice"       // 选项
  | "ending"       // 结局
  | "cg"           // CG 事件
  | "clue"         // 线索
  | "variable"     // 变量/flag
  | "scene"        // 场景

/** 完整的节点类型（小说 + Gal） */
export type ExtendedNodeType = NovelNodeType | GalGraphNodeType

/** Gal 专用节点 */
export interface GalGraphNode {
  id: string
  label: string
  type: ExtendedNodeType
}

// ─── 扩展关系类型 ──────────────────────────────────────────

export const GAL_RELATION_LABELS: Record<string, string> = {
  STARTS_AT: "入口为",
  CHOICE_TO: "选项指向",
  REQUIRES: "需要",
  SETS: "设置",
  ADDS: "增加",
  UNLOCKS: "解锁",
  USES_CG: "使用CG",
  MERGES_TO: "汇入",
  BLOCKS: "阻断",
  LEADS_TO: "导向",
  TRIGGERS_CG: "触发CG",
  DISCOVERS_CLUE: "发现线索",
  CHANGES_VAR: "改变变量",
}

// ─── 节点标签映射（用于 Sigma.js 渲染） ────────────────────

export const GAL_NODE_TYPE_LABELS: Record<GalGraphNodeType, string> = {
  route: "线路",
  "gal-node": "节点",
  choice: "选项",
  ending: "结局",
  cg: "CG",
  clue: "线索",
  variable: "变量",
  scene: "场景",
}

/** 节点类型颜色（追加到 graph-view.tsx 的 NODE_TYPE_COLORS） */
export const GAL_NODE_TYPE_COLORS: Record<GalGraphNodeType, string> = {
  route: "#6c5ce7",       // 紫色
  "gal-node": "#00b894",  // 绿色
  choice: "#fdcb6e",      // 黄色
  ending: "#e17055",      // 珊瑚色
  cg: "#fd79a8",          // 粉色
  clue: "#a29bfe",        // 浅紫
  variable: "#74b9ff",    // 浅蓝
  scene: "#81ecec",       // 青色
}

// ─── 从 GalProject 构建图谱 ────────────────────────────────

/**
 * 将 Gal 项目转换为图谱节点和边。
 * 复用现有 buildWikiGraph 的节点/边结构。
 */
export function galProjectToGraph(
  project: GalProject,
): { nodes: GalGraphNode[]; edges: NovelGraphEdge[] } {
  const nodes: GalGraphNode[] = []
  const edges: NovelGraphEdge[] = []

  // 1. 线路节点
  for (const route of project.routes) {
    nodes.push({
      id: `route:${route.id}`,
      label: route.title,
      type: "route",
    })

    // 2. 节点 → 线路
    for (const node of route.nodes) {
      const nodeGraphId = `gal-node:${node.id}`
      nodes.push({
        id: nodeGraphId,
        label: node.title,
        type: "gal-node",
      })

      edges.push({
        source: nodeGraphId,
        target: `route:${route.id}`,
        relation: "BELONGS_TO",
        confidence: 1,
      })

      // 3. 父 → 子 边
      for (const parentId of node.parents) {
        edges.push({
          source: `gal-node:${parentId}`,
          target: nodeGraphId,
          relation: "LEADS_TO",
          confidence: 1,
        })
      }

      // 4. 选项边
      for (const choice of node.choices) {
        const choiceGraphId = `choice:${choice.id}`
        nodes.push({
          id: choiceGraphId,
          label: choice.text,
          type: "choice",
        })

        edges.push({
          source: nodeGraphId,
          target: choiceGraphId,
          relation: "CHOICE_TO",
          confidence: 1,
        })

        if (choice.nextNodeId) {
          edges.push({
            source: choiceGraphId,
            target: `gal-node:${choice.nextNodeId}`,
            relation: "LEADS_TO",
            confidence: 1,
          })
        }
      }

      // 5. 结局节点
      if (node.type === "ending") {
        nodes.push({
          id: `ending:${node.id}`,
          label: node.title,
          type: "ending",
        })
        edges.push({
          source: nodeGraphId,
          target: `ending:${node.id}`,
          relation: "LEADS_TO",
          confidence: 1,
        })
      }
    }

    // 6. 入口节点边
    const entryNode = route.nodes.find((n) => n.id === route.entryNodeId)
    if (entryNode) {
      edges.push({
        source: `route:${route.id}`,
        target: `gal-node:${entryNode.id}`,
        relation: "STARTS_AT",
        confidence: 1,
      })
    }
  }

  // 7. 线索节点
  for (const clue of project.clues) {
    nodes.push({
      id: `clue:${clue.id}`,
      label: clue.name,
      type: "clue",
    })
  }

  // 8. CG 节点
  for (const cg of project.cgs) {
    nodes.push({
      id: `cg:${cg.id}`,
      label: cg.name,
      type: "cg",
    })
  }

  // 9. 变量节点
  for (const variable of project.variables) {
    nodes.push({
      id: `variable:${variable.id}`,
      label: variable.name,
      type: "variable",
    })
  }

  return { nodes, edges }
}

/**
 * 将节点快照的 graphNodes/graphEdges 合并到图谱。
 */
export function snapshotToGalGraph(
  snapshot: NodeSnapshot,
): { nodes: GalGraphNode[]; edges: NovelGraphEdge[] } {
  const nodes: GalGraphNode[] = []
  const edges: NovelGraphEdge[] = []

  // 节点快照的 graphNodes 是 ["character:张三", "location:教室", ...] 格式
  for (const rawNode of snapshot.graphNodes) {
    const [type, label] = rawNode.includes(":")
      ? [rawNode.split(":")[0], rawNode.slice(rawNode.indexOf(":") + 1)]
      : ["gal-node", rawNode]

    nodes.push({
      id: rawNode,
      label,
      type: type as ExtendedNodeType,
    })
  }

  // graphEdges 是 ["A->关系->B"] 格式
  for (const rawEdge of snapshot.graphEdges) {
    const parts = rawEdge.split("->")
    if (parts.length >= 3) {
      edges.push({
        source: parts[0].trim(),
        target: parts[2].trim(),
        relation: parts[1].trim(),
        confidence: 1,
      })
    }
  }

  return { nodes, edges }
}
