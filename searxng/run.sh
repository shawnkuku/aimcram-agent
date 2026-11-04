#!/usr/bin/env bash
# 首次运行：克隆 SearXNG、创建 Python 3.12 虚拟环境、安装依赖、生成密钥、启动本地实例。
# 再次运行：直接启动（代码更新需手动 git pull）。
#
#   ./searxng/run.sh              # 前台启动，Ctrl+C 停止
#   SEARXNG_PORT=8888 ./searxng/run.sh
#
# 依赖：uv（推荐）或 python3 + venv、git。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="$HERE/.runtime"
SRC="$RUNTIME/searxng"
VENV="$RUNTIME/venv"
PORT="${SEARXNG_PORT:-8888}"

mkdir -p "$RUNTIME"

if [ ! -d "$SRC/.git" ]; then
  echo "==> 克隆 SearXNG（浅克隆）"
  git clone --depth 1 https://github.com/searxng/searxng.git "$SRC"
else
  echo "==> 复用已有 SearXNG 源码：$SRC"
fi

if [ ! -x "$VENV/bin/python" ]; then
  echo "==> 创建 Python 3.12 虚拟环境"
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.12 "$VENV"
  else
    python3 -m venv "$VENV"
  fi
fi

PY="$VENV/bin/python"
if [ ! -f "$VENV/.deps-installed" ]; then
  echo "==> 安装 SearXNG 依赖（首次较慢）"
  if command -v uv >/dev/null 2>&1; then
    # uv venv 默认不含 pip，直接用 uv pip 安装
    uv pip install --python "$PY" -r "$SRC/requirements.txt"
  else
    "$PY" -m pip install --upgrade pip setuptools wheel >/dev/null
    "$PY" -m pip install -r "$SRC/requirements.txt"
  fi
  touch "$VENV/.deps-installed"
fi

if [ ! -f "$RUNTIME/settings.yml" ]; then
  echo "==> 生成本地配置与随机密钥"
  SECRET="$("$PY" -c 'import secrets; print(secrets.token_hex(32))')"
  sed "s|__SECRET__|$SECRET|" "$HERE/settings.yml" > "$RUNTIME/settings.yml"
fi

# 端口可通过环境变量覆盖（同时改写运行时配置）
if [ "$PORT" != "8888" ]; then
  sed -i '' "s|port: 8888|port: $PORT|; s|127.0.0.1:8888|127.0.0.1:$PORT|g" "$RUNTIME/settings.yml" 2>/dev/null \
    || sed -i "s|port: 8888|port: $PORT|; s|127.0.0.1:8888|127.0.0.1:$PORT|g" "$RUNTIME/settings.yml"
fi

export SEARXNG_SETTINGS_PATH="$RUNTIME/settings.yml"
echo "==> 启动 SearXNG：http://127.0.0.1:$PORT/"
echo "    检索测试：curl 'http://127.0.0.1:$PORT/search?q=系统架构&format=json'"
cd "$SRC"
exec "$PY" -m searx.webapp
