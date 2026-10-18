// One configuration workspace, with shared state rather than duplicate editors.
const v4ConfigIds=new Set(v4Hub.map(x=>x[0]));
function v4ConfigNav(id){return `<div class="v4-config-nav"><button class="btn" onclick="v4Go('custom')">← 定制中心</button><span class="v4-label">定制中心 / ${v4Esc(v4Hub.find(x=>x[0]===id)?.[1]||'')}</span><nav aria-label="定制中心模块">${v4Hub.map(([key,title])=>`<button class="${key===id?'active':''}" onclick="v4Go('${key}')">${v4Esc(title)}</button>`).join('')}</nav></div>`;}
const v4BeforeConfigGo=v4Go;
v4Go=function(id){v4BeforeConfigGo(id);document.querySelectorAll('.v4-config-nav').forEach(x=>x.remove());if(v4ConfigIds.has(id)){document.getElementById('p-'+id).insertAdjacentHTML('afterbegin',v4ConfigNav(id));document.querySelector('aside a[data-p="custom"]')?.classList.add('on');}};

function v4Consolidate(){
 // Preserve capability text in the single editable registry and remove old duplicate cards.
 const oldSkills=document.querySelector('#p-skill > .cards');
 oldSkills?.querySelectorAll('.card2').forEach((card,i)=>{if(v4Skills[i]){v4Skills[i].original=card.querySelector('.d2')?.innerHTML||'';if(i!==3)v4Skills[i].content=card.querySelector('.d2')?.textContent||v4Skills[i].content;}});
 oldSkills?.remove();v4RefreshRegistry('skill');
 const toolPage=document.getElementById('p-tools');
 toolPage.querySelectorAll(':scope > .panel').forEach(panel=>{panel.querySelectorAll('tr').forEach(row=>{const cells=row.querySelectorAll('td');const item=v4Tools.find(t=>t.name===cells[0]?.textContent.trim());if(item){item.content=cells[2].textContent.trim();item.original=`调用方：${v4Esc(cells[4].textContent.trim())}`;const select=cells[3].querySelector('select');if(select){select.dataset.v4ToolPermission=item.id;item.permissionHTML=select.outerHTML;}}});panel.remove();});
 toolPage.querySelector('.guide').innerHTML='🧭 工具页统一管理原子能力、契约与执行权限。检索供应商凭据和服务地址集中放在 <button class="btn" onclick="v4Go(\'keys\')">Key 与服务配置 →</button>，此处不再重复配置。';
 v4RefreshRegistry('tool');
 const oldMCP=document.querySelector('#p-mcp > .panel');
 oldMCP?.querySelectorAll('tr[onclick]').forEach(row=>{const key=row.getAttribute('onclick').match(/,'([^']+)'/)[1];if(MCPS[key]){const cells=row.querySelectorAll('td');MCPS[key].summary=cells[1].textContent;MCPS[key].members=cells[2].textContent;MCPS[key].status='连接状态待实测';}});
 oldMCP?.remove();document.getElementById('v4-mcp-edit').innerHTML=v4MCPPanel();
 // Provider credentials are edited in one place, referenced by the model page.
 const secret=document.querySelector('#p-llm input[type="password"]');if(secret){const cell=secret.parentElement;cell.innerHTML='<span class="v4-label">使用 Key 中心的供应商凭据</span> <button class="btn" onclick="v4Go(\'keys\')">管理 Key →</button>';}
 // Seven slots are member-level overrides; provider catalog and shared service URLs are separate.
 const note=document.querySelector('#p-keys .v4-slot-grid')?.previousElementSibling;if(note)note.textContent='供应商目录在 LLM 中管理；此处仅设置七个引擎的模型绑定与可选独立凭据，留空时继承供应商配置。';
}
v4Consolidate();
// LiteLLM URL has two useful views but only one saved value.
const v4BeforeServiceSave=v4SaveServices;
v4SaveServices=function(){v4BeforeServiceSave();PROV.litellm.url=v4Services.litellm;};
const v4BeforeProviderSave=v4SaveProvider;
v4SaveProvider=function(){v4BeforeProviderSave();if(v4State.provider==='litellm')v4Services.litellm=PROV.litellm.url;};
document.addEventListener('change',e=>{const el=e.target;if(!el.dataset.v4ToolPermission)return;const item=v4Tools.find(x=>x.id===el.dataset.v4ToolPermission);if(!item)return;[...el.options].forEach(o=>o.toggleAttribute('selected',o.selected));item.permissionHTML=el.outerHTML;});
// Keep the inner module navigation when a data filter re-renders a whole page.
for(const name of ['v4RenderKeys','v4RenderUsage']){const previous=window[name];window[name]=function(...args){previous(...args);const id=name==='v4RenderKeys'?'keys':'usage';if(document.getElementById('p-'+id).classList.contains('on')&&!document.querySelector('#p-'+id+' .v4-config-nav'))document.getElementById('p-'+id).insertAdjacentHTML('afterbegin',v4ConfigNav(id));};}
