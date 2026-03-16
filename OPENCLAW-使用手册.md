## OpenClaw 本地部署与使用手册（macOS）

> 对应项目仓库：`https://github.com/openclaw/openclaw`

---

### 一、环境要求

- **操作系统**：macOS（建议 13+，Apple Silicon 或 Intel 均可）
- **Node.js**：≥ **22**（你当前已安装 `v22.14.0`）
- **npm**：任意近期版本（你当前已安装 `10.9.2`）

可通过下面命令自查：

```bash
node -v
npm -v
```

---

### 二、全局安装 OpenClaw CLI

在任意终端中执行：

```bash
npm install -g openclaw@latest
```

安装完成后，用下面命令确认版本（应能看到类似 `2026.3.1`）：

```bash
openclaw --version
```

---

### 三、首次启动与向导（onboard）

OpenClaw 官方推荐通过向导完成首次部署与配置，这一步会：

- 生成默认配置文件（例如 `~/.openclaw/openclaw.json`）
- 选择 / 配置模型（OpenAI / Anthropic 等）
- 选择要接入的聊天渠道（如 WhatsApp / Telegram / Slack / Discord 等）
- 配置是否安装并开启网关守护进程（daemon）

在终端执行：

```bash
openclaw onboard --install-daemon
```

向导中的典型问题（根据自己需求选择）：

- **选择模型提供商与模型名称**  
  - 例如：OpenAI、Anthropic；模型如 `gpt-4.1`、`claude-opus-4.6` 等  
  - 需要准备好相应的 API Key 或完成 OAuth 授权
- **是否安装网关守护进程（daemon）**  
  - 建议选择 **安装**，这样网关会随系统自动启动，保持常驻
- **是否立即配置聊天渠道**  
  - 例如配置 Telegram Bot Token、Discord Bot Token 等  
  - 如果暂时没有准备好，可以先跳过，之后再改配置文件并重启网关

向导结束后，OpenClaw 会完成基础配置并（如选择）安装 daemon。

---

### 四、手动启动网关（Gateway）

如果你没有安装 daemon，或者想临时以前台模式运行网关，可以用：

```bash
openclaw gateway --port 18789 --verbose
```

- **`--port 18789`**：WebSocket 网关监听端口，默认也是 18789  
- **`--verbose`**：输出更详细的日志，方便调试

网关正常启动后，你会在终端看到包含 `Gateway`、`ws://127.0.0.1:18789` 之类的日志。

如果已经安装守护进程，相关管理方式请参考官方文档中的 **Gateway runbook / Daemon** 部分。

---

### 五、快速体验：命令行与本地助手

#### 1. 发送一条简单消息

```bash
openclaw agent --message "帮我列一份今天的工作清单" --thinking high
```

说明：

- **`agent`**：直接和默认个人助手会话  
- **`--message`**：要发送的内容  
- **`--thinking`**：推理强度，可选 `minimal|low|medium|high|xhigh`，强度越高推理越深入、耗时与成本也会增加

#### 2. 通过渠道发送消息（示例）

完成相应渠道配置后，例如 WhatsApp / Telegram 等，可以用：

```bash
openclaw message send --to +1234567890 --message "Hello from OpenClaw"
```

其中：

- **`--to`**：目标号码或渠道标识（不同渠道格式略有差异，参考官方文档 Channels 部分）
- **`--message`**：要发送的文本内容

---

### 六、常用聊天内命令（在群聊 / 私聊里使用）

当 OpenClaw 连接到 WhatsApp / Telegram / Slack / Discord 等渠道后，可以在对应聊天里发送以下命令（通常仅对会话 owner 或配置允许的成员生效）：

- **`/status`**：查看当前会话状态（所用模型、tokens 使用情况等）
- **`/new` 或 `/reset`**：重置会话上下文，开始新的对话
- **`/compact`**：对当前会话内容进行压缩 / 总结，减少上下文长度
- **`/think <level>`**：调整当前会话的推理强度  
  - 例如：`/think high`
- **`/verbose on|off`**：打开或关闭详细日志模式
- **`/usage off|tokens|full`**：控制每次回复后是否显示 token / 成本信息
- **`/restart`**：重启网关（通常仅 owner 可用）
- **`/activation mention|always`**：在群聊中控制机器人触发方式（仅被 @ 时响应，或总是响应）

具体行为会受 `openclaw.json` 配置和渠道策略影响。

---

### 七、安全与 DM（私信）策略

OpenClaw 默认对 **私信 / DM** 采取较保守策略，以避免任意陌生人“驱动”你的个人助手：

- 默认 DM 策略为 **pairing**：  
  - 未授权的私信发送者会先收到一段带配对码的提示，机器人不会直接处理其消息  
  - 你需要在终端中使用类似：

    ```bash
    openclaw pairing approve <channel> <code>
    ```

    来显式批准对方

- 如需开放为“任何人都可 DM 使用”，需要在配置中将 `dmPolicy` 设为 `"open"`，并在 `allowFrom` 中包含 `"*"`（**不建议轻易开放**）。

安全配置的详细说明可参考官方仓库中的 **Security guide**。

---

### 八、配置文件与目录位置（简要）

- **工作区目录**：默认在 `~/.openclaw/workspace`
- **主配置文件**：默认在 `~/.openclaw/openclaw.json`
- **技能（skills）目录**：`~/.openclaw/workspace/skills/<skill>/SKILL.md`

通过编辑 `openclaw.json` 可以：

- 更换默认模型及其提供商
- 调整各渠道配置（令牌、allowlist、DM 策略等）
- 修改网关绑定地址、Tailscale 暴露模式等高级选项

详细键值说明请参考官方 **Full configuration reference** 文档。

---

### 九、升级 OpenClaw

官方提供 stable / beta / dev 三个渠道，推荐日常使用 **stable**：

- **升级到最新稳定版本**：

  ```bash
  openclaw update --channel stable
  ```

- 或直接用 npm 升级：

  ```bash
  npm install -g openclaw@latest
  ```

升级后可运行：

```bash
openclaw doctor
```

来检查配置、版本以及潜在风险。

---

### 十、常见问题（FAQ 精简版）

- **Q：如何确认网关是否在运行？**  
  - 看运行 `openclaw gateway --port 18789 --verbose` 的终端日志  
  - 或通过浏览器访问网关控制界面 / WebChat（具体 URL 取决于你的暴露方式，详见官方 “Web surfaces / Control UI” 文档）

- **Q：我只想本机自己用，不想暴露到公网，怎么配置？**  
  - 网关默认绑定在 `127.0.0.1`，不开 Tailscale / SSH 隧道就不会暴露到公网  
  - 确保 `gateway.tailscale.mode` 配置为 `"off"`（默认）即可

- **Q：如何查看更完整的文档？**  
  - 仓库主页 `README`：`https://github.com/openclaw/openclaw`  
  - 官方文档站（Docs / DeepWiki / FAQs 等），从 README 中的链接进入

---

如果你后续有具体使用场景（例如：只接入 Telegram、或想和公司 Slack 集成、或只在本机做语音助手），可以告诉我，我可以基于本手册再帮你输出一个更精简、贴合场景的配置与操作清单。

