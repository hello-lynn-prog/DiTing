import {z} from 'zod';import {hash,encode,type Row} from './db.js';import type {Configuration} from './configuration.js';
const entry=z.object({term:z.string().trim().min(1).max(60),variants:z.array(z.string().trim().min(1).max(60)).min(1).max(20),context:z.string().trim().min(5).max(800),source:z.string().trim().min(1).max(200)}).strict();
export const lexiconSchema=z.object({enabled:z.boolean(),entries:z.array(entry).max(300)}).strict().superRefine((value,ctx)=>{const keys=value.entries.map(e=>e.term.toLocaleLowerCase());if(new Set(keys).size!==keys.length)ctx.addIssue({code:'custom',path:['entries'],message:'词条不能重复'});});
export const defaultLexicon={enabled:true,entries:[
 {term:'生成式AI',variants:['生成式人工智能','AIGC','GenAI'],context:'用于检索相关称呼；同词命中不证明属于同一政策或同一产品。',source:'DiTing项目检索别称初始表'},
 {term:'AI Agent',variants:['AI智能体','人工智能体','Agent应用','智能体落地'],context:'用于检索Agent应用讨论；通用agent一词可能与本主题无关，需回查原文。',source:'DiTing项目检索别称初始表'},
 {term:'世界模型',variants:['world model','world models'],context:'仅扩展中英文相关检索表达，结果需核对具体技术与组织。',source:'DiTing项目检索别称初始表'},
 {term:'物理AI',variants:['physical AI','physical intelligence'],context:'仅是相关检索词，不把不同技术路线或机构视为相同实体。',source:'DiTing项目检索别称初始表'},
 {term:'AI bubble',variants:['AI泡沫','人工智能泡沫','AI估值'],context:'扩展市场讨论用语，不能据词条命中认定已经形成金融泡沫。',source:'DiTing项目检索别称初始表'},
]};
export function freezeLexicon(input:unknown){const parsed=lexiconSchema.parse(input);return {...parsed,version:hash(encode(parsed)),purpose:'query-expansion-only-not-evidence'};}
export function lookupLexicon(frozen:Row,query:string){
 const normalize=(value:string)=>value.toLocaleLowerCase().replace(/\s+/g,''),needle=normalize(query),matches=(frozen.enabled?frozen.entries:[]).filter((e:Row)=>[e.term,...e.variants].some((term:string)=>needle.includes(normalize(term))));
 return {query,version:frozen.version,matches,keywords:[...new Set<string>(matches.flatMap((e:Row)=>[e.term,...e.variants]))].slice(0,30),evidence:false,note:'检索词扩展，不证明暗语含义、主体相同或事实成立；保留上下文与词条来源。'};
}
export class ResearchLexicon{
 constructor(readonly config:Configuration){}
 freeze(){return freezeLexicon(this.config.get('research.lexicon',defaultLexicon));}
 save(input:unknown){const frozen=freezeLexicon(input);this.config.set('research.lexicon',{enabled:frozen.enabled,entries:frozen.entries});return frozen;}
 status(){return this.freeze();}
}
