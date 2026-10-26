# 发布与自动更新指南

仓库：https://github.com/baijiyunze/zotero-chatgpt-sidebar （公开）
当前版本：**1.6.2**（已发布 Release `v1.6.2`）

自动更新的原理：插件 `manifest.json` 里的 `update_url` 指向本仓库根目录的
`update.json`，Zotero 定期拉取，发现版本号更高就提示更新。常驻仓库的只有两样东西：

| 文件 | 位置 | 作用 |
| --- | --- | --- |
| `update.json` | 仓库根目录（main 分支） | 告诉 Zotero 最新版本号、下载地址、SHA-256 |
| `zotero-chatgpt-sidebar-<版本>.xpi` | Release 附件 | 真正的安装包 |

```
update_url = https://raw.githubusercontent.com/baijiyunze/zotero-chatgpt-sidebar/main/update.json
```

---

## 用户怎么装（第一次）

从 Releases 下载 `zotero-chatgpt-sidebar-1.6.2.xpi`，然后：

1. Zotero → `工具` → `插件` → 右上齿轮 → **Install Plugin From File…**
2. 选中该 xpi → 按提示**重启 Zotero**

> 必须走界面安装。实测 Zotero 10 会忽略直接放进 `Profiles/.../extensions/` 的插件。

装好 1.6.2 之后，后续版本就会自动提示更新，不用再手动装。

## 验证自动更新链路是否正常

```bash
# 应返回 update.json 内容（HTTP 200）
curl -sL https://raw.githubusercontent.com/baijiyunze/zotero-chatgpt-sidebar/main/update.json
```

Zotero 里：`工具` → `插件` → 齿轮 → **Check for Updates**，不报错即通。

Zotero 默认约每 24 小时检查一次；想立刻验证可以把系统时间往后拨，或直接手动检查。

---

## 发新版（日常流程）

1. 改代码，把 `manifest.json` 的 `version` 改成新版本号（如 `1.6.3`）
2. 在 `CHANGELOG.md` 顶部加一段对应说明
3. 双击 `build.bat`，输入 `baijiyunze`
   → 生成 `dist/zotero-chatgpt-sidebar-1.6.3.xpi`，并向 `update.json` 追加/替换该版本条目
4. 提交改动：
   ```bash
   git add -A && git commit -m "release: 1.6.3" && git push
   ```
5. 发 Release（**附件文件名不能改**，`update.json` 的 `update_link` 是按文件名拼的）：
   ```bash
   gh release create v1.6.3 "dist/zotero-chatgpt-sidebar-1.6.3.xpi" --title "v1.6.3" --notes-file 说明.md
   ```
   或在网页 Releases → Create a new release，tag 填 `v1.6.3`，拖入 xpi。
6. `git push` 完成后约 1 分钟 raw 缓存刷新，老版本客户端的 Zotero 下次检查时就会提示更新

`build.py` 会保留 `update.json` 里的历史版本记录（同一版本重建则替换该条），
所以停留在老版本的用户也能找到匹配项。

---

## 常见坑

- **私有仓库不工作**：Zotero 拉 `update.json` 不带登录态，私有仓库会 404 → 必须 Public
- **附件名对不上**：`update_link` 严格匹配，Release 附件名错一个字符就 404
- **忘了改版本号**：版本号不涨，Zotero 认为已是最新，不会提示
- **`update.json` 位置**：必须在 main 分支**根目录**，不能塞进 `dist/` 或子目录
- **`update_hash` 不一致**：手工改了 xpi 却忘了重跑 `build.py`，Zotero 会判定校验失败
- **`strict_max_version`**：当前为 `10.*`，Zotero 升到 11 时要一起改，否则新版 Zotero 判为不兼容

## 本地环境说明

打包脚本只依赖 Python 3（`build.py` 仅用标准库）。发 Release 需要 GitHub CLI：

```bash
# 便携版已放在本机，加进 PATH 即可
export PATH="/c/Users/14646/.workbuddy/binaries/gh/2.103.2/bin:$PATH"
gh auth status
```
