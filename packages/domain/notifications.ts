import { Configuration } from './configuration.js';
import { Database, encode, now, uid, type Row } from './db.js';
export const notificationEvents=['report.completed','report.updated','daily_digest.completed','approval.required','signal.created','signal.high_priority','task.attention_required','budget.warning','budget.exhausted'] as const;
const wecomEventAllowed=(event:string)=>event==='daily_digest.completed'||event==='signal.high_priority'||event==='approval.required';
const archivedSignalFresh=(payload:Row,at=Date.now())=>{
  const evidence=payload.evidence||{};
  if(evidence.type!=='archived_post')return true;
  const stamp=Date.parse(String(evidence.published_at||evidence.captured_at||''));
  // Archived-body scans can discover old material long after capture. Keep it
  // visible in the platform, but do not turn a backfill into a fresh alert.
  return Number.isFinite(stamp)&&stamp<=at+5*60_000&&at-stamp<=24*60*60_000;
};
function dailyDigestMessage(db:Database,config:Configuration,payload:Row){
  const digest=payload.digest_id?db.one('SELECT data_json FROM daily_digests WHERE id=?',payload.digest_id):db.one('SELECT data_json FROM daily_digests WHERE report_date=? ORDER BY created_at DESC LIMIT 1',payload.date);
  const d=digest?JSON.parse(digest.data_json):null;
  if(!d)return `【热点日报】${payload.date||''}\n日报已生成，请在 DiTing 平台报告中心查看。`;
  const overview=d.narrative?.lead||(d.sections||[]).find((s:Row)=>s.title==='今日总览')?.text||'';
  const events=(d.sections||[]).find((s:Row)=>s.title==='重点事件')?.items||[];
  const trend=(d.narrative?.trends||[]).map((t:Row)=>t.headline+'：'+t.body).join('；')||(d.sections||[]).find((s:Row)=>s.title==='趋势观察')?.text||'';
  const morning=d.edition==='morning',cutoff=morning&&d.through?new Date(d.through).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'}):null;
  const parts=[`${d.acceptance_test?'🧪【验收测试投递】\n':''}【${morning?'今日早报':'热点日报'}｜${d.date}${cutoff?` 截至${cutoff}`:''}】`,...(morning?['仅覆盖截至上述时间已归档的上午线索，不代表当日完整情况。']:[]),`采集覆盖：${d.coverage?.succeeded??0} 次成功，${d.coverage?.failed??0} 次失败；${d.coverage?.sources??d.source_ids?.length??0} 个榜单入口，${d.coverage?.observations??0} 条观测。`,overview,'重点议题：'];
  const chosen=d.narrative?.events?.length?d.narrative.events.map((e:Row)=>({...((d.candidate_themes||[]).find((t:Row)=>t.id===e.topic_id)||events.find((t:Row)=>t.id===e.topic_id)||{}),editorial:e})):events.slice(0,6);
  for(const [index,item] of chosen.slice(0,9).entries()){const source=(item.sources||[]).join('、'),conclusion=String(item.editorial?.conclusion||item.editorial_note||'').slice(0,160);parts.push(`${index+1}. ${item.editorial?.headline||item.title}${conclusion?`\n${conclusion}`:''}${source?`\n来源：${source}`:''}${item.url?`\n原文：${item.url}`:''}`);}
  if(trend)parts.push(`趋势变化：${trend}`);
  const base=config.get<string>('notification.public_base_url','').replace(/\/+$/,'');
  parts.push(base?`阅读${morning?'今日早报':'完整日报'}：${base}/api/daily-digests/${d.date}/export/html${morning?'?edition=morning':''}`:`阅读${morning?'今日早报':'完整日报'}：打开 DiTing 控制台 → 热点追踪 → 热点日报（${d.date}）`);
  return parts.filter(Boolean).join('\n');
}
function highPriorityMessage(payload:Row){
  const e=payload.evidence||{},heat=(v:unknown)=>v===null||v===undefined?'未提供':String(v),published=e.published_at||'未提供';
  return [`【高优先级线索】${payload.title||''}`,`命中关键词：${(e.keywords||[]).join('、')||'未提供'}`,`触发规则：${e.trigger_rule||payload.priority?.rule||'未提供'}`,`来源：${e.source||'未提供'}${e.rank?`｜榜内排名：第 ${e.rank} 名`:''}`,`当前热度：${heat(e.current_heat)}｜前次热度：${e.previous_heat===null||e.previous_heat===undefined?'无基线':heat(e.previous_heat)}${e.growth===null||e.growth===undefined?'':'｜同源变化 '+(e.growth*100).toFixed(1)+'%'}`,`发布时间：${published}`,e.source_url?`原文：${e.source_url}`:'原文链接：未提供','请查看原文后决定是否在平台发起新主题研判。'].join('\n');
}
function approvalMessage(db:Database,config:Configuration,payload:Row){
  const approvalId=String(payload.approval_id||''),approval=db.one('SELECT * FROM approvals WHERE id=?',approvalId),task=approval?.task_id?db.one('SELECT title FROM tasks WHERE id=?',approval.task_id):null;
  let request:Row={};try{request=JSON.parse(approval?.request_json||'{}')}catch{}
  const op=approval?.operation==='platform_keyword_crawl'?'登录态平台关键词采集':approval?.operation==='public_keyword_crawl'?'公开网页取证':approval?.operation||'受限操作';
  const scope=[request.platform&&`平台：${request.platform}`,request.query&&`关键词：${request.query}`,request.start_at&&`起始：${request.start_at}`,request.end_at&&`截止：${request.end_at}`,request.max_posts&&`帖子上限：${request.max_posts}`,request.max_videos&&`视频上限：${request.max_videos}`,request.comments_per_post&&`每帖评论上限：${request.comments_per_post}`,request.comments_per_video&&`每视频评论上限：${request.comments_per_video}`,request.max_pages&&`页数上限：${request.max_pages}`].filter(Boolean).join('；')||'请在审批页面核对完整请求范围。';
  const base=config.get<string>('notification.public_base_url','').replace(/\/+$/,'');
  const link=base?`${base}/?page=approve&approval_id=${encodeURIComponent(approvalId)}`:null;
  return [`【待处理审批】${task?.title||'研究任务'}`,`操作：${op}`,scope,`审批编号：${approvalId}`,link?`去处理：${link}`:'去处理：打开 DiTing 控制台 → 审批中心（配置可访问的平台地址后可生成直达链接）','批准只对本条列明范围生效；不处理时相关任务会等待。'].join('\n');
}

