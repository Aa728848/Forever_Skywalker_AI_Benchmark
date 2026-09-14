# INT-PY · Python 裁判聚合与并发可复现性

困难，原仓库集成题，版本0.1.0，Python >=3.11 <3.14，集成成绩单独报告。

## 固定真实来源

starter/llm_verifier 下两个完整模块来自 https://github.com/llm-as-a-verifier/llm-as-a-verifier 的固定提交8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770；本机原目录已不存在，从该提交公开raw URL恢复。SOURCE.json保存SHA-256、许可与语义变体，原MIT许可及pyproject.toml保留。除三处目标缺陷，实际概率提取、批量线程池、缓存、奖励均值和PPT选择仍为来源实现。

## 修改范围与目标

只修改starter/llm_verifier/fine_grained_reward.py与pivot_tournament.py，保留全部公开函数签名、既有注释与原算法结构。修复：同标量分数字母别名的概率错误累加；奇数rep反向提示未恢复原候选顺序；PPT并列时误选高下标。不得替换检查、transport fixture或重写成新算法冒充上游。

## 固定的Python语义

- extract_score以A..T/a..t表示20..1；空白与融合的前导>按源规则处理。不同token映射同一标量时取最大概率，再对保留标量概率归一化并线性映射到[0,1]。例如A=.4、a=.2、T=.4的期望是.5，不是.6。读取最后评分tag；没有有效分数时按源定义返回.5。
- 有向比较(a,b)与(b,a)的缓存键不同；测试传入的needed_pairs是唯一有向对列表。奇数rep交换提示槽位，存储score_A/score_B仍代表原候选a/b，不能把槽位偏差当候选优劣。directed_reward按声明criteria与rep求均值，自比较/缺失项遵循原.5规则。
- on_error=tie只为本次失败返回.5/.5，失败项不得持久化缓存；下一次可再次请求。on_error=raise传播工作线程原异常；损坏缓存按源JSONDecodeError失败。以上是被测库固定变体，不是平台缺失评分证据的补分规则。
- score_directed_pairs必须使用真实ThreadPoolExecutor，并遵循max_workers预算；缓存全部命中时不能触发LazyClient.get/create_client或读取凭据。
- PPT使用Bradley-Terry、Python random.Random(seed).shuffle采样环及原pivot聚合；并列选最低下标。比较次数仍是N+k(N-k)+C(k,2)。不要求Python RNG序列与JavaScript随机实现一致。

## 离线执行与验证边界

检查通过importlib.util直接载入两个原文件；只在外部模型调用端口call_verifier注入确定性(text,tokens,position_logprobs)。真实score_pair_criterion、extract_score、线程池、磁盘缓存、directed_reward与select_best全部实际执行。无需pip安装google-genai/openai/tqdm，不得访问真实模型、读取其它项目.env或私有凭据。

运行python -B public-tests/checks.py。公开检查覆盖概率/槽位/并列/缓存失败；隐藏补充真实线程屏障、完整PPT缓存重放、固定随机实现、成本界限与原异常策略。原始来源基线、参考与替代必须通过，注入缺陷的starter必须失败。未声称整个原项目SDK/CLI测试已通过，容器隔离成绩仍须正式环境另行验证。
