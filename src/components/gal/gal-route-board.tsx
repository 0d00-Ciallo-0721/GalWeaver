/**
 * Galgame 线路画布
 *
 * 以 Arcweave 风格展示线路节点和选项连线。点击节点进入详细编辑。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { FileDown, Flag, GitBranch, Hand, Loader2, Maximize2, Minus, Plus, Sparkles } from "lucide-react"
import { useGalStore, type GalBoardHighlightRole } from "@/stores/gal-store"
import { useWikiStore } from "@/stores/wiki-store"
import { generateRelayNodeCard } from "@/lib/gal/gal-node-generation"
import { insertRelayNodeIntoProject } from "@/lib/gal/gal-relay-node-insert"
import { detectGalGraphIssues, getNodeOutgoingTargets } from "@/lib/gal/gal-graph-normalize"
import { loadGalProject, saveGalProject } from "@/lib/gal/gal-storage"
import type { GalNode, GalRoute } from "@/lib/gal/gal-types"
import { getNodeStatusLabel, getNodeTypeColor, getNodeTypeLabel } from "./gal-utils"
import { GalPathExportDialog } from "./gal-path-export-dialog"

interface GalRouteBoardProps {
  route: GalRoute | undefined
  selectedNodeId: string | null
  onSelectNode: (nodeId: string) => void
  onReinitGal?: () => void
  reinitializing?: boolean
  error?: string | null
  onOpenLonglineWorkspace?: (nodeId: string) => void
  readOnly?: boolean
}

interface BoardNode {
  node: GalNode
  worldX: number
  worldY: number
  x: number
  y: number
}

interface BoardEdge {
  id: string
  sourceId: string
  targetId: string
  label: string
}

type BoardPositions = Record<string, { x: number; y: number }>

interface BoardViewportState {
  version: 2
  scrollLeft: number
  scrollTop: number
  scale: number
  focusedNodeId?: string
}

const NODE_WIDTH = 260
const NODE_HEIGHT = 150
const X_GAP = 180
const Y_GAP = 70
const DRAG_THRESHOLD = 4
const CANVAS_ORIGIN = 1600
const CANVAS_PADDING = 600
const MIN_SCALE = 0.1
const MAX_SCALE = 1.35
const SCALE_STEP = 0.01
const SCALE_REPEAT_DELAY = 350
const SCALE_REPEAT_INTERVAL = 60

export function GalRouteBoard({
  route,
  selectedNodeId,
  onSelectNode,
  onReinitGal,
  reinitializing = false,
  error,
  onOpenLonglineWorkspace,
  readOnly = false,
}: GalRouteBoardProps) {
  const project = useWikiStore((state) => state.project)
  const galStore = useGalStore()
  const boardHighlight = galStore.boardHighlight
  const [scale, setScale] = useState(
    () => readBoardViewportState(project?.path, route?.id)?.scale ?? 0.9,
  )
  const [panMode, setPanMode] = useState(false)
  const [positions, setPositions] = useState<BoardPositions>({})
  const [positionsRouteId, setPositionsRouteId] = useState<string | null>(null)
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(
    () => readBoardViewportState(project?.path, route?.id)?.focusedNodeId ?? null,
  )
  const [edgeMenu, setEdgeMenu] = useState<{ x: number; y: number; edge: BoardEdge } | null>(null)
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  const [exportNodeId, setExportNodeId] = useState<string | null>(null)
  const [insertingEdgeId, setInsertingEdgeId] = useState<string | null>(null)
  const [boardMessage, setBoardMessage] = useState<string | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const nodeDragRef = useRef<{
    pointerId: number
    nodeId: string
    startX: number
    startY: number
    originX: number
    originY: number
    currentX: number
    currentY: number
    moved: boolean
  } | null>(null)
  const panDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    scrollLeft: number
    scrollTop: number
  } | null>(null)
  const pendingViewportRestoreRef = useRef<BoardViewportState | null>(null)
  const viewportSaveFrameRef = useRef<number | null>(null)
  const scaleRepeatDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scaleRepeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const routeNodes = getUniqueBoardNodes(route)
  const board = useMemo(() => buildBoard(route, positions), [route, positions])

  const adjustScale = useCallback((direction: -1 | 1) => {
    setScale((current) => Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Number((current + direction * SCALE_STEP).toFixed(2))),
    ))
  }, [])

  const stopScaleAdjustment = useCallback(() => {
    if (scaleRepeatDelayRef.current !== null) {
      clearTimeout(scaleRepeatDelayRef.current)
      scaleRepeatDelayRef.current = null
    }
    if (scaleRepeatIntervalRef.current !== null) {
      clearInterval(scaleRepeatIntervalRef.current)
      scaleRepeatIntervalRef.current = null
    }
  }, [])

  const startScaleAdjustment = useCallback((
    direction: -1 | 1,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) return
    stopScaleAdjustment()
    event.currentTarget.setPointerCapture(event.pointerId)
    adjustScale(direction)
    scaleRepeatDelayRef.current = setTimeout(() => {
      scaleRepeatIntervalRef.current = setInterval(
        () => adjustScale(direction),
        SCALE_REPEAT_INTERVAL,
      )
    }, SCALE_REPEAT_DELAY)
  }, [adjustScale, stopScaleAdjustment])

  useEffect(() => {
    window.addEventListener("blur", stopScaleAdjustment)
    return () => {
      window.removeEventListener("blur", stopScaleAdjustment)
      stopScaleAdjustment()
    }
  }, [stopScaleAdjustment])

  useEffect(() => {
    if (!route) {
      setPositions({})
      setPositionsRouteId(null)
      setFocusedNodeId(null)
      setEdgeMenu(null)
      setNodeMenu(null)
      return
    }
    const realNodeIds = new Set((route.nodes ?? []).map((node) => node.id))
    try {
      const positionsKey = getBoardPositionsKey(project?.path, route.id)
      const legacyKey = getLegacyBoardPositionsKey(route.id)
      const raw = localStorage.getItem(positionsKey) ?? localStorage.getItem(legacyKey)
      const cleanPositions = sanitizeBoardPositions(
        raw ? JSON.parse(raw) as BoardPositions : {},
        realNodeIds,
      )
      setPositions(cleanPositions)
      setPositionsRouteId(route.id)
      localStorage.setItem(positionsKey, JSON.stringify(cleanPositions))
      localStorage.removeItem(legacyKey)
    } catch {
      setPositions({})
      setPositionsRouteId(route.id)
    }
    const savedViewport = readBoardViewportState(project?.path, route.id) ?? {
      version: 2,
      scrollLeft: CANVAS_ORIGIN * 0.9,
      scrollTop: CANVAS_ORIGIN * 0.9,
      scale: 0.9,
    }
    if (savedViewport.focusedNodeId && !realNodeIds.has(savedViewport.focusedNodeId)) {
      console.warn("[GhostNode] 已忽略指向不存在节点的画布焦点", savedViewport.focusedNodeId)
      savedViewport.focusedNodeId = undefined
    }
    pendingViewportRestoreRef.current = savedViewport
    setScale(savedViewport.scale)
    setFocusedNodeId(savedViewport.focusedNodeId ?? null)
  }, [project?.path, route?.id])

  useEffect(() => {
    if (!route || positionsRouteId !== route.id) return
    const realNodeIds = new Set((route.nodes ?? []).map((node) => node.id))
    const cleanPositions = sanitizeBoardPositions(positions, realNodeIds)
    localStorage.setItem(
      getBoardPositionsKey(project?.path, route.id),
      JSON.stringify(cleanPositions),
    )
  }, [project?.path, route, positions, positionsRouteId])

  useEffect(() => {
    if (!route) return
    for (const issue of detectGalGraphIssues(route)) {
      console.warn("[GhostNode]", issue)
    }
  }, [route])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const savedViewport = pendingViewportRestoreRef.current
    if (!viewport || !savedViewport) return
    viewport.scrollLeft = savedViewport.scrollLeft
    viewport.scrollTop = savedViewport.scrollTop
    pendingViewportRestoreRef.current = null
  }, [route?.id, scale, positions, board.width, board.height])

  const persistViewportState = useCallback((nextFocusedNodeId?: string) => {
    const viewport = viewportRef.current
    if (!route || !viewport) return
    const focused = nextFocusedNodeId ?? focusedNodeId ?? undefined
    writeBoardViewportState(project?.path, route.id, {
      version: 2,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      scale,
      focusedNodeId: focused,
    })
    if (nextFocusedNodeId) setFocusedNodeId(nextFocusedNodeId)
  }, [project?.path, route, scale, focusedNodeId])

  useLayoutEffect(() => {
    const request = galStore.locateRequest
    const viewport = viewportRef.current
    if (!request || !route || !viewport) return
    const target = board.nodeMap.get(request.nodeId)
    if (!target) return

    const scrollLeft = Math.max(
      0,
      (target.x + NODE_WIDTH / 2) * scale - viewport.clientWidth / 2,
    )
    const scrollTop = Math.max(
      0,
      (target.y + NODE_HEIGHT / 2) * scale - viewport.clientHeight / 2,
    )
    setFocusedNodeId(request.nodeId)
    writeBoardViewportState(project?.path, route.id, {
      version: 2,
      scrollLeft,
      scrollTop,
      scale,
      focusedNodeId: request.nodeId,
    })
    viewport.scrollTo({ left: scrollLeft, top: scrollTop, behavior: "smooth" })
    galStore.clearLocateRequest()
  }, [board.nodeMap, galStore.locateRequest, project?.path, route, scale])

  useEffect(() => {
    if (!route || pendingViewportRestoreRef.current) return
    persistViewportState()
  }, [route?.id, scale, persistViewportState])

  const handleViewportScroll = useCallback(() => {
    if (viewportSaveFrameRef.current !== null) return
    viewportSaveFrameRef.current = window.requestAnimationFrame(() => {
      viewportSaveFrameRef.current = null
      persistViewportState()
    })
  }, [persistViewportState])

  useEffect(() => () => {
    if (viewportSaveFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportSaveFrameRef.current)
    }
    persistViewportState()
  }, [persistViewportState])

  const handleViewportPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button === 0) {
      setEdgeMenu(null)
      setNodeMenu(null)
    }
    if (event.button !== 0) return
    const viewport = viewportRef.current
    if (!viewport) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    panDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    }
  }, [])

  const handleViewportPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current
    const viewport = viewportRef.current
    if (!drag || drag.pointerId !== event.pointerId || !viewport) return
    viewport.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX)
    viewport.scrollTop = drag.scrollTop - (event.clientY - drag.startY)
  }, [])

  const handleViewportPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    panDragRef.current = null
    persistViewportState()
  }, [persistViewportState])

  const handleNodePointerDown = useCallback((
    event: React.PointerEvent<HTMLButtonElement>,
    nodeId: string,
    x: number,
    y: number,
  ) => {
    if (panMode || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    nodeDragRef.current = {
      pointerId: event.pointerId,
      nodeId,
      startX: event.clientX,
      startY: event.clientY,
      originX: x,
      originY: y,
      currentX: x,
      currentY: y,
      moved: false,
    }
  }, [panMode])

  const handleNodePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = nodeDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = (event.clientX - drag.startX) / scale
    const dy = (event.clientY - drag.startY) / scale
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
      drag.moved = true
    }
    if (!drag.moved) return
    drag.currentX = Math.max(-CANVAS_ORIGIN + 40, Math.round(drag.originX + dx))
    drag.currentY = Math.max(-CANVAS_ORIGIN + 40, Math.round(drag.originY + dy))
    setPositions((current) => ({
      ...current,
      [drag.nodeId]: {
        x: drag.currentX,
        y: drag.currentY,
      },
    }))
  }, [scale])

  const persistNodePosition = useCallback(async (nodeId: string, position: { x: number; y: number }) => {
    if (!project || !route) return
    const galProject = await loadGalProject(project.path)
    const routeToSave = galProject?.routes.find((item) => item.id === route.id)
    const nodeToSave = routeToSave?.nodes.find((item) => item.id === nodeId)
    if (!galProject || !nodeToSave) return
    nodeToSave.boardPosition = position
    nodeToSave.updatedAt = new Date().toISOString()
    await saveGalProject(project.path, galProject)
    galStore.setProject(await loadGalProject(project.path))
  }, [project, route, galStore])

  const handleNodePointerUp = useCallback((
    event: React.PointerEvent<HTMLButtonElement>,
    nodeId: string,
  ) => {
    const drag = nodeDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    nodeDragRef.current = null
    if (!drag.moved && !panMode) {
      persistViewportState(nodeId)
      onSelectNode(nodeId)
      return
    }
    void persistNodePosition(nodeId, { x: drag.currentX, y: drag.currentY })
  }, [onSelectNode, panMode, persistNodePosition, persistViewportState])

  const handleInsertRelayNode = useCallback(async (edge: BoardEdge) => {
    if (!project || !route) return
    setInsertingEdgeId(edge.id)
    setBoardMessage("正在根据父子节点内容生成中继节点...")
    try {
      const relayCard = await galStore.runAiTask(
        {
          title: "AI 插入中继节点",
          detail: "根据父子节点内容生成中继节点...",
        },
        () => generateRelayNodeCard({
          projectPath: project.path,
          routeId: route.id,
          parentNodeId: edge.sourceId,
          childNodeId: edge.targetId,
          edgeLabel: edge.label,
        }),
      )
      const galProject = await loadGalProject(project.path)
      const routeToSave = galProject?.routes.find((item) => item.id === route.id)
      const parentNode = routeToSave?.nodes.find((item) => item.id === edge.sourceId)
      const childNode = routeToSave?.nodes.find((item) => item.id === edge.targetId)
      if (!galProject || !routeToSave || !parentNode || !childNode) {
        throw new Error("插入失败：原线路连接已不存在")
      }
      const hasConnection =
        (parentNode.children ?? []).includes(childNode.id)
        || (parentNode.choices ?? []).some((choice) => choice.nextNodeId === childNode.id)
      if (!hasConnection) {
        throw new Error("插入失败：原线路连接已发生变化")
      }

      const sourcePosition = board.nodeMap.get(parentNode.id)
      const targetPosition = board.nodeMap.get(childNode.id)
      const relayPosition = {
        x: Math.round(((sourcePosition?.worldX ?? 80) + (targetPosition?.worldX ?? 520)) / 2),
        y: Math.round(((sourcePosition?.worldY ?? 80) + (targetPosition?.worldY ?? 80)) / 2),
      }
      const result = insertRelayNodeIntoProject({
        project: galProject,
        routeId: routeToSave.id,
        afterNodeId: parentNode.id,
        beforeNodeId: childNode.id,
        requireNodeIdsAdjacency: false,
        requireSingleDirectConnection: false,
        draft: {
          ...relayCard,
          script: "",
          status: "card",
          boardPosition: relayPosition,
        },
      })
      await saveGalProject(project.path, galProject)
      setPositions((current) => ({ ...current, [result.node.id]: relayPosition }))
      galStore.setProject(await loadGalProject(project.path))
      setBoardMessage(`中继节点「${relayCard.title}」已插入，正文保持为空。`)
    } catch (err) {
      setBoardMessage(`中继节点插入失败：${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setInsertingEdgeId(null)
      setEdgeMenu(null)
    }
  }, [project, route, board.nodeMap, galStore])

  const handleToggleEndingNode = useCallback(async (nodeId: string) => {
    if (!project || !route) return
    setBoardMessage(null)
    try {
      const galProject = await loadGalProject(project.path)
      const routeToSave = galProject?.routes.find((item) =>
        (item.nodes ?? []).some((node) => node.id === nodeId),
      )
      const nodeToSave = routeToSave?.nodes.find((item) => item.id === nodeId)
      if (!galProject || !routeToSave || !nodeToSave) {
        throw new Error("节点不存在，无法更新收尾状态")
      }

      const now = new Date().toISOString()
      const isEnding = nodeToSave.type === "ending" || (routeToSave.endingNodeIds ?? []).includes(nodeId)
      if (isEnding) {
        nodeToSave.type = "daily"
        routeToSave.endingNodeIds = (routeToSave.endingNodeIds ?? []).filter((id) => id !== nodeId)
        setBoardMessage(`已取消「${nodeToSave.title}」的收尾标记。`)
      } else {
        nodeToSave.type = "ending"
        routeToSave.endingNodeIds = Array.from(new Set([...(routeToSave.endingNodeIds ?? []), nodeId]))
        setBoardMessage(`已将「${nodeToSave.title}」标记为收尾节点。`)
      }
      nodeToSave.updatedAt = now
      galProject.updatedAt = now
      await saveGalProject(project.path, galProject)
      galStore.setProject(await loadGalProject(project.path))
    } catch (err) {
      setBoardMessage(`收尾状态更新失败：${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setNodeMenu(null)
    }
  }, [project, route, galStore])

  if (!route || routeNodes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <div>当前线路暂无节点</div>
        {error && <div className="max-w-md text-center text-xs text-destructive">{error}</div>}
        {onReinitGal && (
          <button
            type="button"
            disabled={reinitializing}
            onClick={onReinitGal}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {reinitializing ? (
              <>
                <Sparkles className="h-3.5 w-3.5 animate-spin" />
                初始化中...
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                重新初始化 Gal 项目
              </>
            )}
          </button>
        )}
      </div>
    )
  }

  const width = Math.max(900, board.width)
  const height = Math.max(560, board.height)

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#111414] text-slate-100">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/10 bg-[#0b0d0d] px-3">
        <GitBranch className="h-4 w-4 text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{route.title}</div>
          <div className="truncate text-[11px] text-slate-400">{route.theme}</div>
        </div>
        <button
          type="button"
          onPointerDown={(event) => startScaleAdjustment(-1, event)}
          onPointerUp={stopScaleAdjustment}
          onPointerCancel={stopScaleAdjustment}
          onPointerLeave={stopScaleAdjustment}
          onClick={(event) => {
            if (event.detail === 0) adjustScale(-1)
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-amber-400 hover:bg-white/10"
          title="缩小 1%（长按连续缩小）"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setScale(0.9)}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-white/10 px-2 text-xs text-amber-400 hover:bg-white/10"
          title="重置缩放"
        >
          <Maximize2 className="h-3.5 w-3.5" />
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          onPointerDown={(event) => startScaleAdjustment(1, event)}
          onPointerUp={stopScaleAdjustment}
          onPointerCancel={stopScaleAdjustment}
          onPointerLeave={stopScaleAdjustment}
          onClick={(event) => {
            if (event.detail === 0) adjustScale(1)
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-amber-400 hover:bg-white/10"
          title="放大 1%（长按连续放大）"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div
        ref={viewportRef}
        className="gal-route-board-grid flex-1 cursor-grab overflow-auto active:cursor-grabbing"
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={handleViewportPointerUp}
        onPointerCancel={handleViewportPointerUp}
        onScroll={handleViewportScroll}
      >
        <div
          className="relative origin-top-left"
          style={{
            width: width * scale,
            height: height * scale,
          }}
        >
          <div
            className="relative origin-top-left"
            style={{
              width,
              height,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
            }}
          >
            <svg
              className="pointer-events-none absolute inset-0 overflow-visible"
              width={width}
              height={height}
            >
              <defs>
                <marker
                  id="gal-board-arrow"
                  markerWidth="10"
                  markerHeight="10"
                  refX="8"
                  refY="5"
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#d97706" />
                </marker>
                <marker
                  id="gal-board-arrow-preview"
                  markerWidth="10"
                  markerHeight="10"
                  refX="8"
                  refY="5"
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#38bdf8" />
                </marker>
              </defs>
              {board.edges.map((edge) => {
                const source = board.nodeMap.get(edge.sourceId)
                const target = board.nodeMap.get(edge.targetId)
                if (!source || !target) return null
                const previewInsertion = boardHighlight?.previewInsertions.find((item) =>
                  item.afterNodeId === edge.sourceId && item.beforeNodeId === edge.targetId
                )
                const startX = source.x + NODE_WIDTH
                const startY = source.y + NODE_HEIGHT / 2
                const endX = target.x
                const endY = target.y + NODE_HEIGHT / 2
                const midX = startX + Math.max(80, (endX - startX) / 2)
                const path = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`
                return (
                  <g key={edge.id}>
                    <path
                      d={path}
                      fill="none"
                      stroke={previewInsertion ? "#38bdf8" : "#d97706"}
                      strokeWidth={previewInsertion ? "2.5" : "2"}
                      strokeDasharray={previewInsertion ? "8 6" : undefined}
                      markerEnd={previewInsertion ? "url(#gal-board-arrow-preview)" : "url(#gal-board-arrow)"}
                      opacity={previewInsertion ? "0.95" : "0.85"}
                    />
                    <path
                      d={path}
                      fill="none"
                      stroke="transparent"
                      strokeWidth="16"
                      style={{ pointerEvents: "stroke", cursor: "context-menu" }}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        if (readOnly) return
                        setEdgeMenu({ x: event.clientX, y: event.clientY, edge })
                      }}
                    />
                    {edge.label && (
                      <foreignObject
                        x={(startX + endX) / 2 - 58}
                        y={(startY + endY) / 2 - 16}
                        width="116"
                        height="32"
                      >
                        <div className="truncate rounded bg-black/75 px-2 py-1 text-center text-[11px] text-slate-200">
                          {edge.label}
                        </div>
                      </foreignObject>
                    )}
                    {previewInsertion && (
                      <foreignObject
                        x={(startX + endX) / 2 - 70}
                        y={(startY + endY) / 2 + 12}
                        width="140"
                        height="32"
                      >
                        <div className="truncate rounded border border-sky-400/40 bg-sky-950/80 px-2 py-1 text-center text-[11px] text-sky-100">
                          预览：{previewInsertion.title}
                        </div>
                      </foreignObject>
                    )}
                  </g>
                )
              })}
            </svg>

            {board.nodes.map(({ node, worldX, worldY, x, y }) => {
              const highlight = boardHighlight?.nodes[node.id]
              return (
              <button
                key={node.id}
                type="button"
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (readOnly) return
                  setEdgeMenu(null)
                  setNodeMenu({
                    x: event.clientX,
                    y: event.clientY,
                    nodeId: node.id,
                  })
                }}
                onClick={readOnly ? () => onSelectNode(node.id) : undefined}
                onPointerDown={readOnly ? undefined : (event) => handleNodePointerDown(event, node.id, worldX, worldY)}
                onPointerMove={readOnly ? undefined : handleNodePointerMove}
                onPointerUp={readOnly ? undefined : (event) => handleNodePointerUp(event, node.id)}
                onPointerCancel={readOnly ? undefined : (event) => handleNodePointerUp(event, node.id)}
                className={`absolute flex touch-none flex-col overflow-hidden rounded-md border bg-[#0b0d0d] text-left shadow-xl transition hover:border-amber-400/80 ${
                  panMode
                    ? "cursor-grab"
                    : "cursor-move hover:-translate-y-0.5"
                } ${
                  selectedNodeId === node.id || focusedNodeId === node.id
                    ? "border-amber-400 ring-2 ring-amber-400/30"
                    : getBoardHighlightNodeClass(highlight?.role)
                }`}
                style={{ left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }}
              >
                <div className="flex h-8 items-center gap-2 border-b border-white/10 bg-[#1f2525] px-3">
                  <span className={getNodeTypeColor(node.type)}>
                    <Sparkles className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-amber-300">
                    {node.title}
                  </span>
                  <span className="text-[10px] text-slate-400">
                    {getNodeTypeLabel(node.type)}
                  </span>
                  {highlight?.label && (
                    <span className={getBoardHighlightBadgeClass(highlight.role)}>
                      {highlight.label}
                    </span>
                  )}
                </div>
                <div className="flex-1 px-3 py-2">
                  <p className="line-clamp-3 text-xs leading-5 text-slate-200">
                    {node.summary || node.goal || "尚未生成节点摘要。"}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-300">
                      {getNodeStatusLabel(node.status)}
                    </span>
                    {(node.choices ?? []).length > 0 && (
                      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
                        {(node.choices ?? []).length} 个选项
                      </span>
                    )}
                  </div>
                </div>
                <div className="truncate border-t border-white/10 px-3 py-1.5 text-[11px] text-slate-400">
                  {node.scene || "未设置场景"}
                </div>
              </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-4 right-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPanMode((value) => !value)}
          className={`pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-md border shadow-lg ${
            panMode
              ? "border-amber-400 bg-amber-500 text-black"
              : "border-white/10 bg-[#202626] text-slate-100 hover:bg-white/10"
          }`}
          title={panMode ? "关闭漫游模式" : "漫游模式"}
        >
          <Hand className="h-5 w-5" />
        </button>
      </div>

      {boardMessage && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-40 max-w-[520px] -translate-x-1/2 rounded-md border border-white/10 bg-black/85 px-3 py-2 text-xs text-slate-200 shadow-xl">
          {boardMessage}
        </div>
      )}

      {edgeMenu && (
        <div
          className="fixed z-50 w-52 rounded-md border border-white/15 bg-[#171b1b] p-1.5 text-xs text-slate-100 shadow-2xl"
          style={{
            left: Math.min(edgeMenu.x, window.innerWidth - 220),
            top: Math.min(edgeMenu.y, window.innerHeight - 70),
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            disabled={Boolean(insertingEdgeId)}
            onClick={() => void handleInsertRelayNode(edgeMenu.edge)}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-white/10 disabled:opacity-50"
          >
            {insertingEdgeId === edgeMenu.edge.id
              ? <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
              : <Sparkles className="h-3.5 w-3.5 text-amber-400" />}
            AI 插入中继节点
          </button>
        </div>
      )}

      {nodeMenu && (
        <div
          className="fixed z-50 w-52 rounded-md border border-white/15 bg-[#171b1b] p-1.5 text-xs text-slate-100 shadow-2xl"
          style={{
            left: Math.min(nodeMenu.x, window.innerWidth - 220),
            top: Math.min(nodeMenu.y, window.innerHeight - 70),
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => void handleToggleEndingNode(nodeMenu.nodeId)}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-white/10"
          >
            <Flag className="h-3.5 w-3.5 text-red-400" />
            {route.endingNodeIds.includes(nodeMenu.nodeId) || board.nodeMap.get(nodeMenu.nodeId)?.node.type === "ending"
              ? "取消收尾节点"
              : "标记为收尾节点"}
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenLonglineWorkspace?.(nodeMenu.nodeId)
              setNodeMenu(null)
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-white/10"
          >
            <GitBranch className="h-3.5 w-3.5 text-blue-400" />
            长线检查
          </button>
          <button
            type="button"
            onClick={() => {
              setExportNodeId(nodeMenu.nodeId)
              setNodeMenu(null)
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-white/10"
          >
            <FileDown className="h-3.5 w-3.5 text-amber-400" />
            导出到此节点的剧情
          </button>
        </div>
      )}

      {route && exportNodeId && (
        <GalPathExportDialog
          route={route}
          targetNodeId={exportNodeId}
          onClose={() => setExportNodeId(null)}
        />
      )}
    </div>
  )
}

function buildBoard(route: GalRoute | undefined, positions: BoardPositions): {
  nodes: BoardNode[]
  edges: BoardEdge[]
  nodeMap: Map<string, BoardNode>
  width: number
  height: number
} {
  const routeNodes = getUniqueBoardNodes(route)
  if (!route || routeNodes.length === 0) return { nodes: [], edges: [], nodeMap: new Map(), width: 0, height: 0 }

  const nodeById = new Map(routeNodes.map((node) => [node.id, node]))
  const levels = new Map<string, number>()
  const queue = [{ id: route.entryNodeId || routeNodes[0]?.id, level: 0 }]
  const maxLevel = Math.max(0, routeNodes.length - 1)

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current?.id) continue
    const existing = levels.get(current.id)
    const nextLevel = Math.min(current.level, maxLevel)
    if (existing !== undefined && existing >= nextLevel) continue
    levels.set(current.id, nextLevel)
    const node = nodeById.get(current.id)
    if (!node) continue
    for (const childId of collectChildIds(node, nodeById)) {
      if (nextLevel < maxLevel) queue.push({ id: childId, level: nextLevel + 1 })
    }
  }

  for (const node of routeNodes) {
    if (!levels.has(node.id)) {
      levels.set(node.id, Math.max(0, node.sequence))
    }
  }

  const grouped = new Map<number, GalNode[]>()
  for (const node of routeNodes) {
    const level = levels.get(node.id) ?? 0
    grouped.set(level, [...(grouped.get(level) ?? []), node])
  }

  const boardNodes: BoardNode[] = []
  for (const [level, nodes] of grouped) {
    nodes
      .sort((a, b) => a.sequence - b.sequence)
      .forEach((node, index) => {
        const saved = positions[node.id]
        const worldX = saved?.x ?? node.boardPosition?.x ?? 80 + level * (NODE_WIDTH + X_GAP)
        const worldY = saved?.y ?? node.boardPosition?.y ?? 80 + index * (NODE_HEIGHT + Y_GAP)
        boardNodes.push({
          node,
          worldX,
          worldY,
          x: worldX + CANVAS_ORIGIN,
          y: worldY + CANVAS_ORIGIN,
        })
      })
  }

  const edges: BoardEdge[] = []
  for (const node of routeNodes) {
    for (const target of getNodeOutgoingTargets(node, nodeById)) {
      edges.push({
        id: target.choiceId
          ? `${node.id}-${target.targetId}-${target.choiceId}`
          : `${node.id}-${target.targetId}-direct`,
        sourceId: node.id,
        targetId: target.targetId,
        label: target.choiceText ?? "",
      })
    }
  }

  const nodeMap = new Map(boardNodes.map((node) => [node.node.id, node]))
  const width = Math.max(...boardNodes.map((node) => node.x + NODE_WIDTH + CANVAS_PADDING), 900)
  const height = Math.max(...boardNodes.map((node) => node.y + NODE_HEIGHT + CANVAS_PADDING), 560)

  return { nodes: boardNodes, edges, nodeMap, width, height }
}

function getBoardPositionsKey(projectPath: string | undefined, routeId: string): string {
  return `qmai-gal-board-positions:${encodeURIComponent(projectPath ?? "unknown")}:${routeId}`
}

function getLegacyBoardPositionsKey(routeId: string): string {
  return `qmai-gal-board-positions:${routeId}`
}

function getBoardViewportKey(projectPath: string | undefined, routeId: string): string {
  return `qmai-gal-board-viewport:${encodeURIComponent(projectPath ?? "unknown")}:${routeId}`
}

function readBoardViewportState(
  projectPath: string | undefined,
  routeId: string | undefined,
): BoardViewportState | null {
  if (!routeId) return null
  try {
    const raw = localStorage.getItem(getBoardViewportKey(projectPath, routeId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<BoardViewportState>
    if (
      parsed.version !== 2
      ||
      typeof parsed.scrollLeft !== "number"
      || typeof parsed.scrollTop !== "number"
      || typeof parsed.scale !== "number"
    ) {
      return null
    }
    return {
      version: 2,
      scrollLeft: Math.max(0, parsed.scrollLeft),
      scrollTop: Math.max(0, parsed.scrollTop),
      scale: Math.min(1.35, Math.max(0.1, parsed.scale)),
      focusedNodeId: typeof parsed.focusedNodeId === "string" ? parsed.focusedNodeId : undefined,
    }
  } catch {
    return null
  }
}

function writeBoardViewportState(
  projectPath: string | undefined,
  routeId: string,
  state: BoardViewportState,
): void {
  localStorage.setItem(getBoardViewportKey(projectPath, routeId), JSON.stringify(state))
}

function collectChildIds(node: GalNode, nodeById: Map<string, GalNode>): string[] {
  return getNodeOutgoingTargets(node, nodeById).map((target) => target.targetId)
}

function getBoardHighlightNodeClass(role: GalBoardHighlightRole | undefined): string {
  if (role === "upstream") return "border-emerald-400 ring-2 ring-emerald-400/25"
  if (role === "target") return "border-blue-400 ring-2 ring-blue-400/25"
  if (role === "downstream") return "border-purple-400 ring-2 ring-purple-400/25"
  if (role === "error") return "border-red-400 ring-2 ring-red-400/35"
  if (role === "problem") return "border-amber-300 ring-2 ring-amber-300/30"
  return "border-white/15"
}

function getBoardHighlightBadgeClass(role: GalBoardHighlightRole): string {
  if (role === "upstream") return "rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-100"
  if (role === "target") return "rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] text-blue-100"
  if (role === "downstream") return "rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] text-purple-100"
  if (role === "error") return "rounded bg-red-500/25 px-1.5 py-0.5 text-[10px] text-red-100"
  return "rounded bg-amber-500/25 px-1.5 py-0.5 text-[10px] text-amber-100"
}

function getUniqueBoardNodes(route: GalRoute | undefined): GalNode[] {
  const nodes: GalNode[] = []
  const seen = new Set<string>()
  for (const node of route?.nodes ?? []) {
    if (!node.id || seen.has(node.id)) continue
    seen.add(node.id)
    nodes.push(node)
  }
  return nodes
}

function sanitizeBoardPositions(
  positions: BoardPositions,
  realNodeIds: Set<string>,
): BoardPositions {
  const clean: BoardPositions = {}
  for (const [nodeId, position] of Object.entries(positions)) {
    if (!realNodeIds.has(nodeId)) {
      console.warn("[GhostNode] 已清理非真实节点的画布位置", nodeId)
      continue
    }
    if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) {
      console.warn("[GhostNode] 已清理无效画布坐标", nodeId, position)
      continue
    }
    clean[nodeId] = { x: position.x, y: position.y }
  }
  return clean
}
