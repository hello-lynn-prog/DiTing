// DiTing 舆情工具插件（M0 spike）
// 提供两个工具：
//   heat_state_eval —— 爆发/回落判定（spawn 调用 DiTing/scripts/heat_state.py --json，Python 侧为唯一事实源）
//   crawl_deep      —— L2 深挖演示：经 tools/pre-execute 瀑布返回 {kind:'ask'} 触发人工审批
// 本文件为版本化正本（DiTing/plugins/dsh-yuqing/）；运行前同步副本到 harness 仓
//   cp -r plugins/dsh-yuqing <harness>/scratch-plugin   （见本目录 README.md）
import { spawnSync } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

// heat_state.py 位置：可用环境变量覆盖；默认指向 DiTing 克隆
const HEAT_SCRIPT = process.env.YUQING_HEAT_SCRIPT
  ?? 'C:/Users/13672/Desktop/工作学习/9github项目/DiTing/scripts/heat_state.py'

export const name = 'yuqing-tools'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'heat_state_eval',
    description: '多议题热度环比与爆发/回落判定。输入快照记录 JSON 数组，每条为 [日期, 平台, 议题ID, 榜位, 榜长]；返回每个议题逐日热度分与状态（burst/rise/flat/fall/new）。',
    parameters: {
      records_json: {
        type: 'string',
        required: true,
        description: 'JSON 数组字符串，元素形如 ["09-23","weibo","t1",1,50]',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      let records: unknown
      try {
        records = JSON.parse(args.records_json)
      } catch {
        return '参数错误：records_json 不是合法 JSON'
      }
      if (!Array.isArray(records)) return '参数错误：records_json 必须是 JSON 数组'
      const proc = spawnSync('python', [HEAT_SCRIPT, '--json'], {
        input: JSON.stringify({ records }),
        encoding: 'utf8',
      })
      if (proc.error) return `调用 python 失败：${proc.error.message}`
      if (proc.status !== 0) return `heat_state.py 异常退出(${proc.status})：${proc.stderr}`
      return proc.stdout
    },
  }))

  ctx.tools.register(defineTool({
    name: 'crawl_deep',
    description: 'L2 深挖采集（登录态/重采集）。受采集守则约束：调用会被拦截转人工审批，批准后才执行。当前为 spike 模拟，仅回显受理结果。',
    parameters: {
      source: { type: 'string', required: true, description: '目标信源，如 weibo' },
      query: { type: 'string', required: true, description: '采集关键词或时间范围' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      // 走到这里说明审批已放行（rejected 会被管线拦截，不会进入 execute）
      return `L2 深挖已执行（spike 模拟）：source=${args.source} query=${args.query} —— 审批链路验证通过`
    },
  }))

  // 采集守则 R-02：L2 深挖一律先人工审批（allow/deny 之外的 ask 门）
  ctx.on('tools/pre-execute', async (exec: any, next) => {
    const toolName = exec?.name ?? exec?.toolName
    if (toolName !== 'crawl_deep') return next()
    return { kind: 'ask', reason: '采集守则 R-02：L2 深挖需人工审批后执行' }
  })

  console.log('[yuqing-tools] loaded: heat_state_eval + crawl_deep(审批演示)')
}
