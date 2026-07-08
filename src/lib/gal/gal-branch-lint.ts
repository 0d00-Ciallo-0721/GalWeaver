/**
 * Galgame 分支合法性检查器
 *
 * 对线路的节点图进行静态分析，检测断线、不可达结局、变量冲突等问题。
 * 规则引擎先行（免费、快速），可选 LLM 二次验证。
 *
 * ponytail: 规则引擎覆盖 80% 场景，LLM 只做复杂判断。
 */

import { loadGalProject } from "./gal-storage"
import type {
  GalRoute,
  GalNode,
  GalVariable,
  BranchLintResult,
} from "./gal-types"
import { getNodeOutgoingTargets, hasNodeOutgoingTarget, normalizeGalRouteRelations } from "./gal-graph-normalize"

const legacyBranchCheckers = [
  checkBrokenChildren,
  checkChoiceTargets,
  checkEndingReachability,
  checkDeadEnds,
]
void legacyBranchCheckers

// ─── 主入口 ────────────────────────────────────────────────

export async function lintBranchGraph(
  projectPath: string,
  routeId: string,
): Promise<BranchLintResult[]> {
  const project = await loadGalProject(projectPath)
  if (!project) return []

  const rawRoute = project.routes.find((r) => r.id === routeId)
  if (!rawRoute) return []
  const route = normalizeGalRouteRelations(rawRoute)

  const results: BranchLintResult[] = []

  // 规则引擎检查（免费，按严重度排序）
  checkOrphanEntry(route, results)
  checkCanonicalBrokenChildren(route, results)
  checkCanonicalChoiceTargets(route, results)
  checkCanonicalEndingReachability(route, results)
  checkCanonicalDeadEnds(route, results)
  checkVariableBounds(route, project.variables, results)
  checkConditionImpossible(route, project.variables, results)
  checkMergeConflicts(route, results)

  return results
}

// ─── 检查1：无入口节点 ─────────────────────────────────────

function checkOrphanEntry(route: GalRoute, results: BranchLintResult[]): void {
  if (!route.entryNodeId) {
    results.push({
      severity: "blocking",
      type: "orphan_entry",
      routeId: route.id,
      message: `线路「${route.title}」没有设置入口节点`,
      detail: "每条线路必须有一个 entryNodeId 指向入口节点",
      suggestion: "请设置线路的 entryNodeId",
    })
    return
  }

  const entry = route.nodes.find((n) => n.id === route.entryNodeId)
  if (!entry) {
    results.push({
      severity: "blocking",
      type: "orphan_entry",
      routeId: route.id,
      message: `线路「${route.title}」的入口节点 ${route.entryNodeId} 不存在`,
      detail: "entryNodeId 指向一个不存在的节点",
      suggestion: "请检查入口节点 ID 是否正确",
    })
  }
}

// ─── 检查2：子节点断开 ─────────────────────────────────────

function checkBrokenChildren(route: GalRoute, results: BranchLintResult[]): void {
  const nodeMap = new Map(route.nodes.map((n) => [n.id, n]))

  // 检查 choices.nextNodeId 指向不存在的节点
  for (const node of route.nodes) {
    for (const choice of node.choices) {
      if (choice.nextNodeId && !nodeMap.has(choice.nextNodeId)) {
        results.push({
          severity: "high",
          type: "broken_child",
          nodeId: node.id,
          routeId: route.id,
          message: `节点「${node.title}」的选项「${choice.text}」指向不存在的节点 ${choice.nextNodeId}`,
          detail: "选项指定的 nextNodeId 在路由中不存在",
          suggestion: "请检查选项的目标节点 ID",
        })
      }
    }
  }

  // 检查 children 数组中引用了不存在的节点
  for (const node of route.nodes) {
    for (const childId of node.children) {
      if (!nodeMap.has(childId)) {
        results.push({
          severity: "high",
          type: "broken_child",
          nodeId: node.id,
          routeId: route.id,
          message: `节点「${node.title}」的 children 引用了不存在的节点 ${childId}`,
          detail: "children 数组包含不存在的节点 ID",
          suggestion: "请移除无效的子节点引用",
        })
      }
    }
  }
}

// ─── 检查3：选项目标缺失 ──────────────────────────────────

function checkChoiceTargets(route: GalRoute, results: BranchLintResult[]): void {
  for (const node of route.nodes) {
    // choice 类型节点必须有选项
    if (node.type === "choice" && node.choices.length === 0) {
      results.push({
        severity: "high",
        type: "choice_target_missing",
        nodeId: node.id,
        routeId: route.id,
        message: `选择节点「${node.title}」没有定义任何选项`,
        detail: "choice 类型节点必须包含至少一个选项",
        suggestion: "请为该节点添加选项",
      })
    }
  }
}

