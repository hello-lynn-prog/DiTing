import {test} from 'node:test';import assert from 'node:assert/strict';import {zstdCompressSync} from 'node:zlib';import {decodeDshLog} from '../packages/domain/dsh-log-reader.js';
test('readable dsh export decodes all concatenated frames and retains complete records before a partial final frame',()=>{
 const one=zstdCompressSync(Buffer.from('{"type":"session"}\n')),two=zstdCompressSync(Buffer.from('{"type":"tool","text":"原始正文"}\n'));
 const full=decodeDshLog(Buffer.concat([one,two]));assert.equal(full.frames,2);assert.equal(full.status,'complete');assert.equal(full.text.split('\n').filter(Boolean).length,2);assert.equal(full.trailing_bytes,0);
 const partial=decodeDshLog(Buffer.concat([one,two.subarray(0,Math.floor(two.length/2))]));assert.equal(partial.status,'partial');assert.equal(partial.frames,1);assert.equal(partial.text,'{"type":"session"}\n');assert.ok(partial.trailing_bytes>0);
 assert.equal(decodeDshLog(Buffer.from('corrupt')).frames,0);
});
