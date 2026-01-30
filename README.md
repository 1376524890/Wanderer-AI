# Wanderer AI - 自主探索代理（Node.js）

一个可长期运行、记录完整、易维护的自主探索 AI 项目模板。适合放在拥有 sudo 权限的 Linux 虚拟机上，让 AI 持续做有意义、有意思、有价值且富有创造力的探索，并把每一步写成可追踪的日志。

## 为什么做这个项目
- **持续性**：不需要人工反复启动，代理在失败后会自动恢复。
- **可追踪**：每一步都有“做了什么 / 为什么 / 收获”的记录。
- **可维护**：代码极简、结构清晰，文档要求明确。
- **可扩展**：后续可接入 systemd、更多工具或安全策略。

## 功能特性
- 永不停歇的主循环（崩溃自动恢复）
- vLLM OpenAI 兼容接口（默认 `http://vllm.plk161211.top` + `qwen3-8b`）
- 断线/不可用时自动等待重试（指数退避 + 抖动）
- Markdown 日志沉淀（`journal/`）
- 执行由 AI 生成的 Python 脚本（脚本内运行 shell 命令并根据输出继续）
- 实时美观的 CLI 监控界面（Claude 风格，Blessed TUI，显示实时命令输出）
- 每个代码文件自带职责声明，变更时要求同步更新文档

## 目录结构
```
.
├── src/                 # 核心逻辑
├── journal/             # AI 探索日志（自动生成）
├── state/               # 运行时状态（可清空）
├── logs/                # 运行日志（自动滚动）
├── run-agent.js         # 主循环入口
├── run-monitor.js       # 监控界面入口
├── start.sh             # 一键启动脚本
├── folder.md            # 文件说明清单（必须维护）
└── README.md
```

## 快速开始
### 方式一：一键启动
```bash
bash start.sh
```

### 方式二：手动启动
1) 复制配置文件
```bash
cp .env.example .env
```

2) 安装依赖
```bash
npm install
```

3) 启动代理
```bash
npm run start
```

4) 启动监控面板
```bash
npm run monitor
```

或一次性同时启动：
```bash
npm run start:all
```


## 运行逻辑概览
每个循环会执行：
1. 读取 `journal/` 最近日志作为上下文
2. 调用 LLM 生成下一步计划、命令清单与 Python 脚本内容
3. 执行 Python 脚本（脚本内运行 shell 命令并输出结果）
4. 写入 `journal/` 与 `state/` 状态文件

## 配置说明（.env）
常用项：
- `VLLM_BASE_URL` / `VLLM_MODEL`：模型地址与名称
- `VLLM_BASE_URL` 建议包含 `http://` 或 `https://`（未写会自动补全）
- `ALLOW_COMMAND_EXECUTION`：是否允许命令执行
- `ALLOW_UNSAFE_COMMANDS`：是否允许不受限制的命令
- `MAX_COMMANDS_PER_CYCLE`：每轮最大命令数，`0` 表示无限制
- `COMMAND_TIMEOUT_SECONDS`：单次脚本/命令最大运行时间（默认 300 秒）
- `PYTHON_BIN`：Python 可执行文件（默认 `python3`）
- `LOOP_SLEEP_SECONDS`：每轮循环间隔
- `LOG_FILE` / `LOG_MAX_BYTES` / `LOG_MAX_FILES`：日志文件与滚动策略

## 日志说明
- 运行日志默认写入 `logs/wanderer.log`
- 单文件达到 `LOG_MAX_BYTES` 后自动滚动，保留最近 `LOG_MAX_FILES` 份
- 实时命令输出写入 `state/command_stream.log`，监控界面会实时读取

## 文档与维护约定
- 所有代码文件头部必须有 5 行左右职责声明
- 修改代码后必须同步更新 `folder.md`
- 日志目录 `journal/` 为 AI 自己的探索记录，不建议手动删除

## 计划
- [ ] systemd 守护进程支持（可选）
- [ ] 更严格的命令策略与资源限制
- [ ] 多模型切换与任务优先级

## 贡献
欢迎贡献。请先阅读 `CONTRIBUTING.md`。

## 许可协议
MIT License
