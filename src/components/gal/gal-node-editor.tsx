import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  GitBranchPlus,
  Link2,
  ListPlus,
  Loader2,
  Map as MapIcon,
  Plus,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Unlink,
} from "lucide-react"
import { useGalStore } from "@/stores/gal-store"
import { useWikiStore } from "@/stores/wiki-store"
import { generateNodeChoices } from "@/lib/gal/gal-choice-generation"
import { backfillIncomingChoices } from "@/lib/gal/gal-choice-backfill"
import { expandChildNodeCard, generateChoiceLongLineCards, generateNodeScript, type ChildNodeCardResult } from "@/lib/gal/gal-node-generation"
import { ingestNode } from "@/lib/gal/gal-node-ingest"
import { updateNodeSummary } from "@/lib/gal/gal-node-summary"
import {
  deleteNodeScript,
  loadGalProject,
  loadNodeScript,
  saveGalProject,
  saveNodeScript,
} from "@/lib/gal/gal-storage"
import { sanitizeGalChoices } from "@/lib/gal/gal-variable-guard"
import { getNodeStatusLabel, getNodeTypeColor, getNodeTypeLabel } from "./gal-utils"
import type { BranchLintResult, GalChoice, GalEffect, GalNode, GalRoute, GalStateSnapshot, GalVariable } from "@/lib/gal/gal-types"

