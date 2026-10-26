import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { Configuration } from './configuration.js';
import { PlatformAccounts, type PlatformId } from './platform-accounts.js';

type LoginState={id:string;platform:PlatformId;status:'starting'|'waiting_qr'|'saved'|'failed'|'expired';message:string;started_at:string;updated_at:string};
type LoginEntry={state:LoginState;context?:BrowserContext;timer?:NodeJS.Timeout;capturing?:boolean;bridged?:boolean;lastCookie?:string;lastProbe?:number;readyAt?:number};
const loginUrl:Record<PlatformId,string>={weibo:'https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog&url=https%3A%2F%2Fweibo.com%2F',bilibili:'https://passport.bilibili.com/login'};
const requiredCookie:Record<PlatformId,string>={weibo:'SUB',bilibili:'SESSDATA'};

/** Local, visible QR login. Chromium's persistent profile keeps the browser session between runs;
 * the native TS collectors also receive a separately encrypted cookie snapshot after login. */
export class PlatformBrowserLogin {
  private sessions=new Map<string,LoginEntry>();
  private stopping=false;
  constructor(private config:Configuration,private dataDir:string,private accounts=new PlatformAccounts(config)){}
  list(){return [...this.sessions.values()].map(({state})=>({...state}));}
  get(id:string){const value=this.sessions.get(id);if(!value)throw new Error('扫码登录会话不存在或已过期');return {...value.state};}
  async start(platform:PlatformId){
    if(this.stopping)throw Error('服务正在关闭，请稍后重试');
    const existing=[...this.sessions.values()].find(x=>x.state.platform===platform&&['starting','waiting_qr'].includes(x.state.status));
    if(existing)return {...existing.state};
    const id='login_'+randomUUID().replaceAll('-',''),stamp=new Date().toISOString();
    const entry={state:{id,platform,status:'starting' as const,message:'正在打开平台扫码登录页',started_at:stamp,updated_at:stamp}};
    this.sessions.set(id,entry);void this.open(entry);return {...entry.state};
  }
  private async open(entry:LoginEntry){
    try{
      const dir=join(this.dataDir,'browser_data',entry.state.platform);await mkdir(dir,{recursive:true});
      const context=await chromium.launchPersistentContext(dir,{headless:false,channel:'msedge',viewport:{width:1280,height:900}});entry.context=context;
      if(this.stopping){await this.close(entry);return;}
      context.on('close',()=>{if(entry.state.status==='waiting_qr'){entry.state={...entry.state,status:'failed',message:'扫码登录窗口已关闭；登录态未确认，可重新发起登录',updated_at:new Date().toISOString()};if(entry.timer)clearInterval(entry.timer);entry.timer=undefined;}});
      const page=context.pages()[0]||await context.newPage();await page.goto(loginUrl[entry.state.platform],{waitUntil:'domcontentloaded',timeout:45000});
      entry.state={...entry.state,status:'waiting_qr',message:'请在弹出的浏览器中完成扫码登录；成功后会自动加密保存登录态',updated_at:new Date().toISOString()};
      entry.readyAt=Date.now()+(entry.state.platform==='weibo'?8000:2000);
      entry.timer=setInterval(()=>void this.capture(entry),2000);entry.timer.unref();
      setTimeout(()=>{if(['starting','waiting_qr'].includes(entry.state.status)){entry.state={...entry.state,status:'expired',message:'登录窗口已超时；可重新发起扫码登录',updated_at:new Date().toISOString()};void this.close(entry);}},5*60_000).unref();
    }catch(error){entry.state={...entry.state,status:'failed',message:error instanceof Error&&/msedge|executable/i.test(error.message)?'无法启动本机 Microsoft Edge；请安装 Edge 后重试':'平台登录窗口未能打开，请检查网络后重试',updated_at:new Date().toISOString()};await this.close(entry);}
  }
  private async capture(entry:LoginEntry){
    if(!entry.context||entry.state.status!=='waiting_qr'||entry.capturing||Date.now()<(entry.readyAt||0))return;entry.capturing=true;
    try{
      const target=entry.state.platform==='weibo'?'https://m.weibo.cn/':'https://api.bilibili.com/';
      const cookies=await entry.context.cookies(target);const key=requiredCookie[entry.state.platform],cookie=[...new Map(cookies.filter(c=>c.name&&c.value).map(c=>[c.name,c.value])).entries()].map(([name,value])=>`${name}=${value}`).join('; ');
      if(entry.state.platform==='weibo'&&!cookies.some(c=>c.name===key&&c.value)&&!entry.bridged){const mainCookies=await entry.context.cookies('https://weibo.com/');if(mainCookies.some(c=>c.name===key&&c.value)){entry.bridged=true;await (entry.context.pages()[0]||await entry.context.newPage()).goto(target,{waitUntil:'domcontentloaded',timeout:30000});entry.state.message='主站登录完成，正在同步微博移动端登录；如平台要求，请完成移动端正常登录';return;}}
      if(!cookies.some(c=>c.name===key&&c.value))return;
      if(entry.lastCookie===cookie&&Date.now()-(entry.lastProbe||0)<15000)return;
      if(entry.lastCookie!==cookie)this.accounts.save(entry.state.platform,{enabled:true,cookie});entry.lastCookie=cookie;entry.lastProbe=Date.now();
      const health=await this.accounts.probe(entry.state.platform,AbortSignal.timeout(20000));
      if(health.status!=='authenticated'){entry.state.message='浏览器会话已捕获，但平台尚未确认登录；请保持窗口并完成平台登录或验证。'+health.message;entry.state.updated_at=new Date().toISOString();return;}
      entry.state={...entry.state,status:'saved',message:health.status==='authenticated'?'平台确认已登录，登录态已加密保存，可供后续审批采集复用':`登录态已加密保存；平台验证状态：${health.message}`,updated_at:new Date().toISOString()};
      await this.close(entry);
    }catch{entry.state={...entry.state,status:'failed',message:'登录态保存或平台验证失败；请在定制中心查看状态后重试',updated_at:new Date().toISOString()};await this.close(entry);}finally{entry.capturing=false;}
  }
  private async close(entry:{context?:BrowserContext;timer?:NodeJS.Timeout}){if(entry.timer)clearInterval(entry.timer);entry.timer=undefined;const context=entry.context;entry.context=undefined;try{await context?.close();}catch{}}
  async closeAll(){this.stopping=true;await Promise.all([...this.sessions.values()].map(entry=>this.close(entry)));}
}

export {loginUrl as platformLoginUrls,requiredCookie as platformRequiredCookies};
