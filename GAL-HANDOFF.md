# QMAI Gal 创作台交接文档

更新时间：2026-06-28

## 当前结论

Gal 创作台现在按这个模型实现：

- **主线路**是唯一的总节点集合，保存所有 Gal 节点。
- **自定义线路**不是独立节点树，只是基于主线路节点 id 组成的一条路径。
- 自定义线路只能用于查看单条走向，不能修改主线路节点。
- 只有主线路页面才能进入节点详情，执行编辑、生成、AI 展开、手动展开、删除节点。
- 自定义线路可以新增、删除、重命名、从当前路径末尾选择已有后续节点加入路径、退一步移除路径末尾节点。

最近一次验证：

```powershell
npm run typecheck
```

结果：通过。

## 启动与验证

开发启动：

```powershell
.\start.bat
```

`start.bat` 实际执行：

```bat
npm run tauri dev
```

常用验证：

```powershell
npm run typecheck
npm run build
```

不要把 API Key 写进交接文档。配置文件在用户本机 Tauri app state 中。

## 关键文件

Gal UI：

- `src/components/gal/gal-workspace.tsx`
- `src/components/gal/gal-route-tree.tsx`
- `src/components/gal/gal-route-board.tsx`
- `src/components/gal/gal-node-editor.tsx`
- `src/components/gal/gal-utils.ts`

Gal 数据与生成：

- `src/lib/gal/gal-types.ts`
- `src/lib/gal/gal-storage.ts`
- `src/lib/gal/gal-project-init.ts`
- `src/lib/gal/gal-prompts.ts`
- `src/lib/gal/gal-node-generation.ts`
- `src/lib/gal/gal-node-ingest.ts`
- `src/lib/gal/gal-context-engine.ts`
- `src/lib/gal/gal-branch-lint.ts`

状态：

- `src/stores/gal-store.ts`

小说上下文复用：

- `src/lib/novel/context-engine.ts`
- `src/lib/novel/revision-feedback.ts`

## 数据模型现状

`GalProject.routes` 中包含两类线路：

1. 主线路
   - `id === "main"` 优先识别为主线路。
   - 如果旧数据没有 `main`，读取时会把第一条线路视为主线路。
   - 主线路持有完整 `nodes`。

2. 自定义线路路径
   - `nodeIds?: string[]`
   - `nodes` 不作为真实节点源使用。
   - UI 通过 `nodeIds` 从主线路节点池投影出当前线路。

相关类型字段：

```ts
export interface GalRoute {
  id: string
  title: string
  theme: string
  nodeIds?: string[]
  entryNodeId: string
  endingNodeIds: string[]
  nodes: GalNode[]
}
```

## 当前功能细节

### 初始化

入口：`src/lib/gal/gal-project-init.ts`

当前初始化规则：

- 只生成一个主线路。
- 主线路 id 固定为 `main`。
- 主线路 title 固定为 `主线路`。
- 只生成一个入口/开头节点。
- 不再让 AI 初始化多条角色线、早安线、厨房线等。

初始化上下文：

- 使用小说写作上下文链路 `buildContextPack(..., { force: true })`。
- 会注入大纲、记忆、人物、设定等小说上下文。

### 左侧线路树

入口：`src/components/gal/gal-route-tree.tsx`

行为：

- 顶部 `+` 新增的是“线路路径”，不是节点。
- 主线路展示所有主线节点。
- 主线路节点点击后进入详情编辑。
- 自定义线路展示 `nodeIds` 对应的主线节点路径。
- 自定义线路节点点击不进入详情。
- 自定义线路支持：
  - 重命名
  - 删除路径
  - 从路径末尾选择已有后续节点加入路径
  - 退一步移除路径末尾节点

后续节点候选来源：

- 当前路径末尾节点的 `children`
- 当前路径末尾节点的 `choices[].nextNodeId`
- 候选必须已存在于主线路节点池中

### 路线画布

入口：`src/components/gal/gal-route-board.tsx`

行为：

- Arcweave 风格网格画布。
- 支持节点拖动，位置保存到 `localStorage`。
- 支持手型漫游模式。
- 主线路画布节点点击进入详情。
- 自定义线路画布节点点击不进入详情。

注意：

- 自定义线路画布展示的是投影出来的路径节点。
- 如果自定义线路路径只有入口节点，画布只显示入口。

