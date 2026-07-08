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

export type GalAiTaskStatus = "running" | "retrying" | "failed"
export type GalBoardHighlightRole = "upstream" | "target" | "downstream" | "problem" | "error"

export interface GalBoardNodeHighlight {
  role: GalBoardHighlightRole
  label?: string
}

export interface GalBoardPreviewInsertionHighlight {
  id: string
  afterNodeId: string
  beforeNodeId: string
  title: string
}

export interface GalBoardHighlightState {
  nodes: Record<string, GalBoardNodeHighlight>
  previewInsertions: GalBoardPreviewInsertionHighlight[]
}

export interface GalAiTask {
  id: string
  title: string
  detail: string
  status: GalAiTaskStatus
  attempt: number
  maxRetries: number
  error?: string
  createdAt: number
  updatedAt: number
}

export interface GalAiTaskController {
  update: (detail: string) => void
}

function findRouteContainingNode(project: GalProject | null, nodeId: string | null): GalRoute | undefined {
  if (!project || !nodeId) return undefined
  return (project.routes ?? []).find((route) => {
    if ((route.nodes ?? []).some((node) => node.id === nodeId)) return true
    return Array.isArray(route.nodeIds) && route.nodeIds.includes(nodeId)
  })
}

export interface GalState {
  // ─── 项目状态 ───
  project: GalProject | null
  loading: boolean
  error: string | null

  // ─── 当前选择 ───
  selectedRouteId: string | null
  selectedNodeId: string | null
  locateRequest: { nodeId: string; requestId: number } | null
  boardHighlight: GalBoardHighlightState | null

  // ─── 编辑器 ───
  nodeScriptDraft: string
  editing: boolean

  // ─── 生成状态 ───
  generating: boolean
  generatingNodeId: string | null
  generatingNodeIds: string[]
  generationProgress: string
  aiTasks: GalAiTask[]

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
  requestLocateNode: (nodeId: string) => void
  clearLocateRequest: () => void
  setBoardHighlight: (highlight: GalBoardHighlightState | null) => void
  clearBoardHighlight: () => void
  setNodeScriptDraft: (script: string) => void
  setEditing: (editing: boolean) => void
  setGenerating: (generating: boolean, nodeId?: string | null) => void
  setGenerationProgress: (progress: string) => void
  runAiTask: <T>(
    meta: { title: string; detail?: string; maxRetries?: number },
    runner: (task: GalAiTaskController) => Promise<T>,
  ) => Promise<T>
  dismissAiTask: (taskId: string) => void
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
  locateRequest: null,
  boardHighlight: null,
  nodeScriptDraft: "",
  editing: false,
  generating: false,
  generatingNodeId: null,
  generatingNodeIds: [],
  generationProgress: "",
  aiTasks: [],
  ingesting: false,
  lintRunning: false,
  lintResults: [],

  setProject: (project) =>
    set((state) => {
      const selectedRouteExists = Boolean(project?.routes?.some((route) => route.id === state.selectedRouteId))
      const selectedNodeRoute = findRouteContainingNode(project, state.selectedNodeId)
      return {
        project,
        error: null,
        selectedRouteId: selectedNodeRoute?.id ?? (selectedRouteExists ? state.selectedRouteId : null),
        selectedNodeId: selectedNodeRoute ? state.selectedNodeId : null,
      }
    }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  selectRoute: (routeId) =>
    set({ selectedRouteId: routeId, selectedNodeId: null, nodeScriptDraft: "" }),

  selectNode: (nodeId) =>
    set({ selectedNodeId: nodeId, nodeScriptDraft: "", editing: false }),

  requestLocateNode: (nodeId) =>
    set({ locateRequest: { nodeId, requestId: Date.now() } }),

  clearLocateRequest: () => set({ locateRequest: null }),

  setBoardHighlight: (highlight) => set({ boardHighlight: highlight }),
  clearBoardHighlight: () => set({ boardHighlight: null }),

  setNodeScriptDraft: (script) => set({ nodeScriptDraft: script }),
  setEditing: (editing) => set({ editing }),

  setGenerating: (generating, nodeId) =>
    set((state) => {
      const currentIds = state.generatingNodeIds ?? []
      const nextIds = nodeId
        ? generating
          ? Array.from(new Set([...currentIds, nodeId]))
          : currentIds.filter((id) => id !== nodeId)
        : generating
          ? currentIds
          : []
      return {
        generating: nextIds.length > 0,
        generatingNodeId: nextIds[0] ?? null,
        generatingNodeIds: nextIds,
        generationProgress: generating ? "" : state.generationProgress,
      }
    }),

  setGenerationProgress: (progress) => set({ generationProgress: progress }),
  runAiTask: async (meta, runner) => {
    const taskId = `gal_ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const maxRetries = meta.maxRetries ?? 2
    const now = Date.now()
    set((state) => ({
      aiTasks: [
        ...state.aiTasks,
        {
          id: taskId,
          title: meta.title,
          detail: meta.detail ?? "等待开始...",
          status: "running",
          attempt: 1,
          maxRetries,
          createdAt: now,
          updatedAt: now,
        },
      ],
    }))

    const update = (detail: string) => {
      set((state) => ({
        aiTasks: state.aiTasks.map((task) =>
          task.id === taskId ? { ...task, detail, updatedAt: Date.now() } : task,
        ),
      }))
    }

    let lastError: unknown
    for (let retry = 0; retry <= maxRetries; retry += 1) {
      const attempt = retry + 1
      set((state) => ({
        aiTasks: state.aiTasks.map((task) =>
          task.id === taskId
            ? {
                ...task,
                attempt,
                status: retry > 0 ? "retrying" : "running",
                error: undefined,
                updatedAt: Date.now(),
              }
            : task,
        ),
      }))
      try {
        const result = await runner({ update })
        set((state) => ({ aiTasks: state.aiTasks.filter((task) => task.id !== taskId) }))
        return result
      } catch (err) {
        lastError = err
        const message = err instanceof Error ? err.message : String(err)
        set((state) => ({
          aiTasks: state.aiTasks.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  status: retry < maxRetries ? "retrying" : "failed",
                  detail: retry < maxRetries ? "生成失败，正在自动重试..." : "重试已用完，任务失败。",
                  error: message,
                  updatedAt: Date.now(),
                }
              : task,
          ),
        }))
      }
    }
    throw lastError
  },
  dismissAiTask: (taskId) =>
    set((state) => ({ aiTasks: state.aiTasks.filter((task) => task.id !== taskId) })),
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
