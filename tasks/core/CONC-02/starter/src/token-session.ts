export interface Tokens { readonly accessToken: string; readonly refreshToken: string }
export interface RefreshedTokens { readonly accessToken: string; readonly refreshToken?: string }
export type RefreshPort = (refreshToken: string) => Promise<RefreshedTokens>;
export class SignedOutError extends Error { constructor() { super('已注销'); } }
export class TokenSession {
  #tokens: Tokens | null;
  #refreshPort: RefreshPort;
  constructor(tokens: Tokens, refreshPort: RefreshPort) { this.#tokens = { ...tokens }; this.#refreshPort = refreshPort; }
  get current(): Tokens | null { return this.#tokens === null ? null : { ...this.#tokens }; }
  logout(): void { this.#tokens = null; }
  refresh(): Promise<Tokens> {
    if (this.#tokens === null) return Promise.reject(new SignedOutError());
    const original = this.#tokens;
    // 缺陷：并发调用各自刷新，且过期结果会在注销之后重新写回凭据。
    return Promise.resolve().then(() => this.#refreshPort(original.refreshToken)).then(tokens => {
      this.#tokens = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? original.refreshToken };
      return { ...this.#tokens };
    });
  }
}