export function recordBudgetState(db:Database,taskId:string,budget:number,spent:number,reason:'usage'|'reservation'){
  if(!(budget>0)||!Number.isFinite(spent))return;
  const ratio=spent/budget;
  const threshold=ratio>=1?100:ratio>=0.9?90:ratio>=0.8?80:null;
  if(threshold===null)return;
  const kind=threshold===100?'budget.exhausted':'budget.warning';
  const history=db.rows("SELECT kind,payload_json FROM events WHERE task_id=? AND kind IN ('budget.warning','budget.exhausted')",taskId);
  const alreadyRecorded=history.some(event=>{
    if(event.kind!==kind)return false;
    let payload:Row={};try{payload=JSON.parse(event.payload_json)}catch{}
    // Old warning rows had no band. Count them as the original 80% notice,
    // and old exhaustion rows as the 100% notice, without rewriting history.
    return payload.threshold_percent===threshold||(payload.threshold_percent===undefined&&(threshold===80||threshold===100));
  });
  if(alreadyRecorded)return;
  const message=threshold===100
    ?reason==='reservation'?'剩余预算不足以预留下一次模型调用，已停止继续调用':'模型实际用量已达到或超过任务预算'
    :`研究预算已使用至少 ${threshold}%`;
  const payload={message,spent,budget,threshold_percent:threshold};
  db.event(taskId,kind,payload);
  db.notify(taskId,kind,{title:threshold===100?'研究预算已用尽':`研究预算已使用 ${threshold}%`,spent,budget,threshold_percent:threshold},String(threshold));
}

