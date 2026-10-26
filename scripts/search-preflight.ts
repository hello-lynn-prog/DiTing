/** One real search smoke check; credentials stay in the existing encrypted store.
 * Only diagnostic acquisitions are written to an isolated temporary database.
 */
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Database} from '../packages/domain/db.js';
import {Configuration} from '../packages/domain/configuration.js';
import {Service} from '../packages/domain/service.js';
import {searchWeb} from '../packages/collectors/search.js';
import {ROOT} from '../apps/server/settings.js';
const production=new Database(join(ROOT,'data/diting.sqlite3'),ROOT),secrets=new Configuration(production,join(ROOT,'data')),dir=mkdtempSync(join(ROOT,'tmp/search-check-')),db=new Database(join(dir,'state.sqlite3'),ROOT);
try {
 const config={db,get:secrets.get.bind(secrets),set:secrets.set.bind(secrets),secret:secrets.secret.bind(secrets),hasSecret:secrets.hasSecret.bind(secrets)} as Configuration,task=new Service(db).createTask('明确的真实检索连通性验收，不生成正式报告',null);
 const result=await searchWeb(config,task,'人工智能 监管 官方通报',AbortSignal.timeout(45000));
 const summary={checked_at:new Date().toISOString(),sources:result.sources,result_count:result.results.length,evidence:false,note:'只验证真实搜索协议与返回字段；摘要不是原文，未生成报告'};
 writeFileSync(join(ROOT,'docs/search-live-verification-2026-10-18.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
}finally{db.close();production.close();}
