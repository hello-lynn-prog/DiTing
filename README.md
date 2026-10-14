# DiTing · 舆情研判 Agent（YUQING）

以**事件/议题**为中心的国内舆情监测与多 Agent 研判系统：
热榜发现（60 源）→ 爆发判定（`heat_state` 三条件）→ 多 Agent 研判（取证→核实→质疑→成稿）→ 日报/报告交付（RSS/PDF）。

## 目录结构

| 目录 | 职责 |
|---|---|
| `server/` | FastAPI 网关（自有 API + dsh 桥） |
| `plugins/` | dsh 舆情工具插件（hotlist / heat_state / evidence / chain.write） |
| `mcp/` | Python MCP server（十表只读、采集调度） |
| `teams/` | agent-teams profile（六角色 + 门禁） |
| `frontend/` | Vue3 控制台（原型 → 组件化） |
| `scripts/` | 已验证脚本（`heat_state.py` 爆发/回落判定） |
| `docs/` | 开发规划、控制台 UI 契约原型、全链路讲解稿 |

## 里程碑

M0 spike（dsh Go/No-Go）→ M1 发现层 → M2 研判层 → M3 交付层 → M4 打磨
详见 [docs/舆情Agent开发规划-2026-10-14.md](docs/舆情Agent开发规划-2026-10-14.md)。

## 当前状态

- [x] 仓骨架 + 资产迁入（heat_state.py / 规划 / 原型 / 讲解稿）
- [ ] M0：dsh Go/No-Go 判定
- [ ] M1：60 源接入、快照管线、关键词命中 → 飞书预警
- [ ] M2：六角色研判、链路两表、verifier/advocate 门禁
- [ ] M3：六段日报、RSS、PDF、品牌监测
