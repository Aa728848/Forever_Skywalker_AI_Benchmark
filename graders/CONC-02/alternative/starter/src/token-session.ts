export interface Tokens { readonly accessToken: string; readonly refreshToken: string }
export interface RefreshedTokens { readonly accessToken: string; readonly refreshToken?: string }
export type RefreshPort = (refreshToken: string) => Promise<RefreshedTokens>;
export class SignedOutError extends Error { constructor() { super('已注销'); } }
export class TokenSession {
  #state: { tokens: Tokens; pending?: Promise<Tokens> } | null;
  #refreshPort: RefreshPort;
  constructor(tokens: Tokens, refreshPort: RefreshPort) { this.#state = { tokens: { ...tokens } }; this.#refreshPort = refreshPort; }
  get current(): Tokens | null { return this.#state === null ? null : { ...this.#state.tokens }; }
  logout(): void { this.#state = null; }
  refresh(): Promise<Tokens> {
    const state = this.#state;
    if (state === null) return Promise.reject(new SignedOutError());
    if (state.pending !== undefined) return state.pending;
    const operation = Promise.resolve().then(() => this.#refreshPort(state.tokens.refreshToken)).then(tokens => {
      if (this.#state !== state) throw new SignedOutError();
      state.tokens = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? state.tokens.refreshToken };
      return { ...state.tokens };
    });
    state.pending = operation.then(value => { delete state.pending; return value; }, error => { delete state.pending; throw error; });
    return state.pending;
  }
}
