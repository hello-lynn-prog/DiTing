import test from 'node:test';
import assert from 'node:assert/strict';
import {meaningfulWordCloudTerms} from '../packages/reporting/wordcloud.js';
test('word clouds exclude dates, numeric fragments and page chrome while retaining research terms',()=>{
 assert.deepEqual(meaningfulWordCloudTerms(['2026','10','0月','2026年','发布','来源','the','copyright','世界模型','安全治理','agent','GLM','融资']),['世界模型','安全治理','agent','GLM','融资']);
});
