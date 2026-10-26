import type {Row} from '../domain/db.js';

export function verbatimQuote(content:string,quote:string):string|null{
  if(content.includes(quote))return quote;
  // Retain the original text, allowing only the layout whitespace lost during writing.
  const apostrophe="(?:'|‘|’|&#39;|&#x27;|&#8217;|&apos;)",entities:Record<string,string>={"'":apostrophe,'‘':apostrophe,'’':apostrophe,'"':'(?:"|&quot;|&#34;)', '&':'(?:&|&amp;)','<':'(?:<|&lt;)','>':'(?:>|&gt;)'};
  const pattern=quote.trim().split(/\s+/).map(s=>[...s].map(c=>entities[c]||c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('')).join('\\s+');
  return content.match(new RegExp(pattern))?.[0]||null;
}

/** Resolve a literal source quotation deterministically; never infer a source from a number. */
export function bindReportQuotes(text:string,evidence:Row[]){
  const references:{evidence_id:string;quote:string}[]=[],ambiguous:string[]=[];
  for(const match of text.matchAll(/[“"]([^“”"\n]{20,2000})[”"]/g)){
    const matches=evidence.flatMap(e=>{const quote=verbatimQuote(e.content,match[1]);return quote?[{evidence_id:e.id,quote}]:[];});
    if(matches.length)references.push(...matches);
    if(matches.length>1)ambiguous.push(match[1]); // Same quotation in several pages is not independent corroboration.
  }
  return {references:[...new Map(references.map(r=>[r.evidence_id+'\n'+r.quote,r])).values()],ambiguous};
}
