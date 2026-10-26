'use strict';
const recoverySystem = nativeSystem;
nativeSystem = function () { recoverySystem(); const input = document.querySelector('[name=max_calls]'); if (input) input.max = '2000'; };
const recoveryTitle=value=>value.length<=70?value:value.split(/[。；;，,\n]/)[0].slice(0,70)+'…';
const recoveryDetail=wfDetail;
wfDetail=function(){recoveryDetail();const task=wfTask(wf.task),page=document.getElementById('p-tasks');if(!task)return;const title=page.querySelector('.topbar h1');if(title){title.textContent=recoveryTitle(task.title);title.title=task.title;}if(wf.tab==='过程'){const panel=[...page.querySelectorAll('.wf-panel')].find(p=>p.querySelector('h3')?.textContent==='研究要求');if(panel){const p=panel.querySelector('p');if(p)p.innerHTML=`<details><summary>查看完整研究要求</summary><div style="white-space:pre-wrap;overflow-wrap:anywhere;margin-top:12px">${liveEsc(task.title)}</div></details>`;}}};
wfStats=function(){const attention=['等待执行器','等待补充','等待审批','等待证据','待审核','失败'];return `<div class="wf-stats">${[['运行中',wfTasks.filter(t=>t.status==='运行中').length,'#486df1'],['排队中',wfTasks.filter(t=>t.status==='排队中').length,'#8260df'],['待处理',wfTasks.filter(t=>attention.includes(t.status)).length,'#d69a25'],['报告成果',rcRows.length,'#19a77f']].map(([label,n,c])=>`<button style="--wf-accent:${c}" onclick="wf.task=null;wf.filter='${label==='报告成果'?'全部':label}';v4Go('${label==='报告成果'?'report':'tasks'}')"><span>${label}</span><b>${n}</b></button>`).join('')}</div>`;};
const recoveryStyle=document.createElement('style');recoveryStyle.textContent='#p-tasks>.topbar{align-items:flex-start;gap:20px}#p-tasks>.topbar>div:first-child{flex:1;min-width:0}#p-tasks>.topbar .wf-actions{flex-shrink:0;flex-wrap:wrap;max-width:300px}#p-tasks>.topbar h1{font-size:24px;line-height:1.5;overflow-wrap:anywhere}.wf-list-item b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.wf-title{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}@media(max-width:800px){#p-tasks>.topbar{flex-wrap:wrap}}';document.head.appendChild(recoveryStyle);

const recoveryTaskBody = wfTaskBody;
wfTaskBody = function (task) {
  const original = recoveryTaskBody(task);
  if(wf.tab==='资料与证据'||wf.tab==='证据链'||wf.tab==='过程'){const visuals=(task.remote?.artifacts||[]).map(productArtifact).filter(a=>a.kind==='visual_observation');if(visuals.length)return `<div class="wf-panel"><div class="wf-between"><h3>视觉素材与观察</h3><button class="btn" onclick="productVisuals('${task.id}')">查看素材、抽帧与费用</button></div><p class="native-meta">${visuals.length} 份模型观察已归档；视频仅限已标注抽帧范围，真实性仍须核验。</p></div>`+original;}
  if (wf.tab !== '报告产物') return original;
  const artifacts = (task.remote?.artifacts || []).map(productArtifact), chapters = artifacts.filter(a => a.kind === 'report_stage' && a.data.stage === 'chapter');
  if (!chapters.length) return original;
  const lastError = artifacts.filter(a => a.kind === 'report_validation').at(-1)?.data.message;
  return `<div class="wf-panel"><div class="wf-between"><div><h3>已保存的报告草稿</h3><p class="native-meta">${new Set(chapters.map(a => a.data.data.id)).size} 个章节已有正文；草稿与正式交付版本分别标记。</p></div><button class="btn dark" onclick="productDraft('${task.id}')">查看已保存草稿</button></div>${lastError ? `<div class="wf-note">最近校验：${liveEsc(lastError)}</div>` : ''}</div>` + original;
};
async function productVisuals(taskId) {
  try {
    const data = await liveApi('/tasks/' + taskId + '/visual');
    const cost = value => value == null ? '费用待核对' : '¥' + Number(value).toFixed(6);
    v4Modal('视觉素材与观察记录', data.observations.length ? data.observations.map(v => {
      const a = data.assets.find(a => a.id === v.asset_id), base = '/api/tasks/' + taskId + '/visual/' + v.asset_id;
      return `<article class="native-card"><h3>${liveEsc(v.observation.summary)}</h3>
        <p>${liveEsc(a?.media_type)} · ${a?.frames.length || 0} 张实际输入帧${a?.media_type.startsWith('video/') ? ' · 前90秒内采样，无音频' : ''}</p>
        <div style="display:flex;gap:12px;overflow:auto;padding:8px 0">${(a?.frames || []).map((f, i) => `<figure style="margin:0;min-width:140px"><a href="${base}/frame/${i}" target="_blank" rel="noopener"><img src="${base}/frame/${i}" alt="模型实际读取的第 ${i + 1} 帧" style="height:120px;max-width:220px;object-fit:contain;border-radius:8px;background:#f1f3fa" loading="lazy"></a><figcaption>帧 ${i}${f.seconds == null ? '' : ' · 约 ' + f.seconds + ' 秒'}</figcaption></figure>`).join('')}</div>
        <ul>${v.observation.observations.map(o => '<li>' + liveEsc(o.text) + ' · 帧 ' + o.frame_index + '</li>').join('')}</ul>
        <p>${liveEsc(v.observation.limitations.join('；'))}</p>
        <p><strong>${cost(v.cost)}</strong> · ${liveEsc(v.model)} · 输入 ${v.input_tokens ?? '未知'} / 缓存 ${v.cache_tokens ?? '未知'} / 输出 ${v.output_tokens ?? '未知'} Token</p>
        <a class="btn" target="_blank" rel="noopener" href="${base}/file">打开归档素材</a>
        <details><summary>来源与调用账目编号</summary><p>${liveEsc(a?.source_url)}</p><p>SHA256 ${liveEsc(a?.content_hash)}</p><p>${liveEsc(v.call_id)}</p></details></article>`;
    }).join('') : '<p>本任务尚无完成的视觉观察。已有图片链接并不代表已识别画面。</p>');
  } catch (error) { liveError(error); }
}
async function productDraft(taskId) {
  try {
    const draft = await liveApi('/tasks/' + taskId + '/report-draft');
    v4Modal('报告草稿 · 尚未发布', `<p>已保存 ${draft.document.sections.length} 个章节、${draft.document.tables.length} 张底表。</p><div class="wf-actions"><a class="btn dark" href="/api/tasks/${taskId}/report-draft/html" target="_blank" rel="noopener">打开完整图文草稿 ↗</a><a class="btn" href="/api/tasks/${taskId}/report-draft/md" download="research-draft.md">下载草稿 Markdown</a></div>${draft.validation_errors.length ? '<p>正文仍有引用或数字口径问题，任务正在修订；草稿可先阅读。</p><details><summary>展开具体校验问题</summary><pre style="max-height:35vh;overflow:auto;white-space:pre-wrap">'+liveEsc(draft.validation_errors.join('\n'))+'</pre></details>' : '<p>正文结构校验已通过，仍需完成正式导出与发布。</p>'}`);
  } catch (error) { liveError(error); }
}

