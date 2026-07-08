/**
 * Galgame 工具函数
 *
 * ponytail: 一个文件，够用。
 */

import type { GalProject } from "@/lib/gal/gal-types"

export function isEmptyProject(project: GalProject | null): boolean {
  return !project || !Array.isArray(project.routes) || project.routes.length === 0
}

export function getNodeTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    entry: "入口",
    daily: "日常",
    choice: "选择",
    common: "共同",
    clue: "线索",
    cg: "CG",
    ending: "结局",
  }
  return labels[type] || `未归类(${type})`
}

export function getNodeStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    card: "卡片",
    draft: "草稿",
    final: "终稿",
  }
  return labels[status] || status
}

export function getNodeTypeColor(type: string): string {
  const colors: Record<string, string> = {
    entry: "text-emerald-500",
    daily: "text-blue-500",
    choice: "text-amber-500",
    common: "text-purple-500",
    clue: "text-violet-500",
    cg: "text-pink-500",
    ending: "text-red-500",
  }
  return colors[type] || "text-blue-500"
}
