import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceWindow } from '../packages/dsh-diting/evidence-window.js';

test('evidence windows return bounded contiguous text and continuation metadata',()=>{
  const text='abcdefghij';
  const first=evidenceWindow(text,0,4);
  assert.deepEqual(first,{total_chars:10,offset:0,content:'abcd',has_more:true,next_offset:4});
  const second=evidenceWindow(text,first.next_offset!,4);
  assert.deepEqual(second,{total_chars:10,offset:4,content:'efgh',has_more:true,next_offset:8});
  const last=evidenceWindow(text,second.next_offset!,4);
  assert.deepEqual(last,{total_chars:10,offset:8,content:'ij',has_more:false,next_offset:null});
});
