#!/usr/bin/env python3
"""打包插件并生成 Zotero 自动更新用的 update.json。

用法:
    python build.py --owner <GitHub用户名> [--repo zotero-chatgpt-sidebar]

产物:
    dist/zotero-chatgpt-sidebar-<version>.xpi   ← 传到 GitHub Release
    update.json                                  ← 放仓库根目录，供 Zotero 拉取
"""

import argparse
import hashlib
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
ADDON_ID = "zoterogpt-sidebar@workbuddy.local"


def read_manifest():
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
        return json.load(f)


def collect_files():
    skip_dirs = {".git", "dist", "tmp", "node_modules"}
    # 仓库里用于开发和发布说明的文件，不需要打进 xpi
    skip_files = {
        "build.py", "build.bat", "update.json", "README.md",
        "CHANGELOG.md", "UPLOAD_GUIDE.md", ".gitignore",
    }
    files = []
    for cur, dirs, names in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for n in names:
            if n in skip_files:
                continue
            if n.endswith((".xpi", ".log")) or n.startswith("."):
                continue
            p = os.path.join(cur, n)
            rel = os.path.relpath(p, ROOT).replace("\\", "/")
            files.append((rel, p))
    return sorted(files)


def build_xpi(manifest):
    version = manifest["version"]
    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, f"zotero-chatgpt-sidebar-{version}.xpi")
    files = collect_files()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, p in files:
            z.write(p, rel)
    with open(out, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    return out, version, len(files), digest


def write_update_json(manifest, owner, repo, version, digest):
    zotero_cfg = manifest.get("applications", {}).get("zotero", {})
    entry = {
        "version": version,
        "update_link": (
            f"https://github.com/{owner}/{repo}/releases/download/"
            f"v{version}/zotero-chatgpt-sidebar-{version}.xpi"
        ),
        "update_hash": f"sha256:{digest}",
    }
    apps = {}
    if zotero_cfg.get("strict_min_version"):
        apps["strict_min_version"] = zotero_cfg["strict_min_version"]
    if zotero_cfg.get("strict_max_version"):
        apps["strict_max_version"] = zotero_cfg["strict_max_version"]
    if apps:
        entry["applications"] = {"zotero": apps}

    data = {"addons": {ADDON_ID: {"updates": [entry]}}}

    # 保留历史版本，方便回退 / 老版本客户端能匹配
    path = os.path.join(ROOT, "update.json")
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                old = json.load(f)
            old_updates = old["addons"][ADDON_ID]["updates"]
            # 同一版本重建时（hash 会变）用新条目替换旧条目
            kept = [u for u in old_updates if u.get("version") != version]
            data["addons"][ADDON_ID]["updates"] = kept + [entry]
        except Exception:
            pass

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return path


def patch_manifest_update_url(owner, repo):
    """把 manifest 里的 update_url 指向用户自己的仓库。"""
    path = os.path.join(ROOT, "manifest.json")
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    new_url = f"https://raw.githubusercontent.com/{owner}/{repo}/main/update.json"
    raw_new = re.sub(
        r'"update_url":\s*"[^"]*"',
        f'"update_url": "{new_url}"',
        raw,
        count=1,
    )
    if raw_new != raw:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(raw_new)
        return new_url, True
    return new_url, False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--owner", required=True, help="GitHub 用户名 / 组织名")
    ap.add_argument("--repo", default="zotero-chatgpt-sidebar", help="仓库名")
    ap.add_argument("--no-patch", action="store_true", help="不修改 manifest 的 update_url")
    args = ap.parse_args()

    if not args.no_patch:
        url, changed = patch_manifest_update_url(args.owner, args.repo)
        print(f"update_url -> {url} {'(已更新)' if changed else '(未变化)'}")

    manifest = read_manifest()
    xpi, version, count, digest = build_xpi(manifest)
    upd = write_update_json(manifest, args.owner, args.repo, version, digest)

    print(f"version : {version}")
    print(f"sha256  : {digest}")
    print(f"xpi     : {xpi} ({os.path.getsize(xpi)} bytes, {count} files)")
    print(f"update  : {upd}")
    print(f"release : https://github.com/{args.owner}/{args.repo}/releases/new"
          f"?tag=v{version}")


if __name__ == "__main__":
    sys.exit(main())
