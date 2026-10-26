import { Database, encode, now, uid, type Row } from '../domain/db.js';

export const investigatorRoles = ['insight', 'media', 'query'] as const;
export type InvestigatorRole = typeof investigatorRoles[number];

/** New tasks preserve the source engine's initial summary plus fixed reflection loops.
 * Missing policy is an archived legacy contract; upgrades never alter an existing task. */
export function engineReflectionPolicy(db:Database,taskId:string,role:InvestigatorRole){
 const policy=JSON.parse(db.one('SELECT config_json FROM tasks WHERE id=?',taskId)!.config_json).engine_reflection_policy;
 const sourceRounds={insight:3,media:2,query:2}[role];
 if(!policy)return {mode:'legacy-adaptive',minimum_summaries:1,maximum_summaries:sourceRounds,reflection_rounds:sourceRounds};
 if(policy.version!==1||policy.mode!=='bettafish-fixed'||policy.initial_summaries!==1||policy.reflection_rounds?.[role]!==sourceRounds)throw Error('本任务反思契约损坏，不能默默更改调查轮数');
 return {mode:'bettafish-fixed',minimum_summaries:1+sourceRounds,maximum_summaries:1+sourceRounds,reflection_rounds:sourceRounds};
}

function currentRoot(db:Database,taskId:string,childSessionId?:string){
  return childSessionId?db.one('SELECT root_session_id FROM agent_runs WHERE task_id=? AND child_session_id=?',taskId,childSessionId)?.root_session_id as string|undefined:undefined;
}
function sessionClause(rootSessionId?:string){return rootSessionId?" AND json_extract(data_json,'$.root_session_id')=?":'';}

export function forumCycle(db:Database,taskId:string,rootSessionId?:string){
  const scope=sessionClause(rootSessionId);
  const reflection=Number(db.one(`SELECT COALESCE(MAX(CAST(json_extract(data_json,'$.cycle') AS INTEGER)),0) n FROM artifacts WHERE task_id=? AND kind='investigation_reflection'${scope}`,...(rootSessionId?[taskId,rootSessionId]:[taskId]))?.n||0);
  const followup=Number(db.one(`SELECT COALESCE(MAX(n),0) n FROM (SELECT COUNT(*) n FROM events e JOIN agent_runs a ON a.child_session_id=json_extract(e.payload_json,'$.child_session_id') AND a.task_id=e.task_id WHERE e.task_id=? AND e.kind='agent.followup' AND a.role IN ('insight','media','query')${rootSessionId?' AND a.root_session_id=?':''} GROUP BY a.child_session_id)`,...(rootSessionId?[taskId,rootSessionId]:[taskId]))?.n||0);
  return Math.max(reflection,followup);
}
export function forumCycleState(db:Database,taskId:string,rootSessionId?:string){
  const cycle=forumCycle(db,taskId,rootSessionId),messages=latestForumMessages(db,taskId,100,rootSessionId).filter(m=>Number(m.cycle||0)===cycle);
  const consumed=new Set<string>(messages.flatMap(message=>Array.isArray(message.source_reflection_ids)?message.source_reflection_ids:[]));
  const scope=sessionClause(rootSessionId);
  const summaries=db.rows(`SELECT id,data_json,created_at FROM artifacts WHERE task_id=? AND kind='investigation_reflection'${scope} ORDER BY rowid`,...(rootSessionId?[taskId,rootSessionId]:[taskId]))
    .filter(row=>Number(JSON.parse(row.data_json).cycle||0)===cycle&&!consumed.has(row.id));
  // BettaFish's Forum monitor opens a host turn after five engine summary
  // messages. Here an investigation reflection is the persisted per-section
  // summary node, so ForumHost is triggered by the same rolling batch size.
  const cycleRound=summaries.length;
  const roles=activeInvestigatorRoles(db,taskId,rootSessionId);
  const runs=db.rows("SELECT status FROM agent_runs WHERE task_id=? AND role IN ('insight','media','query')"+(rootSessionId?' AND root_session_id=?':''),...(rootSessionId?[taskId,rootSessionId]:[taskId]));
  const investigators_finished=runs.length>0&&runs.every(r=>!['starting','running'].includes(r.status));
  // This readiness only controls when ForumHost speaks. Investigators never
  // wait on it and keep their native search/summary/reflection loops running.
  return {cycle,cycleRound,roles,investigators_finished,ready:summaries.length>=5,pending_summary_ids:summaries.map(row=>row.id),pending_summaries:summaries.map(row=>({id:row.id,role:JSON.parse(row.data_json).role||db.one('SELECT role FROM artifacts WHERE id=?',row.id)?.role,section_id:JSON.parse(row.data_json).section_id,findings:JSON.parse(row.data_json).findings,assessment:JSON.parse(row.data_json).assessment}))};
}