// ─── 检查4：结局可达性 ─────────────────────────────────────

function checkEndingReachability(
  route: GalRoute,
  results: BranchLintResult[],
): void {
  if (route.endingNodeIds.length === 0) {
    results.push({
      severity: "medium",
      type: "ending_unreachable",
      routeId: route.id,
      message: `线路「${route.title}」没有定义结局节点`,
      detail: "每条线路应至少有一个结局节点",
      suggestion: "请添加 ending 类型节点，并将其 ID 加入 endingNodeIds",
    })
    return
  }

  const nodeMap = new Map(route.nodes.map((n) => [n.id, n]))
  const entryId = route.entryNodeId
  if (!entryId || !nodeMap.has(entryId)) return

  // BFS 从入口找到所有可达节点
  const reachable = bfsReachable(nodeMap, entryId)

  for (const endingId of route.endingNodeIds) {
    if (!reachable.has(endingId)) {
      const ending = nodeMap.get(endingId)
      results.push({
        severity: "blocking",
        type: "ending_unreachable",
        nodeId: endingId,
        routeId: route.id,
        message: `结局节点「${ending?.title || endingId}」无法从入口到达`,
        detail: "从入口节点出发 BFS 无法到达该结局节点",
        suggestion: "请检查是否有断开的边",
      })
    }
  }
}

// ─── 检查5：死胡同（非结局节点无子节点）─────────────────────

function checkDeadEnds(
  route: GalRoute,
  _variables: GalVariable[],
  results: BranchLintResult[],
): void {
  for (const node of route.nodes) {
    if (node.type === "ending") continue
    if (
      node.children.length === 0 &&
      node.choices.every((c) => !c.nextNodeId)
    ) {
      results.push({
        severity: "medium",
        type: "dead_end",
        nodeId: node.id,
        routeId: route.id,
        message: `节点「${node.title}」是非结局节点但没有子节点或选项出口`,
        detail: "非结局节点必须有至少一个子节点或选项指向其他节点",
        suggestion: "请添加子节点或将该节点标记为 ending 类型",
      })
    }
  }
}

// ─── 检查6：变量越界 ───────────────────────────────────────

function checkVariableBounds(
  route: GalRoute,
  variables: GalVariable[],
  results: BranchLintResult[],
): void {
  const varMap = new Map(variables.map((v) => [v.id, v]))

  for (const node of route.nodes) {
    for (const choice of node.choices) {
      for (const eff of choice.effects) {
        const def = varMap.get(eff.variable)
        if (!def) continue
        if (def.type !== "intimacy" && def.type !== "love") continue

        const numVal = Number(eff.value)
        if (isNaN(numVal)) continue

        // 检查 add 操作后是否越界
        if (eff.op === "add") {
          const current = Number(node.incomingState?.variables?.[eff.variable] ?? def.defaultValue ?? 0)
          const newVal = current + numVal
          if (def.max !== undefined && newVal > def.max) {
            results.push({
              severity: "medium",
              type: "variable_out_of_range",
              nodeId: node.id,
              routeId: route.id,
              message: `节点「${node.title}」中变量 ${eff.variable} 的 add 操作可能导致值 ${newVal} 超过上限 ${def.max}`,
              detail: `当前值=${current}，add=${numVal}，预计=${newVal}，上限=${def.max}`,
              suggestion: `请调整 effect 值或添加条件限制`,
            })
          }
          if (def.min !== undefined && newVal < def.min) {
            results.push({
              severity: "medium",
              type: "variable_out_of_range",
              nodeId: node.id,
              routeId: route.id,
              message: `节点「${node.title}」中变量 ${eff.variable} 的 add 操作可能导致值 ${newVal} 低于下限 ${def.min}`,
              detail: `当前值=${current}，add=${numVal}，预计=${newVal}，下限=${def.min}`,
              suggestion: `请调整 effect 值`,
            })
          }
        }

        // 检查 set 操作是否直接越界
        if (eff.op === "set") {
          if (def.max !== undefined && numVal > def.max) {
            results.push({
              severity: "medium",
              type: "variable_out_of_range",
              nodeId: node.id,
              routeId: route.id,
              message: `节点「${node.title}」中变量 ${eff.variable} 被设为 ${numVal}，超过上限 ${def.max}`,
              detail: `set=${numVal}，上限=${def.max}`,
              suggestion: "请调整设置值",
            })
          }
        }
      }
    }
  }
}

// ─── 检查7：不可能满足的条件 ───────────────────────────────