export class Notifications {
  private busy = false; private timer?: ReturnType<typeof setInterval>;
  constructor(readonly db: Database, readonly config: Configuration, readonly fetcher: typeof fetch = fetch) {}
  async test(channel: 'feishu' | 'wecom') {
    const settings = this.config.get<Row>(`service.${channel}`, {}), webhook = this.config.secret(`service.${channel}`);
    if (!settings.enabled || !webhook) throw new Error('请先启用通知服务并保存 Webhook');
    let url: URL;
    try { url = new URL(webhook); } catch { throw new Error('Webhook 配置无效'); }
    if (url.protocol !== 'https:' || url.hostname !== (channel === 'feishu' ? 'open.feishu.cn' : 'qyapi.weixin.qq.com') || url.username || url.password) throw new Error('Webhook 主机与通道不匹配');
    try {
      const text = 'DiTing 通知通道连通测试：企业微信机器人已成功接收测试消息。';
      const response = await this.fetcher(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify(channel === 'feishu' ? { msg_type: 'text', content: { text } } : { msgtype: 'text', text: { content: text } }) });
      if (!response.ok) throw new Error('通知请求未成功');
      const body = await response.json() as Row;
      if ((channel === 'feishu' ? (body.code ?? body.StatusCode) : body.errcode) !== 0) throw new Error('通知渠道未确认成功');
      this.config.set(`service.health.${channel}`, { status: 'healthy', checked_at: now() });
      return { success: true, channel, checked_at: now(), detail: '机器人已确认接收测试消息' };
    } catch (error) {
      this.config.set(`service.health.${channel}`, { status: 'failed', checked_at: now() });
      if (error instanceof Error && ['通知请求未成功', '通知渠道未确认成功'].includes(error.message)) throw error;
      throw new Error('通知发送失败；请检查网络和 Webhook 状态');
    }
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const subscription = this.config.get<Row>('notification.subscription', { enabled: false });
      const originals = this.db.rows("SELECT * FROM outbox WHERE channel='in_app' AND status='pending_configuration' ORDER BY created_at LIMIT 30");
      this.db.transaction(() => {
        for (const row of originals) {
          this.db.run("UPDATE outbox SET status='delivered' WHERE id=?", row.id);
          const essentialApproval=row.event_type==='approval.required'&&subscription.channels.includes('wecom');
          if (!subscription.enabled || row.created_at < subscription.starts_at || (!subscription.events.includes(row.event_type)&&!essentialApproval)) continue;
          for (const channel of subscription.channels.filter((c: string) => ['feishu', 'wecom'].includes(c))) {
            if(channel==='wecom'&&!wecomEventAllowed(row.event_type))continue;
            if(channel==='wecom'&&row.event_type==='approval.required'&&row.created_at<subscription.starts_at)continue;
            if(channel==='wecom'&&row.event_type==='signal.high_priority'&&JSON.parse(row.payload_json).priority?.level!=='high')continue;
            this.db.run('INSERT OR IGNORE INTO outbox(id,dedupe_key,task_id,event_type,channel,payload_json,created_at,status) VALUES(?,?,?,?,?,?,?,?)', uid('notification'), `${row.dedupe_key}:${channel}`, row.task_id, row.event_type, channel, row.payload_json, now(), 'pending');
          }
        }
      });
      if (!subscription.enabled) return;
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date()));
      if (subscription.quiet && (hour >= 22 || hour < 8)) return;
      for (const row of this.db.rows("SELECT * FROM outbox WHERE channel<>'in_app' AND status='pending' AND attempts<3 AND (next_attempt_ms IS NULL OR next_attempt_ms<=?) ORDER BY created_at LIMIT 10",Date.now())) {
        const essentialApproval=row.channel==='wecom'&&row.event_type==='approval.required';
        if (!subscription.channels.includes(row.channel)||(!subscription.events.includes(row.event_type)&&!essentialApproval)||row.created_at<subscription.starts_at||(row.channel==='wecom'&&!wecomEventAllowed(row.event_type))) {this.db.run("UPDATE outbox SET status='suppressed' WHERE id=?",row.id);continue;}
        const settings = this.config.get<Row>(`service.${row.channel}`, {}), webhook = this.config.secret(`service.${row.channel}`);
        if (!settings.enabled || !webhook) continue;
        let url:URL;try{url=new URL(webhook);}catch{this.db.run("UPDATE outbox SET status='configuration_error' WHERE id=?",row.id);continue;}
        if (url.protocol !== 'https:' || url.hostname!==(row.channel==='feishu'?'open.feishu.cn':'qyapi.weixin.qq.com')||url.username||url.password) { this.db.run("UPDATE outbox SET status='configuration_error' WHERE id=?", row.id); continue; }
        const payload = JSON.parse(row.payload_json), report=payload.report_id?this.db.one('SELECT title FROM reports WHERE id=?',payload.report_id):null,task=row.task_id?this.db.one('SELECT title FROM tasks WHERE id=?',row.task_id):null;
        if(row.channel==='wecom'&&row.event_type==='signal.high_priority'&&payload.priority?.level!=='high'){this.db.run("UPDATE outbox SET status='suppressed' WHERE id=?",row.id);continue;}
        if(row.channel==='wecom'&&row.event_type==='signal.high_priority'&&Date.now()-Date.parse(row.created_at)>24*60*60_000){this.db.run("UPDATE outbox SET status='suppressed',last_error='expired_high_priority_signal' WHERE id=?",row.id);continue;}
        if(row.channel==='wecom'&&row.event_type==='signal.high_priority'&&!archivedSignalFresh(payload)){this.db.run("UPDATE outbox SET status='suppressed' WHERE id=?",row.id);continue;}
        const text=row.channel==='wecom'?(row.event_type==='daily_digest.completed'?dailyDigestMessage(this.db,this.config,payload):row.event_type==='approval.required'?approvalMessage(this.db,this.config,payload):highPriorityMessage(payload)):`DiTing ${row.event_type}\n任务：${task?.title || '监测线索'}\n${payload.title || report?.title || payload.reason || ''}${payload.reason?'\n'+payload.reason:''}`;
        let failure='network_or_timeout';
        try {
          const response = await this.fetcher(url, { method: 'POST',redirect:'error', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify(row.channel === 'feishu' ? { msg_type: 'text', content: { text } } : { msgtype: 'text', text: { content: text } }) });
          if (!response.ok){failure=`http_${response.status}`;throw new Error('通知请求失败');}
          failure='invalid_provider_response';const body = await response.json() as Row;
          const code=row.channel==='feishu'?(body.code??body.StatusCode):body.errcode;
          if(code!==0){failure=Number.isInteger(code)?`provider_code_${code}`:'provider_rejected';throw new Error('通知渠道未明确确认成功');}
          this.db.run("UPDATE outbox SET status='delivered',attempts=attempts+1,next_attempt_ms=NULL,last_error=NULL WHERE id=?", row.id);
        } catch {
          const attempt=Number(row.attempts)+1,delay=attempt>=3?null:Date.now()+(attempt===1?60_000:300_000);
          this.db.transaction(()=>{
            this.db.run("UPDATE outbox SET status=?,attempts=?,next_attempt_ms=?,last_error=? WHERE id=?",attempt>=3?'failed':'pending',attempt,delay,failure,row.id);
            this.db.event(row.task_id,'notification.delivery_failed',{notification_id:row.id,event_type:row.event_type,channel:row.channel,attempt,error:failure,next_attempt_ms:delay});
          });
        }
      }
    } finally { this.busy = false; }
  }
  start() { this.timer = setInterval(() => void this.tick().catch(() => {}), 10000); this.timer.unref(); }
  async stop() { if (this.timer) clearInterval(this.timer); while (this.busy) await new Promise(resolve => setTimeout(resolve, 25)); }
}
