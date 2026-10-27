import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../apps/server/settings.js';
import { Database,encode,uid,now } from '../packages/domain/db.js';
import { Service as CurrentService } from '../packages/domain/service.js';
import { assertReflectionGate, forumCycleState, latestForumMessages, postForumMessage, submitReflection } from '../packages/dsh-diting/investigation-reflection.js';

// Existing cases describe the archived adaptive wire contract. Keep explicit
// compatibility coverage rather than rewriting old persisted tasks on upgrade.
class Service extends CurrentService {
 override createTask(...args:Parameters<CurrentService['createTask']>){const id=super.createTask(...args),policy=JSON.parse(this.rawTask(id).config_json);delete policy.engine_reflection_policy;this.db.run('UPDATE tasks SET config_json=? WHERE id=?',encode(policy),id);return id;}
}

test('new native contracts require an initial summary and every source reflection round, independently per section and role',()=>{
 const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-fixed-reflection-')),'db.sqlite3'),ROOT),task=new CurrentService(db).createTask('固定轮次全链路',null);
 try{for(const role of ['insight','media','query'] as const){
  const child=role+'-child',total=role==='insight'?4:3;
  const input={section_id:'section-1',assessment:'按本段真实取证结果检查具体缺口与反例。',findings:'记录本轮读取原文形成的段落总结，不把没有材料的问题视为已解决。',decision:'search_more',next_queries:['下一项具体核验']};
  for(let round=1;round<=total;round++){
   assert.throws(()=>submitReflection(db,task,role,input,child),/实际完成/);
   db.event(task,'tool.completed',{role,child_session_id:child,tool:'source_fetch',summary:{section_id:'section-1',evidence_id:'different-source-'+round}});
   if(round<total)assert.throws(()=>submitReflection(db,task,role,{...input,decision:'stop'},child),/不能提前交卷/);
   const saved=submitReflection(db,task,role,{...input,decision:round===total?'stop':'search_more',next_queries:round===total?[]:input.next_queries},child);
   assert.equal(saved.round,round);assert.equal(saved.remaining_reflections,total-round);
   if(round<total)assert.throws(()=>assertReflectionGate(db,task,role,child,'section-1'),/尚未完成/);
  }
  assert.doesNotThrow(()=>assertReflectionGate(db,task,role,child,'section-1'));
  assert.throws(()=>assertReflectionGate(db,task,role,child,'section-2'),/至少一轮/);
  assert.throws(()=>submitReflection(db,task,role,input,child),/达到本任务的反思上限/);
  const history=db.rows("SELECT data_json FROM artifacts WHERE task_id=? AND role=? AND kind='investigation_reflection' ORDER BY rowid",task,role).map(r=>JSON.parse(r.data_json));
  assert.equal(history[0].initial_summary,true);assert.deepEqual(history.map(r=>r.reflection_index),Array.from({length:total},(_,i)=>i));
 }}finally{db.close();}
});

test('an unscoped local query supports the default overall section but cannot satisfy a different named section',()=>{
 const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-default-section-')),'db.sqlite3'),ROOT),task=new Service(db).createTask('默认章节检索测试',null),child='query-child';
 try{
  db.event(task,'tool.completed',{role:'insight',tool:'db_ro_query',child_session_id:child,summary:{query_executed:true,evidence_count:1}});
  const reflection={assessment:'已检索本地实际归档材料，范围限定为本次查询。',findings:'已取得本地检索目录，保留后续逐字核验要求。',decision:'stop',next_queries:[]};
  assert.throws(()=>submitReflection(db,task,'insight',{...reflection,section_id:'another'},child),/实际完成/);
  assert.doesNotThrow(()=>submitReflection(db,task,'insight',reflection,child));
  assert.doesNotThrow(()=>assertReflectionGate(db,task,'insight',child));
 }finally{db.close();}
});

test('ForumHost can detect investigators have finished instead of waiting for a batch that will never arrive',()=>{
  const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-forum-finish-')),'db.sqlite3'),ROOT),task=new Service(db).createTask('论坛退出条件',null),root='current-root';
  for(const role of ['insight','media','query'])db.run('INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?,?,?)',uid('run'),task,root,role+'-child',role,'idle',null,now(),now());
  const state=forumCycleState(db,task,root);assert.equal(state.investigators_finished,true);assert.equal(state.ready,false);db.close();
});

