# Firecrawl 本地配置与日报验收

2026-10-22 晚间状态：Firecrawl `v2.11.162` 已在 `D:\Project\firecrawl` 的独立 Compose 项目 `ditingfirecrawl` 中运行，API 仅绑定 `127.0.0.1:3002`；`/v0/health/readiness` 返回 `ok`，公开测试页的 `/v2/scrape` 已返回 Markdown。DiTing 8090 已加载 `v5-daily-digest-20261022`，正式配置 `service.firecrawl` 已启用并指向本机 API。下面的安装步骤保留为故障恢复说明，无需再次克隆或创建容器。

## 启动本地 Firecrawl

1. 启动 Docker Desktop，确认它的 Linux engine 已运行；在 PowerShell 执行 `docker info`，不能再出现 `dockerDesktopLinuxEngine` 管道不存在。
2. 从 [Firecrawl 官方仓库](https://github.com/firecrawl/firecrawl)取得源码，按[官方自托管指南](https://docs.firecrawl.dev/contributing/self-host)固定其已验证的 `v2.11.162` 版本。官方这版要求在 Firecrawl 根目录的 `.env` 填 `USE_DB_AUTHENTICATION=false`、`POSTGRES_USER=postgres`、随机的 `POSTGRES_PASSWORD` 和 `POSTGRES_DB=postgres`。不要把 `.env` 或密码提交进 DiTing。
3. 在 Firecrawl 目录执行 `docker compose -p ditingfirecrawl up -d --no-build`（首次安装才需要构建），再执行 `docker compose -p ditingfirecrawl ps --all`。本机 `docker-compose.yaml` 的 API 端口已限定为 `127.0.0.1:${PORT:-3002}:${INTERNAL_PORT:-3002}`，不可恢复为对所有网卡开放的无认证端口。用 `docker port ditingfirecrawl-api-1 3002` 验证仅有 `127.0.0.1:3002`，再请求 `http://127.0.0.1:3002/v0/health/readiness`。这些仍只是启动检查，必须用一个公开网页实际调用 `/v2/scrape` 并取得 Markdown 正文，才算可用。

在 PowerShell 可按以下顺序执行（先确认 Docker Desktop 显示运行中）：

```powershell
git clone https://github.com/firecrawl/firecrawl.git D:\Project\firecrawl
Set-Location D:\Project\firecrawl
git checkout v2.11.162
$pgPassword = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
@('USE_DB_AUTHENTICATION=false','POSTGRES_USER=postgres',"POSTGRES_PASSWORD=$pgPassword",'POSTGRES_DB=postgres') | Set-Content -Encoding utf8 .env
docker compose up --build -d
docker compose ps --all
Invoke-RestMethod http://127.0.0.1:3002/v0/health/readiness
$body = @{url='https://example.com';formats=@('markdown');timeout=60000} | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3002/v2/scrape -Method Post -ContentType 'application/json' -Body $body
```

若目标文件夹已存在，不要重复 `git clone`；在已有 Firecrawl 目录核对版本和配置。最后一条应返回 `success=true` 且 `data.markdown` 有正文，之后才启用 DiTing 的服务开关。

## 在 DiTing 中连接

先从 `D:\Project\DiTing` 正常重启 DiTing，再访问 `http://127.0.0.1:8090/api/health`，确认 `ui_revision` 为 `v5-daily-digest-20261022` 或更新版本。

在控制台“定制中心 → Key 与服务配置 → Firecrawl”填写：

- 服务地址：`http://127.0.0.1:3002`（DiTing 默认请求 `/v2/scrape`；旧实例可显式填完整的 `/v1` 基址）。
- 启用：是。
- API Key：本机无认证的 Firecrawl 留空；如自托管实例启用了认证，填写该实例的真实 Key。云端 Firecrawl 必须填写真实 Key，不能留空。

本项目已支持 **仅对 HTTP loopback 地址** 无 Key 接入；其它地址没有 Key 时仍走原生公开网页抓取。不要将无认证的 Firecrawl 直接暴露在公网。配置保存后，先用一个公开新闻页做端到端抽取核验，检查返回的正文、最终 URL 与页面原站同源，随后再运行日报。

## 日报真实验收条件

10 月 22 日最终累计 30 次来源页尝试、2 次标题搜索，已用完当日明确授权；不是重置计数，其他日期不能沿用。Firecrawl 已连接运行，8090 已加载清洗修复。最终验收预览为 1 篇不少于 800 字符的长正文与 5 条可回源短讯，来源页推荐栏不计入正文；原定至少 4/6 长正文的目标未通过。搜索兜底仍限每天 6 次，模型预算保险丝仍为 ¥0.50；搜索与抓取供应商未回传真实费用时要保留“未知”。成果及边界详见《DiTing-全功能验收与交付状态》末节。

预览生成后逐项核对：六张卡是否是不同事件；可用正文是否至少 4/6；事实句是否能回到对应来源页；无正文卡是否只呈现榜单事实；模型叙事是否通过绑定校验；实际账本与抓取运行记录是否保存。未达标保留失败稿与原因，不发企微，不启动认证级 24 小时稳定性观察。
