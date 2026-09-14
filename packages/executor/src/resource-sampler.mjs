// 受信侧资源采样器：由平台通过 --import 注入被测进程，退出时写回原始资源数据。
// 它不是候选项的一部分，也不依赖被测代码；候选进程被强杀时不会产生报告。
import { writeFileSync } from 'node:fs';

const target = process.env.FSA_RESOURCE_REPORT;
if (target) {
  process.on('exit', () => {
    try {
      const usage = process.resourceUsage();
      writeFileSync(target, JSON.stringify({
        // maxRSS 为千字节，CPU 时间为微秒（Node 文档口径）。
        peakRssBytes: usage.maxRSS * 1024,
        userCpuMs: usage.userCPUTime / 1000,
        systemCpuMs: usage.systemCPUTime / 1000,
      }));
    } catch {
      // 采样失败不影响被测进程退出；缺失的报告按 null 记录。
    }
  });
}
