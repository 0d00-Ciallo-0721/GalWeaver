# GalWeaver (织梦) — AI 驱动的 Galgame 剧本生成器

<p align="center">
  <b>基于 <a href="https://github.com/Mochocyang/QMAI">QMAI (青幕AI写作)</a> 魔改的 Galgame 视觉小说专用写作工具</b>
</p>

---

## 项目定位

GalWeaver 不是通用的 AI 写作工具。它是专门为 **多线路分支 Galgame 视觉小说** 设计的剧本生成系统。

核心理念：**从项目大纲/灵魂文档/角色记忆中提取上下文 → AI 按线路生成节点剧本 → 选项展开子节点 → 分支检查保证完整性**

与原始 QMAI 的区别：QMAI 面向长篇连载小说（章节目录 + 续写模式），GalWeaver 将其改造为线路节点图编辑器（线路树 + 节点卡片 + 选项展开 + 分支 Lint）。

---

## 核心功能

- **线路节点树**：7 条主线路 + 真结局线，每条线路独立节点图
- **上下文注入**：AI 写作时自动注入项目大纲、灵魂文档、角色状态、时间线、伏笔
- **选项展开**：从节点末尾选项生成子节点卡片，逐节点写作不污染上下文
- **分支检查**：8 项规则引擎检测断线、不可达结局、变量越界、合流冲突
- **变量系统**：亲密度/恋爱度/Flag 追踪，每个节点独立 incomingState/outgoingState

---

## 魔改内容

| 模块 | 原 QMAI | GalWeaver |
|------|---------|-----------|
| 写作单元 | 章节 (Chapter) | 节点 (Node) |
| 组织结构 | 卷 (Volume) | 线路 (Route) |
| 续写方式 | 下一章续写 | 选项展开子节点 |
| 上下文窗口 | 最近 N 章 | 路径祖先节点 |
| 审查系统 | 17 维章节审查 | 分支合法性检查 |
| 图谱节点 | 13 种小说类型 | +8 种 Gal 专用类型 |
| 文件存储 | `.novel/` | `.gal/` |
| 自动更新 | GitHub Releases | 已移除 |

---

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | Tauri 2 |
| 前端 | React 19 + TypeScript + Vite 8 |
| 样式 | Tailwind CSS 4 |
| 状态管理 | Zustand 5 |
| 图谱渲染 | Sigma.js 3 + Graphology |
| 后端 | Rust |
| 向量存储 | LanceDB |

---

## 快速启动

```powershell
# 双击 start.bat 或
.\start.bat
```

首次启动会自动安装依赖并进行 TypeScript 类型检查。

---

## 项目结构

```
src/
  lib/gal/                   # Galgame 核心模块
    gal-types.ts             # 全部类型定义
    gal-storage.ts           # .gal/ 目录读写
    gal-project-init.ts      # 项目初始化
    gal-prompts.ts           # LLM 提示词
    gal-context-engine.ts    # 上下文引擎
    gal-node-generation.ts   # 节点正文生成
    gal-node-ingest.ts       # 节点记忆摄取
    gal-branch-lint.ts       # 分支检查
    gal-task-router.ts       # 意图路由
    gal-graph-adapter.ts     # 图谱适配
  components/gal/            # UI 组件
  stores/gal-store.ts        # Zustand 状态管理
```

---

## 致谢

- 原始项目：[QMAI (青幕AI写作)](https://github.com/Mochocyang/QMAI) — 面向长篇小说的记忆型 AI 写作桌面系统
- 灵感来源：[webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer)
- UI 框架：[LLM Wiki](https://github.com/nashsu/llm_wiki)
- 角色灵魂设计：[女娲.skill](https://github.com/alchaincyf/nuwa-skill)

---

## 许可

基于原始项目 [MIT License](https://github.com/Mochocyang/QMAI) 魔改，本仓库继承相同许可。
