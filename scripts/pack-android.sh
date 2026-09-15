#!/usr/bin/env bash
#
# LX Music 移动版 Android 一键打包脚本（面向本地大模型 / 自动化执行）
#
# 用法:
#   bash scripts/pack-android.sh
#   ARCH=arm64-v8a bash scripts/pack-android.sh
#   KEYSTORE_PASSWORD='你的密码' bash scripts/pack-android.sh
#
# 可选环境变量:
#   ARCH               仅打包指定架构，可用值: armeabi-v7a,arm64-v8a,x86,x86_64（不设置则全部架构）
#   KEYSTORE_PASSWORD  签名密码（默认 lxmusic123456，仅用于本地安装，正式发布请自行替换）
#   KEYSTORE_ALIAS     签名别名（默认 lxmusic）
#   ANDROID_HOME       Android SDK 路径（不设置则自动探测常见路径）
#   JAVA_HOME          JDK 17 路径（不设置则自动探测）
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

log()  { printf '[PACK] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
die()  { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

ARCH="${ARCH:-}"
KEYSTORE_ALIAS="${KEYSTORE_ALIAS:-lxmusic}"
KEYSTORE_FILE_NAME="release.keystore"
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:-lxmusic123456}"

log "项目根目录: $PROJECT_ROOT"

# ---------- 1. 检查 JDK 17 ----------
if [ -z "${JAVA_HOME:-}" ] && [ -x /usr/libexec/java_home ]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
fi
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME}/bin/java" ]; then
  die "未找到 JDK 17。请先安装（macOS: brew install --cask temurin@17），或设置 JAVA_HOME。"
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"
log "JDK: $("$JAVA_HOME/bin/java" -version 2>&1 | head -n 1)"

# ---------- 2. 检查 Node 18 ----------
if [ -x "$HOME/.local/node18/bin/node" ]; then
  export PATH="$HOME/.local/node18/bin:$PATH"
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  nvm use 18 >/dev/null 2>&1 || warn "nvm 无法切换到 Node 18，将使用当前版本。"
fi
command -v node >/dev/null 2>&1 || die "未找到 node，请安装 Node.js 18.x。"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" = "18" ] || warn "当前 Node 版本为 $(node -v)，项目推荐 18.x；若构建失败请切换后再试。"
log "Node: $(node -v)"

# ---------- 3. 检查 Android SDK / NDK ----------
if [ -z "${ANDROID_HOME:-}" ]; then
  for d in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk" "/usr/local/share/android-sdk"; do
    if [ -d "$d" ]; then ANDROID_HOME="$d"; break; fi
  done
fi
[ -n "${ANDROID_HOME:-}" ] || die "未找到 Android SDK，请设置 ANDROID_HOME。"
export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties
log "Android SDK: $ANDROID_HOME"

# ---------- 4. 安装依赖 ----------
if [ ! -d node_modules ] || [ ! -f node_modules/.package-lock.json ]; then
  log "安装 npm 依赖 (npm ci)..."
  npm ci || npm install
else
  log "node_modules 已存在，跳过 npm ci。"
fi

# ---------- 5. 准备签名 ----------
if [ ! -f android/keystore.properties ]; then
  command -v keytool >/dev/null 2>&1 || die "未找到 keytool，请确认 JDK 安装完整。"
  log "生成签名证书 android/app/$KEYSTORE_FILE_NAME ..."
  [ -f "android/app/$KEYSTORE_FILE_NAME" ] || keytool -genkeypair -v \
    -keystore "android/app/$KEYSTORE_FILE_NAME" \
    -alias "$KEYSTORE_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KEYSTORE_PASSWORD" \
    -keypass "$KEYSTORE_PASSWORD" \
    -dname "CN=LX Music, OU=Dev, O=LX Music, L=Unknown, ST=Unknown, C=CN"
  cat > android/keystore.properties <<EOF
storeFile=$KEYSTORE_FILE_NAME
storePassword=$KEYSTORE_PASSWORD
keyAlias=$KEYSTORE_ALIAS
keyPassword=$KEYSTORE_PASSWORD
EOF
  warn "已生成签名配置（密码: ${KEYSTORE_PASSWORD}）。正式发布请自行替换证书与密码。"
else
  log "复用已有 android/keystore.properties。"
fi

# ---------- 6. 执行构建 ----------
GRADLE_ARGS=(assembleRelease)
if [ -n "$ARCH" ]; then
  GRADLE_ARGS+=("-PreactNativeArchitectures=$ARCH")
fi
log "执行: (cd android && ./gradlew ${GRADLE_ARGS[*]})"
( cd android && ./gradlew "${GRADLE_ARGS[@]}" )

# ---------- 7. 校验产物 ----------
OUT_DIR="android/app/build/outputs/apk/release"
log "构建产物:"
ls -lh "$OUT_DIR"/*.apk || die "未找到 APK 产物，请检查上方构建日志。"

log "打包完成。APK 目录: $PROJECT_ROOT/$OUT_DIR"
