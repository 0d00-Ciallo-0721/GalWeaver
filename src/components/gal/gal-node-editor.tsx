import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  GitBranchPlus,
  Link2,
  Loader2,
  Map as MapIcon,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react"
import { useGalStore } from "@/stores/gal-store"
import { useWikiStore } from "@/stores/wiki-store"
import { expandChildNodeCard, generateNodeScript } from "@/lib/gal/gal-node-generation"
import { ingestNode } from "@/lib/gal/gal-node-ingest"
import {
  deleteNodeScript,
  loadGalProject,
  loadNodeScript,
  saveGalProject,
  saveNodeScript,
} from "@/lib/gal/gal-storage"
import { getNodeStatusLabel, getNodeTypeColor, getNodeTypeLabel } from "./gal-utils"
import type { BranchLintResult, GalChoice, GalEffect, GalNode, GalRoute } from "@/lib/gal/gal-types"

interface GalNodeEditorProps {
  onLintBranch: () => void
  lintRunning: boolean
  lintResults: BranchLintResult[]
  onBackToBoard?: () => void
  onReinitGal?: () => void
  reinitializing?: boolean
  onShowInitContext?: () => void
  loadingInitContext?: boolean
}

export function GalNodeEditor({
  onLintBranch,
  lintRunning,
  lintResults,
  onBackToBoard,
  onReinitGal,
  reinitializing = false,
  onShowInitContext,
  loadingInitContext = false,
}: GalNodeEditorProps) {
  const project = useWikiStore((s) => s.project)
  const galStore = useGalStore()
  const node = galStore.selectedNode()
  const route = galStore.currentNodeRoute() ?? galStore.selectedRoute()
  const selectedRouteId = useGalStore((s) => s.selectedRouteId)

  const [scriptContent, setScriptContent] = useState("")
  const [aiPrompt, setAiPrompt] = useState("")
  const [draftTitle, setDraftTitle] = useState("")
  const [draftGoal, setDraftGoal] = useState("")
  const [draftScene, setDraftScene] = useState("")
  const [draftCharacters, setDraftCharacters] = useState("")
  const [draftChoices, setDraftChoices] = useState<GalChoice[]>([])
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [expanding, setExpanding] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const mergeTargets = useMemo(
    () => route && node ? getMergeTargets(route, node) : [],
    [route, node],
  )
  const directLinkedNodes = useMemo(() => {
    if (!route || !node) return []
    const choiceLinkedIds = new Set(
      (draftChoices ?? [])
        .map((choice) => choice.nextNodeId)
        .filter((id): id is string => Boolean(id)),
    )
    const directLinkedIds = new Set(
      (node.children ?? []).filter((childId) => !choiceLinkedIds.has(childId)),
    )
    return (route.nodes ?? []).filter((item) => directLinkedIds.has(item.id))
  }, [route, node, draftChoices])

  useEffect(() => {
    if (!project || !route || !node) {
      setScriptContent("")
      setAiPrompt("")
      setDraftTitle("")
      setDraftGoal("")
      setDraftScene("")
      setDraftCharacters("")
      setDraftChoices([])
      return
    }

    setDraftTitle(node.title)
    setDraftGoal(node.goal)
    setDraftScene(node.scene)
    setDraftCharacters((node.characters ?? []).join("、"))
    setDraftChoices(cloneChoices(node.choices ?? []))
    setAiPrompt(node.aiPrompt ?? "")

    const load = async () => {
      try {
        setScriptContent((await loadNodeScript(project.path, route.id, node.id)) || "")
      } catch {
        setScriptContent("")
      }
    }
    void load()
  }, [project, route?.id, node?.id])

  const saveDraft = useCallback(async (status?: GalNode["status"]) => {
    if (!project || !route || !node) return null
    await saveNodeScript(project.path, route.id, node.id, scriptContent)
    const galProject = await loadGalProject(project.path)
    if (!galProject) return null
    const routeToSave = galProject.routes.find((r) => r.id === route.id)
    const nodeToSave = routeToSave?.nodes.find((n) => n.id === node.id)
    if (!routeToSave || !nodeToSave) {
      throw new Error("保存失败：当前节点不存在，请重新加载项目")
    }

    const previousChoiceChildren = new Set(
      (nodeToSave.choices ?? [])
        .map((choice) => choice.nextNodeId)
        .filter((childId): childId is string => Boolean(childId)),
    )
    const directChildren = (nodeToSave.children ?? [])
      .filter((childId) => !previousChoiceChildren.has(childId))
    const nextChoiceChildren = new Set(
      draftChoices
        .map((choice) => choice.nextNodeId)
        .filter((childId): childId is string => Boolean(childId)),
    )
    const nextChildren = new Set([...directChildren, ...nextChoiceChildren])

    nodeToSave.title = draftTitle.trim() || nodeToSave.title
    nodeToSave.goal = draftGoal
    nodeToSave.scene = draftScene
    nodeToSave.characters = splitCharacters(draftCharacters)
    nodeToSave.aiPrompt = aiPrompt
    nodeToSave.choices = cloneChoices(draftChoices)
    nodeToSave.children = Array.from(nextChildren)
    nodeToSave.updatedAt = new Date().toISOString()
    if (status) nodeToSave.status = status

    for (const child of routeToSave.nodes) {
      if (child.id === node.id) continue
      if (nextChildren.has(child.id)) {
        child.parents = Array.from(new Set([...(child.parents ?? []), node.id]))
      } else {
        child.parents = (child.parents ?? []).filter((parentId) => parentId !== node.id)
      }
    }

    await saveGalProject(project.path, galProject)
    const refreshed = await loadGalProject(project.path)
    galStore.setProject(refreshed)
    return refreshed
  }, [project, route, node, scriptContent, aiPrompt, draftTitle, draftGoal, draftScene, draftCharacters, draftChoices, galStore])

  const handleSaveDraft = useCallback(async () => {
    setSaving(true)
    setMessage(null)
    try {
      await saveDraft()
      setMessage("保存完成")
    } catch (err) {
      setMessage(`保存失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setSaving(false)
    }
  }, [saveDraft])

  const runGeneration = useCallback(async (replaceExisting: boolean) => {
    if (!project || !route || !node) return
    galStore.setGenerating(true, node.id)
    setMessage(null)
    try {
      setMessage("正在保存当前节点...")
      await saveDraft()
      if (replaceExisting) {
        setMessage("正在删除原正文...")
        await saveNodeScript(project.path, route.id, node.id, "")
        setScriptContent("")
      }
      setMessage("正在调用 AI 生成正文...")
      const { script, choices } = await generateNodeScript({
        projectPath: project.path,
        routeId: route.id,
        nodeId: node.id,
        userPrompt: aiPrompt,
        onToken: () => {},
      })
      setScriptContent(script)
      const refreshed = await loadGalProject(project.path)
      galStore.setProject(refreshed)
      const refreshedNode = refreshed?.routes
        .find((r) => r.id === route.id)
        ?.nodes.find((n) => n.id === node.id)
      if (refreshedNode) setDraftChoices(cloneChoices(refreshedNode.choices ?? []))
      setMessage(choices.length > 0 ? "生成完成，选项已写入节点。" : "生成完成")
    } catch (err) {
      setMessage(`生成失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      galStore.setGenerating(false)
    }
  }, [project, route, node, aiPrompt, saveDraft, galStore])

  const handleFirstGenerate = useCallback(async () => {
    if (scriptContent.trim()) return
    await runGeneration(false)
  }, [scriptContent, runGeneration])

  const handleRegenerate = useCallback(async () => {
    if (!scriptContent.trim()) return
    if (!window.confirm("重新生成会删除当前节点正文，并由 AI 完整生成一遍。是否继续？")) return
    await runGeneration(true)
  }, [scriptContent, runGeneration])

  const handleSaveAndIngest = useCallback(async () => {
    if (!project || !route || !node) return
    setSaving(true)
    setMessage(null)
    try {
      setMessage("正在保存当前节点...")
      await saveDraft("final")
      setMessage("正在摄取节点记忆...")
      await ingestNode({
        projectPath: project.path,
        routeId: route.id,
        nodeId: node.id,
      })
      galStore.setProject(await loadGalProject(project.path))
      setMessage("保存并摄取完成。")
    } catch (err) {
      setMessage(`保存失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setSaving(false)
    }
  }, [project, route, node, saveDraft, galStore])

  const attachChildNode = useCallback(async (choiceId: string, childNode: GalNode) => {
    if (!project || !route || !node) return
    const galProject = await loadGalProject(project.path)
    const routeToSave = galProject?.routes.find((r) => r.id === route.id)
    const parentToSave = routeToSave?.nodes.find((n) => n.id === node.id)
    const choiceToSave = parentToSave?.choices.find((choice) => choice.id === choiceId)
    if (!galProject || !routeToSave || !parentToSave || !choiceToSave) {
      throw new Error("创建后续节点失败：当前节点或选项不存在")
    }

    choiceToSave.nextNodeId = childNode.id
    parentToSave.children = Array.from(new Set([...(parentToSave.children ?? []), childNode.id]))
    parentToSave.updatedAt = new Date().toISOString()
    routeToSave.nodes.push(childNode)

    const pathRoute = galProject.routes.find((r) => r.id === selectedRouteId)
    if (pathRoute && pathRoute.id !== route.id && Array.isArray(pathRoute.nodeIds)) {
      pathRoute.nodeIds = Array.from(new Set([...pathRoute.nodeIds, childNode.id]))
    }

    await saveGalProject(project.path, galProject)
    galStore.setProject(await loadGalProject(project.path))
    galStore.selectNode(childNode.id)
  }, [project, route, node, selectedRouteId, galStore])

  const attachDirectChildNode = useCallback(async (childNode: GalNode) => {
    if (!project || !route || !node) return
    const galProject = await loadGalProject(project.path)
    const routeToSave = galProject?.routes.find((r) => r.id === route.id)
    const parentToSave = routeToSave?.nodes.find((n) => n.id === node.id)
    if (!galProject || !routeToSave || !parentToSave) {
      throw new Error("创建后续节点失败：当前节点不存在")
    }

    parentToSave.children = Array.from(new Set([...(parentToSave.children ?? []), childNode.id]))
    parentToSave.updatedAt = new Date().toISOString()
    routeToSave.nodes.push(childNode)

    const pathRoute = galProject.routes.find((r) => r.id === selectedRouteId)
    if (pathRoute && pathRoute.id !== route.id && Array.isArray(pathRoute.nodeIds)) {
      pathRoute.nodeIds = Array.from(new Set([...pathRoute.nodeIds, childNode.id]))
    }

    await saveGalProject(project.path, galProject)
    galStore.setProject(await loadGalProject(project.path))
    galStore.selectNode(childNode.id)
  }, [project, route, node, selectedRouteId, galStore])

  const handleAiExpandChild = useCallback(async (choiceId: string) => {
    if (!project || !route || !node) return
    setExpanding(choiceId)
    setMessage(null)
    try {
      setMessage("正在保存当前选项...")
      await saveDraft()
      setMessage("正在根据选项生成后续节点卡片...")
      const card = await expandChildNodeCard({
        projectPath: project.path,
        routeId: route.id,
        parentNodeId: node.id,
        choiceId,
      })
      const now = new Date().toISOString()
      await attachChildNode(choiceId, {
        id: card.id,
        routeId: route.id,
        title: card.title,
        type: card.type,
        status: "card",
        parents: [node.id],
        children: [],
        goal: card.goal,
        summary: card.summary,
        scriptPath: `nodes/${route.id}/${card.id}.md`,
        incomingState: node.outgoingState || createEmptyState(),
        choices: card.choices,
        memoryScope: "node",
        characters: card.characters,
        scene: card.scene,
        clueIds: [],
        sequence: getNextSequence(route),
        createdAt: now,
        updatedAt: now,
      })
      setMessage("AI 后续节点已创建。")
    } catch (err) {
      setMessage(`AI 展开失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setExpanding(null)
    }
  }, [project, route, node, saveDraft, attachChildNode])

  const handleManualExpandChild = useCallback(async (choiceId: string) => {
    if (!project || !route || !node) return
    setExpanding(choiceId)
    setMessage(null)
    try {
      setMessage("正在保存当前选项...")
      await saveDraft()
      const choice = draftChoices.find((item) => item.id === choiceId)
      const now = new Date().toISOString()
      const childId = `node_${Date.now().toString(36)}`
      await attachChildNode(choiceId, {
        id: childId,
        routeId: route.id,
        title: choice?.nextNodeTitle?.trim() || "新节点",
        type: "daily",
        status: "card",
        parents: [node.id],
        children: [],
        goal: choice?.nextNodeGoal?.trim() || "",
        summary: "",
        scriptPath: `nodes/${route.id}/${childId}.md`,
        incomingState: node.outgoingState || createEmptyState(),
        choices: [],
        memoryScope: "node",
        characters: [],
        scene: "",
        clueIds: [],
        sequence: getNextSequence(route),
        createdAt: now,
        updatedAt: now,
      })
      setMessage("空节点已创建并连接到当前选项。")
    } catch (err) {
      setMessage(`手动展开失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setExpanding(null)
    }
  }, [project, route, node, draftChoices, saveDraft, attachChildNode])

  const handleDefaultManualExpand = useCallback(async () => {
    if (!project || !route || !node) return
    const expandKey = "__default__"
    setExpanding(expandKey)
    setMessage(null)
    try {
      setMessage("正在创建默认后续空节点...")
      await saveDraft()
      const now = new Date().toISOString()
      const childId = `node_${Date.now().toString(36)}`
      await attachDirectChildNode({
        id: childId,
        routeId: route.id,
        title: "新节点",
        type: "daily",
        status: "card",
        parents: [node.id],
        children: [],
        goal: "",
        summary: "",
        scriptPath: `nodes/${route.id}/${childId}.md`,
        incomingState: node.outgoingState || createEmptyState(),
        choices: [],
        memoryScope: "node",
        characters: [],
        scene: "",
        clueIds: [],
        sequence: getNextSequence(route),
        createdAt: now,
        updatedAt: now,
      })
      setMessage("默认后续空节点已创建。")
    } catch (err) {
      setMessage(`手动展开失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setExpanding(null)
    }
  }, [project, route, node, saveDraft, attachDirectChildNode])

  const handleMergeToExisting = useCallback(async (choiceId: string, targetNodeId: string) => {
    if (!project || !route || !node || !targetNodeId) return
    setExpanding(choiceId)
    setMessage(null)
    try {
      setMessage("正在连接到已有收束节点...")
      await saveDraft()
      const galProject = await loadGalProject(project.path)
      const routeToSave = galProject?.routes.find((r) => r.id === route.id)
      const parentToSave = routeToSave?.nodes.find((n) => n.id === node.id)
      const targetToSave = routeToSave?.nodes.find((n) => n.id === targetNodeId)
      const choiceToSave = parentToSave?.choices.find((choice) => choice.id === choiceId)
      if (!galProject || !routeToSave || !parentToSave || !targetToSave || !choiceToSave) {
        throw new Error("连接失败：目标节点或选项不存在")
      }
      if (!isMergeTargetAllowed(routeToSave, parentToSave, targetToSave)) {
        throw new Error("不能连接到同级、上级或会导致剧情倒转的节点")
      }

      choiceToSave.nextNodeId = targetNodeId
      parentToSave.children = Array.from(new Set([...(parentToSave.children ?? []), targetNodeId]))
      targetToSave.parents = Array.from(new Set([...(targetToSave.parents ?? []), node.id]))
      parentToSave.updatedAt = new Date().toISOString()
      targetToSave.updatedAt = new Date().toISOString()
      await saveGalProject(project.path, galProject)
      galStore.setProject(await loadGalProject(project.path))
      setDraftChoices((choices) =>
        choices.map((choice) => choice.id === choiceId ? { ...choice, nextNodeId: targetNodeId } : choice),
      )
      setMessage("已收束到已有节点。")
    } catch (err) {
      setMessage(`收束失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setExpanding(null)
    }
  }, [project, route, node, saveDraft, galStore])

  const handleDefaultMergeToExisting = useCallback(async (targetNodeId: string) => {
    if (!project || !route || !node || !targetNodeId) return
    const expandKey = "__default__"
    setExpanding(expandKey)
    setMessage(null)
    try {
      setMessage("正在连接默认出口到已有节点...")
      await saveDraft()
      const galProject = await loadGalProject(project.path)
      const routeToSave = galProject?.routes.find((r) => r.id === route.id)
      const parentToSave = routeToSave?.nodes.find((n) => n.id === node.id)
      const targetToSave = routeToSave?.nodes.find((n) => n.id === targetNodeId)
      if (!galProject || !routeToSave || !parentToSave || !targetToSave) {
        throw new Error("连接失败：目标节点不存在")
      }
      if (!isMergeTargetAllowed(routeToSave, parentToSave, targetToSave)) {
        throw new Error("不能连接到同级、上级或会导致剧情倒转的节点")
      }

      parentToSave.children = Array.from(new Set([...(parentToSave.children ?? []), targetNodeId]))
      targetToSave.parents = Array.from(new Set([...(targetToSave.parents ?? []), node.id]))
      parentToSave.updatedAt = new Date().toISOString()
      targetToSave.updatedAt = new Date().toISOString()
      await saveGalProject(project.path, galProject)
      galStore.setProject(await loadGalProject(project.path))
      setMessage("默认出口已连接到已有节点。")
    } catch (err) {
      setMessage(`收束失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setExpanding(null)
    }
  }, [project, route, node, saveDraft, galStore])

  const handleDeleteNode = useCallback(async () => {
    if (!project || !route || !node) return
    if (!window.confirm(`确定删除节点「${node.title}」吗？该节点正文也会被删除。`)) return
    setDeleting(true)
    setMessage(null)
    try {
      const galProject = await loadGalProject(project.path)
      const routeToSave = galProject?.routes.find((r) => r.id === route.id)
      if (!galProject || !routeToSave) throw new Error("删除失败：线路不存在")

      routeToSave.nodes = routeToSave.nodes
        .filter((item) => item.id !== node.id)
        .map((item) => ({
          ...item,
          children: (item.children ?? []).filter((childId) => childId !== node.id),
          parents: (item.parents ?? []).filter((parentId) => parentId !== node.id),
          choices: (item.choices ?? []).map((choice) => (
            choice.nextNodeId === node.id ? { ...choice, nextNodeId: undefined } : choice
          )),
        }))
      if (routeToSave.entryNodeId === node.id) {
        routeToSave.entryNodeId = routeToSave.nodes[0]?.id ?? ""
      }
      routeToSave.endingNodeIds = routeToSave.endingNodeIds.filter((id) => id !== node.id)
      for (const pathRoute of galProject.routes) {
        if (Array.isArray(pathRoute.nodeIds)) {
          pathRoute.nodeIds = pathRoute.nodeIds.filter((id) => id !== node.id)
        }
      }

      await saveGalProject(project.path, galProject)
      await deleteNodeScript(project.path, route.id, node.id)
      galStore.setProject(await loadGalProject(project.path))
      galStore.selectNode(null)
      onBackToBoard?.()
    } catch (err) {
      setMessage(`删除失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setDeleting(false)
    }
  }, [project, route, node, galStore, onBackToBoard])

  const updateChoice = useCallback((choiceId: string, patch: Partial<GalChoice>) => {
    setDraftChoices((choices) =>
      choices.map((choice) => choice.id === choiceId ? { ...choice, ...patch } : choice),
    )
  }, [])

  const addChoice = useCallback(() => {
    setDraftChoices((choices) => [
      ...choices,
      {
        id: `choice_${Date.now().toString(36)}`,
        text: "新的选项",
        emotionalIntent: "",
        effects: [],
        nextNodeTitle: "",
        nextNodeGoal: "",
      },
    ])
  }, [])

  const removeChoice = useCallback((choiceId: string) => {
    setDraftChoices((choices) => choices.filter((choice) => choice.id !== choiceId))
  }, [])

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        请从左侧选择一个节点
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="flex-1 truncate text-sm font-medium">
          <span className={getNodeTypeColor(node.type)}>[{getNodeTypeLabel(node.type)}]</span>{" "}
          {draftTitle || node.title}
        </span>
        <span className="text-xs text-muted-foreground">{getNodeStatusLabel(node.status)}</span>
        {onShowInitContext && (
          <button type="button" disabled={loadingInitContext} onClick={onShowInitContext} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-40">
            {loadingInitContext ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            初始化上下文
          </button>
        )}
        {onReinitGal && (
          <button type="button" disabled={reinitializing} onClick={onReinitGal} className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 px-2 py-1 text-xs text-amber-500 hover:bg-amber-500/10 disabled:opacity-40">
            {reinitializing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            重新初始化 Gal
          </button>
        )}
        <button type="button" disabled={deleting} onClick={handleDeleteNode} className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-40">
          {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          删除
        </button>
        {onBackToBoard && (
          <button type="button" onClick={onBackToBoard} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent">
            <MapIcon className="h-3.5 w-3.5" />
            线路画布
          </button>
        )}
      </div>

      {message && <div className="border-b px-3 py-1.5 text-xs text-muted-foreground">{message}</div>}

      <div className="flex-1 overflow-y-auto p-3">
        <div className="mb-3 rounded-md border bg-muted/30 p-2.5 text-xs">
          <div className="grid gap-2 md:grid-cols-[1fr_1.4fr]">
            <label className="min-w-0">
              <span className="mb-1 block text-[10px] font-medium text-muted-foreground">标题</span>
              <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20" />
            </label>
            <label className="min-w-0">
              <span className="mb-1 block text-[10px] font-medium text-muted-foreground">人物</span>
              <input value={draftCharacters} onChange={(event) => setDraftCharacters(event.target.value)} placeholder="妃爱、主角" className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20" />
            </label>
          </div>
          <label className="mt-2 block">
            <span className="mb-1 block text-[10px] font-medium text-muted-foreground">目标</span>
            <textarea value={draftGoal} onChange={(event) => setDraftGoal(event.target.value)} className="h-16 w-full resize-y rounded border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20" />
          </label>
          <label className="mt-2 block">
            <span className="mb-1 block text-[10px] font-medium text-muted-foreground">场景</span>
            <textarea value={draftScene} onChange={(event) => setDraftScene(event.target.value)} className="h-14 w-full resize-y rounded border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20" />
          </label>
        </div>

        <div className="mb-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="flex-1 text-xs font-medium text-muted-foreground">选项</div>
            <button type="button" onClick={addChoice} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent">
              <Plus className="h-3 w-3" />
              添加选项
            </button>
          </div>
          {draftChoices.length > 0 ? (
            draftChoices.map((choice) => (
              <ChoiceItem
                key={choice.id}
                choice={choice}
                expanding={expanding === choice.id}
                mergeTargets={mergeTargets}
                onChange={updateChoice}
                onEffectsChange={(choiceId, effectsText) => updateChoice(choiceId, { effects: parseEffectsText(effectsText) })}
                onRemove={() => removeChoice(choice.id)}
                onAiExpand={() => handleAiExpandChild(choice.id)}
                onManualExpand={() => handleManualExpandChild(choice.id)}
                onMergeExisting={(targetNodeId) => handleMergeToExisting(choice.id, targetNodeId)}
              />
            ))
          ) : (
            <DefaultOutletPanel
              expanding={expanding === "__default__"}
              linkedNodes={directLinkedNodes}
              mergeTargets={mergeTargets}
              onManualExpand={handleDefaultManualExpand}
              onMergeExisting={handleDefaultMergeToExisting}
            />
          )}
        </div>

        {lintResults.length > 0 && (
          <div className="mb-3 space-y-1 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs dark:border-amber-800 dark:bg-amber-950">
            <div className="font-medium text-amber-700 dark:text-amber-400">分支检查结果 ({lintResults.length} 项)</div>
            {lintResults.map((result, index) => (
              <div key={index} className="flex items-start gap-1">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                <span>[{result.severity}] {result.message}</span>
              </div>
            ))}
          </div>
        )}

        <div className="mb-3">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">AI 提示词</div>
          <textarea value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} placeholder="补充本节点的写作要求，例如对话重点、情绪推进、节奏、需要埋下的线索..." className="h-24 w-full resize-y rounded-md border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
        </div>

        <div className="mb-3">
          <textarea value={scriptContent} onChange={(event) => setScriptContent(event.target.value)} placeholder="节点正文将在此显示。点击「生成」让 AI 撰写，或手动输入..." className="min-h-[300px] w-full resize-y rounded-md border bg-background p-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
        </div>
      </div>

      <div className="flex items-center gap-1.5 border-t px-3 py-2">
        <button type="button" disabled={galStore.generating || Boolean(scriptContent.trim())} onClick={handleFirstGenerate} className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {galStore.generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          首次生成
        </button>
        <button type="button" disabled={galStore.generating || !scriptContent.trim()} onClick={handleRegenerate} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50">
          {galStore.generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          重新生成
        </button>
        <button type="button" disabled={saving} onClick={handleSaveDraft} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存
        </button>
        <button type="button" disabled={saving || !scriptContent} onClick={handleSaveAndIngest} className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存并摄取
        </button>
        <div className="flex-1" />
        <button type="button" disabled={lintRunning} onClick={onLintBranch} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50">
          {lintRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          分支检查
        </button>
      </div>
    </div>
  )
}

function DefaultOutletPanel({
  expanding,
  linkedNodes,
  mergeTargets,
  onManualExpand,
  onMergeExisting,
}: {
  expanding: boolean
  linkedNodes: GalNode[]
  mergeTargets: GalNode[]
  onManualExpand: () => void
  onMergeExisting: (targetNodeId: string) => void
}) {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">
      <div>
        当前没有预设选项。AI 生成时会自由发挥，也可以通过默认出口连接一个后续节点。
      </div>
      {linkedNodes.length > 0 ? (
        <div className="mt-2 rounded border bg-background/60 px-2 py-1.5 text-[11px]">
          默认出口已连接：{linkedNodes.map((item) => item.title).join("、")}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <button type="button" disabled={expanding} onClick={onManualExpand} className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-50">
            {expanding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            手动展开空节点
          </button>
          <label className="inline-flex items-center gap-1">
            <Link2 className="h-3 w-3 text-muted-foreground" />
            <select
              disabled={expanding || mergeTargets.length === 0}
              defaultValue=""
              onChange={(event) => {
                const targetNodeId = event.target.value
                event.currentTarget.value = ""
                if (targetNodeId) onMergeExisting(targetNodeId)
              }}
              className="h-6 max-w-[180px] rounded border bg-background px-1 text-[10px]"
            >
              <option value="">收束到已有</option>
              {mergeTargets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  )
}

function ChoiceItem({
  choice,
  expanding,
  mergeTargets,
  onChange,
  onEffectsChange,
  onRemove,
  onAiExpand,
  onManualExpand,
  onMergeExisting,
}: {
  choice: GalChoice
  expanding: boolean
  mergeTargets: GalNode[]
  onChange: (choiceId: string, patch: Partial<GalChoice>) => void
  onEffectsChange: (choiceId: string, effectsText: string) => void
  onRemove: () => void
  onAiExpand: () => void
  onManualExpand: () => void
  onMergeExisting: (targetNodeId: string) => void
}) {
  return (
    <div className="rounded-md border bg-background p-2 text-xs">
      <div className="flex items-start gap-2">
        <div className="grid flex-1 gap-2 md:grid-cols-[1.5fr_1fr_1fr]">
          <label className="min-w-0">
            <span className="mb-1 block text-[10px] text-muted-foreground">选项文本</span>
            <input value={choice.text} onChange={(event) => onChange(choice.id, { text: event.target.value })} className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20" />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[10px] text-muted-foreground">情感意图</span>
            <input value={choice.emotionalIntent} onChange={(event) => onChange(choice.id, { emotionalIntent: event.target.value })} className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20" />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[10px] text-muted-foreground">变量影响</span>
            <input value={effectsToText(choice.effects)} onChange={(event) => onEffectsChange(choice.id, event.target.value)} placeholder="feiai_trust +1" className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20" />
          </label>
        </div>
        <button type="button" onClick={onRemove} className="mt-4 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-destructive/30 text-destructive hover:bg-destructive/10" title="删除选项">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <label className="min-w-0 flex-1">
          <span className="mb-1 block text-[10px] text-muted-foreground">下个节点建议标题</span>
          <input value={choice.nextNodeTitle ?? ""} onChange={(event) => onChange(choice.id, { nextNodeTitle: event.target.value })} className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20" />
        </label>
        <label className="min-w-0 flex-[2]">
          <span className="mb-1 block text-[10px] text-muted-foreground">下个节点剧情目标</span>
          <input value={choice.nextNodeGoal ?? ""} onChange={(event) => onChange(choice.id, { nextNodeGoal: event.target.value })} className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20" />
        </label>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="truncate text-[10px] text-muted-foreground">
          {choice.nextNodeId ? `已连接：${choice.nextNodeId}` : "尚未连接后续节点"}
        </div>
        {!choice.nextNodeId && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            <button type="button" disabled={expanding} onClick={onAiExpand} className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-[10px] hover:bg-accent/80 disabled:opacity-50">
              {expanding ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranchPlus className="h-3 w-3" />}
              AI 展开
            </button>
            <button type="button" disabled={expanding} onClick={onManualExpand} className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-50">
              <Plus className="h-3 w-3" />
              手动展开
            </button>
            <label className="inline-flex items-center gap-1">
              <Link2 className="h-3 w-3 text-muted-foreground" />
              <select
                disabled={expanding || mergeTargets.length === 0}
                defaultValue=""
                onChange={(event) => {
                  const targetNodeId = event.target.value
                  event.currentTarget.value = ""
                  if (targetNodeId) onMergeExisting(targetNodeId)
                }}
                className="h-6 max-w-[160px] rounded border bg-background px-1 text-[10px]"
              >
                <option value="">收束到已有</option>
                {mergeTargets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>
    </div>
  )
}

function cloneChoices(choices: GalChoice[]): GalChoice[] {
  return choices.map((choice) => ({
    ...choice,
    condition: choice.condition ? [...choice.condition] : undefined,
    effects: (choice.effects ?? []).map((effect) => ({ ...effect })),
  }))
}

function effectsToText(effects: GalEffect[] = []): string {
  return effects
    .map((effect) => `${effect.variable} ${effect.op === "add" ? "+" : "="}${String(effect.value)}`)
    .join("; ")
}

function parseEffectsText(text: string): GalEffect[] {
  return text
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/^(.+?)\s*(\+|=)\s*(.+)$/)
      if (!match) return null
      return {
        variable: match[1].trim(),
        op: match[2] === "+" ? "add" : "set",
        value: parseEffectValue(match[3].trim()),
      } satisfies GalEffect
    })
    .filter((effect): effect is GalEffect => Boolean(effect))
}

function parseEffectValue(value: string): number | string | boolean {
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if (value === "true") return true
  if (value === "false") return false
  return value
}

function splitCharacters(value: string): string[] {
  return value
    .split(/[、，,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function createEmptyState() {
  return {
    variables: {},
    characterCognition: {},
    acquiredClueIds: [],
    seenCgIds: [],
    visitedNodeIds: [],
    currentScene: "",
    characterMoods: {},
  }
}

function getNextSequence(route: GalRoute): number {
  return Math.max(0, ...(route.nodes ?? []).map((item) => item.sequence || 0)) + 1
}

function getMergeTargets(route: GalRoute, source: GalNode): GalNode[] {
  return (route.nodes ?? [])
    .filter((target) => isMergeTargetAllowed(route, source, target))
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
}

function isMergeTargetAllowed(route: GalRoute, source: GalNode, target: GalNode): boolean {
  if (source.id === target.id) return false
  if (canReach(route, target.id, source.id)) return false

  const depths = computeDepths(route)
  const sourceDepth = depths.get(source.id) ?? 0
  const targetDepth = depths.get(target.id)
  if (targetDepth === undefined) {
    return target.id !== route.entryNodeId && (target.parents ?? []).length === 0
  }

  return targetDepth > sourceDepth
}

function computeDepths(route: GalRoute): Map<string, number> {
  const nodes = route.nodes ?? []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const depths = new Map<string, number>()
  const queue = [{ id: route.entryNodeId || nodes[0]?.id, depth: 0 }]
  while (queue.length > 0) {
    const item = queue.shift()
    if (!item?.id) continue
    const previous = depths.get(item.id)
    if (previous !== undefined && previous <= item.depth) continue
    depths.set(item.id, item.depth)
    const node = nodeById.get(item.id)
    if (!node) continue
    for (const childId of collectNextNodeIds(node)) {
      queue.push({ id: childId, depth: item.depth + 1 })
    }
  }
  return depths
}

function canReach(route: GalRoute, fromId: string, toId: string): boolean {
  const nodeById = new Map((route.nodes ?? []).map((node) => [node.id, node]))
  const visited = new Set<string>()
  const queue = [fromId]
  while (queue.length > 0) {
    const id = queue.shift()
    if (!id || visited.has(id)) continue
    if (id === toId) return true
    visited.add(id)
    const node = nodeById.get(id)
    if (!node) continue
    queue.push(...collectNextNodeIds(node))
  }
  return false
}

function collectNextNodeIds(node: GalNode): string[] {
  return Array.from(new Set([
    ...(node.children ?? []),
    ...(node.choices ?? [])
      .map((choice) => choice.nextNodeId)
      .filter((id): id is string => Boolean(id)),
  ]))
}
