# 白色失明文字麻将

> 汉字组词造句 · 人机混战 · WebRTC 联机 · 单文件 HTML 游戏

一款基于汉字组词玩法的四人麻将游戏。手牌由汉字组成，通过吃、碰、组词造句来胡牌。支持真人联机和人机混战，单文件即可运行，无需后端。

<!-- 有游戏截图后可放在此处：![游戏对局](screenshots/game.png) -->

## ✨ 功能特性

- **🀄 汉字麻将**：36 种汉字各 4 张，共 144 张牌，组词造句胡牌
- **🤖 人机混战**：不足 4 人自动补 AI，最少 1 人即可开始
- **🌐 WebRTC 联机**：P2P 直连，支持 4 人实时联机对战
- **📱 手机适配**：大厅竖屏 + 对局横屏自动切换，支持触摸操作
- **🔄 掉线重连**：刷新页面自动恢复对局，房主退出自动迁移
- **🎯 吃碰胡完整**：吃牌组词、碰牌、真人投票胡 / AI 词库胡
- **🖱️ 手牌拖拽**：自由整理手牌顺序
- **💬 对局聊天**：内置聊天面板
- **📖 规则弹窗**：游戏内随时查看玩法规则

## 🚀 快速开始

### 在线游玩

部署到 GitHub Pages 后直接访问：`https://你的用户名.github.io/white-blind-mahjong/`

### 本地运行

直接用浏览器打开 `index.html` 即可，无需任何依赖：

```bash
# 方式一：双击 index.html

# 方式二：本地服务器（推荐，避免某些浏览器限制）
python -m http.server 8080
# 然后访问 http://localhost:8080
```

## 🎮 游戏规则

### 基本流程
1. 每名玩家起手 13 张牌，庄家首轮直接摸牌
2. 摸牌 → 出牌 → 下家选择吃/碰/胡/过
3. 吃碰后跳过摸牌，直接出牌
4. 直到有人胡牌或牌库摸空（流局）

### 吃牌与碰牌
- **吃牌**：只能吃上家打出的牌，用手牌与打出的字组成词库中的词语（2-4 字）
- **碰牌**：手牌中有 2 张相同字即可碰任何人打出的牌
- **优先级**：胡 ＞ 碰 ＞ 吃

### 胡牌条件
- **真人胡牌**：点击「胡」发起投票，其他真人全票同意即胡（不校验手牌）
- **AI 胡牌**：系统自动校验 14 张能否全部拆分成词库中的词语或短句
- AI 不参与投票，仅真人投票

### 人机混战
- AI 纯随机出牌，摸到能胡的牌自动申请胡牌
- AI 有 50% 概率碰、30% 概率吃
- AI 胡牌需真人投票同意

## 🌐 联机部署

联机需要信令服务器协助建立 WebRTC 连接。

### 自建信令服务器

项目提供 Python 和 Node.js 两个版本：

```bash
# Python 版
pip install websockets
python signaling-server.py

# Node.js 版
npm install ws
node signaling-server.js
```

默认监听 `ws://0.0.0.0:8765`，用 ngrok 映射到公网：

```bash
ngrok tcp 8765
```

将得到的地址（如 `ws://0.tcp.ngrok.io:12345`）填入游戏大厅的「信令服务器地址」框，所有玩家填同一个地址即可联机。

### GitHub Pages 部署

1. 将本仓库上传到 GitHub
2. Settings → Pages → Source 选 `Deploy from a branch`，Branch 选 `main` / `(root)`
3. 等待 1-2 分钟即可获得访问地址

## 🛠️ 技术栈

- **前端**：纯 HTML + CSS + 原生 JavaScript，无框架
- **联机**：WebRTC (RTCPeerConnection) + WebSocket 信令
- **构建**：无构建工具，单文件直接运行
- **存储**：localStorage 保存对局状态用于重连

## 📁 项目结构

```
white-blind-mahjong/
├── index.html              # 主程序（单文件，包含所有 HTML/CSS/JS）
├── signaling-server.py     # Python 版信令服务器
├── signaling-server.js     # Node.js 版信令服务器
└── README.md               # 项目说明
```

## 📝 注意事项

- 公共信令服务器不稳定，联机建议自建
- iOS Safari 对横屏锁定 API 支持有限，可能需手动旋转手机
- 部分公司/学校网络会屏蔽 WebRTC，可切换手机热点测试
- 牌库和词库可在 `index.html` 的 `TILE_CHARS` 和 `HU_WORDS` 变量中自定义

## 📄 License

MIT
