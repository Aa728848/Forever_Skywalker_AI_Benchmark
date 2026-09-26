/**
 * 运行令牌的浏览器本地存储。
 *
 * 三个面板（配置、发起测评、清理）用的是同一个令牌，键名必须只有一处定义，
 * 否则改了其中一处就会出现「配置页保存了、清理页读不到」这种难查的不一致。
 */
import { useCallback, useEffect, useState } from 'react';

export const tokenStorageKey = 'fsa.bench-token';

/** 读取当前令牌；空字符串表示未填写。 */
export function readToken(): string {
  try { return window.localStorage.getItem(tokenStorageKey) ?? ''; } catch { return ''; }
}

/** 记录令牌；空值即清除，避免留着一个不再有效的旧令牌去发请求。 */
export function writeToken(value: string): void {
  try {
    if (value.trim() === '') window.localStorage.removeItem(tokenStorageKey);
    else window.localStorage.setItem(tokenStorageKey, value);
  } catch { /* 隐私模式下 localStorage 可能不可用：退化为本次会话不记忆令牌。 */ }
}

/** 令牌状态 + 请求头。写入即同步到 localStorage。 */
export function useBenchToken() {
  const [token, setTokenState] = useState('');
  // 首帧后再读：服务端渲染或测试环境没有 window。
  useEffect(() => { setTokenState(readToken()); }, []);
  const setToken = useCallback((value: string) => { setTokenState(value); writeToken(value); }, []);
  /** 有请求体时用：带上 JSON content-type。 */
  const headers = useCallback(() => ({ 'content-type': 'application/json', 'x-bench-token': token }), [token]);
  /**
   * 无请求体时用（DELETE 等）。**不能**带 content-type: application/json：
   * Fastify 见到该头却收到空体会以 400 FST_ERR_CTP_EMPTY_JSON_BODY 拒绝，
   * 服务端根本没机会执行清理。
   */
  const authHeaders = useCallback(() => ({ 'x-bench-token': token }), [token]);
  return { token, setToken, headers, authHeaders };
}