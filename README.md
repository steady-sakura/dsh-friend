# dsh-friend

把蓝色小鲸放到桌边。用自己的 API 聊天，让模型自己选动作，也能一起看你选中的窗口。

角色素材与 106 个动画来自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，保留 MIT 署名。本插件使用独立 API、独立设置和独立聊天记录。

## 安装到 DSH

需要 Node.js 22.12+，建议使用 DSH 0.2.0-rc.2。插件使用 Cordis 的 `commands` 服务注册命令，不需要编译。

```powershell
dsh plugin --profile web add github:steady-sakura/dsh-friend
```

安装后重新打开对应的 DSH，在输入框执行 **`/friend`**。第一次会打开 API 设置窗口。

默认已经填好 DeepSeek API 地址和 `deepseek-flash` 模型：填入自己的 API Key，点 **保存并开始**，双击桌宠就能聊。也可以修改地址和模型，使用兼容 Chat Completions 的服务。地址填写 API 根路径（例如带 `/v1` 的根地址），不要填写完整 `/chat/completions` 路径。密钥仅在本机设置窗口输入，不要发进 DSH 对话。

第一次启动如果没有 Electron，会下载官方 Electron 43.3.0，通常直接复用 DSH 已有运行时；不会运行额外安装脚本。首次下载需要联网，失败可以重试。可通过 `DSH_FRIEND_ELECTRON` 指定现有 Electron 可执行文件。

## 从源码直接运行

```powershell
git clone https://github.com/steady-sakura/dsh-friend.git
cd dsh-friend
npm install
npm start
```

Windows 也可双击 `启动桌面陪伴.cmd`。有现成 DSH Electron 时，直接 `node scripts/start.mjs` 也能运行。独立运行不依赖 DSH 会话。

## 怎么相处

- 双击身体展开气泡聊天；气泡可切换面板。拖动标题调整距离，拖边角缩放。
- 按住身体拖动，快速松手可甩动和弹跳；轻点是互动，会单独标注，和你说的话分开。
- 右键能打开 API 设置、选择全部 106 个动作、共享屏幕或退出。
- 模型回复可包含文字和最多三个动作，也可以只说话、只做动作或沉默。动作只来自内置目录，没有命令执行工具。
- 默认允许每 300 秒自由活动一次；每次会调用 API，由模型自行决定是否说话。可在设置关闭或调节。
- 面板可开启本机语音朗读，默认关闭。当前朗读使用 Windows 系统语音；其他平台请保持关闭。

## 角色提示词和记忆文件夹

API 设置页有两个独立入口：**选择角色文件夹**、**选择记忆文件夹**。可以分别选择，也可以只选一个。

每个文件夹只读第一层 `.md` / `.txt`，按文件名排序；每类最多 30 个文件、24,000 字符，单个文件最多 128 KiB。不会递归读取子目录，不读取隐藏文件、链接目录、`private` / `auth` / `state` 等敏感目录或疑似密钥文件。达到限制或略过疑似敏感文件时会显示提示。建议专门建两个干净文件夹。

角色内容进入人物提示词；记忆带“背景、可能过时”的标记进入上下文。选择后立即生效，重启时重新读取；修改原文件后点“重新读取这两个文件夹”。“取消导入”停止后续使用，不删除原文件。插件不会修改这些文件，也不会自动把聊天写回记忆文件夹。路径只保存在本机 `imports.json`，导入正文在内存中；API 请求会发送所载入的正文，不发送绝对路径。

## 一起看屏幕

在设置里启用图片输入。模型必须支持图片；也可给看屏幕单独配置地址、模型和 Key。文本模型无法通过本插件获得视觉能力。

点 **共享应用 / 屏幕**，选定具体窗口、勾选允许发给 API 后开始。选整屏需要额外勾选确认。只获取列表名称，不预先抓取未选窗口的缩略图；不采集麦克风、系统音或摄像头，不控制游戏。

观察间隔可选 5 / 10 / 20 / 30 / 60 / 120 秒，默认 30 秒。每张定格会产生 API 调用；请求未完成时跳过后续采样。失败会显示原因并暂停，不无限重试。暂停 / 继续可用面板、右键或 **Ctrl+Alt+F8**。结束共享或关闭选择窗口会停止媒体流；锁屏、休眠会暂停，不会自动恢复共享。已经发出的请求无法从服务商撤回。

截图仅在内存处理，不保存图片；模型对画面的文字描述会进入本机聊天。部分全屏游戏可能盖住桌宠，可使用无边框窗口模式。窗口最小化、受保护视频、系统权限限制等情况可能无法捕获；不会偷偷换成整屏。

## 聊天与隐私

默认数据目录位于系统用户目录下：

| 系统 | 目录 |
| --- | --- |
| Windows | `%APPDATA%\dsh-friend` |
| macOS | `~/Library/Application Support/dsh-friend` |
| Linux | `$XDG_CONFIG_HOME/dsh-friend`，通常为 `~/.config/dsh-friend` |

聊天在 `chats/YYYY-MM-DD.jsonl`；设置在 `settings.json`；密钥密文在 `credentials.json`；导入路径在 `imports.json`；位置和朗读偏好在 `preferences.json`。也可用 `DSH_FRIEND_DATA_DIR` 指定独立目录，请选择仓库外的位置。

重启会恢复最近最多 120 条聊天，发给 API 的历史最多 40 条 / 48,000 字符；不意味着模型每次读完整个聊天档案。发送失败不会自动重发或恢复旧请求。备份时退出插件后复制整个数据目录；系统加密的密钥换电脑或账户后通常需要重新输入。聊天文件是本机明文，请按自己的隐私需求保护或备份。

插件没有遥测、第三方记忆同步或自动上传 GitHub。聊天、导入的角色 / 记忆，以及明确授权的画面会发往你自己配置的 API 服务商。详细说明见 [PRIVACY.md](PRIVACY.md)。

## 验证

```powershell
npm test
npm run check
npm run test:desktop
npm pack --dry-run
```

测试使用模拟 API，不需要真实密钥。检查脚本验证 106 个素材的 SHA256、JavaScript 语法和发布目录中的疑似隐私内容。`test:desktop` 需要桌面环境与 Electron，使用隔离数据目录、本机模拟 API 和自行创建的色块窗口，验证表单保存、聊天、播放确认、角色导入与授权共享，不采集其他窗口画面。截图证据仅留本机 `evidence/`，不提交。Windows 已实测；macOS / Linux 的窗口与系统录屏授权仍需对应平台实测。

API 格式及默认模型依据 [DeepSeek 官方文档](https://api-docs.deepseek.com/quick_start)；密钥保护与屏幕采集分别使用 Electron [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)、[desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)。
