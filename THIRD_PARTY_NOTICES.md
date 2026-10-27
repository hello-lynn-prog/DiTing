# 第三方来源与许可说明

DiTing 的业务控制层和报告管线在本项目中实现；TS 采集器包含按 NewsNow、DailyHotApi 的 MIT 源码改写的取数与解析逻辑。两份完整 MIT 许可和版权声明分别保留在 `assets/licenses/NewsNow-MIT.txt`、`assets/licenses/DailyHotApi-MIT.txt`。这不表示把这些项目的服务端、UI 或全部代码打包进本项目。来源哈希清单见 `docs/source-inventory-2026-10-18.json`。

| 项目 | 本地用途 | 上游与许可 |
| --- | --- | --- |
| DeepSeek Harness | 通过本机 SDK 运行 Agent；代码位于项目外的本地目录，本仓库不复制 dsh runtime | [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，本机源码 LICENSE 为 MIT；运行需要用户自行取得并构建 |
| NewsNow | 知乎、百度原始平台端点与字段映射参考，TypeScript 解析器位于 `packages/collectors/hotlists.ts` | [newsnext/newsnow](https://github.com/newsnext/newsnow)，上游标注 MIT。DiTing 独立实现网络层、归一化、快照与审计逻辑；本轮按固定源码改写新增取数逻辑，分发时保留上述 MIT 许可文本和版权说明 |
| DailyHotApi | 27 个展示频道、扩展源端点和响应字段形态参考，TypeScript 原生解析器位于 `packages/collectors/hotlists.ts`、`dailyhot-extended.ts` | [imsyy/DailyHotApi](https://github.com/imsyy/DailyHotApi)，上游标注 MIT。DiTing 独立实现采集生命周期、标准化与证据保存；原型 27 频道对应 25 个来源，扩展项另列，不包含 DailyHotApi 服务端或缓存服务 |
| Playwright | 本地平台扫码登录、持久浏览器配置 | 安装包许可为 Apache-2.0；浏览器使用本机 Microsoft Edge，浏览器本身的许可独立适用 |
| ffmpeg-static 5.3.0 | 通过独立进程解码已归档图片、提取视频输入帧 | 安装包声明 GPL-3.0-or-later；其二进制和许可由依赖包提供，`node_modules/` 不提交。发布含该依赖或二进制的安装包时须同时处理其适用许可和来源义务；不能把该依赖称为 MIT |
| BettaFish | 调查职责和报告形态参考 | [666ghj/BettaFish](https://github.com/666ghj/BettaFish)。本仓库 `assets/report-templates/` 仍保存六份用户快照原样模板与原许可证材料；2026-10-20 起，用户授权的本地运行时读取六份原模板，冻结主章和完整子节；中文成稿与渲染由 TS 管线执行。原模板内容未改写。其随附许可证文件包含多种许可证文本与额外非商业条款，不能用单一宽松许可概括；在逐项完成版权/许可核对前，不要把该目录或模板复制到公开分发包。 |

本轮另外核对了用户本机 MediaCrawler 的微博公开接口契约。DiTing 新增的微博/B站关键词解析、分页、范围审批、批次和证据存储由本项目独立实现，没有复制其 Python 实现、登录流程、签名脚本或原提示词；不以这些有界模块声称完整移植了 MediaCrawler。

来源哈希清单见 `docs/source-inventory-2026-10-18.json`。本表是来源记录，不构成法律意见，也不改变上游许可文本。


2026-10-20 新增独立情感推理层：`packages/sentiment/` 用 TypeScript + Transformers.js / ONNX Runtime 在本机加载五级分类器。来源为 BettaFish 默认使用的 `tabularisai/multilingual-sentiment-analysis`，ONNX 转换文件来自 `maximka608/multilingual-sentiment-analysis-ONNX`，固定提交 `3022fd62fd378c1a05af00933495f98da1ea872d`；模型卡声明 CC-BY-NC-4.0。模型卡、配置、分词器、原始 FP32 ONNX 文件及逐文件 SHA256 清单保存在 `data/models/bettafish-multilingual-sentiment/`，模型文件不随 Git 上传。此接入未复制 Python 推理服务，也未宣称已经迁入 SVM、贝叶斯、BERT LoRA、GPT2 LoRA 等所有历史模型。Transformers.js 与 ONNX Runtime 的许可随 npm 依赖保留；模型权重许可与运行库许可分别适用。

2026-10-21 新增本地语义抽样：模型基座 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`（Apache-2.0，源提交 `e8f8c211226b894fcb81acc59f3b34ba3efd5f42`），ONNX q8转换来自 `Xenova/paraphrase-multilingual-MiniLM-L12-v2`，固定提交 `2c4055b12046f11709e9df2c122e59ffbdc2f900`。逐文件SHA256见 `assets/semantic-model.manifest.json`，运行前核验本地文件；权重不随Git提交。TS KMeans++/Lloyd实现及缓存由本项目编写，沿用BettaFish的10次初始化/seed42/按簇选择代表策略，不声称与scikit-learn逐位等价。语义抽样与五分类情感是不同模型。

可读dsh日志导出器的帧边界处理参考/改编自本机dsh `session-persistence-jsonl/src/zstd.ts`（提交9fcc9f4d6ea6e02ab92ed12bfb2ca627b3363035）。其MIT许可证原文保留于 `assets/licenses/deepseek-harness-session-reader-MIT.txt`。原压缩日志不改写，只读导出全部完整帧并标记未完成尾帧。
