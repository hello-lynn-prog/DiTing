/** Presentation numbering is not part of a built-in template's chapter identity. */
export function canonicalChapterTitle(title:string,required:string[]){
 const matches=(value:string)=>required.some(name=>value===name||value.startsWith(name+'：')||value.startsWith(name+':'));
 if(matches(title))return title;
 const stripped=title.replace(/^(?:[一二三四五六七八九十百]+\s*[、.．]|第[一二三四五六七八九十百\d]+章\s*[:：、.]?|\d{1,2}\s*[、.．])\s*/, '');
 return matches(stripped)?stripped:title;
}
