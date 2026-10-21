#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给 /resident/ 挂上 nginx 反代（Debian 默认站点布局）。

用法：
    sudo python3 ~/resident/install-nginx.py

做的事（幂等，重复执行安全）：
  1. 在 /etc/nginx/sites-available/default 的 server 块里加 location /resident/ → 127.0.0.1:8901
  2. nginx -t 通过才 reload，不通过自动回滚
"""
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

NGINX_CONF = os.environ.get("NGINX_CONF", "/etc/nginx/sites-available/default")

BLOCK = (
    "\t# 网站常驻（Resident）：托管网站登录态，供 AI 取文件 / 代操作\n"
    "\tlocation /resident/ {\n"
    "\t\tproxy_pass http://127.0.0.1:8901/;\n"
    "\t\tproxy_http_version 1.1;\n"
    "\t\tproxy_set_header Host $host;\n"
    "\t\tproxy_set_header X-Real-IP $remote_addr;\n"
    "\t\tproxy_read_timeout 120s;\n"
    "\t\tclient_body_timeout 120s;\n"
    "\t\tclient_max_body_size 4m;\n"
    "\t}\n"
    "\n"
)

# 行首匹配，避开文件末尾被注释掉的那段 `#\tlocation / {`
ANCHOR_RE = re.compile(r"^([ \t]*)location / \{", re.M)


def die(msg):
    print("错误：" + msg, file=sys.stderr)
    sys.exit(1)


def backup(path):
    ts = time.strftime("%Y%m%d-%H%M%S")
    dst = "%s.bak-%s" % (path, ts)
    shutil.copy2(path, dst)
    print("备份：%s" % dst)
    return dst


def service_up():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8901/api/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    if os.geteuid() != 0:
        die("需要 root：sudo python3 ~/resident/install-nginx.py")

    if not service_up():
        print("警告：127.0.0.1:8901 没有响应，反代加了也会 502。")
        print("      先执行：systemctl --user start resident.service   （用你的账号，不要 sudo）")
        ans = input("仍要继续？[y/N] ").strip().lower()
        if ans != "y":
            sys.exit(1)

    # ---------- 1. nginx ----------
    with open(NGINX_CONF, encoding="utf-8") as f:
        conf = f.read()

    if "location /resident/" in conf:
        print("nginx：已有 location /resident/，跳过")
    else:
        hits = list(ANCHOR_RE.finditer(conf))
        if len(hits) != 1:
            die("在 %s 里找到 %d 处 `location / {`（应为 1），页面结构可能已变，请手动添加" % (NGINX_CONF, len(hits)))
        bak = backup(NGINX_CONF)
        indent = hits[0].group(1)
        conf = ANCHOR_RE.sub(lambda m: BLOCK + m.group(1) + "location / {", conf, count=1)
        with open(NGINX_CONF, "w", encoding="utf-8") as f:
            f.write(conf)

        t = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
        if t.returncode != 0:
            shutil.copy2(bak, NGINX_CONF)
            die("nginx -t 失败，已回滚：\n" + t.stderr)
        print("nginx -t 通过：%s" % t.stderr.strip().splitlines()[-1])

        r = subprocess.run(["systemctl", "reload", "nginx"], capture_output=True, text=True)
        if r.returncode != 0:
            die("nginx reload 失败：" + r.stderr)
        print("nginx 已 reload")

    print("""
完成。访问 https://你的域名/resident/
取 token：cat ~/resident/data/token.txt
""")


if __name__ == "__main__":
    main()
