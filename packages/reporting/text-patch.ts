/** Exact, non-overlapping edits against the original saved chapter; never fuzzy matching. */
export function patchChapterText(text:string,edits:{old:string;new:string}[]){
 const spans=edits.map(edit=>{if(!edit.old)throw Error('原句不能为空');const at=text.indexOf(edit.old);if(at<0)throw Error('原句不在已保存正文中，请逐字复制');if(text.indexOf(edit.old,at+1)!==-1)throw Error('原句出现多次，请提供唯一的完整句子');return {start:at,end:at+edit.old.length,replacement:edit.new};}).sort((a,b)=>a.start-b.start);
 for(let i=1;i<spans.length;i++)if(spans[i].start<spans[i-1].end)throw Error('替换片段重叠，请合并成一个唯一原句');
 let result=text;for(const span of spans.reverse())result=result.slice(0,span.start)+span.replacement+result.slice(span.end);return result;
}
