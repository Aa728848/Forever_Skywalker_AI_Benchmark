import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 真实 Chromium DOM 检查，不依赖候选工作区的 npm 包或伪造 DOM。 */
export function runBrowser<T>(source: URL, exercise: string): T {
  const locations = [
    process.env['BENCH_BROWSER_EXECUTABLE'],
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const executable = locations.find((path): path is string => path !== undefined && existsSync(path));
  if (executable === undefined) throw new Error('浏览器运行时未配置：请设置 BENCH_BROWSER_EXECUTABLE。');
  const directory = mkdtempSync(join(tmpdir(), 'fsa-browser-check-'));
  try {
    const javascript = stripTypeScriptTypes(readFileSync(source, 'utf8'));
    const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(javascript).toString('base64');
    const page = join(directory, 'check.html');
    writeFileSync(page, `<!doctype html><meta charset="utf-8"><body><script type="module">
      const report = value => document.documentElement.dataset.benchmarkResult = btoa(unescape(encodeURIComponent(JSON.stringify(value))));
      try {
        const candidate = await import(${JSON.stringify(moduleUrl)});
        const result = await (async () => { ${exercise.replace(/<\/script/gi, '<\\/script')} })();
        report({ok:true,result});
      } catch (error) { report({ok:false,error:String(error.stack ?? error)}); }
      </script></body>`);
    const output = execFileSync(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox',
      '--disable-background-networking', '--disable-extensions', '--no-first-run',
      '--no-default-browser-check', '--user-data-dir=' + join(directory, 'profile'),
      '--virtual-time-budget=10000', '--dump-dom', pathToFileURL(page).href,
    ], { encoding: 'utf8', timeout: 45_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const encoded = /data-benchmark-result="([A-Za-z0-9+/=]+)"/.exec(output)?.[1];
    if (encoded === undefined) throw new Error('浏览器未返回检查结果。');
    const result = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { ok: boolean; result: T; error?: string };
    if (!result.ok) throw new Error(result.error ?? '浏览器检查失败。');
    return result.result;
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
