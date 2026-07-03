/**
 * Galgame 线路画布
 *
 * 以 Arcweave 风格展示线路节点和选项连线。点击节点进入详细编辑。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { GitBranch, Hand, Maximize2, Minus, Plus, Sparkles } from "lucide-react"
import type { GalNode, GalRoute } from "@/lib/gal/gal-types"
import { getNodeStatusLabel, getNodeTypeColor, getNodeTypeLabel } from "./gal-utils"

interface GalRouteBoardProps {
  route: GalRoute | undefined
  selectedNodeId: string | null
  onSelectNode: (nodeId: string) => void
  onReinitGal?: () => void
  reinitializing?: boolean
  error?: string | null
}

interface BoardNode {
  node: GalNode
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

const NODE_WIDTH = 260
const NODE_HEIGHT = 150
const X_GAP = 180
const Y_GAP = 70
const DRAG_THRESHOLD = 4

export function GalRouteBoard({
  route,
  selectedNodeId,
  onSelectNode,
  onReinitGal,
  reinitializing = false,
  error,
}: GalRouteBoardProps) {
  const [scale, setScale] = useState(0.9)
  const [panMode, setPanMode] = useState(false)
  const [positions, setPositions] = useState<BoardPositions>({})
  const viewportRef = useRef<HTMLDivElement>(null)
  const nodeDragRef = useRef<{
    pointerId: number
    nodeId: string
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
  } | null>(null)
  const panDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    scrollLeft: number
    scrollTop: number
  } | null>(null)
  const routeNodes = Array.isArray(route?.nodes) ? route.nodes : []
  const board = useMemo(() => buildBoard(route, positions), [route, positions])

  useEffect(() => {
    if (!route) {
      setPositions({})
      return
    }
    try {
      const raw = localStorage.getItem(getBoardPositionsKey(route.id))
      setPositions(raw ? JSON.parse(raw) as BoardPositions : {})
    } catch {
      setPositions({})
    }
  }, [route?.id])

  useEffect(() => {
    if (!route) return
    localStorage.setItem(getBoardPositionsKey(route.id), JSON.stringify(positions))
  }, [route?.id, positions])

  const handleViewportPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!panMode || event.button !== 0) return
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
  }, [panMode])

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
  }, [])

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
    setPositions((current) => ({
      ...current,
      [drag.nodeId]: {
        x: Math.max(20, Math.round(drag.originX + dx)),
        y: Math.max(20, Math.round(drag.originY + dy)),
      },
    }))
  }, [scale])

  const handleNodePointerUp = useCallback((
    event: React.PointerEvent<HTMLButtonElement>,
    nodeId: string,
  ) => {
    const drag = nodeDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    nodeDragRef.current = null
    if (!drag.moved && !panMode) {
      onSelectNode(nodeId)
    }
  }, [onSelectNode, panMode])

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
          onClick={() => setScale((v) => Math.max(0.55, Number((v - 0.1).toFixed(2))))}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-amber-400 hover:bg-white/10"
          title="缩小"
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
          onClick={() => setScale((v) => Math.min(1.35, Number((v + 0.1).toFixed(2))))}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-amber-400 hover:bg-white/10"
          title="放大"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div
        ref={viewportRef}
        className={`gal-route-board-grid flex-1 overflow-auto ${panMode ? "cursor-grab active:cursor-grabbing" : ""}`}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={handleViewportPointerUp}
        onPointerCancel={handleViewportPointerUp}
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
              </defs>
              {board.edges.map((edge) => {
                const source = board.nodeMap.get(edge.sourceId)
                const target = board.nodeMap.get(edge.targetId)
                if (!source || !target) return null
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
                      stroke="#d97706"
                      strokeWidth="2"
                      markerEnd="url(#gal-board-arrow)"
                      opacity="0.85"
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
                  </g>
                )
              })}
            </svg>

            {board.nodes.map(({ node, x, y }) => (
              <button
                key={node.id}
                type="button"
                onPointerDown={(event) => handleNodePointerDown(event, node.id, x, y)}
                onPointerMove={handleNodePointerMove}
                onPointerUp={(event) => handleNodePointerUp(event, node.id)}
                onPointerCancel={(event) => handleNodePointerUp(event, node.id)}
                className={`absolute flex touch-none flex-col overflow-hidden rounded-md border bg-[#0b0d0d] text-left shadow-xl transition hover:border-amber-400/80 ${
                  panMode
                    ? "cursor-grab"
                    : "cursor-move hover:-translate-y-0.5"
                } ${
                  selectedNodeId === node.id
                    ? "border-amber-400 ring-2 ring-amber-400/30"
                    : "border-white/15"
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
            ))}
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
  const routeNodes = Array.isArray(route?.nodes) ? route.nodes : []
  if (!route || routeNodes.length === 0) return { nodes: [], edges: [], nodeMap: new Map(), width: 0, height: 0 }

  const nodeById = new Map(routeNodes.map((node) => [node.id, node]))
  const levels = new Map<string, number>()
  const queue = [{ id: route.entryNodeId || routeNodes[0]?.id, level: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current?.id) continue
    const existing = levels.get(current.id)
    if (existing !== undefined && existing <= current.level) continue
    levels.set(current.id, current.level)
    const node = nodeById.get(current.id)
    if (!node) continue
    for (const childId of collectChildIds(node)) {
      queue.push({ id: childId, level: current.level + 1 })
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
        boardNodes.push({
          node,
          x: saved?.x ?? 80 + level * (NODE_WIDTH + X_GAP),
          y: saved?.y ?? 80 + index * (NODE_HEIGHT + Y_GAP),
        })
      })
  }

  const edges: BoardEdge[] = []
  for (const node of routeNodes) {
    for (const childId of node.children ?? []) {
      if (nodeById.has(childId)) {
        edges.push({
          id: `${node.id}-${childId}`,
          sourceId: node.id,
          targetId: childId,
          label: (node.choices ?? []).find((choice) => choice.nextNodeId === childId)?.text ?? "",
        })
      }
    }
    for (const choice of node.choices ?? []) {
      if (choice.nextNodeId && nodeById.has(choice.nextNodeId) && !edges.some((edge) => edge.sourceId === node.id && edge.targetId === choice.nextNodeId)) {
        edges.push({
          id: `${node.id}-${choice.nextNodeId}-${choice.id}`,
          sourceId: node.id,
          targetId: choice.nextNodeId,
          label: choice.text,
        })
      }
    }
  }

  const nodeMap = new Map(boardNodes.map((node) => [node.node.id, node]))
  const width = Math.max(...boardNodes.map((node) => node.x + NODE_WIDTH + 120), 900)
  const height = Math.max(...boardNodes.map((node) => node.y + NODE_HEIGHT + 120), 560)

  return { nodes: boardNodes, edges, nodeMap, width, height }
}

function getBoardPositionsKey(routeId: string): string {
  return `qmai-gal-board-positions:${routeId}`
}

function collectChildIds(node: GalNode): string[] {
  return Array.from(
    new Set([
      ...(node.children ?? []),
      ...(node.choices ?? []).map((choice) => choice.nextNodeId).filter((id): id is string => Boolean(id)),
    ]),
  )
}