function checkConditionImpossible(
  route: GalRoute,
  variables: GalVariable[],
  results: BranchLintResult[],
): void {
  const varMap = new Map(variables.map((v) => [v.id, v]))

  for (const node of route.nodes) {
    for (const choice of node.choices) {
      if (!choice.condition || choice.condition.length === 0) continue

      for (const cond of choice.condition) {
        const def = varMap.get(cond.variable)
        if (!def) continue

        // 检查条件值是否永远无法达到
        if (def.type === "intimacy" || def.type === "love") {
          const condVal = Number(cond.value)
          if (isNaN(condVal)) continue

          if (def.max !== undefined && condVal > def.max) {
            results.push({
              severity: "blocking",
              type: "condition_impossible",
              nodeId: node.id,
              routeId: route.id,
              message: `节点「${node.title}」的选项「${choice.text}」条件要求 ${cond.variable} ${cond.op} ${condVal}，但该变量最大值为 ${def.max}`,
              detail: "条件值超过变量的最大值，永远不可能满足",
              suggestion: "请修正条件或调整变量的 max 值",
            })
          }
        }
      }
    }
  }
}

// ─── 检查8：共同节点合流冲突 ──────────────────────────────

function checkMergeConflicts(
  route: GalRoute,
  results: BranchLintResult[],
): void {
  const nodeMap = new Map(route.nodes.map((n) => [n.id, n]))

  for (const node of route.nodes) {
    // 共同节点：有多个 parent
    if (node.parents.length <= 1) continue

    // 检查各父节点的 outgoingState 是否有冲突的变量
    const parentStates = node.parents
      .map((pid) => nodeMap.get(pid)?.outgoingState)
      .filter(Boolean)

    if (parentStates.length < 2) continue

    // 比较各父节点的变量值，找出差异大的
    const allVarKeys = new Set<string>()
    for (const state of parentStates) {
      for (const key of Object.keys(state!.variables)) {
        allVarKeys.add(key)
      }
    }

    for (const key of allVarKeys) {
      const values = parentStates.map((s) => s!.variables[key])
      const uniqueValues = new Set(values.map((v) => JSON.stringify(v)))

      if (uniqueValues.size > 1) {
        results.push({
          severity: "medium",
          type: "merge_conflict",
          nodeId: node.id,
          routeId: route.id,
          message: `共同节点「${node.title}」的多个父节点对变量 ${key} 有不同值：${Array.from(uniqueValues).join(" vs ")}`,
          detail: "共同节点合并时可能存在状态不一致",
          suggestion: "考虑添加 normalizeEffects 来统一状态，或确保各分支在汇合前状态一致",
        })
      }
    }
  }
}

// ─── BFS 辅助 ──────────────────────────────────────────────

function bfsReachable(
  nodeMap: Map<string, GalNode>,
  startId: string,
): Set<string> {
  const visited = new Set<string>()
  const queue = [startId]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)

    const node = nodeMap.get(current)
    if (!node) continue

    // 通过 children 扩展
    for (const childId of node.children) {
      if (!visited.has(childId)) queue.push(childId)
    }

    // 通过 choices.nextNodeId 扩展
    for (const choice of node.choices) {
      if (choice.nextNodeId && !visited.has(choice.nextNodeId)) {
        queue.push(choice.nextNodeId)
      }
    }
  }

  return visited
}

function checkCanonicalBrokenChildren(route: GalRoute, results: BranchLintResult[]): void {
  const nodeMap = new Map(route.nodes.map((node) => [node.id, node]))

  for (const node of route.nodes) {
    for (const choice of node.choices ?? []) {
      if (!choice.nextNodeId) continue
      if (nodeMap.has(choice.nextNodeId)) continue
      results.push({
        severity: "high",
        type: "broken_child",
        nodeId: node.id,
        routeId: route.id,
        message: `节点「${node.title}」的选项「${choice.text || choice.id}」连接了不存在的节点`,
        detail: `选项 nextNodeId=${choice.nextNodeId} 在当前路线节点列表中不存在。`,
        suggestion: "重新连接该选项，或删除无效的目标节点 ID。",
      })
    }

    for (const childId of node.children ?? []) {
      if (nodeMap.has(childId)) continue
      results.push({
        severity: "high",
        type: "broken_child",
        nodeId: node.id,
        routeId: route.id,
        message: `节点「${node.title}」的默认出口连接了不存在的节点`,
        detail: `children 包含不存在的节点 ID：${childId}。`,
        suggestion: "解除该默认出口，或重新连接到真实节点。",
      })
    }

    for (const target of getNodeOutgoingTargets(node, nodeMap)) {
      const child = nodeMap.get(target.targetId)
      if (!child || (child.parents ?? []).includes(node.id)) continue
      results.push({
        severity: "low",
        type: "broken_child",
        nodeId: node.id,
        routeId: route.id,
        message: `节点「${node.title}」连接到「${child.title}」，但目标节点 parents 未记录该父节点`,
        detail: "出口关系和反向 parents 缓存不一致。保存项目时会自动规范化。",
        suggestion: "保存当前 Gal 项目以刷新关系缓存。",
      })
    }
  }
}

