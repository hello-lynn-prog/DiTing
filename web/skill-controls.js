/* dsh native instruction skills, managed separately from executable tools. */
'use strict';
const skillConsole={data:null};
const skillRoleNames={main:'主 Agent',insight:'DiTing Ledger · 档案研析',media:'DiTing Prism · 媒介取证',query:'DiTing Trace · 新闻溯源',forum:'ForumHost',planner:'Planner',verifier:'Verifier',advocate:'Advocate',report:'Report'};
const previousExtensions=nativeExtensions;
nativeExtensions=function(id){if(id==='skill')return skillRender();return previousExtensions(id);};
async function skillRender(){
 try{
  const data=await liveApi('/config/extensions/skills');skillConsole.data=data;
  const enabled=data.items.filter(s=>s.enabled).length;
  document.getElementById('p-skill').innerHTML=nativeHead('skill','Skill 技能','dsh 原生技能 · 按角色授权 · 任务内冻结版本')+`
   <div class="wf-note">${liveEsc(data.note)}</div>
   <div class="wf-panel"><div class="wf-between"><div><h3>研究技能库</h3><p class="native-meta">${data.items.length} 个技能 · ${enabled} 个启用 · ${data.calls.filter(c=>c.status==='succeeded').length} 次近期成功读取</p></div><button class="btn dark" onclick="skillEdit()">＋ 新建技能</button></div></div>
   <div class="native-grid">${data.items.map((s,i)=>{
    const mounted=data.mounted.filter(m=>m.skill_id===s.id&&m.version===s.version),calls=data.calls.filter(c=>c.skill_id===s.id&&c.version===s.version);
    return `<article class="native-card" style="--accent:${v4Colors[i%v4Colors.length]}"><div class="wf-between"><h3>${liveEsc(s.name)}</h3>${v4Tag(s.enabled?'已启用':'已停用',s.enabled?'g':'gr')}</div><p>${liveEsc(s.description)}</p><div>${s.roles.map(r=>v4Tag(skillRoleNames[r]||r,'p')).join(' ')}</div><p class="native-meta">当前版本 ${liveEsc(s.version.slice(0,10))}<br>${mounted.length?'此版本已挂载 '+mounted.length+' 个成员会话':'此版本尚未挂载到研究会话'} · ${calls.filter(c=>c.status==='succeeded').length} 次成功读取</p><div class="v4-report-actions"><button class="btn" onclick="skillEdit('${s.id}')">查看 / 编辑指令</button><button class="btn" onclick="skillToggle('${s.id}',${!s.enabled})">${s.enabled?'停用':'启用'}</button></div></article>`;
   }).join('')}</div>
   <div class="wf-panel" style="margin-top:20px"><h3>最近技能调用</h3><p class="native-meta">挂载表示技能进入成员目录；读取表示成员实际调用了 dsh skill 工具，不代表对应业务功能已验收。</p>${data.calls.length?`<div style="overflow:auto"><table class="wf-table"><thead><tr><th>时间 / 任务</th><th>角色 / 技能</th><th>版本</th><th>结果</th></tr></thead><tbody>${data.calls.map(c=>`<tr><td>${liveEsc(liveStamp(c.created_at))}<small>${liveEsc(c.task_id)}</small></td><td>${liveEsc(skillRoleNames[c.role]||c.role)}<small>${liveEsc(c.skill_id)}</small></td><td>${liveEsc(c.version?.slice(0,10)||'未授权')}</td><td>${v4Tag({succeeded:'已读取',failed:'失败',denied:'无权限'}[c.status]||c.status,c.status==='succeeded'?'g':'r')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="wf-empty">尚无实际技能读取记录。研究尚未执行时，这里保持为空。</div>'}</div>`;
 }catch(error){liveError(error);}
}
function skillEdit(id){
 const s=skillConsole.data.items.find(s=>s.id===id)||{id:'',name:'',description:'',content:'',roles:['insight'],enabled:false};
 v4Modal(id?'编辑研究技能':'新建研究技能',`<form data-skill-editor><div class="v4-field"><label>技能 ID（英文小写，单词用 - 连接）</label><input name="id" value="${liveEsc(s.id)}" ${id?'readonly':''} pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="80" required></div><div class="native-fields"><div class="v4-field"><label>显示名称</label><input name="name" value="${liveEsc(s.name)}" maxlength="100" required></div><div class="v4-field"><label>用途说明</label><input name="description" value="${liveEsc(s.description)}" maxlength="2000" required></div></div><div class="v4-field"><label>允许读取的角色（至少一个）</label><div class="v4-report-actions">${Object.entries(skillRoleNames).map(([key,name])=>`<label><input type="checkbox" name="role" value="${key}" ${s.roles.includes(key)?'checked':''}> ${name}</label>`).join('')}</div></div><div class="v4-field"><label>技能指令正文（Markdown）</label><textarea name="content" rows="12" maxlength="50000" style="width:100%;font:14px/1.7 system-ui" placeholder="描述适用场景、执行步骤、检查项和无法完成时的处理方式">${liveEsc(s.content)}</textarea><label>从 .md / SKILL.md 导入正文 <input type="file" accept=".md,text/markdown" data-skill-file></label></div><label><input type="checkbox" name="enabled" ${s.enabled?'checked':''}> 启用，下次新研究启动时生效</label><p class="native-meta">正文只作为研究指令，不执行脚本；已启动任务继续使用冻结版本。内置技能可修改或停用。文件按完整正文导入，元数据请在以上字段填写。</p><button class="btn dark" type="submit">保存技能</button></form>`);
}
async function skillToggle(id,enabled){
 try{const items=skillConsole.data.items.map(s=>skillWritable({...s,enabled:s.id===id?enabled:s.enabled}));await liveApi('/config/extensions/skills','PUT',{items});await skillRender();showToast('已保存；已启动任务保留原技能版本');}catch(error){liveError(error);}
}
function skillWritable(s){return {id:s.id,name:s.name,description:s.description,content:s.content,roles:s.roles,enabled:s.enabled};}
document.addEventListener('change',async event=>{
 if(!event.target.matches('[data-skill-file]'))return;
 const file=event.target.files[0];if(!file)return;
 if(file.size>150000){showToast('技能文件过大，请使用 150 KB 内的 Markdown 文件');event.target.value='';return;}
 const content=await file.text();if(content.length>50000){showToast('技能正文不能超过 50000 字符');event.target.value='';return;}
 event.target.form.elements.content.value=content;
});
document.addEventListener('submit',async event=>{
 const form=event.target;if(!form.matches('[data-skill-editor]'))return;event.preventDefault();
 const d=new FormData(form),entry={id:d.get('id'),name:d.get('name'),description:d.get('description'),content:d.get('content'),roles:d.getAll('role'),enabled:d.has('enabled')};
 try{const items=skillConsole.data.items.filter(s=>s.id!==entry.id).map(skillWritable);items.push(entry);await liveApi('/config/extensions/skills','PUT',{items});v4CloseModal();await skillRender();showToast('技能已保存，下次新研究启动时生效');}catch(error){liveError(error);}
});
