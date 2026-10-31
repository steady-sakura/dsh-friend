# 界面美术与素材

现有角色来自 dsh-pet。保留角色及其动作，不混用其他风格的角色插画。界面延续浅蓝背景、深蓝文字和清楚的操作边界；聊天、设置属于日常操作界面，优先保证文字和按钮易读。

## 已检索的外部资源

- [Lucide](https://github.com/lucide-icons/lucide)：适合设置、声音、文件夹和屏幕共享的统一线性图标。[官方许可](https://github.com/lucide-icons/lucide/blob/main/LICENSE)为 ISC；实际引入时应随分发保留完整版权与许可。本次仅完成选型，尚未引入图标文件或依赖。
- [unDraw](https://undraw.co/illustrations)：可用于帮助页或首次使用说明的插画候选。[官方许可](https://undraw.co/license)允许项目中使用，但限制素材包再分发、竞争服务及机器学习等用途。本次未引入，避免与现有角色争夺视觉焦点。

## README 截图

截图来自 `npm run test:desktop` 的隔离 Electron 测试，使用合成资料；原始输出在被 Git 忽略的 `evidence/`。人工查看后，仅将展示需要的图片复制到 `docs/screenshots/`。不复制用户聊天、密钥或真实共享画面。

刷新截图时重新运行桌面测试，检查图片内容及版本，再替换文档图片。测试画面中的长回复和本机测试目录是测试内容，不代表默认聊天文案。

## 前端目录约定

- `desktop/settings.css`：设置与屏幕选择共用的基础控件。
- `desktop/settings-layout.css`：仅设置页加载的分类导航、布局和响应式规则。
- `desktop/chat.css`：气泡与聊天面板，保留两种视图各自的滚动边界。
- `desktop/settings-nav.js`：分类展示及焦点处理，不访问模型或修改授权。
- `src/client-ui.mjs`：DSH 网页入口源码；修改后执行 `npm run build:client` 同步分发文件。

本轮调整不改个人资料格式，不需要迁移数据库。历史记录、草稿及旧版回执兼容性由现有回归测试覆盖；不能据此代替真实 DSH 安装升级测试。

共享窗口可直接调整观察间隔：

![选择共享来源与观察间隔](docs/screenshots/sharing.png)
