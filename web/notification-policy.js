// The WeCom channel is intentionally a reader-facing digest/lead channel, not a task event bus.
window.wfNotifications=function(){
  const s=native.subscription||{enabled:false,channels:[],events:[],quiet:true};
  const checked=id=>s.events?.includes(id)?'checked':'';
  const rows=(wf.notifications||[]).map(n=>`<div class="native-list"><div>${liveEsc(n.time)} · ${liveEsc(n.channel)}<p class="native-meta">${liveEsc(n.title)}</p></div>${v4Tag(n.status,'gr')}</div>`).join('')||'<p class="native-meta">尚无通知记录。</p>';
  v4Modal('通知订阅与发送记录',`<form data-notification-policy>
    <label><input type="checkbox" name="enabled" ${s.enabled?'checked':''}> 启用通知</label>
    <div class="native-meta">${[['feishu','飞书'],['wecom','企业微信']].map(([id,title])=>`<label style="margin-right:20px"><input name="channel_${id}" type="checkbox" ${s.channels?.includes(id)?'checked':''}> ${title}</label>`).join('')}</div>
    <div class="wf-note"><b>企业微信接收三类必须及时处理的消息：</b>热点日报、高优先级线索和待处理审批。报告完成、普通任务等待、预算及普通线索留在平台。审批消息包含任务、范围和“去处理”入口。</div>
    <div class="native-meta"><label style="margin-right:18px"><input name="event_daily_digest.completed" type="checkbox" ${checked('daily_digest.completed')}> 多主题热点日报</label><label style="margin-right:18px"><input name="event_signal.high_priority" type="checkbox" ${checked('signal.high_priority')}> 高优先级线索</label><label><input type="checkbox" checked disabled> 待处理审批（企业微信必发）</label></div>
    <div class="v4-field"><label>企业微信“去处理”链接的外部访问基础地址</label><input name="public_base_url" type="url" value="${liveEsc(s.public_base_url||'')}" placeholder="例如 https://diting.example.com"><small>配置后审批通知直达该地址的审批中心；留空时消息提示从平台菜单进入，不伪造本机链接。</small></div>
    <label><input name="quiet" type="checkbox" ${s.quiet?'checked':''}> 北京时间 22:00–08:00 暂缓发送</label>
    <p class="native-meta">审批是会让任务停摆的事件，会随企业微信通道推送，不受日报/线索勾选项影响。需先在 Key 与服务配置保存机器人 Webhook。</p>
    <button class="btn dark">保存通知订阅</button></form><h3 style="margin-top:20px">实际发送记录</h3>${rows}`);
};

window.wfMonitorForm=function(id){
  const m=(native.monitors||[]).find(x=>x.id===id)||{title:'',keywords:[],interval_minutes:15,cron:'',enabled:false};
  v4Modal(id?'编辑监测规则':'新增监测规则',`<form data-monitor-policy="${id||''}" data-native-monitor="${id||''}">
    <div class="v4-field"><label>监测名称</label><input name="title" required value="${liveEsc(m.title)}"></div>
    <div class="v4-field"><label>关键词（逗号分隔）</label><input name="keywords" required value="${liveEsc((m.keywords||[]).join(','))}"></div>
    <div class="native-fields"><label>采集间隔<select name="interval_minutes">${[5,15,30,60].map(n=>`<option ${n===m.interval_minutes?'selected':''}>${n}</option>`).join('')}</select></label><label>或 cron（北京时间）<input name="cron" value="${liveEsc(m.cron||'')}" placeholder="例如 */15 * * * *"></label></div>
    <p class="wf-note">标题或已归档正文命中关键词时先生成线索；热度跃升独立用于高/中/低优先级，不作为关键词命中的前置条件。无可比热度时显示“无基线”。规则只扫描已归档内容，不会新增平台抓取，也不会自动启动深度研判。</p>
    <label class="native-meta"><input type="checkbox" name="enabled" ${m.enabled?'checked':''}> 启用定时热榜采集与归档内容巡检</label>
    <p class="native-meta">高优先级线索会发企业微信；是否进一步研判由读者决定。</p><button class="btn dark">保存监测规则</button></form>`);
};

document.addEventListener('submit',async e=>{
  const f=e.target;if(!(f instanceof HTMLFormElement))return;
  if(f.matches('[data-notification-policy]')){
    e.preventDefault();e.stopImmediatePropagation();const d=Object.fromEntries(new FormData(f));
    try{await liveApi('/subscriptions','PUT',{enabled:!!d.enabled,channels:['feishu','wecom'].filter(c=>d['channel_'+c]),events:['daily_digest.completed','signal.high_priority','approval.required'].filter(k=>k==='approval.required'?!!d.channel_wecom:!!d['event_'+k]),quiet:!!d.quiet,public_base_url:d.public_base_url||''});v4CloseModal();await nativeSync();showToast('通知订阅已保存');}catch(error){liveError(error);}return;
  }
  if(f.matches('[data-monitor-policy]')){
    e.preventDefault();e.stopImmediatePropagation();const d=Object.fromEntries(new FormData(f)),data={title:d.title,keywords:d.keywords.split(/[,，]/).map(s=>s.trim()).filter(Boolean),enabled:!!d.enabled,interval_minutes:Number(d.interval_minutes),rule:'keyword',growth:2,auto_research:false,action:'notify',budget:20,max_daily_tasks:0,daily_budget:0};if(d.cron.trim())data.cron=d.cron.trim();
    try{const id=f.dataset.monitorPolicy;await liveApi('/monitors'+(id?'/'+id:''),id?'PUT':'POST',data);v4CloseModal();await nativeSync();wfHotRender();showToast('监测规则已保存');}catch(error){liveError(error);}
  }
},true);

// WeCom approval links can open the exact card when DITING_PUBLIC_URL is configured.
const approvalDeepLink=new URLSearchParams(location.search).get('approval_id');
if(approvalDeepLink){setTimeout(()=>{if(typeof v4Go==='function')v4Go('approve');setTimeout(()=>document.getElementById('approval-'+CSS.escape(approvalDeepLink))?.scrollIntoView({behavior:'smooth',block:'center'}),350);},900);}
