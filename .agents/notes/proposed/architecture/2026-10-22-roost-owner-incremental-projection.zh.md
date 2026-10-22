# Lody Roost owner 的增量投影

Status: proposed
Translation: current

[English](2026-10-22-roost-owner-incremental-projection.md)

## 摘要

长会话实测表明，Lody 的 Roost 接入在很小的 Native 增量操作前后仍然处理整条消息。
本地 CPU 诊断定位到反复 JSON 编解码，包括转换窗口中未变化的正文，以及为了建立
身份索引而转换最终被丢弃的正文。首步实现已在保留权威读取的条件下消除重复转换，
四组真实 Native 回归在 v8、v9 候选上均为 107 项通过。按已提交增量更新内存投影和
尾部窗口仍是后续方案；首步不能证明长会话性能目标已经完成。

## 证据与边界

同机 Linux 长会话对照记录在 [Roost #22](https://github.com/loro-dev/roost/pull/22)。
其中 v8/v9 使用同一份 Lody 运行时源码，不能用于归因此前每一个 Lody 优化的影响。
Lody 的 cf1ee8dcbd / PR #1329 已经包含当前消息复制、提交后整条正文回读及窗口重载；
a4de9a264 / PR #1626 新增的增量写入路径仍沿用刷新。这只能确定这些具体操作的来源，
不能证明全部历史改动都没有引入其他回退。

本地 Mac 新诊断调用真实 Lody backend 和 v9 Native addon，执行 1000 次独立 1 KiB
低重复度追加，保留 16 KiB 工具结果，SQLite WAL/FULL，每次操作等待持久化。
V8 采样覆盖写入阶段的主线程；关闭交错的 readChanges，以区分消费者读取。
保留完整内容及凭据重试断言。这是定位实验，不是优化前后对照，也没有采样 Rust worker。

该轮 21.17 秒采样时间中，Roost JSON 编解码代码自身占 10.44 秒，约占全部采样的
49.3%，或排除 idle/program 后的 65.9%。包含子栈的分组有重叠，不能相加。
此前纯 Native 微测不含 Lody 的凭据、控制文档与投影工作，不能据此判断完整链路性能。
合成 profile 与临时 harness 保存在仓库外现有 packed-storage 研究产物目录。

第二组诊断包含 50 轮 / 100 条消息、200 次追加，每条 assistant 有 16 KiB 工具结果。
编解码自身占 11.71 秒中的 2.51 秒，排除 idle/program 后占 42.4%。两组都校验完整业务
内容与凭据重试，并在新进程重开后验证完整 digest 一致。它们定位了可避免的工作，
没有测出其中能消除的比例，也没有将新实现与 Loro 对照。整条复制确实存在，但不能
依据这些 profile 把它称作最大的 CPU 开销。

更正此前验证归因：为整个 workspace 设置 NAPI_RS_NATIVE_LIBRARY_PATH 也会覆盖其他
napi-rs 依赖，导致 Rolldown 加载 Roost 二进制后报告 Class extends undefined、Oxlint
报告 lint is not a function。此前 site-docs 的失败不能证明仓库另有缺陷。
完整 workspace 验证改为仅在隔离的候选 Native 包旁放置二进制，清除全局覆盖后运行；
不修改共享 pnpm store 或仓库中的依赖版本。单独的 Native 测试命令可以显式指定
匹配的候选二进制。

## 待评估的改动

1. rebuildSegmentIndexes 直接用 businessId/segmentId 构造 key。当前先调用
   adaptRoostProjectedMessage 转换、校验正文，却丢弃正文。在 refreshTurnProjections
   中保留未变的行投影，只转换变化行。保留现有 Native 回读、凭据、边界验证与发布顺序。
2. 对本地未封口消息的编辑，暂存私有投影增量，只在 Native 返回的事件区间和所有权
   证据证明这次事务完整成功时安装。现有 expectedEventCursor/expectedIndexes、提交
   元数据和 generation 防护提供相关能力。回复丢失、外部修改、待应用远端工作或
   generation 不确定时必须权威重建；只有凭据存在不等于可以直接更新缓存。
3. 普通尾部追加直接推进有界窗口，避免再次加载未变正文。分支状态、逻辑总数与分页
   游标仍归 SDK；现有 mutation result 不足以安全推进时扩展 Roost TypeScript helper，
   不在 Lody 复制其私有分支格式。
4. 由语义 reducer 输出增量并共享未变结构，消除常见流式更新中的整条复制与 diff。
   保留跨片段 thinking/plan 标记、文本规范化、工具更新和 Unicode scalar 偏移语义。
   把每个原始通知直接当 appendText 会改变现有行为。

第一步只需改 Lody。后续可能需要调整 Roost TypeScript API；现有证据不要求重写 Rust
存储或 wire format。不增加旧格式读取器、迁移、凭据裁剪、延迟持久化或减弱签名与 seal
检查。不能为了 benchmark 关闭公共无损 JSON 验证。

## 所有权与实施验收

首个实施 PR 从 packed-storage-contract 分出，仅消除 Lody 的重复投影工作：建立身份
索引时不转换正文、保留未变的已解码行、为精确匹配当前物理行的 primary 复用已经验证
的解码内容来计算 patch。保留 Native 权威刷新及全部事务、发布与恢复检查。用真实
backend 验证调用者隔离与同会话交错修改，再以相同持久化合成负载和未修改基线对照。
提交后安装增量及 SDK 拥有的增量尾部追加留作单独范围，先测量此步骤；首步不声称
流式成本恒定，也不代表已经完成长会话性能目标。

触发来自 owner 的串行修改或外部观察。当前 owner 持有原始 Native 请求直到实际完成；
调用者取消不能证明不确定提交可以重发。只安装已提交状态，在对应投影就绪后推进
revision/checkpoint；所有权或覆盖区间不明确时失效并重建。恢复应保留可用性及原有
close/flush 行为。本方案不迁移生命周期：剩余 Session/Promise 消费者不能在小范围内
完成一个独立原生 Effect 单元，且迁移不直接消除重复投影工作。

扩展真实 backend 测试，覆盖 Unicode/拆分标记、混合工具、无变化/重复/冲突通知、
回复丢失、并发 Native 写入、待应用远端工作、seal/状态修订、分支变化、分页边界、
重开及调用者不能修改内部缓存。以未改的语义 reducer 为对照，不能用重复实现的简化
算法充当正确性依据。[原子元数据决策](../../implemented/architecture/2026-10-21-roost-atomic-commit-metadata.zh.md)
继续拥有持久化与发布门槛。

性能验收需要前后配对和相同内容、相同持久化边界的 Loro 对照。分别扩大总历史、当前
回复长度和窗口，测量打开尾部、追加、新增消息、分页、CPU 与 RSS。长压测留在普通 CI
之外。不能由本轮 profile 承诺数量级收益。本次仅改变 Lody 的重复投影转换，Native
存储、依赖版本、部署与已有数据库均未改变。

## 首步实现结果

最终实现按精确物理消息对象复用行，在异步刷新前保存对应的解码窗口；解码内容快捷
路径也比较完整 business/segment 身份。提交后仍由 Native 返回变化消息的权威正文，
未移除事务、签名、凭据、发布或持久化检查。新增真实 backend 回归会修改对外副本、
重试 Unicode 通知、通过 peer 修订已封口旧行，再追加并在新 owner 打开后比较完整历史。

Linux 对照的两个 Lody 版本使用同一 v9 addon，WAL/FULL，每次操作等待持久化。
多消息负载为 100 轮 / 200 条 / 2000 次追加，可见 JSON 2,220,771 B；单回复为
1000 次 1 KiB 追加，可见 JSON 1,041,086 B，每条 assistant 保留 16 KiB 工具结果。
表中为两次修改前、两次最终源码修改后的中位数，Loro 参照为一次。收紧快照匹配后复用
已完成的原始基线，最终执行顺序不是严格交替。初版候选数据单独保留，未混入结果。

| 指标 | 修改前 | 复用投影后 | 同内容 Loro |
| --- | ---: | ---: | ---: |
| 多消息追加 p95 | 37.31 ms | 30.01 ms | 3.86 ms |
| 多消息追加总耗时 | 61.10 s | 48.97 s | 5.07 s |
| 多消息追加 CPU | 43.70 s | 29.86 s | 2.39 s |
| 多消息新增消息 p95 | 341.61 ms | 332.65 ms | 4.56 ms |
| 单回复追加 p95 | 131.45 ms | 110.30 ms | 12.30 ms |
| 单回复追加总耗时 | 75.67 s | 64.69 s | 7.80 s |
| 单回复追加 CPU | 68.43 s | 57.16 s | 6.73 s |

追加 p95 改善约 19.6% / 16.1%，追加 CPU 改善约 31.7% / 16.5%。有实际收益，尚未达到
原性能目标。新增消息成本仍主要来自未改的重载路径，增长中的完整回复仍会回读并处理。
不能声称存储收益：存储路径和格式未变，少量数据库大小差异含随机身份及压缩变化。
整 worker RSS 采样不等于 Roost 独占内存，也不作为独立的内存优化结论。

十组 write/reopen/paging 均通过，规范化消息内容 digest 在三种 backend 间一致，重开
完整历史 digest 与写入结果一致；每个 Roost 版本 202 次重试未重复内容。18 个 SQLite
数据库 quick_check 通过，两个 Roost 版本均为 container 9。研究源码已恢复，临时
benchmark 已移出普通 suite；原始样本、最终源码 hash 与恢复记录保存在仓库外
owner-projection-optimization 研究产物目录。

首轮读取的分页尾部耗时有波动。三对额外交替读取的 12 个进程检查均通过，但逐轮分页
p95 的中位数为 86.07 -> 94.35 ms，不能直接声称无回退。再做 8 次交叉读取，让两版
源码各自读同一份库：基线库的分页总耗时中位数为 764.63 -> 763.29 ms，候选库为
802.79 -> 860.02 ms。逐对差异会反向，区间明显重叠，未定位到一致的源码变慢方向；
少量波动样本也不能证明所有读取路径均无回退。两轮调查后均恢复源码、移除临时测试。

最终验证：两种候选布局均通过四个 owning suite（107 项），CLI typecheck 和定向
type-aware lint 通过（72 个既有 warnings），root format 通过，docs check 为
0 errors / 71 个既有 warnings。完整 pnpm check 在清除通用 Native 覆盖、正确装配
隔离候选包及 split host binding 后通过；其 6 项打包测试也通过。最初误用不匹配的
addon、全 workspace 覆盖或不完整私有包的尝试不作为通过证据。父 PR 仍须协调发布
Native；候选链接的本地检查通过不能替代正式注册表包的 CI。
