# 传到 GitHub 并开启 Zotero 自动更新

目标仓库：`https://github.com/baijiyunze/zotero-chatgpt-sidebar`（当前尚未创建，名字未占用）

自动更新的原理：插件的 `manifest.json` 里写了一个 `update_url`，Zotero 会定期去拉这个
JSON，发现版本号比自己高就提示更新。所以只需要两样东西常驻在仓库里：

| 文件 | 位置 | 作用 |
| --- | --- | --- |
| `update.json` | 仓库根目录（main 分支） | 告诉 Zotero 最新版本号和下载地址 |
| `zotero-chatgpt-sidebar-1.6.2.xpi` | 某个 Release 的附件 | 真正的安装包 |

---

## 第 1 步：建仓库

1. 打开 https://github.com/new
2. **Repository name** 填 `zotero-chatgpt-sidebar`
3. 选 **Public**（Zotero 拉取 raw 文件不需要登录，私有仓库会 404）
4. 不要勾选 "Add a README file"，直接 **Create repository**

## 第 2 步：上传源码

1. 在新仓库页面点 **uploading an existing file**（或 Add file → Upload files）
2. 打开资源管理器，进入这个目录：
   `C:\Users\14646\WorkBuddy\2026-10-23-14-31-07\zotero-plugin`
3. **全选里面的文件和文件夹**（bootstrap.js、manifest.json、update.json、content、locale、
   prefs.js、README.md、CHANGELOG.md、build.py、build.bat、.gitignore 等），
   直接拖进浏览器的上传框
   - **不要**拖 `dist` 文件夹（安装包走 Release，不进源码树）
   - 拖文件夹时 GitHub 会自动保留目录结构，`content/`、`locale/` 拖进去即可
4. 底部 Commit message 随便写，比如 `init: Zotero ChatGPT Sidebar 1.6.2`，点 **Commit changes**

## 第 3 步：发 Release（关键，自动更新靠它）

1. 仓库右侧 **Releases** → **Create a new release**
2. **Choose a tag** 里输入 `v1.6.2` → 点 "Create new tag: v1.6.2 on publish"
3. **Release title** 填 `v1.6.2`
4. **Description** 可以把 `CHANGELOG.md` 里 1.6.2 那一段粘进去
5. 下方 **Attach binaries** 拖入：
   `C:\Users\14646\WorkBuddy\2026-10-23-14-31-07\zotero-plugin\dist\zotero-chatgpt-sidebar-1.6.2.xpi`
6. 点 **Publish release**

> 附件名必须是 `zotero-chatgpt-sidebar-1.6.2.xpi`，因为 `update.json` 里的
> `update_link` 就是按这个文件名拼的。改名要在 `build.py` 里改，别只在网页上改。

## 第 4 步：本机装一次新包（必须做）

你现在装的是 **1.6.1**，它里面的 `update_url` 指向一个不存在的地址（404），
所以**旧包永远收不到更新提示**。必须手动装一次 1.6.2，把正确的地址写进配置：

1. Zotero → `工具` → `插件` → 右上齿轮 → **Install Plugin From File…**
2. 选 `dist\zotero-chatgpt-sidebar-1.6.2.xpi` → 重启 Zotero

之后就不用再手动装了。

## 第 5 步：验证

在浏览器打开（应返回一段 JSON，不是 404）：

```
https://raw.githubusercontent.com/baijiyunze/zotero-chatgpt-sidebar/main/update.json
```

再打开（应能下载到安装包）：

```
https://github.com/baijiyunze/zotero-chatgpt-sidebar/releases/download/v1.6.2/zotero-chatgpt-sidebar-1.6.2.xpi
```

Zotero 里：`工具` → `插件` → 齿轮 → **Check for Updates**，能正常检查且不报错就通了。

---

## 以后发新版怎么走

1. 改代码，把 `manifest.json` 的 `version` 改成新版本号（例如 1.6.3）
2. 在 `CHANGELOG.md` 顶部加一段对应说明
3. 双击 `build.bat`，输入 `baijiyunze` → 自动生成
   `dist/zotero-chatgpt-sidebar-1.6.3.xpi` 并向 `update.json` 追加一条记录
4. GitHub 网页：把改动的文件（`bootstrap.js`、`manifest.json`、`update.json` 等）
   Commit 上去 → 建新 Release（tag `v1.6.3`）→ 挂上新 xpi
5. 用户的 Zotero 会在下次检查时（约每天一次，或手动 Check for Updates）提示更新

`build.py` 会**保留 `update.json` 里的历史版本记录**，所以老版本客户端也能找到匹配项。

---

## 常见坑

- **私有仓库不工作**：Zotero 拉 `update.json` 不带你的登录态，私有仓库直接 404 → 必须 Public
- **文件名对不上**：`update_link` 是严格匹配的，Release 附件名错一个字符就 404
- **忘了改版本号**：版本号不涨，Zotero 认为已是最新，不会提示
- **`update.json` 放错位置**：必须在 main 分支的仓库**根目录**，不能塞进 `dist/` 或子文件夹
- **`strict_max_version`**：当前是 `10.*`，将来 Zotero 升到 11 要把这里一起改，否则新版本 Zotero 会判定不兼容