### 节点编辑器

入口：`src/components/gal/gal-node-editor.tsx`

只应从主线路进入。

功能：

- 标题、目标、场景、人物编辑
- 选项手动新增、编辑、删除
- 正文生成
- 保存
- 保存并摄取
- 删除节点
- 分支检查
- AI 提示词编辑

选项展开：

- `AI 展开`：调用 AI 生成后续节点卡片，并连接当前选项。
- `手动展开`：创建一个空后续节点，并连接当前选项。

展开创建出来的节点：

- 永远写入主线路节点池。
- 如果当前选中了某条自定义线路路径，展开出的新节点 id 会追加到该路径的 `nodeIds`。

## 已修复问题

1. AI 生成报错 `content.trim is not a function`
   - 已在相关调用链做文本兼容处理。

2. 初始化上下文报错 `Cannot read properties of undefined (reading 'length')`
   - `revision-feedback.ts` 增加数组保护。
   - `context-engine.ts` 增加 Gal 初始化强制上下文模式。

3. 初始化后重启丢失
   - `gal-storage.ts` 中 `routes.json` 写入语句之前被注释吞掉。
   - 已恢复 `routes.json` 写入。

4. 初始化生成多条独立线路
   - `gal-project-init.ts` 强制只返回主线路和一个入口节点。
   - `gal-prompts.ts` 明确提示 AI 不能生成多条顶层线路。

5. 选项不可编辑
   - `gal-node-editor.tsx` 已支持选项新增、编辑、删除。

6. 节点删除
   - 主线路节点编辑器中支持删除节点。
   - 删除会断开父子关系、清理选项指向、删除正文文件。

7. 左侧线路模型误解
   - 已改为“主线路总树 + 自定义线路路径”。
   - 自定义线路不再持有独立节点集合。

## 当前剩余小问题/建议

1. **自定义线路路径体验还可以继续优化**
   - 目前通过下拉框选择“下一个主线节点”。
   - 更好的方式是做成可视化路径编辑器，显示每一步的选项来源。

2. **自定义线路重命名交互较基础**
   - 目前是左侧内联输入框。
   - 可以后续换成右键菜单或小弹窗。

3. **旧项目数据兼容**
   - 如果历史 `.gal` 已经生成过多条独立线路，读取层会把第一条/`main` 识别成主线路。
   - 历史自定义线路里的旧 `nodes` 不会自动迁移成 `nodeIds`。
   - 最干净的方式是重新初始化 Gal 项目，或手动整理 `.gal/routes.json` 和 `.gal/routes/*.json`。

4. **编码问题**
   - 之前部分 Gal 文件出现过中文乱码。
   - 已重写过 `gal-route-tree.tsx`、`gal-node-editor.tsx`、`gal-project-init.ts`、`gal-prompts.ts`。
   - 如果后续看到 `銆?`、`鍒?` 这类内容，优先检查文件是否又被错误编码写入。

5. **不建议继续全文件重写**
   - 后续小改动尽量局部改。
   - 这次全文件重写是因为文件已出现真实语法级编码损坏。

## 继续开发时的关键判断

如果要改“线路”，先确认：

- 是否在改主线路节点集合？
- 是否只是在改自定义线路 `nodeIds` 路径？

原则：

- 主线路才有节点 CRUD。
- 自定义线路只保存路径，不保存真实节点。
- 自定义线路不能新建节点。
- 自定义线路只能选择主线路中已经存在且与当前路径末尾有前后关系的节点。

如果要改“展开”，先确认：

- `AI 展开`：生成节点内容/卡片。
- `手动展开`：创建空节点。
- 两者都必须写入主线路节点池。
- 如果当前选中自定义线路，两者都可以顺手追加新节点 id 到该线路路径。

## 最近涉及的核心改动文件

- `src/components/gal/gal-route-tree.tsx`
- `src/components/gal/gal-node-editor.tsx`
- `src/components/gal/gal-workspace.tsx`
- `src/stores/gal-store.ts`
- `src/lib/gal/gal-types.ts`
- `src/lib/gal/gal-storage.ts`
- `src/lib/gal/gal-project-init.ts`
- `src/lib/gal/gal-prompts.ts`
- `src/lib/novel/context-engine.ts`
- `src/lib/novel/revision-feedback.ts`

## 最后验证记录

```powershell
npm run typecheck
```

通过。
