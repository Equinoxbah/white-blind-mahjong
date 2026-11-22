# worker/ —— 联机通行证签发服务

这个小服务负责给玩家签发声网 RTM 的**临时通行证（token）**。

## 为什么需要它

声网要求客户端登录时携带 token，而签发 token 必须用到 **AppCertificate**（相当于私章）。

早期版本把这个"私章"加密后直接写在 `index.html` 里，但**浏览器必须能解密才能用**，所以解密密钥和密文放在同一个文件里 —— 等于明文。任何人查看网页源代码就能拿走，进而用你的额度。

现在改成：**私章只存在 Cloudflare 的环境变量里**，浏览器只拿到一张 1~3 小时后过期的通行证，拿不到任何密钥。

```
玩家浏览器  ──GET /api/token?uid=xxx──▶  worker（持有私章签名）
     │                                        │
     └──────────  006 开头的 token  ◀──────────┘
     │
     └──  用 token 连声网，正常游戏
```

## 部署步骤

全程网页操作，不需要命令行。

### 1. 创建 Worker

1. 登录 Cloudflare 后台 → **计算 (Workers)** → **创建应用程序**
2. 选 **从 Hello World! 开始**
3. Worker 名字建议填 `mahjong-token`（会成为网址的一部分）
4. 点 **部署**

### 2. 粘贴代码

1. 进入刚创建的 Worker → 右上角 **`</> 编辑代码`**
2. 编辑器里全选删除模板代码
3. 把本目录 `worker.js` 全文粘贴进去
4. 点 **部署**

### 3. 配置环境变量

Worker 页面 → **设置 (Settings)** → **变量和密钥** → **添加变量**

| 名称 | 值 | 类型 |
|---|---|---|
| `AGORA_APP_ID` | 你的 AppID（32 位） | 密钥 |
| `AGORA_APP_CERT` | 你的 AppCertificate（32 位） | **密钥（务必加密）** |
| `TOKEN_TTL_SEC` | `10800`（3 小时） | 文本 |

可选：

| 名称 | 说明 |
|---|---|
| `ALLOWED_ORIGINS` | 允许调用本接口的页面来源，逗号分隔。默认 `*` 不限制；收紧后更安全 |
| `RATE_PER_MIN` | 单 IP 每分钟最多要几张票，默认 30 |

> **注意**：改完环境变量后需要**再点一次部署**才会生效。
> **注意**：`AGORA_APP_CERT` 存成密钥后，后台只显示 `••••`，之后无法再查看 —— 请自行另存一份。

### 4. 验收

浏览器打开：

```
https://<你的worker>.workers.dev/health
```

应返回 `{"ok":true}`。再打开：

```
https://<你的worker>.workers.dev/api/token?uid=test
```

应返回类似：

```json
{"appId":"...","token":"006...","ttl":10800,"expireAt":...}
```

看到 `"token":"006...` 就说明成功了。

### 5. 接到游戏页面

打开根目录 `index.html`，找到这一行（约在 1580 行附近）：

```javascript
var TOKEN_API = "https://<你的worker>.<你的子域>.workers.dev/api/token";
```

把地址换成你自己的 Worker 地址即可。

## 常见问题

| 现象 | 原因 |
|---|---|
| `/api/token` 返回 `server not configured` | 环境变量没配好，或变量名拼错，或改完没重新部署 |
| `/` 返回 `not found` | 正常。本服务只处理 `/health` 和 `/api/token` |
| 返回 `too many requests` | 触发了单 IP 限流，等一分钟即可 |
| 游戏提示"无法获取联机通行证" | `TOKEN_API` 地址填错了，或 Worker 未部署 |

## 说明

- 签发算法与声网官方 RTM token 规格一致，`006` 前缀即标准格式
- 通行证有效期由 `TOKEN_TTL_SEC` 控制，过期后页面刷新会自动重新获取
- 本目录不包含任何密钥，可以安全提交