function checkCanonicalChoiceTargets(route: GalRoute, results: BranchLintResult[]): void {
  for (const node of route.nodes) {
    if (node.type === "choice" && (node.choices ?? []).length === 0) {
      results.push({
        severity: "high",
        type: "choice_target_missing",
        nodeId: node.id,
        routeId: route.id,
        message: `选择节点「${node.title}」没有定义任何选项`,
        detail: "choice 类型节点至少需要一个选项，或改成普通/结局节点。",
        suggestion: "为该节点添加选项，或调整节点类型。",
      })
    }

    for (const choice of node.choices ?? []) {
      if (choice.nextNodeId) continue
      results.push({
        severity: "low",
        type: "choice_target_missing",
        nodeId: node.id,
        routeId: route.id,
        message: `节点「${node.title}」的选项「${choice.text || choice.id}」尚未连接目标节点`,
        detail: "该选项存在于详情页，但没有 nextNodeId；它不会在画布上生成选项连线。",
        suggestion: "如果它需要成为分支，请使用 AI 展开、手动展开或收束到已有节点；如果只是文案占位，可以暂时忽略。",
      })
    }
  }
}

function checkCanonicalEndingReachability(route: GalRoute, results: BranchLintResult[]): void {
  const nodeMap = new Map(route.nodes.map((node) => [node.id, node]))
  const endingIds = Array.from(new Set([
    ...(route.endingNodeIds ?? []),
    ...route.nodes.filter((node) => node.type === "ending").map((node) => node.id),
  ])).filter((id) => nodeMap.has(id))

  if (endingIds.length === 0) {
    results.push({
      severity: "medium",
      type: "ending_unreachable",
      routeId: route.id,
      message: `线路「${route.title}」没有定义结局节点`,
      detail: "当前路线没有 type=ending 的节点，也没有有效 endingNodeIds。",
      suggestion: "将一个终点节点标记为 ending，或把它加入 endingNodeIds。",
    })
    return
  }

  const entryId = route.entryNodeId
  if (!entryId || !nodeMap.has(entryId)) return
  const reachable = bfsReachableByCanonicalTargets(nodeMap, entryId)

  for (const endingId of endingIds) {
    if (reachable.has(endingId)) continue
    const ending = nodeMap.get(endingId)
    results.push({
      severity: "blocking",
      type: "ending_unreachable",
      nodeId: endingId,
      routeId: route.id,
      message: `结局节点「${ending?.title || endingId}」无法从入口到达`,
      detail: "从入口节点按选项出口和默认出口遍历时，无法到达该结局节点。",
      suggestion: "检查中间节点是否缺少连接，或重新连接到该结局节点。",
    })
  }
}

function checkCanonicalDeadEnds(route: GalRoute, results: BranchLintResult[]): void {
  const nodeMap = new Map(route.nodes.map((node) => [node.id, node]))

  for (const node of route.nodes) {
    if (node.type === "ending") continue
    if (hasNodeOutgoingTarget(node, nodeMap)) continue
    const hasChoices = (node.choices ?? []).length > 0
    results.push({
      severity: "medium",
      type: "dead_end",
      nodeId: node.id,
      routeId: route.id,
      message: hasChoices
        ? `节点「${node.title}」有选项，但没有任何有效出口`
        : `节点「${node.title}」是非结局节点但没有出口`,
      detail: hasChoices
        ? "该节点存在选项，但所有选项都未连接目标节点，且没有默认出口。"
        : "普通节点需要至少一个有效选项出口或默认出口；结局节点可以没有出口。",
      suggestion: "连接一个后续节点，或将该节点标记为 ending。",
    })
  }
}

function bfsReachableByCanonicalTargets(
  nodeMap: Map<string, GalNode>,
  startId: string,
): Set<string> {
  const visited = new Set<string>()
  const queue = [startId]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || visited.has(current)) continue
    visited.add(current)

    const node = nodeMap.get(current)
    if (!node) continue
    for (const target of getNodeOutgoingTargets(node, nodeMap)) {
      if (!visited.has(target.targetId)) queue.push(target.targetId)
    }
  }

  return visited
}