interface GalNodeEditorProps {
  onLintBranch: () => void
  lintRunning: boolean
  lintResults: BranchLintResult[]
  onBackToBoard?: () => void
  onReinitGal?: () => void
  reinitializing?: boolean
  onShowInitContext?: () => void
  loadingInitContext?: boolean
  onOpenLonglineWorkspace?: (nodeId: string) => void
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
  onOpenLonglineWorkspace,
}: GalNodeEditorProps) {
  const project = useWikiStore((s) => s.project)
  const galStore = useGalStore()
  const node = galStore.selectedNode()
  const route = galStore.currentNodeRoute() ?? galStore.selectedRoute()
  const selectedRouteId = useGalStore((s) => s.selectedRouteId)
  const currentNodeGenerating = Boolean(node && galStore.generatingNodeIds.includes(node.id))

  const [scriptContent, setScriptContent] = useState("")
  const [aiPrompt, setAiPrompt] = useState("")
  const [choicePrompt, setChoicePrompt] = useState("")
  const [draftTitle, setDraftTitle] = useState("")
  const [draftGoal, setDraftGoal] = useState("")
  const [draftScene, setDraftScene] = useState("")
  const [draftCharacters, setDraftCharacters] = useState("")
  const [draftChoices, setDraftChoices] = useState<GalChoice[]>([])
  const [saving, setSaving] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [_backfilling, setBackfilling] = useState(false)
  const [generatingChoices, setGeneratingChoices] = useState(false)
  const [showChoiceCountPicker, setShowChoiceCountPicker] = useState(false)
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
      setChoicePrompt("")
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
    setChoicePrompt(node.choicePrompt ?? "")

    const load = async () => {
      try {
        setScriptContent((await loadNodeScript(project.path, route.id, node.id)) || "")
      } catch {
        setScriptContent("")
      }
    }
    void load()
  }, [project, route?.id, node?.id])

  const saveDraft = useCallback(async (status?: GalNode["status"], choicesOverride?: GalChoice[]) => {
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
    const choicesToSave = choicesOverride ?? draftChoices
    const safeChoices = sanitizeGalChoices(choicesToSave, galProject.variables ?? [])
    const nextChoiceChildren = new Set(
      safeChoices
        .map((choice) => choice.nextNodeId)
        .filter((childId): childId is string => Boolean(childId)),
    )
    const nextChildren = new Set([...directChildren, ...nextChoiceChildren])

    nodeToSave.title = draftTitle.trim() || nodeToSave.title
    nodeToSave.goal = draftGoal
    nodeToSave.scene = draftScene
    nodeToSave.characters = splitCharacters(draftCharacters)
    nodeToSave.aiPrompt = aiPrompt
    nodeToSave.choicePrompt = choicePrompt
    nodeToSave.choices = cloneChoices(safeChoices)
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
  }, [project, route, node, scriptContent, aiPrompt, choicePrompt, draftTitle, draftGoal, draftScene, draftCharacters, draftChoices, galStore])

  const performIncomingChoiceBackfill = useCallback(async (content: string) => {
    if (!project || !route || !node || !content.trim()) return 0
    setBackfilling(true)
    try {
      const count = await galStore.runAiTask(
        {
          title: `回写前置选项：${node.title}`,
          detail: "调用 AI 根据正文优化前置选项...",
        },
        () => backfillIncomingChoices({
          projectPath: project.path,
          routeId: route.id,
          nodeId: node.id,
          scriptContent: content,
        }),
      )
      if (count > 0) {
        galStore.setProject(await loadGalProject(project.path))
      }
      return count
    } finally {
      setBackfilling(false)
    }
  }, [project, route, node, galStore])

  const handleSaveDraft = useCallback(async () => {
    setSaving(true)
    setMessage(null)
    try {
      await saveDraft()
      setMessage("保存完成")
      const backfilledCount = await performIncomingChoiceBackfill(scriptContent)
      if (backfilledCount > 0) {
        setMessage(`保存完成，已按当前正文回写 ${backfilledCount} 个前置选项。`)
      }
    } catch (err) {
      setMessage(`保存失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setSaving(false)
    }
  }, [saveDraft, performIncomingChoiceBackfill, scriptContent])

  const runGeneration = useCallback(async (replaceExisting: boolean) => {
    if (!project || !route || !node) return
    if (useGalStore.getState().generatingNodeIds.includes(node.id)) return
    const isCurrentNode = () => useGalStore.getState().selectedNodeId === node.id
    galStore.setGenerating(true, node.id)
    setMessage(null)
    try {
      setMessage("正在保存当前节点...")
      await saveDraft()
      if (replaceExisting) {
        if (isCurrentNode()) setMessage("正在删除原正文...")
        await saveNodeScript(project.path, route.id, node.id, "")
        if (isCurrentNode()) setScriptContent("")
      }
      if (isCurrentNode()) setMessage("正在调用 AI 生成正文...")
      const { script, choices } = await galStore.runAiTask(
        {
          title: `${replaceExisting ? "重新生成正文" : "生成正文"}：${node.title}`,
          detail: "调用 AI 生成节点正文...",
        },
        () => generateNodeScript({
          projectPath: project.path,
          routeId: route.id,
          nodeId: node.id,
          userPrompt: aiPrompt,
          onToken: () => {},
        }),
      )
      if (isCurrentNode()) setScriptContent(script)
      const backfilledCount = await performIncomingChoiceBackfill(script)
      const refreshed = await loadGalProject(project.path)
      galStore.setProject(refreshed)
      const refreshedNode = refreshed?.routes
        .find((r) => r.id === route.id)
        ?.nodes.find((n) => n.id === node.id)
      if (isCurrentNode()) {
        if (refreshedNode) setDraftChoices(cloneChoices(refreshedNode.choices ?? []))
        setMessage(backfilledCount > 0
          ? `生成完成，已按正文回写 ${backfilledCount} 个前置选项。`
          : choices.length > 0 ? "生成完成，选项已写入节点。" : "生成完成")
      }
    } catch (err) {
      if (isCurrentNode()) {
        setMessage(`生成失败: ${err instanceof Error ? err.message : "未知错误"}`)
      }
    } finally {
      galStore.setGenerating(false, node.id)
    }
  }, [project, route, node, aiPrompt, saveDraft, performIncomingChoiceBackfill, galStore])

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
      await galStore.runAiTask(
        {
          title: `摄取记忆：${node.title}`,
          detail: "调用 AI 提取节点记忆...",
        },
        () => ingestNode({
          projectPath: project.path,
          routeId: route.id,
          nodeId: node.id,
        }),
      )
      const backfilledCount = await performIncomingChoiceBackfill(scriptContent)
      galStore.setProject(await loadGalProject(project.path))
      setMessage(backfilledCount > 0
        ? `保存并摄取完成，已按正文回写 ${backfilledCount} 个前置选项。`
        : "保存并摄取完成。")
    } catch (err) {
      setMessage(`保存失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setSaving(false)
    }
  }, [project, route, node, scriptContent, saveDraft, performIncomingChoiceBackfill, galStore])

  const handleUpdateSummary = useCallback(async () => {
    if (!project || !route || !node) return
    setSummarizing(true)
    setMessage(null)
    try {
      setMessage("正在保存当前节点...")
      await saveDraft()
      setMessage("正在生成节点摘要...")
      const summary = await galStore.runAiTask(
        {
          title: `生成摘要：${node.title}`,
          detail: "调用 AI 更新节点摘要...",
        },
        () => updateNodeSummary({
          projectPath: project.path,
          routeId: route.id,
          nodeId: node.id,
          scriptContent,
        }),
      )
      const backfilledCount = await performIncomingChoiceBackfill(scriptContent)
      galStore.setProject(await loadGalProject(project.path))
      setMessage(backfilledCount > 0
        ? `摘要已更新，并已回写 ${backfilledCount} 个前置选项：${summary}`
        : `摘要已更新：${summary}`)
    } catch (err) {
      setMessage(`摘要更新失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setSummarizing(false)
    }
  }, [project, route, node, scriptContent, saveDraft, performIncomingChoiceBackfill, galStore])

  const handleBackfillIncomingChoices = useCallback(async () => {
    if (!scriptContent.trim()) {
      setMessage("当前节点正文为空，不会覆盖前置选项。")
      return
    }
    setMessage("正在根据当前节点正文回写前置选项...")
    try {
      await saveDraft()
      const count = await performIncomingChoiceBackfill(scriptContent)
      setMessage(count > 0
        ? `已按当前节点正文回写 ${count} 个前置选项。`
        : "当前节点没有已连接的前置选项，无需回写。")
    } catch (err) {
      setMessage(`前置选项回写失败: ${err instanceof Error ? err.message : "未知错误"}`)
    }
  }, [scriptContent, saveDraft, performIncomingChoiceBackfill])

  const attachChildNode = useCallback(async (choiceId: string, childNode: GalNode) => {
    if (!project || !route || !node) return
    const galProject = await loadGalProject(project.path)
    const routeToSave = galProject?.routes.find((r) => r.id === route.id)
    const parentToSave = routeToSave?.nodes.find((n) => n.id === node.id)
    const choiceToSave = parentToSave?.choices.find((choice) => choice.id === choiceId)
    if (!galProject || !routeToSave || !parentToSave || !choiceToSave) {
      throw new Error("创建后续节点失败：当前节点或选项不存在")
    }

    if (routeToSave.nodes.some((item) => item.id === childNode.id)) {
      throw new Error(`创建后续节点失败：节点 ID ${childNode.id} 已存在`)
    }

    choiceToSave.nextNodeId = childNode.id
    childNode.incomingState = applyChoiceEffectsToState(
      parentToSave.outgoingState ?? parentToSave.incomingState ?? createEmptyState(),
      choiceToSave.effects,
    )
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

  const attachChoiceLongLine = useCallback(async (choiceId: string, cards: ChildNodeCardResult[]) => {
    if (!project || !route || !node || cards.length === 0) return []
    const galProject = await loadGalProject(project.path)
    const routeToSave = galProject?.routes.find((r) => r.id === route.id)
    const parentToSave = routeToSave?.nodes.find((n) => n.id === node.id)
    const choiceToSave = parentToSave?.choices.find((choice) => choice.id === choiceId)
    if (!galProject || !routeToSave || !parentToSave || !choiceToSave) {
      throw new Error("创建长线剧情失败：当前节点或选项不存在")
    }
    if (choiceToSave.nextNodeId) {
      throw new Error("创建长线剧情失败：该选项已经连接了后续节点")
    }

    const now = new Date().toISOString()
    const nodeIds = cards.map(() => createUniqueNodeId(routeToSave))
    let incomingState = applyChoiceEffectsToState(
      parentToSave.outgoingState ?? parentToSave.incomingState ?? createEmptyState(),
      choiceToSave.effects,
    )
    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index]
      const childId = nodeIds[index]
      const nextId = nodeIds[index + 1]
      const nextCard = cards[index + 1]
      const continuationChoice = nextId
        ? {
            id: `choice_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 6)}`,
            text: card.choices[0]?.text?.trim() || "继续",
            emotionalIntent: card.choices[0]?.emotionalIntent || "推进连续剧情",
            effects: card.choices[0]?.effects ?? [],
            nextNodeId: nextId,
            nextNodeTitle: nextCard?.title ?? "",
            nextNodeGoal: nextCard?.goal ?? "",
          } satisfies GalChoice
        : undefined
      const childNode: GalNode = {
        id: childId,
        routeId: route.id,
        title: card.title,
        type: card.type,
        status: "card",
        parents: [index === 0 ? node.id : nodeIds[index - 1]],
        children: nextId ? [nextId] : [],
        goal: card.goal,
        summary: card.summary,
        scriptPath: `nodes/${route.id}/${childId}.md`,
        incomingState,
        choices: continuationChoice ? [continuationChoice] : [],
        memoryScope: "node",
        characters: card.characters,
        scene: card.scene,
        clueIds: [],
        sequence: getNextSequence(routeToSave) + index,
        createdAt: now,
        updatedAt: now,
      }
      routeToSave.nodes.push(childNode)
      if (continuationChoice) {
        incomingState = applyChoiceEffectsToState(incomingState, continuationChoice.effects)
      }
    }

    choiceToSave.nextNodeId = nodeIds[0]
    choiceToSave.nextNodeTitle = cards[0]?.title ?? choiceToSave.nextNodeTitle
    choiceToSave.nextNodeGoal = cards[0]?.goal ?? choiceToSave.nextNodeGoal
    parentToSave.children = Array.from(new Set([...(parentToSave.children ?? []), nodeIds[0]]))
    parentToSave.updatedAt = now

    const pathRoute = galProject.routes.find((r) => r.id === selectedRouteId)
    if (pathRoute && pathRoute.id !== route.id && Array.isArray(pathRoute.nodeIds)) {
      pathRoute.nodeIds = Array.from(new Set([...pathRoute.nodeIds, ...nodeIds]))
    }

    await saveGalProject(project.path, galProject)
    galStore.setProject(await loadGalProject(project.path))
    galStore.selectNode(nodeIds[0])
    return nodeIds
  }, [project, route, node, selectedRouteId, galStore])

  const attachDirectChildNode = useCallback(async (childNode: GalNode) => {
    if (!project || !route || !node) return
    const galProject = await loadGalProject(project.path)
    const routeToSave = galProject?.routes.find((r) => r.id === route.id)
    const parentToSave = routeToSave?.nodes.find((n) => n.id === node.id)
    if (!galProject || !routeToSave || !parentToSave) {
      throw new Error("创建后续节点失败：当前节点不存在")
    }

    if (routeToSave.nodes.some((item) => item.id === childNode.id)) {
      throw new Error(`创建后续节点失败：节点 ID ${childNode.id} 已存在`)
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
      const card = await galStore.runAiTask(
        {
          title: `AI 展开节点：${node.title}`,
          detail: "根据选项生成后续节点卡片...",
        },
        () => expandChildNodeCard({
          projectPath: project.path,
          routeId: route.id,
          parentNodeId: node.id,
          choiceId,
        }),
      )
      const now = new Date().toISOString()
      const childId = createUniqueNodeId(route)
      await attachChildNode(choiceId, {
        id: childId,
        routeId: route.id,
        title: card.title,
        type: card.type,
        status: "card",
        parents: [node.id],
        children: [],
        goal: card.goal,
        summary: card.summary,
        scriptPath: `nodes/${route.id}/${childId}.md`,
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
      if (!useGalStore.getState().selectedNodeId) {
        galStore.selectRoute(route.id)
        galStore.selectNode(node.id)
      }
      setExpanding(null)
    }
  }, [project, route, node, saveDraft, attachChildNode, galStore])

  const handleGenerateLongLine = useCallback(async (choiceId: string, nodeCount: number, prompt: string, withScript: boolean) => {
    if (!project || !route || !node) return
    setExpanding(choiceId)
    setMessage(null)
    try {
      setMessage("正在保存当前选项...")
      await saveDraft()
      const cards = await galStore.runAiTask(
        {
          title: `生成长线剧情：${node.title}`,
          detail: `基于当前选项生成 ${nodeCount} 个连续节点...`,
        },
        () => generateChoiceLongLineCards({
          projectPath: project.path,
          routeId: route.id,
          parentNodeId: node.id,
          choiceId,
          nodeCount,
          userPrompt: prompt,
        }),
      )
      const nodeIds = await attachChoiceLongLine(choiceId, cards)
      if (withScript && nodeIds.length > 0) {
        for (let index = 0; index < nodeIds.length; index += 1) {
          const nodeId = nodeIds[index]
          galStore.setGenerating(true, nodeId)
          try {
            await galStore.runAiTask(
              {
                title: `生成长线正文：${cards[index]?.title || `节点${index + 1}`}`,
                detail: `正在生成第 ${index + 1}/${nodeIds.length} 个长线节点正文...`,
              },
              () => generateNodeScript({
                projectPath: project.path,
                routeId: route.id,
                nodeId,
                userPrompt: buildLongLineScriptPrompt({
                  cards,
                  index,
                  userPrompt: prompt,
                  parentTitle: node.title,
                }),
                onToken: () => {},
              }),
            )
          } finally {
            galStore.setGenerating(false, nodeId)
          }
        }
        galStore.setProject(await loadGalProject(project.path))
      }
      setMessage(withScript
        ? `已生成 ${cards.length} 个连续剧情节点，并已补完正文。`
        : `已生成 ${cards.length} 个连续剧情节点。`)
    } catch (err) {
      if (!useGalStore.getState().selectedNodeId) {
        galStore.selectRoute(route.id)
        galStore.selectNode(node.id)
      }
      setMessage(`长线剧情生成失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setExpanding(null)
    }
  }, [project, route, node, saveDraft, attachChoiceLongLine, galStore])

  const handleManualExpandChild = useCallback(async (choiceId: string) => {
    if (!project || !route || !node) return
    setExpanding(choiceId)
    setMessage(null)
    try {
      setMessage("正在保存当前选项...")
      await saveDraft()
      const choice = draftChoices.find((item) => item.id === choiceId)
      const now = new Date().toISOString()
      const childId = createUniqueNodeId(route)
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
      const childId = createUniqueNodeId(route)
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

  const handleUnlinkChoice = useCallback(async (choiceId: string) => {
    if (!project || !route || !node) return
    setExpanding(choiceId)
    setMessage(null)
    try {
      await saveDraft()
      const galProject = await loadGalProject(project.path)
      const routeToSave = galProject?.routes.find((r) => r.id === route.id)
      const parentToSave = routeToSave?.nodes.find((n) => n.id === node.id)
      const choiceToSave = parentToSave?.choices.find((choice) => choice.id === choiceId)
      const targetNodeId = choiceToSave?.nextNodeId
      if (!galProject || !routeToSave || !parentToSave || !choiceToSave || !targetNodeId) {
        throw new Error("解除失败：当前链接不存在")
      }

      choiceToSave.nextNodeId = undefined
      const remainsLinked = parentToSave.choices.some((choice) => choice.nextNodeId === targetNodeId)
      if (!remainsLinked) {
        parentToSave.children = (parentToSave.children ?? []).filter((childId) => childId !== targetNodeId)
        const targetToSave = routeToSave.nodes.find((item) => item.id === targetNodeId)
        if (targetToSave) {
          targetToSave.parents = (targetToSave.parents ?? []).filter((parentId) => parentId !== node.id)
          targetToSave.updatedAt = new Date().toISOString()
        }
      }
      parentToSave.updatedAt = new Date().toISOString()
      await saveGalProject(project.path, galProject)
      const refreshed = await loadGalProject(project.path)
      galStore.setProject(refreshed)
      const refreshedNode = refreshed?.routes
        .find((item) => item.id === route.id)
        ?.nodes.find((item) => item.id === node.id)
      if (refreshedNode) setDraftChoices(cloneChoices(refreshedNode.choices ?? []))
      setMessage("选项链接已解除，原后继节点仍然保留。")
    } catch (err) {
      setMessage(`解除链接失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setExpanding(null)
    }
  }, [project, route, node, saveDraft, galStore])

  const handleUnlinkDefaultOutlet = useCallback(async (targetNodeId: string) => {
    if (!project || !route || !node) return
    const expandKey = "__default__"
    setExpanding(expandKey)
    setMessage(null)
    try {
      await saveDraft()
      const galProject = await loadGalProject(project.path)
      const routeToSave = galProject?.routes.find((r) => r.id === route.id)
      const parentToSave = routeToSave?.nodes.find((n) => n.id === node.id)
      const targetToSave = routeToSave?.nodes.find((n) => n.id === targetNodeId)
      if (!galProject || !routeToSave || !parentToSave || !targetToSave) {
        throw new Error("解除失败：当前链接或目标节点不存在")
      }

      parentToSave.children = (parentToSave.children ?? []).filter((childId) => childId !== targetNodeId)
      const remainsLinked = parentToSave.choices.some((choice) => choice.nextNodeId === targetNodeId)
      if (!remainsLinked) {
        targetToSave.parents = (targetToSave.parents ?? []).filter((parentId) => parentId !== node.id)
      }
      parentToSave.updatedAt = new Date().toISOString()
      targetToSave.updatedAt = new Date().toISOString()
      await saveGalProject(project.path, galProject)
      galStore.setProject(await loadGalProject(project.path))
      setMessage("默认出口链接已解除，原后继节点仍然保留。")
    } catch (err) {
      setMessage(`解除链接失败: ${err instanceof Error ? err.message : "未知错误"}`)
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

  const handleCreateVariable = useCallback(async (
    choiceId: string,
    variableIdInput: string,
    variableNameInput: string,
  ): Promise<boolean> => {
    if (!project) return false
    const variableId = variableIdInput.trim()
    const variableName = variableNameInput.trim() || variableId
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(variableId)) {
      setMessage("变量 ID 只能使用英文字母、数字和下划线，并且必须以字母开头。")
      return false
    }

    try {
      const galProject = await loadGalProject(project.path)
      if (!galProject) {
        setMessage("创建变量失败：Gal 项目不存在。")
        return false
      }
      if (galProject.variables.some((variable) => variable.id === variableId)) {
        setMessage(`变量 ${variableId} 已存在，请直接选择已有变量。`)
        return false
      }

      galProject.variables.push({
        id: variableId,
        name: variableName,
        type: "custom",
        defaultValue: 0,
        description: "用户手动创建的变量",
      })
      await saveGalProject(project.path, galProject)
      galStore.setProject(await loadGalProject(project.path))
      updateChoice(choiceId, { effects: [createAddEffect(variableId, "+", 1)] })
      setMessage(`变量 ${variableName} (${variableId}) 已创建并绑定到当前选项。`)
      return true
    } catch (error) {
      setMessage(`创建变量失败：${error instanceof Error ? error.message : "未知错误"}`)
      return false
    }
  }, [project, galStore, updateChoice])

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

  const handleGenerateChoices = useCallback(async (count: number) => {
    setGeneratingChoices(true)
    setShowChoiceCountPicker(false)
    setMessage(null)
    try {
      setMessage(`正在生成 ${count} 个选项...`)
      const generatedChoices = await galStore.runAiTask(
        {
          title: `生成选项：${draftTitle || node?.title || "当前节点"}`,
          detail: `调用 AI 生成 ${count} 个选项...`,
        },
        () => generateNodeChoices({
          count,
          projectPath: project?.path,
          routeId: route?.id,
          nodeId: node?.id,
          title: draftTitle,
          characters: draftCharacters,
          goal: draftGoal,
          scene: draftScene,
          scriptContent,
          choicePrompt,
          existingChoices: draftChoices,
        }),
      )
      setDraftChoices((choices) => [...choices, ...generatedChoices])
      await saveDraft(undefined, [...draftChoices, ...generatedChoices])
      setMessage(`已生成 ${generatedChoices.length} 个选项，并已自动保存到节点。`)
    } catch (err) {
      setMessage(`选项生成失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setGeneratingChoices(false)
    }
  }, [project?.path, route?.id, node?.id, node?.title, draftTitle, draftCharacters, draftGoal, draftScene, scriptContent, choicePrompt, draftChoices, saveDraft, galStore])

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
            <input
              value={choicePrompt}
              onChange={(event) => setChoicePrompt(event.target.value)}
              placeholder="选项生成提示词"
              className="h-7 w-56 rounded-md border bg-background px-2 text-[11px] focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            {showChoiceCountPicker && (
              <select
                value=""
                disabled={generatingChoices}
                onChange={(event) => {
                  const count = Number(event.target.value)
                  event.currentTarget.value = ""
                  if (count > 0) void handleGenerateChoices(count)
                }}
                className="h-7 rounded-md border bg-background px-2 text-[11px] focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="">选择数量</option>
                <option value="1">生成 1 个</option>
                <option value="2">生成 2 个</option>
                <option value="3">生成 3 个</option>
                <option value="4">生成 4 个</option>
              </select>
            )}
            <button type="button" disabled={generatingChoices} onClick={() => setShowChoiceCountPicker((value) => !value)} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50">
              {generatingChoices ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              AI 生成选项
            </button>
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
                variables={galStore.project?.variables ?? []}
                variablePreview={buildChoiceVariablePreview(choice, node, galStore.project?.variables ?? [])}
                onChange={updateChoice}
                onCreateVariable={handleCreateVariable}
                onRemove={() => removeChoice(choice.id)}
                onAiExpand={() => handleAiExpandChild(choice.id)}
                onGenerateLongLine={(count, prompt, withScript) => handleGenerateLongLine(choice.id, count, prompt, withScript)}
                onManualExpand={() => handleManualExpandChild(choice.id)}
                onMergeExisting={(targetNodeId) => handleMergeToExisting(choice.id, targetNodeId)}
                onUnlink={() => handleUnlinkChoice(choice.id)}
              />
            ))
          ) : (
            <DefaultOutletPanel
              expanding={expanding === "__default__"}
              linkedNodes={directLinkedNodes}
              mergeTargets={mergeTargets}
              onManualExpand={handleDefaultManualExpand}
              onMergeExisting={handleDefaultMergeToExisting}
              onUnlink={handleUnlinkDefaultOutlet}
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
        <button type="button" disabled={currentNodeGenerating || Boolean(scriptContent.trim())} onClick={handleFirstGenerate} className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {currentNodeGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          首次生成
        </button>
        <button type="button" disabled={currentNodeGenerating || !scriptContent.trim()} onClick={handleRegenerate} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50">
          {currentNodeGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          重新生成
        </button>
        <button type="button" disabled={saving} onClick={handleSaveDraft} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存
        </button>
        <button type="button" disabled={saving || summarizing} onClick={handleUpdateSummary} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50">
          {summarizing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          更新摘要
        </button>
        <button type="button" disabled={saving || !scriptContent} onClick={handleBackfillIncomingChoices} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50">
          <Link2 className="h-3.5 w-3.5" />
          回写选项
        </button>
        <button type="button" disabled={saving || !scriptContent} onClick={handleSaveAndIngest} className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存并摄取
        </button>
        <div className="flex-1" />
        <button type="button" disabled={!node} onClick={() => node && onOpenLonglineWorkspace?.(node.id)} className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50">
          <MapIcon className="h-3.5 w-3.5" />
          长线检查
        </button>
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
  onUnlink,
}: {
  expanding: boolean
  linkedNodes: GalNode[]
  mergeTargets: GalNode[]
  onManualExpand: () => void
  onMergeExisting: (targetNodeId: string) => void
  onUnlink: (targetNodeId: string) => void
}) {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">
      <div>
        当前没有预设选项。AI 生成时会自由发挥，也可以通过默认出口连接一个后续节点。
      </div>
      {linkedNodes.length > 0 ? (
        <div className="mt-2 space-y-1">
          {linkedNodes.map((item) => (
            <div key={item.id} className="flex items-center gap-2 rounded border bg-background/60 px-2 py-1.5 text-[11px]">
              <span className="min-w-0 flex-1 truncate">默认出口已连接：{item.title}</span>
              <button
                type="button"
                disabled={expanding}
                onClick={() => onUnlink(item.id)}
                className="inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-50"
                title="解除链接，不删除节点"
              >
                <Unlink className="h-3 w-3" />
                解除链接
              </button>
            </div>
          ))}
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
  variables,
  variablePreview,
  onChange,
  onCreateVariable,
  onRemove,
  onAiExpand,
  onGenerateLongLine,
  onManualExpand,
  onMergeExisting,
  onUnlink,
}: {
  choice: GalChoice
  expanding: boolean
  mergeTargets: GalNode[]
  variables: GalVariable[]
  variablePreview: string
  onChange: (choiceId: string, patch: Partial<GalChoice>) => void
  onCreateVariable: (choiceId: string, variableId: string, variableName: string) => Promise<boolean>
  onRemove: () => void
  onAiExpand: () => void
  onGenerateLongLine: (count: number, prompt: string, withScript: boolean) => void
  onManualExpand: () => void
  onMergeExisting: (targetNodeId: string) => void
  onUnlink: () => void
}) {
  const primaryEffect = choice.effects[0]
  const knownVariableIds = new Set(variables.map((variable) => variable.id))
  const canUseExistingVariable = variables.length > 0
  const initialVariableMode = primaryEffect && knownVariableIds.has(primaryEffect.variable)
    ? "existing"
    : "none"
  const [variableMode, setVariableMode] = useState<"none" | "existing" | "manual">(initialVariableMode)
  const [newVariableId, setNewVariableId] = useState("")
  const [newVariableName, setNewVariableName] = useState("")
  const [creatingVariable, setCreatingVariable] = useState(false)
  const [showLongLinePanel, setShowLongLinePanel] = useState(false)
  const [longLineCount, setLongLineCount] = useState(5)
  const [longLinePrompt, setLongLinePrompt] = useState("")
  const [longLineWithScript, setLongLineWithScript] = useState(true)
  const selectedVariableId = primaryEffect && knownVariableIds.has(primaryEffect.variable)
    ? primaryEffect.variable
    : (variables[0]?.id ?? "")
  const numericEffectValue = Number(primaryEffect?.value ?? 1)
  const effectSign = Number.isFinite(numericEffectValue) && numericEffectValue < 0 ? "-" : "+"
  const effectAmount = Number.isFinite(numericEffectValue) ? Math.abs(numericEffectValue) : 1

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
            <span className="mb-1 block text-[10px] text-muted-foreground">内部变量影响（不注入 AI）</span>
            <select
              value={variableMode}
              onChange={(event) => {
                const mode = event.target.value as "none" | "existing" | "manual"
                setVariableMode(mode)
                if (mode === "none" || mode === "manual") {
                  onChange(choice.id, { effects: [] })
                } else if (variables[0]) {
                  onChange(choice.id, { effects: [createAddEffect(variables[0].id, "+", 1)] })
                }
              }}
              className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="none">无变量影响</option>
              <option value="existing" disabled={!canUseExistingVariable}>已有变量叠加</option>
              <option value="manual">人工创建新变量</option>
            </select>
          </label>
        </div>
        <button type="button" onClick={onRemove} className="mt-4 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-destructive/30 text-destructive hover:bg-destructive/10" title="删除选项">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
        {variablePreview}
      </div>
      {variableMode === "existing" && canUseExistingVariable ? (
        <div className="mt-2 grid gap-2 rounded border bg-muted/20 p-2 md:grid-cols-[1fr_80px_120px]">
          <label className="min-w-0">
            <span className="mb-1 block text-[10px] text-muted-foreground">变量</span>
            <select
              value={selectedVariableId}
              onChange={(event) => onChange(choice.id, {
                effects: [createAddEffect(event.target.value, effectSign, effectAmount)],
              })}
              className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              {variables.map((variable) => (
                <option key={variable.id} value={variable.id}>
                  {variable.name} ({variable.id})
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[10px] text-muted-foreground">加减</span>
            <select
              value={effectSign}
              onChange={(event) => onChange(choice.id, {
                effects: [createAddEffect(selectedVariableId, event.target.value === "-" ? "-" : "+", effectAmount)],
              })}
              className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="+">+</option>
              <option value="-">-</option>
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[10px] text-muted-foreground">数值</span>
            <input
              type="number"
              min="0"
              step="1"
              value={String(effectAmount)}
              onChange={(event) => onChange(choice.id, {
                effects: [createAddEffect(selectedVariableId, effectSign, Number(event.target.value || 0))],
              })}
              className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </label>
        </div>
      ) : variableMode === "manual" ? (
        <div className="mt-2 grid gap-2 rounded border bg-muted/20 p-2 md:grid-cols-[1fr_1fr_auto]">
          <label className="min-w-0">
            <span className="mb-1 block text-[10px] text-muted-foreground">变量 ID</span>
            <input
              value={newVariableId}
              onChange={(event) => setNewVariableId(event.target.value)}
              placeholder="例如 trust"
              className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[10px] text-muted-foreground">显示名称</span>
            <input
              value={newVariableName}
              onChange={(event) => setNewVariableName(event.target.value)}
              placeholder="例如 信任度"
              className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <button
            type="button"
            disabled={creatingVariable || !newVariableId.trim()}
            onClick={async () => {
              setCreatingVariable(true)
              try {
                if (await onCreateVariable(choice.id, newVariableId, newVariableName)) {
                  setVariableMode("existing")
                  setNewVariableId("")
                  setNewVariableName("")
                }
              } finally {
                setCreatingVariable(false)
              }
            }}
            className="mt-4 inline-flex h-8 items-center gap-1 rounded border px-2 text-xs hover:bg-accent disabled:opacity-50"
          >
            {creatingVariable ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            创建变量
          </button>
        </div>
      ) : null}
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
        {choice.nextNodeId ? (
          <button
            type="button"
            disabled={expanding}
            onClick={onUnlink}
            className="inline-flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-50"
            title="解除链接，不删除节点"
          >
            {expanding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlink className="h-3 w-3" />}
            解除链接
          </button>
        ) : (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            <button type="button" disabled={expanding} onClick={onAiExpand} className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-[10px] hover:bg-accent/80 disabled:opacity-50">
              {expanding ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranchPlus className="h-3 w-3" />}
              AI 展开
            </button>
            <button
              type="button"
              disabled={expanding}
              onClick={() => setShowLongLinePanel((value) => !value)}
              className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] hover:bg-accent disabled:opacity-50"
              title="生成一条连续剧情线"
            >
              {expanding ? <Loader2 className="h-3 w-3 animate-spin" /> : <ListPlus className="h-3 w-3" />}
              长线
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
      {!choice.nextNodeId && showLongLinePanel && (
        <div className="mt-2 rounded border bg-muted/20 p-2">
          <div className="grid gap-2 md:grid-cols-[120px_1fr_120px_auto]">
            <label className="min-w-0">
              <span className="mb-1 block text-[10px] text-muted-foreground">节点数</span>
              <select
                value={String(longLineCount)}
                disabled={expanding}
                onChange={(event) => setLongLineCount(Number(event.target.value))}
                className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
              >
                <option value="3">3 个节点</option>
                <option value="5">5 个节点</option>
                <option value="8">8 个节点</option>
              </select>
            </label>
            <label className="min-w-0">
              <span className="mb-1 block text-[10px] text-muted-foreground">长线提示词</span>
              <input
                value={longLinePrompt}
                disabled={expanding}
                onChange={(event) => setLongLinePrompt(event.target.value)}
                placeholder="例如：偏甜蜜、慢慢升温、不要马上收束"
                className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </label>
            <label className="mt-4 inline-flex h-8 items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={longLineWithScript}
                disabled={expanding}
                onChange={(event) => setLongLineWithScript(event.target.checked)}
              />
              生成正文
            </label>
            <button
              type="button"
              disabled={expanding}
              onClick={() => onGenerateLongLine(longLineCount, longLinePrompt, longLineWithScript)}
              className="mt-4 inline-flex h-8 items-center gap-1 rounded bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {expanding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ListPlus className="h-3.5 w-3.5" />}
              生成长线
            </button>
          </div>
        </div>
      )}
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

function buildLongLineScriptPrompt({
  cards,
  index,
  userPrompt,
  parentTitle,
}: {
  cards: ChildNodeCardResult[]
  index: number
  userPrompt: string
  parentTitle: string
}): string {
  const current = cards[index]
  const previous = cards[index - 1]
  const next = cards[index + 1]
  const plan = cards.map((card, cardIndex) => {
    return `${cardIndex + 1}. ${card.title}：${card.goal || card.summary || "推进连续剧情"}`
  }).join("\n")
  return [
    "## 长线剧情生成约束（最高优先级）",
    `这是从「${parentTitle}」的某个选项出发生成的一条单线长剧情。`,
    `当前正在写第 ${index + 1}/${cards.length} 个节点：${current?.title ?? ""}`,
    "",
    "## 整条长线计划",
    plan,
    "",
    previous
      ? `## 上一个节点\n标题：${previous.title}\n目标：${previous.goal || "（无）"}\n摘要：${previous.summary || "（无）"}`
      : "## 上一个节点\n本节点是长线起点，必须直接承接父节点结尾和玩家选项。",
    "",
    next
      ? `## 下一个节点\n标题：${next.title}\n目标：${next.goal || "（无）"}\n摘要：${next.summary || "（无）"}\n正文结尾必须自然导向唯一继续选项，不要写成分叉。`
      : "## 下一个节点\n本节点是当前长线末端。不要生成新的分叉选项，不要写成最终结局，保持后续可继续推进。",
    "",
    "## 单线硬规则",
    "1. 只写当前节点正文，不要替其他节点写正文。",
    "2. 不要在正文中新增分叉、多个选择、选项列表或变量说明。",
    "3. 中间节点结尾必须自然导向唯一继续选项。",
    "4. 末端节点保持可继续，不要强行收尾成结局，除非用户提示词明确要求。",
    "5. 不要创造新的核心人物、地点或设定；必须沿用项目上下文。",
    userPrompt.trim() ? `\n## 用户对这条长线的提示词\n${userPrompt.trim()}` : "",
  ].filter(Boolean).join("\n")
}

function createAddEffect(variableId: string, sign: "+" | "-", amount: number): GalEffect {
  const safeAmount = Number.isFinite(amount) ? Math.abs(amount) : 0
  return {
    variable: variableId.trim(),
    op: "add",
    value: sign === "-" ? -safeAmount : safeAmount,
  }
}

function buildChoiceVariablePreview(choice: GalChoice, node: GalNode, variables: GalVariable[]): string {
  if (choice.effects.length === 0) return "变量预览：不会改变变量"
  const base = node.incomingState?.variables ?? {}
  const variableMap = new Map(variables.map((variable) => [variable.id, variable]))
  return `变量预览（仅统计，不写入 AI）：${choice.effects.map((effect) => {
    const variable = variableMap.get(effect.variable)
    const current = base[effect.variable] ?? variable?.defaultValue ?? 0
    const next = applyEffectValue(current, effect)
    const label = variable?.name ? `${variable.name}(${effect.variable})` : effect.variable
    return `${label}: ${String(current)} -> ${String(next)}`
  }).join("；")}`
}

function applyChoiceEffectsToState(state: GalStateSnapshot, effects: GalEffect[]): GalStateSnapshot {
  const variables = { ...state.variables }
  for (const effect of effects) {
    variables[effect.variable] = applyEffectValue(variables[effect.variable] ?? 0, effect)
  }
  return { ...state, variables }
}

function applyEffectValue(current: number | string | boolean, effect: GalEffect): number | string | boolean {
  if (effect.op === "set") return effect.value
  const currentNumber = Number(current ?? 0)
  const delta = Number(effect.value)
  if (!Number.isFinite(currentNumber) || !Number.isFinite(delta)) return effect.value
  return currentNumber + delta
}

function splitCharacters(value: string): string[] {
  return value
    .split(/[、，,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function createEmptyState(): GalStateSnapshot {
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

function createUniqueNodeId(route: GalRoute): string {
  const existingIds = new Set((route.nodes ?? []).map((item) => item.id))
  let nodeId = ""
  do {
    nodeId = `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  } while (existingIds.has(nodeId))
  return nodeId
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
  const maxDepth = Math.max(0, nodes.length - 1)
  while (queue.length > 0) {
    const item = queue.shift()
    if (!item?.id) continue
    const previous = depths.get(item.id)
    const nextDepth = Math.min(item.depth, maxDepth)
    if (previous !== undefined && previous >= nextDepth) continue
    depths.set(item.id, nextDepth)
    const node = nodeById.get(item.id)
    if (!node) continue
    for (const childId of collectNextNodeIds(node)) {
      if (nextDepth < maxDepth) queue.push({ id: childId, depth: nextDepth + 1 })
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