const recoverySources = wfSources;
wfSources = function () {
  recoverySources();
  document.querySelectorAll('#p-src .src-service').forEach((card, index) => {
    const service = native.services[index], state = card.querySelector('.src-state');
    if (!service || !state) return;
    const health = service.health || {};
    if (health.checked_at) {
      state.className = 'src-state ' + (health.status === 'succeeded' ? 'ok' : 'bad');
      state.textContent = health.status === 'succeeded' ? '最近实测成功' : '最近实测失败';
      card.insertAdjacentHTML('beforeend', `<p class="native-meta">${liveEsc(liveStamp(health.checked_at))}${health.status === 'succeeded' ? ' · 返回 ' + health.result_count + ' 条线索' : ' · ' + liveEsc(health.last_error || '查看流水')}</p>`);
    }
    if (['bocha', 'tavily', 'anspire'].includes(service.id) && service.enabled && service.key_configured)
      card.insertAdjacentHTML('beforeend', `<button class="btn" onclick="nativeCheckSearch('${service.id}')">重新实测</button>`);
  });
};
async function nativeCheckSearch(provider) {
  try {
    showToast('正在实测 ' + provider + '，结果会保存到采集流水');
    const result = await liveApi('/config/services/' + provider + '/check', 'POST', {});
    await nativeSync(); wfSources();
    showToast(result.error || `${provider} 连接成功：${result.count} 条发现线索`);
  } catch (error) { liveError(error); }
}

const recoveryRecords = wfRecords;
wfRecords = function () {
  recoveryRecords();
  const root = document.getElementById('p-crawl'); if (!root) return;
  const rows = (wf.records || []).filter(r => (!wf.recordTask || r.task === wf.recordTask) && (!wf.recordSource || r.source === wf.recordSource));
  const failed = rows.filter(r => ['failed', '失败'].includes(r.status)), types = new Map();
  for (const row of failed) types.set(row.operation, (types.get(row.operation) || 0) + 1);
  const label = root.querySelectorAll('.acq-count span')[2]; if (label) label.textContent = '历史失败次数';
  root.querySelector('.acq-summary')?.insertAdjacentHTML('afterend', `<div class="wf-note">这里按执行次数累计，包含同一渠道的历史失败重试，不代表当前失败的平台数。${[...types].map(([operation, n]) => liveEsc(acquisitionOperationNames[operation] || operation) + '：' + n + ' 次').join('；') || '当前筛选下暂无失败记录。'}。充值或恢复后，最新健康状态请看“信源”；历史记录保留供审计。</div>`);
  root.querySelectorAll('.acq-record').forEach(card => {
    const id = card.querySelector('.acq-id code')?.textContent;
    if (id) card.querySelector('.acq-id')?.insertAdjacentHTML('beforeend', `<button class="btn" onclick="nativeRecordDetail('${liveEsc(id)}')">查看执行详情 / 原始响应</button>`);
  });
};
async function nativeRecordDetail(id) {
  try {
    const row = await liveApi('/acquisitions/' + id);
    v4Modal('采集执行详情', `<h3>${liveEsc(row.source)}</h3><p>${liveEsc(row.detail)}</p><p class="native-meta">${liveEsc(row.id)} · ${liveEsc(liveStamp(row.created_at))} · HTTP ${row.http_status ?? '历史记录未保存'}</p>${row.raw_response_saved ? `<h4>请求范围</h4><pre>${liveEsc(JSON.stringify(row.request, null, 2))}</pre><h4>供应商响应</h4><pre style="max-height:50vh;overflow:auto;white-space:pre-wrap">${liveEsc(JSON.stringify(row.response, null, 2))}</pre>` : '<p>这条旧记录只保存了状态与说明，未保存原始响应；不会补造历史响应。新检索响应会自动归档。</p>'}`);
  } catch (error) { liveError(error); }
}
