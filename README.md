# DiTing 舆情 Agent

用户通过对话发起独立研究，系统管理采集、证据、质量门禁和完整报告。以 dsh 为运行底座，保留 BettaFish 三引擎、Forum 与完整 ReportEngine。

当前版本 **0.1.0 / M0 持久控制层**。完整路线见 [实施规划](docs/DiTing-整体实施规划-v6-2026-10-18.md)。

## 启动

在 `D:/Project/DiTing` 执行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
.\.venv\Scripts\python.exe -m diting
```

打开 `http://127.0.0.1:8090`，API 说明在 `/docs`。也可运行 `scripts/start.ps1`。默认仅监听本机，不作为公网多用户服务。

已有 `.venv` 时只需最后一条命令。正式应用必须通过 HTTP 服务打开；`prototypes/diting-v5/dist/index.html` 仍是可单独打开的内存原型，供设计对照。

## 已实现

- FastAPI + SQLite/WAL；对话、任务、事件、原文与哈希持久保存。
- 对话创建任务、幂等请求、单执行槽、暂停/继续/取消、revision 冲突检测、租约过期恢复。
- 用户导入原文、任务证据隔离、内部结论引用与三审版本绑定、报告入库与通知 outbox 契约。
- 用量与费用分账，缓存不重复统计，未知费用保持未知。
- 前端复用已确认的 v5 布局，连接真实任务与对话；不将演示数字当作真实输入。
- 参考仓库发现、dsh SDK 适配入口、六模板快照及哈希清单。

## 尚未接入

真实模型问答、dsh 受控研究 profile、BettaFish 引擎执行、在线采集和定时规则、图表统计、完整成稿及 PDF、真实通知发送。未就绪任务停在“等待执行器”，不会显示虚假完成。

配置页面现仍为原型草稿，不能认为已经配置生产服务。`.env.example` 仅提供环境变量示例，应用不会自动加载文件。已有参考仓库密钥未导入、未使用。

数据默认在 `data/diting.sqlite3`。可通过 `DITING_DATA_DIR` 更改；备份时停止服务并保存整个 data 目录。不要删除数据库来重置页面。首次验收产生的任务与材料明确为验收数据，并非新闻事实。

## 测试

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

测试使用临时数据库与明确的测试输入，不调用模型、外部抓取或消息发送。直接运行接口不会触发真实收费研究。