export function reflectionHistory(db: Database, taskId: string, role: InvestigatorRole,rootSessionId?:string,sectionId?:string):Array<Row & {data:Row}> {
  const scope=sessionClause(rootSessionId);
  const section=sectionId?" AND json_extract(data_json,'$.section_id')=?":'';
  return db.rows(`SELECT id,data_json,created_at FROM artifacts WHERE task_id=? AND kind='investigation_reflection' AND role=?${scope}${section} ORDER BY rowid`, ...(rootSessionId?[taskId,role,rootSessionId,...(sectionId?[sectionId]:[])]:[taskId,role,...(sectionId?[sectionId]:[])])).map(row => ({ ...row, data: JSON.parse(row.data_json) as Row }));
}

export function submitReflection(db: Database, taskId: string, role: InvestigatorRole, input: Row, childSessionId: string) {
  const rootSessionId=currentRoot(db,taskId,childSessionId);
  const followup=db.one("SELECT COUNT(*) n,COALESCE(MAX(rowid),0) since FROM events WHERE task_id=? AND kind='agent.followup' AND json_extract(payload_json,'$.child_session_id')=?",taskId,childSessionId)!,cycle=Number(followup.n||0);
  const sectionId=String(input.section_id||'overall').trim().slice(0,100)||'overall';
  const history = reflectionHistory(db, taskId, role,rootSessionId,sectionId).filter(r=>Number(r.data.cycle||0)===cycle&&r.data.child_session_id===childSessionId);
  const policy=engineReflectionPolicy(db,taskId,role),reflectionLimit:Record<InvestigatorRole,number>={insight:3,media:2,query:2};reflectionLimit[role]=policy.maximum_summaries;
  if (history.length >= reflectionLimit[role]) throw new Error(`本段已达到 BettaFish 对应的反思上限（${reflectionLimit[role]}）`);
  const last = history.at(-1);
  if (last?.data.decision === 'stop') throw new Error('上轮已明确停止调查；如需补证应由主 Agent 发起新的补证轮');
  const latestReflectionEvent = Math.max(Number(followup.since||0),db.one("SELECT COALESCE(MAX(rowid),0) n FROM events WHERE task_id=? AND kind='investigation.reflection' AND json_extract(payload_json,'$.role')=? AND json_extract(payload_json,'$.child_session_id')=? AND COALESCE(json_extract(payload_json,'$.cycle'),0)=? AND json_extract(payload_json,'$.section_id')=?", taskId, role,childSessionId,cycle,sectionId)?.n || 0);
  const searchNames = new Set(['source_search','media_search','source_fetch','db_ro_query','crawl_deep','evidence_read','media_inspect']);
  const searches = db.rows("SELECT rowid,payload_json FROM events WHERE task_id=? AND kind='tool.completed' AND json_extract(payload_json,'$.role')=? AND json_extract(payload_json,'$.child_session_id')=? AND rowid>? ORDER BY rowid",taskId,role,childSessionId,latestReflectionEvent);
  const completedAfterLast = searches.some(event=>{const payload=JSON.parse(event.payload_json),tool=payload.tool,summary=payload.summary||{};if(!searchNames.has(tool))return false;const belongsToSection=summary.section_id===sectionId||(!summary.section_id&&(tool==='evidence_read'||sectionId==='overall'));if(!belongsToSection)return false;if(tool==='source_fetch')return typeof summary.evidence_id==='string';if(tool==='evidence_read')return typeof summary.evidence_id==='string'&&Number(summary.read_chars)>0;if(tool==='media_inspect')return typeof summary.visual_id==='string';if(tool==='db_ro_query')return summary.query_executed===true||Number(summary.evidence_count)>0; if(tool==='crawl_deep')return summary.executed===true;return summary.search_attempted===true||Number(summary.results_count)>0;});
  if (!completedAfterLast) throw new Error('每轮反思都必须基于本轮实际完成的检索、抓取或本地语料查询');
  const round = history.length + 1;
  if(round<policy.minimum_summaries&&input.decision==='stop')throw Error(`不能提前交卷：本次是${role}第${round}/${policy.minimum_summaries}次总结（首轮1次+追加反思${policy.reflection_rounds}次）。本次总结尚未保存。下一步只将本次decision改为search_more、填入具体next_queries并重交同一section_id/assessment/findings，不必先重复检索；保存成功后再执行下一次不同补查。仅第${policy.minimum_summaries}次总结使用stop。`);
  if (round === reflectionLimit[role] && input.decision !== 'stop') throw new Error(`本引擎达到 BettaFish 对应的反思上限（${reflectionLimit[role]}），请记录缺口并停止本轮`);
  const value = { cycle,section_id:sectionId,round, ...(policy.mode==='bettafish-fixed'?{initial_summary:round===1,reflection_index:round-1,reflection_policy:policy}:{}), assessment: String(input.assessment).trim(), findings: String(input.findings).trim(), decision: input.decision, next_queries: input.next_queries, child_session_id: childSessionId, root_session_id:rootSessionId||null, created_at: now() };
  const id = uid('reflection'); db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)', id, taskId, 'investigation_reflection', role, encode(value), now());
  db.event(taskId, 'investigation.reflection', { message: `${role} 完成第 ${cycle+1} 次调查的第 ${sectionId} 段第 ${round} 轮证据反思`, role,cycle,section_id:sectionId,round, decision: value.decision, artifact_id: id, child_session_id: childSessionId });
  const forum = latestForumMessages(db, taskId, 3,rootSessionId);
  return { artifact_id: id, section_id:sectionId,round,reflection_policy:policy,reflection_limit:reflectionLimit[role],remaining_reflections:reflectionLimit[role]-round,last_round_requires_stop:true,decision: value.decision, message: value.decision==='search_more'?`继续本段下一轮检索；最多还可提交 ${reflectionLimit[role]-round} 轮反思，最后一轮必须 decision=stop，未解决问题保存为缺口，不重新提交 search_more。`:'已记录本段停止判断，可处理其他段落；所有段落完成后提交调查结论及缺口。', latest_forum_feedback: forum };
}

