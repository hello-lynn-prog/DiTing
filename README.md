# DiTing 舆情 Agent

DiTing 是基于 DeepSeek Harness（dsh）原生 TypeScript SDK 的本机舆情研判控制台。前端沿用 `prototypes/diting-v5/dist`，业务后端由 TypeScript/Fastify/SQLite 提供；不需要启动 NewsNow、DailyHotApi 或 BettaFish HTTP 服务。

**当前全功能验收入口：[全功能验收与交付状态](docs/DiTing-全功能验收与交付状态-2026-10-21.md)。自动测试数量请以 `npm test` 当次结果为准；真实业务结果与模拟测试分开记录。最新热榜逐源状态和失败归因见[2026-10-23 热榜失败源诊断](docs/DiTing-热榜失败源诊断-2026-10-23.md)。**

**最新调查效率、独立情感模型和真实复测状态见 [独立情感与调查效率验收](docs/DiTing-独立情感与调查效率验收-2026-10-20.md)；视觉与登录情况见 [视觉取证与登录采样验收](docs/视觉取证与平台登录验收-2026-10-20.md)。此前日期化文档是历史快照。**

整体目标与分期见 [v6 规划](docs/DiTing-整体实施规划-v6-2026-10-18.md)。日期较早的审计、TS 实施和测试记录均是当时状态快照；2026-10-19 的研究恢复与供应商状态见[研究故障修复与验收记录](docs/DiTing-研究故障修复与验收-2026-10-19.md)，最新报告质量修订和待验收项见[产品完成度复核](docs/DiTing-产品完成度与待验收项-2026-10-19.md)。v5 zip 与原型文件作为视觉参考保留，真实页面通过 web 目录连接后端。

[测试与验收文档](docs/DiTing-测试与验收文档-2026-10-18.md) 是 10 月 18 日的测试快照，不代表当前测试数或实时业务状态。运行 `npm test` 获取当前结果；真实业务未验收项见最新日期化记录。原始结果在 `docs/test-results/`。

最新 BettaFish 原生能力移植对照与本轮业务验收记录见[完整 TypeScript 移植清单](docs/BettaFish-原生能力TS移植清单-v1-2026-10-19.md)和[业务验收记录](docs/业务验收记录-2026-10-19.md)。

## 启动

要求 Node.js 24 或更高版本（使用 Node 内置 `node:sqlite`；低于 24 不受支持）与已构建的本机 dsh 源码。dsh 路径通过 `DITING_DSH_ROOT` 配置，优先查找项目内 `vendor/deepseek-harness` 和相邻 `../deepseek-harness` 的已构建SDK；旧开发机路径仅在实际存在构建SDK时兼容。迁移机器时复制 `.env.example` 为 `.env` 并设置实际路径。也可在当前进程环境中设置该变量。运行时未启用或找不到 SDK 时，研究任务会等待配置，不会自动启动模型调用。

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm start
```

打开 `http://127.0.0.1:8090`。也可以运行 `scripts/start.ps1`。服务仅监听 loopback，定位为个人单机工具。

更新代码后，在项目目录的 PowerShell 终端运行 `& .\scripts\restart.ps1 -Background` 可构建并后台重启，终端关闭后服务继续运行；默认不带参数仍以前台运行，按 Ctrl+C 停止。脚本先核对 8090 的 Node 进程与本项目 `server.lock` 一致，并检查没有正在运行的研究任务，再构建；构建失败时保留原服务，端口由其他程序占用时拒绝停止。仅检查当前进程可加 `-CheckOnly`。本机执行策略若禁止自动化工具结束现有进程，仍需由你在自己的终端运行这条命令；不要删除服务锁或强行启动第二套后端。后台运行不等于开机自启或通过 24 小时稳定性验收。

数据默认保存在 `data/`。数据库、密钥、备份和导出属于业务数据；运行日志与诊断探针分别放在 `data/logs/`、`data/diagnostics/probes/`，不应当作研究数据打包。服务启动会将旧版根目录日志归档至 `data/logs/legacy/`，探针归档至 `data/diagnostics/probes/`；新的服务日志使用 JSONL，每日最多 3 个 5 MiB 文件，自动清理超过 14 天的滚动日志。`legacy/` 内历史日志不自动删除。首次升级旧数据库时程序先在 `data/backups/pre-ts-*` 建 SQLite 备份，再应用兼容迁移。备份时停止服务，至少保留 `diting.sqlite3` 与解密密钥 `master.key`；需要长期保留报告时另备份 `exports/`，通常无需打包 `logs/` 和诊断探针。不要提交 `.env`、`data/` 或真实凭据。

## 当前已实现

