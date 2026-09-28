#!/usr/bin/env bash
# tools/rotate-lp-token.sh —— 在【服务器上】轮换 LP 仪表盘登录令牌 (2026-09-28 审计修复)
#
# 做什么 (按顺序, 任一步失败回滚旧文件):
#   1. openssl rand -hex 24 生成 48 位 hex 新令牌 (只存在于变量和文件里, 全程不 echo)
#   2. 写应用侧 $APP_DIR/.lpauth-token (0600)              —— lp-auth.js 按 mtime 自动重读, 不用重启 5179
#   3. 用 deploy/nginx/lp-token.map.example 渲染 /etc/nginx/lp-token.map (root:root 0600, sudo)
#   4. nginx -t && systemctl reload nginx
#   5. 校验两处令牌 sha256 一致 (只比对, 不打印)
# 副作用: 所有已登录浏览器的 cookie 立刻失效, 需要重新登录 —— 这正是轮换的目的。
# 用法:  bash tools/rotate-lp-token.sh                       (以 ubuntu 用户运行, 需要能 sudo)
#        APP_DIR=/srv/lp-dashboard bash tools/rotate-lp-token.sh
set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-/home/ubuntu/lp-dashboard}"
TOKEN_FILE="$APP_DIR/.lpauth-token"
MAP_FILE="${MAP_FILE:-/etc/nginx/lp-token.map}"
TEMPLATE="${TEMPLATE:-$APP_DIR/deploy/nginx/lp-token.map.example}"

log() { printf '[rotate-lp-token] %s\n' "$*" >&2; }
die() { log "错误: $*"; exit 1; }

command -v openssl >/dev/null 2>&1 || die "缺 openssl"
command -v nginx   >/dev/null 2>&1 || die "缺 nginx"
command -v sudo    >/dev/null 2>&1 || die "缺 sudo"
[ -d "$APP_DIR" ]  || die "应用目录不存在: $APP_DIR"
[ -f "$TEMPLATE" ] || die "缺模板: $TEMPLATE"
grep -q '__LPAUTH_TOKEN__' "$TEMPLATE" || die "模板里没有 __LPAUTH_TOKEN__ 占位: $TEMPLATE"
sudo -n true 2>/dev/null || log "提示: 接下来会要求 sudo 密码 (写 /etc/nginx 与 reload)"

# ---- 1. 生成新令牌 ----
NEW="$(openssl rand -hex 24)"
[ "${#NEW}" -eq 48 ] || die "生成令牌长度异常 (${#NEW})"
case "$NEW" in *[!0-9a-f]*) die "生成令牌不是纯 hex";; esac

# ---- 2. 备份旧文件 (同目录, 0600; 回滚用) ----
TS="$(date +%Y%m%d-%H%M%S)"
OLD_TOKEN_BAK=""; OLD_MAP_BAK=""
if [ -f "$TOKEN_FILE" ]; then
  OLD_TOKEN_BAK="$TOKEN_FILE.bak-$TS"
  cp -p "$TOKEN_FILE" "$OLD_TOKEN_BAK"; chmod 600 "$OLD_TOKEN_BAK"
fi
if sudo test -f "$MAP_FILE"; then
  OLD_MAP_BAK="$MAP_FILE.bak-$TS"
  sudo cp -p "$MAP_FILE" "$OLD_MAP_BAK"; sudo chmod 600 "$OLD_MAP_BAK"
fi

rollback() {
  log "回滚到轮换前的令牌..."
  if [ -n "$OLD_TOKEN_BAK" ] && [ -f "$OLD_TOKEN_BAK" ]; then cp -p "$OLD_TOKEN_BAK" "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"; fi
  if [ -n "$OLD_MAP_BAK" ] && sudo test -f "$OLD_MAP_BAK"; then sudo cp -p "$OLD_MAP_BAK" "$MAP_FILE"; sudo chmod 600 "$MAP_FILE"; fi
  if sudo nginx -t >/dev/null 2>&1; then sudo systemctl reload nginx >/dev/null 2>&1 || true; fi
  log "已回滚 (备份保留: ${OLD_TOKEN_BAK:-无} / ${OLD_MAP_BAK:-无})"
}

# ---- 3. 写应用侧 token 文件 (原子: 临时文件 + mv; 与现有文件一样不带换行, lp-auth.js 读时 trim) ----
TMP_TOKEN="$(mktemp "$APP_DIR/.lpauth-token.tmp.XXXXXX")"
printf '%s' "$NEW" > "$TMP_TOKEN"
chmod 600 "$TMP_TOKEN"
mv -f "$TMP_TOKEN" "$TOKEN_FILE"

# ---- 4. 渲染 nginx map (root:root 0600) ----
TMP_MAP="$(mktemp)"
sed "s/__LPAUTH_TOKEN__/$NEW/" "$TEMPLATE" > "$TMP_MAP"
if ! grep -q "\"$NEW\"" "$TMP_MAP"; then rm -f "$TMP_MAP"; rollback; die "渲染 map 失败"; fi
if ! sudo install -o root -g root -m 0600 "$TMP_MAP" "$MAP_FILE"; then rm -f "$TMP_MAP"; rollback; die "写 $MAP_FILE 失败"; fi
rm -f "$TMP_MAP"

# ---- 5. nginx 语法检查 + reload ----
if ! sudo nginx -t; then rollback; die "nginx -t 失败, 已回滚"; fi
if ! sudo systemctl reload nginx; then rollback; die "nginx reload 失败, 已回滚"; fi

# ---- 6. 校验两处一致 (比对 sha256, 不打印令牌) ----
H_APP="$(tr -d '\r\n' < "$TOKEN_FILE" | sha256sum | cut -d' ' -f1)"
H_NGX="$(sudo sed -n 's/^[[:space:]]*"\([0-9a-f]\{48\}\)"[[:space:]]\{1,\}1;.*/\1/p' "$MAP_FILE" | head -n1 | tr -d '\r\n' | sha256sum | cut -d' ' -f1)"
if [ -z "$H_NGX" ] || [ "$H_APP" != "$H_NGX" ]; then rollback; die "两处令牌 sha256 不一致, 已回滚"; fi

log "完成: 新令牌已生效, .lpauth-token 与 $MAP_FILE 一致 (sha256 相同)"
log "旧文件备份: ${OLD_TOKEN_BAK:-无} / ${OLD_MAP_BAK:-无} —— 确认登录正常后可删"
log "应用侧 lp-auth.js 按 mtime 自动重读令牌, 不需要重启 5179; 所有旧 cookie 已失效, 需重新登录"
