import {TaskGroup,GroupCancelledError} from './group.ts';
export interface Tokens {readonly accessToken:string;readonly refreshToken:string}
export interface RefreshedTokens {readonly accessToken:string;readonly refreshToken?:string}
export type RefreshPort=(refreshToken:string)=>Promise<RefreshedTokens>;
export class SignedOutError extends Error {constructor(){super('signed out');}}
export class TokenSession {
 private state:{tokens:Tokens;refresh?:Promise<Tokens>}|null;private port:RefreshPort;private requests=new TaskGroup();private draining:Promise<void>|undefined;
 constructor(tokens:Tokens,refreshPort:RefreshPort){this.state={tokens:{...tokens}};this.port=refreshPort;}
 get current():Tokens|null{return this.state?{...this.state.tokens}:null;}
 logout():void{if(this.draining)return;this.state=null;this.draining=this.requests.cancelAll();}
 close():Promise<void>{this.logout();return this.draining!;}
 refresh():Promise<Tokens>{const state=this.state;if(!state)return Promise.reject(new SignedOutError());if(!state.refresh){state.refresh=Promise.resolve().then(()=>this.port(state.tokens.refreshToken)).then(next=>{if(this.state!==state)throw new SignedOutError();state.tokens={accessToken:next.accessToken,refreshToken:next.refreshToken??state.tokens.refreshToken};return state.tokens;},error=>{if(this.state!==state)throw new SignedOutError();throw error;}).finally(()=>{delete state.refresh;});}return state.refresh.then(tokens=>({...tokens}));}
 authorized<T>(id:string,work:(accessToken:string,signal:AbortSignal)=>Promise<T>):Promise<T>{if(!this.state)return Promise.reject(new SignedOutError());return this.requests.run(id,async signal=>{const tokens=await this.refresh();if(signal.aborted||!this.state)throw new SignedOutError();return work(tokens.accessToken,signal);}).catch(error=>{if(error instanceof GroupCancelledError)throw new SignedOutError();throw error;});}
}
