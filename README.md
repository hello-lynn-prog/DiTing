# DiTing

DiTing 是运行在本机的舆情监测与研究工作台。它提供热点采集、主题日报、关键词信号、研究任务、报告生成和报告追问，并将采集记录、证据与模型用量保存在本地。

## 技术栈

| 部分 | 技术 |
| --- | --- |
| 后端与 API | Node.js 24+、TypeScript、Fastify |
| 数据存储 | SQLite（`node:sqlite`） |
| Agent 执行 | dsh TypeScript SDK、原生子 Agent、任务队列与检查点 |
| 网页与平台采集 | TypeScript 采集器、RSS、Playwright、正文抽取 |
| 本地模型 | Transformers.js、ONNX Runtime |
| 前端与导出 | v5 控制台、HTML、Markdown、PDF |
| 质量检查 | TypeScript 类型检查、Node.js Test Runner、GitHub Actions |

## 主要功能

- 采集热榜与 RSS 信息，保存来源状态、原始快照和采集流水；来源失败会如实显示。
- 按主题汇集线索，结合公开网页材料生成日报和早报；支持手动刷新与定时采集。
- 自定义关注关键词，查看分级信号，并按配置推送高优先级线索和日报。
- 由多个子 Agent 协作完成调查、补证、讨论、核验与成稿；研究任务支持预算、审批和断点续跑。
- 管理证据引用、报告模板、可视化与导出，并对已归档报告继续提问。
- 按授权范围使用平台登录态采样；在本机运行情感分类与语义抽样模型。

采集条目、互动指标和情感分类是有界样本，不应直接解释为全网声量或公众总体态度。页面会展示实际来源状态及各任务的证据范围。

## 本机运行

需要 Node.js 24 或更新版本，以及已构建的 dsh SDK。将 `.env.example` 复制为 `.env`，按本机实际位置设置 `DITING_DSH_ROOT`；模型、搜索和通知配置可在控制台中完成。运行数据默认写入被 Git 忽略的 `data/`。

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm start
```

打开 <http://127.0.0.1:8090>。服务仅监听本机。

## 验证

```powershell
npm run typecheck
npm test
npm run build
```

自动测试和 CI 用于检查代码回归；真实来源可用性、研究结论、通知送达与长期稳定性需要分别验收。

## 数据与许可

不要提交 `.env`、`data/` 或真实凭据。所用第三方代码、模型与模板的许可和来源记录见 [第三方许可说明](THIRD_PARTY_NOTICES.md)。
