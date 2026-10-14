# plugins/dsh-yuqing — dsh 舆情工具插件（M0 spike）

dsh 官方插件协议：Cordis `apply(ctx)` + `ctx.tools.register(defineTool({...}))`。
参考：harness 仓 `docs/user/develop/basic/tool.md`、`docs/subsystems/approval.md`。

## 工具清单

| 工具 | 作用 | 验证的机制 |
|---|---|---|
| `heat_state_eval` | 爆发/回落判定（spawn `scripts/heat_state.py --json`，Python 为唯一事实源） | 自定义工具注册 + 跨语言调用 |
| `crawl_deep` | L2 深挖演示，`tools/pre-execute` 返回 `{kind:'ask'}` 拦截转审批 | guard 人工审批闭环 |

## 运行（每次改完插件都要重跑）

```sh
# 1) 同步正本到 harness 仓（scratch 副本不进 git）
cp -r DiTing/plugins/dsh-yuqing D:/Study/deepseek_harness/deepseek-harness/scratch-plugin

# 2) 在 harness 仓根目录启动 Web UI 并加载 overlay
cd D:/Study/deepseek_harness/deepseek-harness
pnpm dsh web --patch ./scratch-plugin/cordis.yml

# 3) 打开 http://127.0.0.1:3080 验证
#    ① 启动时终端出现 [yuqing-tools] loaded
#    ② 对话：把 heat_state.py 里 demo 的 R 记录贴给模型，让它调 heat_state_eval → 应返回 C 议题爆发、D 议题新增候选
#    ③ 对话：让它调 crawl_deep(source="weibo", query="闲鱼涉黄") → Web UI 应弹人工审批；拒绝/批准两种结局都试一次
```

## M0 验收（Go 判据）

- [ ] 插件加载无报错，两个工具出现在模型工具列表
- [ ] `heat_state_eval` 返回与 `python scripts/heat_state.py` demo 一致的判定
- [ ] `crawl_deep` 未审批不执行、批准后正常返回（审批审计事件 `approval/asked` + `approval/decided` 成对出现）
- [ ] （加分）agent-team bundle 装上后 Lead 能动态拉起 teammate 并在任务板看到 DAG
