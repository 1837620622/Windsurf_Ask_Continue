#!/bin/bash
# ============================================================
# MCP 服务启动器 - 带容错和重试机制
# ============================================================
# 逻辑：
#   1. 优先尝试启动 Go 版本
#   2. Go 失败则切换到 Python 版本
#   3. 两个都失败则进入重试机制（各 5 次，每次间隔 5 秒）
# ============================================================

# 获取脚本所在目录（mcp-server-go 目录）
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

# 服务器路径
GO_SERVER="$SCRIPT_DIR/ask-continue-mcp"
PY_SERVER="$PROJECT_DIR/mcp-server-python/server.py"

# 重试配置
MAX_RETRIES=5
RETRY_INTERVAL=5

# 日志文件
LOG_FILE="$SCRIPT_DIR/mcp-launcher.log"

# ============================================================
# 日志函数
# ============================================================
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# ============================================================
# 检测 Python 命令
# ============================================================
detect_python() {
    if command -v python3 &> /dev/null; then
        echo "python3"
    elif command -v python &> /dev/null; then
        echo "python"
    else
        echo ""
    fi
}

# ============================================================
# 尝试启动 Go 版本
# ============================================================
try_go() {
    if [ -f "$GO_SERVER" ] && [ -x "$GO_SERVER" ]; then
        log "尝试启动 Go 版本: $GO_SERVER"
        exec "$GO_SERVER"
        return $?
    fi
    return 1
}

# ============================================================
# 尝试启动 Python 版本
# ============================================================
try_python() {
    local py_cmd=$(detect_python)
    if [ -n "$py_cmd" ] && [ -f "$PY_SERVER" ]; then
        log "尝试启动 Python 版本: $py_cmd $PY_SERVER"
        exec "$py_cmd" "$PY_SERVER"
        return $?
    fi
    return 1
}

# ============================================================
# 带重试的启动函数
# ============================================================
start_with_retry() {
    local attempt=1
    local backend=$1
    
    while [ $attempt -le $MAX_RETRIES ]; do
        log "第 $attempt 次尝试启动 $backend 版本..."
        
        if [ "$backend" = "go" ]; then
            try_go && return 0
        else
            try_python && return 0
        fi
        
        log "$backend 版本启动失败，$RETRY_INTERVAL 秒后重试..."
        sleep $RETRY_INTERVAL
        attempt=$((attempt + 1))
    done
    
    log "$backend 版本 $MAX_RETRIES 次重试均失败"
    return 1
}

# ============================================================
# 主逻辑
# ============================================================
log "========== MCP 启动器开始 =========="

# 第一阶段：尝试 Go 版本
if [ -f "$GO_SERVER" ]; then
    log "检测到 Go 版本，优先启动"
    try_go
    # 如果 exec 成功，后面的代码不会执行
    # 如果到这里说明失败了，进入重试
    log "Go 版本首次启动失败，进入重试机制"
    start_with_retry "go" && exit 0
fi

# 第二阶段：尝试 Python 版本
py_cmd=$(detect_python)
if [ -n "$py_cmd" ] && [ -f "$PY_SERVER" ]; then
    log "Go 版本不可用，切换到 Python 版本"
    try_python
    # 如果 exec 成功，后面的代码不会执行
    log "Python 版本首次启动失败，进入重试机制"
    start_with_retry "python" && exit 0
fi

# 两个都失败
log "错误：Go 和 Python 版本均不可用"
echo "错误：无法启动 MCP 服务器，请检查 Go 或 Python 环境" >&2
exit 1
