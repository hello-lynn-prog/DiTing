/** Exact decimal scaling for lexical validation; never rewrites archived quotes. */
function shift(value:string,places:number){
 const [whole,fraction='']=value.replaceAll(',','').split('.');
 const digits=(whole+fraction).replace(/^0+(?=\d)/,'');
 const exponent=places-fraction.length;
 if(exponent>=0)return (digits+'0'.repeat(exponent)).replace(/^0+(?=\d)/,'');
 const padded=digits.padStart(-exponent+1,'0'),at=padded.length+exponent;
 return (padded.slice(0,at)+'.'+padded.slice(at)).replace(/0+$/,'').replace(/\.$/,'');
}
const monthNames=['January','February','March','April','May','June','July','August','September','October','November','December'];
const monthPattern=monthNames.join('|');
/** Deterministic unit/calendar equivalence, not entity attribution or factual verification. */
export function canonicalNumericText(text:string){
 const month=(value:string)=>String(monthNames.findIndex(x=>x.toLowerCase()===value.toLowerCase())+1);
 text=text.replace(new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,'gi'),(_m,name,day,year)=>`${year?year+'年':''}${month(name)}月${Number(day)}日`)
   .replace(new RegExp(`\\b(\\d{1,2})\\s+(${monthPattern})(?:\\s+(\\d{4}))?\\b`,'gi'),(_m,day,name,year)=>`${year?year+'年':''}${month(name)}月${Number(day)}日`)
   .replace(new RegExp(`\\b(?:in|by|until|during|on)\\s+(${monthPattern})\\b`,'gi'),(_m,name)=>month(name)+'月')
   .replace(new RegExp(`\\b(${monthNames.filter(x=>x!=='May').join('|')})\\b`,'g'),name=>month(name)+'月');
 const scales:Record<string,number>={thousand:3,million:6,billion:9,trillion:12,'万亿':12,'亿':8,'万':4};
 return text.replace(/(\d+(?:,\d{3})*(?:\.\d+)?)\s*(trillion|billion|million|thousand|万亿|亿|万)(?![a-z])/gi,(_m,value,scale)=>shift(value,scales[scale.toLowerCase()]));
}
