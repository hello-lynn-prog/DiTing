import {numbers,unsupportedNumericRelations} from '../domain/service.js';
import type {Row} from '../domain/db.js';
import {canonicalNumericText} from '../domain/numeric-equivalence.js';

const normalized=(text:string)=>text.replace(/\s+/g,'').toLocaleLowerCase();
function lowerBoundSupport(text:string,source:string){
 const canonical=canonicalNumericText(source),issues:string[]=[],quantity='(\\d+(?:\\.\\d+)?)\\s*(美元|人民币|欧元|款|家|条|人|件|次|天|个|元|%)';
 const named=(prefix:string)=>{const clause=prefix.split(/[。；;\n，,]/).at(-1)!.replace(/(?:共有|共|有|为|约|至少|超过|逾|多于|不少于|发布了?|达到|合计|收入)+$/g,'').replace(/\s+/g,'');return clause.match(/^(?:[\p{Script=Han}A-Za-z0-9_-]{1,12}(?:公司|集团|机构|团队|小组|组)|(?:Company|Group|Team)[A-Za-z0-9_-]+)$/u)?.[0]||'';};
 const quantities=[...canonical.matchAll(new RegExp(quantity,'g'))].flatMap(m=>{const prefix=canonical.slice(Math.max(0,m.index!-40),m.index);if(/(?:[-−负]|不超过|未超过|不足|少于|至多|最多|不多于|约|近|预计|预期|\d\s*[-~—–至到]|at most|up to|less than|not more than|about|around|approximately)\s*$/i.test(prefix))return [];return [{value:Number(m[1]),unit:m[2],entity:named(prefix),strict:/(?:超过|逾|多于)\s*$/.test(prefix)}];});
 const cleaned=canonicalNumericText(text).replace(new RegExp('(逾|超过|多于|至少|不少于)\\s*'+quantity,'g'),(whole,op,value,unit,offset:number,all:string)=>{
  if(/(?:不|未|没有)$/.test(all.slice(Math.max(0,offset-2),offset)))return whole;
  const entity=named(all.slice(Math.max(0,offset-30),offset)),n=Number(value),supported=Number.isSafeInteger(n)&&quantities.some(q=>Number.isSafeInteger(q.value)&&q.unit===unit&&(!entity||!q.entity||q.entity===entity)&&(op==='至少'||op==='不少于'?q.value>=n:q.value>n||q.value===n&&q.strict));
  if(supported)return '原文支持的数量下界';issues.push(`数量下界“${whole}”未获得同单位原文支持`);return whole;
 });return {text:cleaned,issues};
}

/** Quote/source existence, explicit entity measures and generated table rows are distinct checks.
 * A rolling 16-character English prose window is not a reliable semantic entity identifier.
 */
export function reportNumberIssues(text:string,source:string,tables:Row[],windowDays:number){
  text=text.replace(/^(#{2,5}\s+)\d+(?:\.\d+)+\s+/gm,'$1').replace(/(?:第|参见|详见|见)\s*\d+(?:\.\d+)+\s*(?:小节|节|章|的(?:对照表|表格|分析|讨论|小结|说明))|(?:参见|详见|见)\s*\d+(?:\.\d+)+(?=$|[\s，。；;）)])/g,'章节交叉引用');
  const issues:string[]=[],canonical=normalized(source);
  const bounded=lowerBoundSupport(text.replace(/[“"]([^“”"\n]{5,})[”"]/g,(quote,body:string)=>canonical.includes(normalized(body))?' ':quote),source),unquoted=bounded.text;issues.push(...bounded.issues);
  const supported=source+' '+tables.flatMap(t=>t.rows.flat()).join(' ')+' '+windowDays;
  const allowed=new Set(numbers(canonicalNumericText(supported)));
  const unknown=[...new Set(numbers(canonicalNumericText(unquoted)).filter(n=>!allowed.has(n)))];
  if(unknown.length)issues.push('含无引用或统计底表支持的数字：'+unknown.join('、'));
  const explicit=unsupportedNumericRelations(unquoted,source).filter(n=>/(?:组|公司|企业|机构|团队|部门|地区|省|市)$/.test(n.subject));
  if(explicit.length)issues.push('数字与所引原文主体或单位不匹配：'+explicit.slice(0,12).map(n=>`${n.subject}＝${n.value}${n.unit}`).join('；'));
  const labels=new Map<string,Set<string>>();
  for(const table of tables)for(const row of table.rows){const label=normalized(String(row[0]));const values=labels.get(label)||new Set<string>();values.add(String(row[1]));labels.set(label,values);}
  for(const match of unquoted.matchAll(/([\p{L}\p{N}_.-]+)[”"]?\s*[=:：]\s*(\d+)/gu)){
    const values=labels.get(normalized(match[1]));if(values&&!values.has(match[2]))issues.push(`统计行“${match[1]}”的数值 ${match[2]} 与代码底表不符`);
  }
  return issues;
}
