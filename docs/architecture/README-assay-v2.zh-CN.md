# Assay 工作区拆分与 Source 复用设计索引

## 当前结论

当前推荐方案是 **V2：同形工作区 + Source Reference**。

- 不把工作区声明成 `study` 或 `build` 类型；所有 Assay 工作区使用同一形状、同一组命令。
- “Study”与“Build”只描述某个工作区当前主要承担的用途，不成为 manifest 中的持久化身份。
- 大型 Source 保留在最初拥有它的工作区中，该目录就是该 Source 的 **home**。
- 其他工作区在自己的 `sources/<local-alias>/` 下创建一个极薄的 `source.ref.yaml`，引用另一个 Assay 工作区中的 Source。
- 当前工作区继续拥有自己的 Task、System、Analysis、Knowledge、Spec、Roadmap 与 Adoption；不会因为 Source 来自别处而把这些对象自动路由到另一个工作区。
- 所谓“聚合”不再是一个需要保存的第三种对象：当前工作区加上它所引用的 Source homes，就是用户实际使用的 Assay 视图。

## 文档

1. [`design-history/stable-source-home-v1.zh-CN.md`](design-history/stable-source-home-v1.zh-CN.md)  
   第一轮收敛方案：稳定 Source Home、轻量 System 作用域、Task 物理分组。

2. [`design-history/study-build-split-v1.zh-CN.md`](design-history/study-build-split-v1.zh-CN.md)  
   第二轮方案：显式 Study / Build 工作区类型与单向组合。

3. [`source-reference-v2.zh-CN.md`](source-reference-v2.zh-CN.md)  
   当前推荐的 V2 完整设计。

4. [`source-reference-v2-scenarios.zh-CN.md`](source-reference-v2-scenarios.zh-CN.md)  
   对常见使用情形、故障与“别扭点”的逐项模拟。

5. [`source-reference-v2-amendments.zh-CN.md`](source-reference-v2-amendments.zh-CN.md)  
   已采纳的修订（2026-08-27）：移除“只有不可变才可共享”原则，改为单一 mutation 权威；证据强度分层；全局 clone registry 缓存；审计腔改写清单。修订 §6.4，其余 V2 语义不变。

## 版本关系

```text
Workset / Source Store / Capsule
        ↓ 推翻：概念过多，制造新的上下文容器
稳定 Source Home V1
        ↓ 保留：Source 原地、引用关系、Task 可轻量分组
Study / Build Split V1
        ↓ 推翻：把内容倾向固化成工作区类型，路由和迁移语义过重
同形工作区 + Source Reference V2
```

V2 不是折中地把 V1 和 Study/Build 各留一半，而是重新确定最小模型：

> **工作区不分型；Source 分“拥有”与“引用”；其他对象永远留在当前工作区。**
