# opencode-demo

这是一个集成了 [OpenCode](https://opencode.ai) GitHub Agent 的示例仓库。

## 如何使用

在任意 **Issue** 或 **Pull Request** 的评论中输入 `/oc` 或 `/opencode` 加上你的指令，OpenCode 就会自动在 GitHub Actions 中运行并协助你完成任务。

例如：
- `/oc 帮我解释一下这个项目`
- `/oc 修复这个 Issue 中描述的问题并提交 PR`
- `/opencode 为项目添加一个简单的示例脚本`

## 配置说明

工作流配置文件位于 [`.github/workflows/opencode.yml`](.github/workflows/opencode.yml)。

1. **配置 API Key Secret**：
   前往仓库的 **Settings -> Secrets and variables -> Actions**，添加你所使用的模型服务商密钥（例如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 或 `GEMINI_API_KEY`）。
2. **安装 GitHub App（可选但推荐）**：
   访问 [github.com/apps/opencode-agent](https://github.com/apps/opencode-agent) 并安装到本仓库；或者在工作流中启用 `use_github_token: true` 直接使用自带的 `GITHUB_TOKEN`。
