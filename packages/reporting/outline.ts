import type {Row} from '../domain/db.js';

export function chineseChapter(n:number):string {
  const digits=['零','一','二','三','四','五','六','七','八','九'];
  if(n<10)return digits[n];if(n<20)return '十'+(n%10?digits[n%10]:'');
  return digits[Math.floor(n/10)]+'十'+(n%10?digits[n%10]:'');
}

/** Preserve native BettaFish numbered outline as structured data, including all subsections. */
export function numberedOutline(markdown:string){
  const chapters:Row[]=[];
  for(const line of markdown.split('\n')){
    const main=line.match(/^-\s+\*\*(\d+)\.0\s+(.+?)\*\*\s*$/);
    if(main){chapters.push({number:Number(main[1]),title:main[2],subsections:[]});continue;}
    const sub=line.match(/^\s+-\s+(\d+\.\d+)\s+(.+?)\s*$/);
    if(sub&&chapters.length&&Number(sub[1].split('.')[0])===chapters.at(-1)!.number)chapters.at(-1)!.subsections.push({number:sub[1],title:sub[2]});
  }
  return chapters;
}

export function subsectionWarnings(sections:Row[],contract:Row){
  const warnings:string[]=[];
  for(const chapter of contract.outline||[]) {
    const section=sections.find(s=>s.title===chapter.title||s.title.startsWith(chapter.title+'：'));
    if(!section)continue;
    const headings=section.text.split('\n').filter((s:string)=>/^###\s/.test(s)).map((s:string)=>s.replace(/^###\s+/,'').trim());
    const missing=chapter.subsections.filter((sub:Row)=>!headings.some((h:string)=>h===sub.number+' '+sub.title||h===sub.title||h.startsWith(sub.number+' '+sub.title+'：')));
    if(missing.length)warnings.push(`章节“${chapter.title}”尚缺模板子节：${missing.map((s:Row)=>s.number+' '+s.title).join('、')}；保留正文，按模板归位，不要重复调查`);
  }
  return warnings;
}