test('investigators use source-backed reflection; ForumHost runs independently after five new section summaries',()=>{
  const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-reflection-')),'db.sqlite3'),ROOT),service=new Service(db),task=service.createTask('调查反思状态机测试',null),roles=['insight','media','query'] as const;
  const child=(role:typeof roles[number])=>`${role}-child`;
  for(const role of roles){db.event(task,'tool.completed',{role,child_session_id:child(role),tool:'source_search',summary:{section_id:'overall',results_count:4}});submitReflection(db,task,role,{section_id:'overall',assessment:'首轮材料已记录，当前仍可补充核验原发来源。',findings:'发现一条需要继续核对的观点，后续应查找发布方原文。',decision:'search_more',next_queries:['查找发布方原文']},child(role));}
  assert.equal(forumCycleState(db,task).ready,false);
  assert.throws(()=>postForumMessage(db,task,{summary:'三引擎首轮材料仍有不同来源与时间线需要核对。',disagreements:[],supplements:[]},'forum-child'),/当前只有3条/);
  for(let i=0;i<2;i++)db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',uid('reflection'),task,'investigation_reflection','insight',encode({cycle:0,section_id:`section-${i+4}`,round:1,findings:'另一个段落的已存摘要。'}),now());
  const state=forumCycleState(db,task);assert.equal(state.ready,true);assert.equal(state.pending_summary_ids.length,5);
  postForumMessage(db,task,{summary:'主持人基于五条新摘要归并已核验共识并保留待核实分歧。',disagreements:['事件发生日期的来源记录还不一致。'],supplements:['Query 请补查发布方原始公告并核对日期。']},'forum-child');
  assert.equal(forumCycleState(db,task).ready,false);
  for(const role of roles){const input={section_id:'overall',assessment:'第二轮开始前没有新增检索，不能提交反思。',findings:'当前没有本轮新增发现，因此不应提交。',decision:'search_more' as const,next_queries:['补充']};assert.throws(()=>submitReflection(db,task,role,input,child(role)),/每轮反思都必须基于本轮实际完成的检索/);db.event(task,'tool.completed',{role,child_session_id:child(role),tool:'source_fetch',summary:{section_id:'other',evidence_id:'evidence_fixture'}});assert.throws(()=>submitReflection(db,task,role,input,child(role)),/每轮反思都必须基于本轮实际完成的检索/);db.event(task,'tool.completed',{role,child_session_id:child(role),tool:'source_fetch',summary:{section_id:'overall',evidence_id:'evidence_fixture'}});submitReflection(db,task,role,{...input,assessment:'本轮补查了原始来源并检查尚存争议。',findings:'新增原始页面回应了需要核对的日期问题。',decision:'stop',next_queries:[]},child(role));}
  for(const role of roles)assert.doesNotThrow(()=>assertReflectionGate(db,task,role,child(role)));
  assert.equal(latestForumMessages(db,task,10).length,1);
  db.event(task,'agent.followup',{child_session_id:child('insight')});
  assert.throws(()=>assertReflectionGate(db,task,'insight',child('insight')),/必须先完成至少一轮/);
  db.event(task,'tool.completed',{role:'insight',child_session_id:child('insight'),tool:'db_ro_query',summary:{section_id:'overall',query_executed:true,evidence_count:0}});
  submitReflection(db,task,'insight',{section_id:'overall',assessment:'本次补证重新查过资料，但尚无新增的真实来源。',findings:'需要本次主持人检查未解决的资料覆盖缺口。',decision:'search_more',next_queries:['补证来源']},child('insight'));
  assert.equal(forumCycleState(db,task).ready,false); // a new supplement cycle starts its own five-summary batch
  db.close();
});

