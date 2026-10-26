import {test} from 'node:test';import assert from 'node:assert/strict';import {resolve,join} from 'node:path';import {findDshRoot} from '../packages/domain/dsh-path.js';
test('portable dsh discovery prioritizes explicit configuration, project vendor and sibling builds before a legacy checkout',()=>{
 const root=resolve('example-project'),vendor=resolve(root,'vendor/deepseek-harness'),sibling=resolve(root,'../deepseek-harness');
 assert.equal(findDshRoot(root,'../custom',()=>true),resolve(root,'../custom'));assert.equal(findDshRoot(root,undefined,()=>true),vendor);
 assert.equal(findDshRoot(root,undefined,path=>path===join(sibling,'packages/sdk/client/lib/index.js')),sibling);assert.equal(findDshRoot(root,undefined,()=>false),vendor);
});