- TypeScript 持久 API、任务队列、独立会话、请求幂等、租约隔离、证据归档、审查门禁、报告存档与用量账本。
- dsh 官方 SDK 启动适配，Insight、Media、Query、ForumHost、Planner、Verifier、Advocate、Report 作为 dsh 原生子 Agent 配置；执行受到 runtime 开关、角色工具范围、任务预算与模型调用限制约束。
- Anthropic Messages 与 OpenAI Completions 两种模型协议；密钥以本机 AES-GCM 加密保存。GLM Anthropic 入口已完成一次真实 API 连通、DiTing 对话调用和 usage 记录验证。本机研究槽、关键词槽与费率已配置并启用；迁移机器仍须自行配置。失败调用无供应商用量时保留未知费用和预算预留。
- 按 v5 原版 27 个展示频道映射采集源，并含扩展入口，共 52 个内部 TypeScript 入口。2026-10-21 完整逐源实采 42 成功、10 失败；失败和原始快照如实归档；没有把同流多分类重复计算为独立信源。见 docs/热榜原型清单与源码迁入说明-2026-10-18.md 及当日业务验收记录。
- 可配置搜索供应商；DiTing 进程内完成公开网页的安全抓取、正文提取与归档，保存来源 URL、哈希和采集审计。外部 Firecrawl 只保留为显式选择的兼容选项，正常日报不依赖它。搜索摘要仅用于发现，不直接当作证据。
- 监测规则、同源热度跃升比较、信号与可选自动开题、通知 outbox；外部通知需另行配置并启用订阅。
- 自建报告 IR、真实样本统计、结构与数字校验、HTML/Markdown/PDF 导出；公共事件模板采用六章专题叙事骨架，保存逐章篇幅与正文深度编辑建议（不因长度重复重写），报告正文与文末来源目录分离。2026-10-21真实报告有33页、11个SVG资源，但正文约15.7k字符，低于约40k目标；时间窗标题也有偏差。它证明报告链路可成稿，不代表内容深度已达到BettaFish。
- dsh 原生 Skill 注册和读取：十个独立编写的工作指令，含版本化检索词库与本机历史相似检索；支持自定义 Markdown、角色授权、任务冻结版本、挂载与实际读取审计。配置入口为定制中心 → Skill。
- 普通问答/报告追问/明确研究指令分流；主题澄清保留先前时间窗和预算，不提前占用研究执行槽。
- 研究任务 → 资料与证据 → 平台样本与批次：分平台/类型分页查看、父帖关联、原文证据、精确批准范围、原始 JSON 响应与 SHA-256 下载；信源页独立显示平台取证状态，审批中心显示实际请求上限。
- 定制中心 → Key 与服务提供微博/B站扫码登录：点击后在本机 Microsoft Edge 打开平台登录页，登录后浏览器状态保存在 `data/browser_data/{weibo,bilibili}`，采集用 Cookie 另行加密入库且不回显；支持只读验证、按任务冻结版本与撤销。公开采集不携带 Cookie；使用登录态的范围和版本须重新审批。2026-10-21已完成一次主题样本验收：微博10帖+18条评论；B站本轮0条，因为批准的单页结果发布时间均晚于任务冻结截止时间，不是登录失败。
- v5 DOM/API 自动化验证及原 Python SQLite 基线迁移验证。

- 新任务逐段固定执行首轮查询/总结，再执行Insight三轮、Media/Query各两轮反思查询/总结；旧任务保留原先冻结的轮次契约；ForumHost 是并行旁路滚动回流，调查引擎不等待主持发言。补证有独立轮次。
- Insight 独立关键词模型、滚动主持回流、多模态素材发现和视觉观察；视觉实际输入帧、素材/帧哈希、原文引用与观察引文共同绑定，纳入任务预算、门禁、报告验证和追问上下文。
- 样本词频/词云、文本相似聚类、SWOT/PEST 富块均有结构与引用验证。报告词组聚类明确标注为确定性Jaccard方法；Insight候选语料抽样另有已实测的本地MiniLM/KMeans，两者用途与方法分开记录。

## 独立情感模型（本地 TypeScript 推理）

迁入 BettaFish 实际默认使用的五级多语言 DistilBERT 分类器 `tabularisai/multilingual-sentiment-analysis`，通过 Transformers.js / ONNX Runtime 在本机 CPU 执行。首次准备：

```powershell
npm run sentiment:setup
npm run sentiment:check
```

在“定制中心 → Agent 与引擎”启用并设置置信度阈值。默认阈值 0.5，低于阈值保留未知，中性不强制转正负；每条仅输入前 512 个分词 Token。推理不请求云端模型、不计云端 Token 费；模型文件约 541 MB，另需 CPU 和内存。原文哈希、固定模型版本、五类分数、任务关联和推理过程入库，重复文本可复用。五级统计进入认证底表和报告校验。分类结果仍需主题样本抽检，不能当作公众总体情绪。

固定 ONNX 转换来源、提交及逐文件 SHA256 由安装脚本核验，模型卡与权重单独适用其 CC-BY-NC-4.0 许可，见 THIRD_PARTY_NOTICES.md。此处迁入的是默认五级模型；历史 SVM、贝叶斯、BERT/GPT2 LoRA 训练代码与全部权重未宣称迁入。详见[本地情感与效率验收](docs/DiTing-独立情感与调查效率验收-2026-10-20.md)。

## 仍待完成的实际验收