test('legacy adaptive caps stay frozen and ForumHost consumes only its rolling batch',()=>{
  const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-third-reflection-')),'db.sqlite3'),ROOT),task=new Service(db).createTask('滚动主持批次',null);
  for(const role of ['media','query'] as const)for(let round=1;round<=2;round++)db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',uid('reflection'),task,'investigation_reflection',role,encode({cycle:0,section_id:'overall',round,decision:'search_more',child_session_id:`${role}-child`}),now());
  const input={section_id:'overall',assessment:'已完成本引擎源码设定的反思轮数。',findings:'现有材料仍有缺口，提交结论时应明确标注。',decision:'stop',next_queries:[]};
  assert.throws(()=>submitReflection(db,task,'media',input,'media-child'),/达到本任务的反思上限/);
  for(let i=0;i<5;i++)db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',uid('reflection'),task,'investigation_reflection',['insight','media','query'][i%3],encode({cycle:0,section_id:`s${i}`,round:1,findings:`摘要${i}`}),now());
  assert.equal(forumCycleState(db,task).ready,true);
  postForumMessage(db,task,{summary:'主持人基于当前收到的五条成员摘要归纳分歧与待补证事项。',disagreements:['当前资料对时间线仍有不同表述。'],supplements:['继续核对发布方原始信息。']},'forum-child');
  assert.equal(latestForumMessages(db,task,10).length,1);assert.equal(forumCycleState(db,task).ready,false);db.close();
});

test('a resumed ForumHost sees only summaries from its own dsh root session',()=>{
  const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-forum-resume-')),'db.sqlite3'),ROOT),task=new Service(db).createTask('恢复会话主持轮次隔离',null),oldRoot='root-old',root='root-new';
  for(let round=1;round<=3;round++)db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',uid('forum'),task,'forum','forum',encode({round,cycle:0,cycle_round:round,root_session_id:oldRoot,source_reflection_ids:[],summary:'之前会话的已存主持记录。'}),now());
  for(let i=0;i<5;i++)db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',uid('reflection'),task,'investigation_reflection',['insight','media','query'][i%3],encode({cycle:0,section_id:`section-${i}`,round:1,root_session_id:root,findings:'本恢复会话的一条摘要。'}),now());
  for(const role of ['insight','media','query','forum'] as const)db.run('INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?,?,?)',uid('run'),task,root,`child-${role}`,role,'running',null,now(),now());
  const state=forumCycleState(db,task,root);assert.equal(state.cycleRound,5);assert.equal(state.ready,true);assert.equal(state.pending_summary_ids.length,5);
  postForumMessage(db,task,{summary:'本次恢复后的主持意见绑定到本会话的五条摘要。',disagreements:[],supplements:[]},'child-forum');
  assert.equal(latestForumMessages(db,task,10,root).length,1);assert.equal(db.rows("SELECT id FROM artifacts WHERE task_id=? AND kind='forum'",task).length,4);db.close();
});

test('an archived evidence read is valid source work when its dsh event has no section annotation',()=>{
  const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-unscoped-read-')),'db.sqlite3'),ROOT),task=new Service(db).createTask('已归档材料逐段研读',null),child='media-child';
  db.event(task,'tool.completed',{role:'media',child_session_id:child,tool:'evidence_read',summary:{evidence_id:'evidence_saved',read_chars:900,offset:0}});
  assert.doesNotThrow(()=>submitReflection(db,task,'media',{section_id:'section-1',assessment:'阅读了本任务归档原文，明确了下一步需核验的事项。',findings:'原文提供了当前段落所需的可引用依据。',decision:'stop',next_queries:[]},child));
  assert.doesNotThrow(()=>assertReflectionGate(db,task,'media',child));db.close();
});

test('rolling HOST never reopens a batch already consumed by an earlier host message',()=>{
 const db=new Database(join(mkdtempSync(join(tmpdir(),'diting-host-consumed-union-')),'db.sqlite3'),ROOT),task=new Service(db).createTask('滚动去重验收',null);
 try{for(let batch=0;batch<3;batch++){
  const added:string[]=[];for(let i=0;i<5;i++){const id=uid('reflection');added.push(id);db.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?)',id,task,'investigation_reflection','insight',encode({cycle:0,section_id:`s-${batch}-${i}`,round:1,findings:'真实新批次摘要'}),now());}
  assert.deepEqual(forumCycleState(db,task).pending_summary_ids,added);postForumMessage(db,task,{summary:'主持人处理本批五条新摘要并形成共识和分歧记录。',disagreements:[],supplements:[]},'forum-child');
  assert.equal(forumCycleState(db,task).ready,false);assert.deepEqual(forumCycleState(db,task).pending_summary_ids,[]);
 }}finally{db.close();}
});
