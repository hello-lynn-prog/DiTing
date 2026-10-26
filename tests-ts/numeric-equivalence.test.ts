import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalNumericText} from '../packages/domain/numeric-equivalence.js';
import {unsupportedNumericRelations} from '../packages/domain/service.js';
import {reportNumberIssues} from '../packages/reporting/numeric-support.js';

test('exact publication names containing digits do not masquerade as unsupported measurements',()=>{
 const source='在目前已披露的155款拒绝应用中，腾讯及关联生态应用达到66款；阿里巴巴及关联生态应用共有23款。';
 const claim='21世纪经济报道统计155款，其中腾讯关联生态66款、阿里关联生态23款。';
 assert.deepEqual(unsupportedNumericRelations(claim,source),[]);
 assert.deepEqual(reportNumberIssues(claim,source,[],7),[]);
 assert.deepEqual(unsupportedNumericRelations('36氪报道融资规模为42亿美元。','融资规模为42亿美元。'),[]);
 assert.ok(unsupportedNumericRelations(claim.replace('155款','151款'),source).length,'real counts remain checked');
 assert.ok(unsupportedNumericRelations('36氪报道融资规模为36亿美元。','融资规模为42亿美元。').length,'the same numeral as the brand cannot support an amount');
 assert.ok(unsupportedNumericRelations('136氪报道了136款产品。','报道了42款产品。').length,'do not match a suffix inside a different number');
 assert.ok(unsupportedNumericRelations('甲公司42万元。','乙公司42万元。').length,'entity attribution guards stay intact');
});
test('English financial units and calendar months match their exact Chinese equivalents',()=>{
 assert.equal(canonicalNumericText('$16.8 billion, 168亿; 1.5 trillion, 1.5万亿; 2.5 million, 250万'),'$16800000000, 16800000000; 1500000000000, 1500000000000; 2500000, 2500000');
 const source='On October 19, 2026, revenue was $16.8 billion; a valuation of $1.5 trillion was discussed for the November share sale.';
 const claim='2026年10月19日，收入168亿美元，11月股份发售估值讨论约1.5万亿美元。';
 assert.deepEqual(unsupportedNumericRelations(claim,source),[]);
 assert.deepEqual(reportNumberIssues(claim,source,[],7),[]);
 assert.deepEqual(unsupportedNumericRelations('7月21日披露约300亿美元','On July 21, it disclosed about $30 billion'),[]);
 assert.ok(unsupportedNumericRelations('收入1680亿美元',source).length);
 assert.ok(unsupportedNumericRelations('12月发售',source).length);
 assert.ok(reportNumberIssues('收入1680亿美元',source,[],7).length);
 assert.ok(unsupportedNumericRelations('甲公司共有42万元','乙公司共有42万元').length);
 assert.ok(unsupportedNumericRelations('收入42亿元','收入42万元').length);
 assert.ok(unsupportedNumericRelations('2026年7月21日发布','On July 21 it was published').length,'missing source year cannot be invented');
 assert.equal(canonicalNumericText('They may change it. May I ask?'),'They may change it. May I ask?');
});

test('readable report lower bounds are computed from same-unit quantities, never guessed or turned into exact counts',()=>{
 assert.deepEqual(reportNumberIssues('清单涉及逾150款应用。','共计151款应用不允许操作',[],7),[]);
 assert.deepEqual(reportNumberIssues('甲公司超过150款产品。','甲公司共有151款产品',[],7),[]);
 assert.ok(reportNumberIssues('乙公司超过150款产品。','甲公司共有151款产品',[],7).length);
 assert.ok(reportNumberIssues('清单涉及超过150款应用。','共计150款应用',[],7).length);
 assert.ok(reportNumberIssues('清单涉及逾150款应用。','共计149款应用',[],7).length);
 assert.ok(reportNumberIssues('清单涉及逾150款应用。','共计151家企业',[],7).length);
 assert.ok(reportNumberIssues('清单涉及未超过150款应用。','共计151款应用',[],7).length);
 assert.ok(reportNumberIssues('清单涉及150款应用。','共计151款应用',[],7).length);
 assert.ok(reportNumberIssues('收入超过150元。','收入-151元',[],7).length);
 assert.ok(reportNumberIssues('清单涉及逾150款应用。','不超过151款应用',[],7).length);
 assert.ok(reportNumberIssues('清单涉及逾150款应用。','约151款应用',[],7).length);
 assert.ok(reportNumberIssues('清单涉及逾150款应用。','范围0至200款应用',[],7).length);
 assert.deepEqual(reportNumberIssues('清单涉及超过150款应用。','明确超过150款应用',[],7),[]);
});
