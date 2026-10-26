import test from 'node:test';
import assert from 'node:assert/strict';
import {patchChapterText} from '../packages/reporting/text-patch.js';
test('sentence repairs preserve all other text and apply original offsets, rejecting ambiguous or overlapping edits',()=>{
 const text='第一段原样保留。\n\n原数字57.97万缺少归档依据。\n\n第三段也保留。';assert.equal(patchChapterText(text,[{old:'原数字57.97万缺少归档依据。',new:'本节仅分析已归档文本。'}]),'第一段原样保留。\n\n本节仅分析已归档文本。\n\n第三段也保留。');
 assert.equal(patchChapterText('AAA BBB',[{old:'AAA',new:'BBB'},{old:'BBB',new:'CCC'}]),'BBB CCC');
 assert.throws(()=>patchChapterText('重复重复',[{old:'重复',new:'改'}]),/多次/);
 assert.throws(()=>patchChapterText('完整原句',[{old:'近似原句',new:'改'}]),/不在/);
 assert.throws(()=>patchChapterText('abcdef',[{old:'abc',new:'1'},{old:'bcde',new:'2'}]),/重叠/);
});