export function assertReflectionGate(db: Database, taskId: string, role: InvestigatorRole,childSessionId?:string,sectionId?:string) {
  const rootSessionId=currentRoot(db,taskId,childSessionId);
  const cycle=childSessionId?Number(db.one("SELECT COUNT(*) n FROM events WHERE task_id=? AND kind='agent.followup' AND json_extract(payload_json,'$.child_session_id')=?",taskId,childSessionId)?.n||0):0;
  const history = reflectionHistory(db, taskId, role,rootSessionId,sectionId).filter(r=>Number(r.data.cycle||0)===cycle&&r.data.child_session_id===childSessionId);
  if (history.length < 1) throw new Error(`${role} 必须先完成至少一轮“检索/读取→证据反思”后才能提交调查结论`);
  const policy=engineReflectionPolicy(db,taskId,role);if(history.length<policy.minimum_summaries)throw Error(`${role} 尚未完成BettaFish首轮总结与${policy.reflection_rounds}轮反思，不能提交调查结论`);
  if (history.at(-1)?.data.decision !== 'stop') throw new Error(`${role} 最后一轮反思必须明确判断停止条件；如需继续，先执行补充查询再反思`);
}

export function latestForumMessages(db: Database, taskId: string, limit = 10,rootSessionId?:string) {
  const scope=sessionClause(rootSessionId);
  return db.rows(`SELECT id,data_json,created_at FROM artifacts WHERE task_id=? AND kind='forum'${scope} ORDER BY rowid DESC LIMIT ?`, ...(rootSessionId?[taskId,rootSessionId,limit]:[taskId,limit])).reverse().map(row => ({ id: row.id, created_at: row.created_at, ...JSON.parse(row.data_json) }));
}

export function latestForumRound(db: Database, taskId: string,rootSessionId?:string) {
  const scope=sessionClause(rootSessionId);
  return Number(db.one(`SELECT COALESCE(MAX(CAST(json_extract(data_json,'$.round') AS INTEGER)),0) n FROM artifacts WHERE task_id=? AND kind='forum'${scope}`, ...(rootSessionId?[taskId,rootSessionId]:[taskId]))?.n || 0);
}

export function activeInvestigatorRoles(db:Database,taskId:string,rootSessionId?:string):InvestigatorRole[]{
  const active=db.rows(`SELECT DISTINCT role FROM agent_runs WHERE task_id=? AND role IN ('insight','media','query')${rootSessionId?' AND root_session_id=?':''}`,...(rootSessionId?[taskId,rootSessionId]:[taskId])).map(r=>r.role as InvestigatorRole);
  return active.length?active:[...investigatorRoles];
}

export function postForumMessage(db: Database, taskId: string, input: Row, childSessionId: string) {
  const round = (db.one("SELECT COALESCE(MAX(CAST(json_extract(data_json,'$.round') AS INTEGER)),0) n FROM artifacts WHERE task_id=? AND kind='forum'", taskId)?.n || 0) + 1;
  const rootSessionId=currentRoot(db,taskId,childSessionId);
  const state=forumCycleState(db,taskId,rootSessionId);
  if(!state.ready)throw new Error(`ForumHost 按 BettaFish 滚动机制需累计5条新引擎摘要；当前只有${state.cycleRound}条`);
  const value = { ...input, round,cycle:state.cycle,cycle_round:state.cycleRound,root_session_id:rootSessionId||null,
    input_evidence_revision:db.one('SELECT evidence_revision FROM tasks WHERE id=?',taskId)!.evidence_revision,
    source_reflection_ids:state.pending_summary_ids,
    child_session_id: childSessionId, created_at: now() };
  const id = uid('forum'); db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)', id, taskId, 'forum', 'forum', encode(value), now());
  db.event(taskId, 'forum.message', { message: `ForumHost 发布第 ${round} 轮主持意见`, artifact_id: id, round, supplements: input.supplements });
  return { artifact_id: id, round, delivered_to_shared_context: true };
}
