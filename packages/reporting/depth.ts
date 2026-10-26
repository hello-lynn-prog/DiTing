/** BettaFish WORD_BUDGET targets about 40,000 characters; this is an editorial plan, not permission to invent. */
export function narrativeProfile(text:string){
 const short=/(?:只要|仅需|仅输出|生成|写一份).{0,8}(?:简报|摘要)|简版报告/.test(text)&&!/不要[^。\n]{0,8}(?:简报|摘要|简版)/.test(text);
 const explicit=text.match(/(?:控制在|约|不少于|字数|写)(?:为|在|：|:|\s)*(\d{3,5})\s*字/),wan=text.match(/(?:控制在|约|不少于|字数|写)(?:为|在|：|:|\s)*(\d+(?:\.\d+)?)\s*万字/);
 const target=Math.max(500,Math.min(60000,wan?Number(wan[1])*10000:explicit?Number(explicit[1]):short?1500:40000));
 return {mode:short?'brief':'full',target_chars:target,recommended_min:Math.round(target*0.95),recommended_max:Math.round(target*1.05),advisory:true,source:explicit||wan?'user_request':short?'user_brief_request':'bettafish_word_budget_default',instruction:'按事实节点、具体案例、多方观点、因果机制、影响和行动展开；主分析详写，摘要与方法附录简洁。篇幅目标不是充分性证明，不能填充、重复或编造数据，也不因字数自动重写全章。'};
}
