import {narrativeProfile} from '../reporting/depth.js';
export function classify(text: string, hasReport = false, awaitingTopic = false) {
  const value=text.trim(), ordinary=hasReport?'report_question':'question';
  // Questions about a capability, quotations, negations and report explanations
  // must not reserve a research slot merely because they contain a research verb.
  if(/^(?:算了|取消|先不|暂不|不需要|不用|不要|停止)|(?:不要|不用|无需|别)(?:再|重新|联网|自动|帮我|\s)*(?:研究|调查|研判|分析|采集|检索|生成|出报告)/.test(value))return ordinary;
  const action=/(?:^|[，。；;\n])\s*(?:(?:请问)?(?:能不能|能否|可以)(?:请|帮我|为我)?|请|帮我|替我|为我|我想(?:要)?|我要|麻烦)?\s*(?:帮我|请)?\s*(?:深度|全面|详细|重新|补充|另外|再)?\s*(?:(?:研究|调查|研判|分析)(?!任务|功能|流程|方法|系统)|查一下|查一查|查查|生成|出一份|写一份)/.test(value);
  if(!action&&/什么是|是什么|什么意思|如何|怎么|为什么|能不能|能否|可以吗|有什么区别|有什么用|有何区别|是否|吗[？?]?$/.test(value))return ordinary;
  const researchAction=/(?:^|[，。；;\n])\s*(?:请|帮我|为我|我要|我想要|麻烦)?\s*(?:深度|全面|详细|重新|补充|另外|再)?\s*(?:研究|调查|研判|分析)(?!任务|功能|流程|方法|系统)/.test(value);
  if(!researchAction&&/(?:共创|设计|创建|生成|保存).*模板|模板.*(?:共创|设计|创建|生成|保存)/.test(value))return 'template';
  if(hasReport){
    const explicitNew=/(?:重新|补充|另外|新建|更新)(?:联网)?(?:研究|调查|研判|采集|检索)|(?:联网|重新采集|重新检索)|(?:生成|出|写)(?:一份|个|份)?新报告/.test(value);
    if(!explicitNew&&/这份报告|报告中|报告里|报告的|这张表|这个图|上面|刚才|这些(?:数字|结论|引用|数据)/.test(value))return 'report_question';
    // Within a report conversation, "分析一下风险" explains the fixed version.
    // New research requires a deliberate investigation/research command.
    if(!explicitNew&&!/^(?:请|帮我|我想|我要|能不能帮我|能否帮我)?(?:深度|全面|详细)?(?:研究|调查|研判)/.test(value))return 'report_question';
  }
  if(action||/(?:发起|开启|新建).*(?:研究|调查|研判)|(?:给我|帮我).*(?:完整报告|研究报告)/.test(value)||awaitingTopic){
    if(!action&&!awaitingTopic&&!hasReport)return 'research';
    const topic=value.replace(/(?:请问|能不能|能否|可以|帮我|替我|为我|我想要|我想|我要|麻烦|请|深度|全面|详细|重新|补充|另外|研究|调查|研判|分析|查一下|查一查|查查|生成|出一份|写一份|一下|一份|完整|图文|报告|近期|最近|今天|今日|过去|近|的|舆情)/g,'')
      .replace(/\d{1,3}\s*(?:天|周|个月|月|小时)|预算(?:上限)?[为是：:\s¥￥]*\d+(?:\.\d+)?\s*元?/g,'').replace(/[\s，,。.!！?？：:；;、]/g,'');
    if(topic.length<2&&!hasReport)return 'clarify';
    return 'research';
  }
  return ordinary;
}
export function scope(text: string, defaultBudget: number) {
  const days = text.match(/(?:近|最近|过去)\s*(\d{1,3})\s*天/);
  const amount = text.match(/预算(?:上限)?[为是：:\s¥￥]*([0-9]+(?:\.[0-9]+)?)/);
  const budget = amount ? Number(amount[1]) : defaultBudget;
  if (!Number.isFinite(budget) || budget <= 0 || budget > 10000) throw new Error('研究预算须在 0 到 10000 元之间');
  const window_days=days?Math.max(1,Math.min(Number(days[1]),365)):/近一个?月|最近一个?月|过去一个?月/.test(text)?30:/今天|今日|近24小时/.test(text)?1:7;
  return { window_days, budget,report_profile:narrativeProfile(text),engine_section_contract:true,min_engine_sections:/行业|舆情|全网|近期|热点|趋势/.test(text)?4:1,reuse_public_library:/复用[^。\n]{0,30}公开|公开[^。\n]{0,20}语料库/.test(text), template: 'auto', data_policy: 'observed_or_cited_only' };
}
