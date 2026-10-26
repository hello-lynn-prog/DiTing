import { z } from 'zod';
import { hash, uid, type Row } from './db.js';
import type { Configuration } from './configuration.js';
import { skillRoles } from './skills.js';

const secretsSchema=z.object({env:z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/),z.string().max(16000)).default({}),headers:z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/),z.string().max(16000)).default({})}).strict();
const grantSchema=z.object({name:z.string().regex(/^[A-Za-z0-9_-]{1,50}$/),roles:z.array(z.enum(skillRoles)).min(1).max(9)}).strict();
export const mcpSchema=z.object({
  id:z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),name:z.string().trim().min(1).max(100),description:z.string().max(2000).default(''),enabled:z.boolean().default(false),
  transport:z.enum(['stdio','streamable-http']).default('streamable-http'),
  url:z.string().max(2000).default(''),command:z.string().max(2000).default(''),args:z.array(z.string().max(2000)).max(40).default([]),cwd:z.string().max(2000).default(''),
  tools:z.array(grantSchema).max(40).default([]),timeout_ms:z.number().int().min(1000).max(60000).default(15000),max_calls:z.number().int().min(1).max(100).default(10),
}).strict().superRefine((s,ctx)=>{
  if(s.enabled&&!s.tools.length)ctx.addIssue({code:'custom',path:['tools'],message:'启用 MCP 必须列出精确工具名和角色授权'});
  if(new Set(s.tools.map(t=>t.name)).size!==s.tools.length)ctx.addIssue({code:'custom',path:['tools'],message:'工具名不可重复'});
  if(s.tools.some(t=>7+s.id.length+t.name.length>64))ctx.addIssue({code:'custom',path:['tools'],message:'MCP 公共工具名须在 64 字符内，请缩短服务 ID 或工具名'});
  if(s.url){try{const u=new URL(s.url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error();}catch{ctx.addIssue({code:'custom',path:['url'],message:'端点须为 HTTP/HTTPS；凭据请填私密配置，不放 URL 参数'});}}
  if(s.enabled&&(s.transport==='stdio'?!s.command:!s.url))ctx.addIssue({code:'custom',message:'启用前必须配置对应的启动命令或 MCP 端点'});
});
export type McpServer=z.infer<typeof mcpSchema>&{key_ref?:string};
export const mcpName=(id:string,tool:string)=>`mcp__${id}__${tool}`;
export class Mcp {
  constructor(readonly config:Configuration){}
  items():McpServer[]{return this.config.get<Row[]>('mcp',[]).map(({key_ref,...s})=>{
    const entry=mcpSchema.parse({...s,enabled:s.enabled&&Array.isArray(s.tools)&&s.tools.length>0});return {...entry,...key_ref?{key_ref}:{}};
  });}
  save(input:unknown){
    const {items}=z.object({items:z.array(z.object({config:mcpSchema,credentials:secretsSchema.optional()}).strict()).max(20)}).strict().parse(input);
    if(new Set(items.map(s=>s.config.id)).size!==items.length)throw new Error('MCP 服务 ID 不可重复');
    const previous=new Map(this.items().map(s=>[s.id,s]));
    this.config.db.transaction(()=>{
      const next=items.map(({config,credentials})=>{
        let key_ref=previous.get(config.id)?.key_ref;
        if(credentials){key_ref=`mcp.${config.id}.${uid('key')}`;this.config.putSecret(key_ref,JSON.stringify(credentials));}
        return {...config,...key_ref?{key_ref}:{}};
      });this.config.set('mcp',next);
    });return this.status();
  }
  freeze(){return this.items().filter(s=>s.enabled).map(s=>({...s,version:hash(JSON.stringify(s))}));}
  status(){
    const items=this.items().map(s=>({...s,key_ref:undefined,credentials_configured:!!s.key_ref&&this.config.hasSecret(s.key_ref),status:s.enabled?'ready_for_next_run':'disabled'}));
    const records=this.config.db.rows("SELECT task_id,kind,created_at,payload_json FROM events WHERE kind IN ('mcp.mounted','mcp.failed','mcp.called','mcp.denied') ORDER BY id DESC LIMIT 100").map(e=>({...e,...JSON.parse(e.payload_json),payload_json:undefined}));
    return {items,records,status:'dsh_native_mcp_client',note:'保存不会立即启动外部程序。下次新研究启动时，经 dsh 官方 MCP client 连接并按角色授权工具；启动失败或授权工具不存在会停止该轮研究。MCP 结果是待核实资料，不自动成为原文证据。'};
  }
}