- 真实研究已有跨主题报告与登录态平台样本，但仍缺固定配置、无人工干预的时长/费用基线，以及达到目标深度的多主题正文和复杂追问抽样。历史单次耗时与费用不能代替稳定性能结论。
- 52 个目录入口并非全部可用。2026-10-23 18:07逐源最新状态为44成功、8失败；Hacker News 官方 API 已在正式服务定向采集并入库20条，其余8源的拒绝、验证、证书和网络超时分别列在诊断文档。不绕过验证码或关闭证书校验。
- Bocha 充值后真实搜索已成功，Tavily 已配置；企业微信真实测试已被接口确认接收。飞书为可选通道。公开网页默认由 DiTing 内置正文提取读取；Firecrawl 外部接口仅用于显式兼容配置，动态渲染页面不能因此视为已由内置能力覆盖。历史失败保留在流水，不能据历史403判断当前Bocha不可用。
- 用户提供的关键词监测已配置，信号只辅助人工决定是否发起研判；深度报告不会因信号自动启动。2026-10-24 起正式计划为北京时间每天 08:00 与 11:30 各更新一次热榜，页面仍可手动更新。值守定时器只扫描已归档正文，不另起全源采集；自动采集或手动更新完成后才评估新热榜信号。08:00 采集后以**前一自然日实际归档的快照**生成正式日报；11:30 采集后以**截至当时的今日快照**生成单独保存的今日早报。两版均须通过质检才进入企微通知队列；手动刷新不会暗中生成付费日报。11:30 错过半小时以上不补发，停机期间不重造历史快照。来源失败、模型叙事失败和质检未通过时保留运行记录。每天两次采集不等于覆盖全天或全网。日报先由热榜选题，随后读取原始链接，并对入选主题主动搜索其他公开文章；搜索摘要只作发现，正文成功抓取后才入写作材料。每天原有最多6次标题搜索仍为共享上限，新增原生公开页读取默认最多6次（`daily_digest.policy.research_extra_page_limit` 可设为0–8），同主题优先不同域名，至多两篇补充正文；早报与正式日报同日额度共用。搜索供应商的实际扣费未回传时保持未知，模型继续受既有日报预算闸门约束。这是有界跨源调查，不代表已穷尽全网或完成独立事实核验；自然成稿、内容质量、企微送达和24小时稳定性仍待观察。
- 真实业务 MCP 尚未接入；自定义 Tool 的任意代码执行仍未开放；历史相似、品牌监测、完整子评论采集和 MiniLM/KMeans 语义抽样仍有实现差距。
- Git remote 已配置为用户指定的 DiTing 仓库；本地有 pre-push 与 CI 工作流。尚未推送本轮改动或宣称云端 CI 通过，遵守开发测试完成后再推送的约定。
- 报告结构与数值可以程序校验；实体归属、事实蕴含、来源可靠性与总体代表性仍须语义核验和抽检。

## 本地验证

```powershell
npm run typecheck
npm test
npm run test:reliability
npm run runtime:check
npm run runtime:check -- --full
npm run runtime:check -- --fail-closed
npm run runtime:check -- --followup
npm run runtime:check -- --skills
npm run runtime:check -- --mcp
npm run runtime:check -- --mcp-stdio
npm run runtime:check -- --mcp-fail
npm run runtime:check -- --crawl-approval
npm run runtime:check -- --crawl-session
npm run runtime:check -- --cancel
```

`--full` 使用隔离测试数据库与合成模型数据验证 dsh 原生协作和报告导出，不是外部新闻研究，也不会作为正式报告写入生产数据库。`--fail-closed` 验证领域插件挂载失败时零模型请求。登录采样和视觉接口的真实测试与合成测试分别记录，详见10月20日验收文档。

## 仓库检查

Git pre-push hook 运行 `npm run typecheck` 和 `npm test`；首次克隆后用 `git config core.hooksPath .githooks` 启用。GitHub Actions 在 push 和 pull request 上运行类型检查、测试及构建。自动化通过只说明代码回归检查通过，不等于真实数据、语义门禁或业务运行验收通过。

## 完整验收与本地语义抽样

`npm run test:acceptance` 保存类型检查、单元/API/DOM、构建、10种原生dsh合成链路与21页真实浏览器检查的逐项日志。真实平台、真实付费研究、通知和24小时观察分别记录，不从模拟测试推定。

`npm run sampling:setup` 安装固定版本多语言MiniLM q8 ONNX（约135MB模型与分词器），`npm run sampling:check` 执行真实本地推理。Insight检索超过30条候选时自动按KMeans选代表，完整归档保留；缺失或失败明确记录回退。`npm run sentiment:setup` / `npm run sentiment:check` 是另一套五分类情感模型。权重均保存在忽略的data目录，不随Git提交。

`npm run soak:status` 查看实际心跳与存活状态；`node --import tsx scripts/soak-check.ts --hours=24` 被动观察服务，不创建研究或付费调用。进程退出/心跳过期不能算24小时通过。

词库与历史相似检索位于定制中心 → Skill。词库版本按任务冻结；历史结果保留每个任务的最新版本，优先本地MiniLM余弦排序，失败明确回退词组匹配。分数不是事实正确率。自定义可执行工具从Tool页进入MCP注册，本机stdio也可用，旧名称配置不冒充挂载。
