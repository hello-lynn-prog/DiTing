import {test} from 'node:test';
import assert from 'node:assert/strict';
import {streamUsage} from '../packages/dsh-diting/stream-accounting.js';

test('failed adapter zero counters keep cost unknown while actual billed failed output is retained',()=>{
  assert.deepEqual(streamUsage({inputTokens:0,outputTokens:0},'failed'),{input:null,output:null,cache:null});
  assert.deepEqual(streamUsage(undefined,'failed'),{input:null,output:null,cache:null});
  assert.deepEqual(streamUsage({inputTokens:100,outputTokens:20,cacheReadTokens:40},'failed'),{input:140,output:20,cache:40});
  assert.deepEqual(streamUsage({inputTokens:100,outputTokens:20,cacheReadTokens:40,cacheWriteTokens:10},'succeeded'),{input:150,output:20,cache:40});
  assert.deepEqual(streamUsage({inputTokens:-1,outputTokens:20},'succeeded'),{input:null,output:null,cache:null});
});
