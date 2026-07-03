/**
 * Galgame 工作台状态管理
 *
 * 管理当前 Gal 项目的运行时状态：选中线路、选中节点、编辑中的正文等。
 * 持久化数据通过 gal-storage.ts 读写，此 Store 管理 UI 状态。
 *
 * ponytail: 最小状态集，够用就行。
 */

import { create } from "zustand"
import type { GalProject, GalRoute, GalNode, BranchLintResult } from "@/lib/gal/gal-types"

export interface GalState {
  // ─── 项目状态 ───
  project: GalProject | null
  loading: boolean
  error: string | null

  // ─── 当前选择 ───
  selectedRouteId: string | null
  selectedNodeId: string | null

  // ─── 编辑器 ───
  nodeScriptDraft: string
  editing: boolean

  // ─── 生成状态 ───
  generating: boolean
  generatingNodeId: string | null
  generationProgress: string

  // ─── 摄取状态 ───
  ingesting: boolean

  // ─── 分支检查 ───
  lintRunning: boolean
  lintResults: BranchLintResult[]

  // ─── 操作 ───
  setProject: (project: GalProject | null) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  selectRoute: (routeId: string | null) => void
  selectNode: (nodeId: string | null) => void
  setNodeScriptDraft: (script: string) => void
  setEditing: (editing: boolean) => void
  setGenerating: (generating: boolean, nodeId?: string | null) => void
  setGenerationProgress: (progress: string) => void
  setIngesting: (ingesting: boolean) => void
  setLintRunning: (running: boolean) => void
  setLintResults: (results: BranchLintResult[]) => void

  // ─── 派生 ───
  selectedRoute: () => GalRoute | undefined
  selectedNode: () => GalNode | undefined
  currentNodeRoute: () => GalRoute | undefined
}

export const useGalStore = create<GalState>((set, get) => ({
  project: null,
  loading: false,
  error: null,
  selectedRouteId: null,
  selectedNodeId: null,
  nodeScriptDraft: "",
  editing: false,
  generating: false,
  generatingNodeId: null,
  generationProgress: "",
  ingesting: false,
  lintRunning: false,
  lintResults: [],

  setProject: (project) => set({ project, error: null }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  selectRoute: (routeId) =>
    set({ selectedRouteId: routeId, selectedNodeId: null, nodeScriptDraft: "" }),

  selectNode: (nodeId) =>
    set({ selectedNodeId: nodeId, nodeScriptDraft: "", editing: false }),

  setNodeScriptDraft: (script) => set({ nodeScriptDraft: script }),
  setEditing: (editing) => set({ editing }),

  setGenerating: (generating, nodeId) =>
    set({
      generating,
      generatingNodeId: generating ? (nodeId ?? null) : null,
      generationProgress: generating ? "" : "",
    }),

  setGenerationProgress: (progress) => set({ generationProgress: progress }),
  setIngesting: (ingesting) => set({ ingesting }),

  setLintRunning: (running) => set({ lintRunning: running }),
  setLintResults: (results) => set({ lintResults: results }),

  selectedRoute: () => {
    const { project, selectedRouteId } = get()
    const routes = Array.isArray(project?.routes) ? project.routes : []
    const route = routes.find((r) => r.id === selectedRouteId)
    if (!route) return undefined
    const mainRoute = routes.find((r) => r.id === "main") ?? routes[0]
    if (!mainRoute || route.id === mainRoute.id || !Array.isArray(route.nodeIds)) {
      return route
    }
    const nodeById = new Map((mainRoute.nodes ?? []).map((node) => [node.id, node]))
    const nodes = route.nodeIds
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is GalNode => Boolean(node))
    return {
      ...route,
      entryNodeId: nodes[0]?.id ?? mainRoute.entryNodeId,
      nodes,
    }
  },

  selectedNode: () => {
    const route = get().selectedRoute()
    const nodeId = get().selectedNodeId
    return (route?.nodes ?? []).find((n) => n.id === nodeId)
  },

  currentNodeRoute: () => {
    const { project, selectedNodeId } = get()
    if (!project || !selectedNodeId) return undefined
    const routes = Array.isArray(project.routes) ? project.routes : []
    return routes.find((r) => (r.nodes ?? []).some((n) => n.id === selectedNodeId))
  },
}))
