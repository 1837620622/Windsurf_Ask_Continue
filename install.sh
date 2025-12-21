#!/bin/bash
# ============================================================
# Ask Continue - Mac/Linux 一键安装脚本
# ============================================================
# 功能：
#   1. 检查 Python/Go 环境
#   2. 安装 MCP Server 依赖
#   3. 配置 MCP 配置文件（支持双后端）
#   4. 配置全局规则文件
#   5. 提示安装 VSIX 扩展
# ============================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # 无颜色

# 获取脚本所在目录（支持软链接）
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# 后端选择标志
USE_PYTHON=false
USE_GO=false
PYTHON_CMD=""
GO_CMD=""

echo ""
echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}   Ask Continue - 继续牛马 MCP 工具${NC}"
echo -e "${BLUE}   Mac/Linux 一键安装脚本${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

# ========== 步骤 1：检查运行环境 ==========
echo -e "${YELLOW}[1/5]${NC} 检查运行环境..."

# 检查 Python
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
    PIP_CMD="pip3"
    USE_PYTHON=true
elif command -v python &> /dev/null; then
    PYTHON_CMD="python"
    PIP_CMD="pip"
    USE_PYTHON=true
fi

if [ "$USE_PYTHON" = true ]; then
    PYTHON_VERSION=$($PYTHON_CMD --version 2>&1)
    echo -e "${GREEN}[OK]${NC} Python: $PYTHON_VERSION"
else
    echo -e "${YELLOW}[提示]${NC} Python 未安装"
fi

# 检查 Go
if command -v go &> /dev/null; then
    GO_CMD="go"
    USE_GO=true
elif [ -f "/opt/homebrew/bin/go" ]; then
    GO_CMD="/opt/homebrew/bin/go"
    USE_GO=true
elif [ -f "/usr/local/go/bin/go" ]; then
    GO_CMD="/usr/local/go/bin/go"
    USE_GO=true
fi

if [ "$USE_GO" = true ]; then
    GO_VERSION=$($GO_CMD version 2>&1)
    echo -e "${GREEN}[OK]${NC} Go: $GO_VERSION"
else
    echo -e "${YELLOW}[提示]${NC} Go 未安装"
fi

# 至少需要一个后端
if [ "$USE_PYTHON" = false ] && [ "$USE_GO" = false ]; then
    echo -e "${RED}[错误]${NC} 需要安装 Python 3.10+ 或 Go 1.21+"
    echo "Python 下载: https://www.python.org/downloads/"
    echo "Go 下载: https://go.dev/dl/"
    exit 1
fi

# ========== 步骤 2：安装依赖 ==========
echo ""
echo -e "${YELLOW}[2/5]${NC} 安装 MCP Server 依赖..."

# 安装 Python 依赖
if [ "$USE_PYTHON" = true ]; then
    cd "$SCRIPT_DIR/mcp-server-python"
    $PIP_CMD install -r requirements.txt -q
    echo -e "${GREEN}[OK]${NC} Python 依赖已安装"
fi

# 编译 Go 版本
if [ "$USE_GO" = true ]; then
    cd "$SCRIPT_DIR/mcp-server-go"
    if [ ! -f "ask-continue-mcp" ]; then
        echo -e "${BLUE}[编译]${NC} 正在编译 Go 版本..."
        $GO_CMD build -o ask-continue-mcp server.go
    fi
    echo -e "${GREEN}[OK]${NC} Go 版本已就绪"
fi

# ========== 步骤 3：配置 MCP ==========
echo ""
echo -e "${YELLOW}[3/5]${NC} 配置 MCP..."

# MCP 配置文件路径
WINDSURF_MCP_DIR="$HOME/.codeium/windsurf"
WINDSURF_MCP_FILE="$WINDSURF_MCP_DIR/mcp_config.json"
PYTHON_SERVER_PATH="$SCRIPT_DIR/mcp-server-python/server.py"
GO_SERVER_PATH="$SCRIPT_DIR/mcp-server-go/ask-continue-mcp"
LAUNCHER_PATH="$SCRIPT_DIR/mcp-server-go/mcp-launcher.sh"

# 创建目录
mkdir -p "$WINDSURF_MCP_DIR"

# 确保启动器脚本有执行权限
if [ -f "$LAUNCHER_PATH" ]; then
    chmod +x "$LAUNCHER_PATH"
    echo -e "${GREEN}[OK]${NC} 启动器脚本已就绪（Go 优先，Python 备选，自动重试）"
fi

# 使用统一启动器（内置容错和重试机制）
PRIMARY_CMD="$LAUNCHER_PATH"
PRIMARY_ARGS="[]"
BACKEND_NAME="智能启动器"

echo -e "${BLUE}[选择]${NC} 使用 $BACKEND_NAME（Go 优先 → Python 备选 → 5次重试）"

# 备份旧配置
if [ -f "$WINDSURF_MCP_FILE" ]; then
    cp "$WINDSURF_MCP_FILE" "$WINDSURF_MCP_FILE.backup"
    echo -e "${YELLOW}[备份]${NC} 旧 MCP 配置已备份"
fi

# 使用 Python 更新 JSON（更可靠）
if [ "$USE_PYTHON" = true ]; then
    $PYTHON_CMD << EOF
import json
import os

config_file = "$WINDSURF_MCP_FILE"
launcher_path = "$LAUNCHER_PATH"

try:
    # 读取现有配置
    config = {}
    if os.path.exists(config_file):
        with open(config_file, 'r') as f:
            config = json.load(f)
    
    if 'mcpServers' not in config:
        config['mcpServers'] = {}
    
    # 配置 ask-continue（使用智能启动器）
    config['mcpServers']['ask-continue'] = {
        'command': launcher_path,
        'args': [],
        'disabled': False
    }
    
    with open(config_file, 'w') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    
    print("MCP 配置已更新（智能启动器：Go优先 → Python备选 → 5次重试）")
except Exception as e:
    print(f"更新配置失败: {e}")
    exit(1)
EOF
else
    # 如果没有 Python，直接用 shell 创建配置
    cat > "$WINDSURF_MCP_FILE" << EOF
{
  "mcpServers": {
    "ask-continue": {
      "command": "$LAUNCHER_PATH",
      "args": []
    }
  }
}
EOF
fi

echo -e "${GREEN}[OK]${NC} MCP 配置已写入: $WINDSURF_MCP_FILE"

# ========== 步骤 4：配置全局规则 ==========
echo ""
echo -e "${YELLOW}[4/5]${NC} 配置全局规则文件..."

RULES_SRC="$SCRIPT_DIR/rules/example-windsurfrules.txt"
RULES_DST="$HOME/.windsurfrules"

if [ ! -f "$RULES_SRC" ]; then
    echo -e "${YELLOW}[警告]${NC} 规则模板文件不存在: $RULES_SRC"
else
    if [ -f "$RULES_DST" ]; then
        # 备份旧规则
        cp "$RULES_DST" "$RULES_DST.backup"
        echo -e "${YELLOW}[备份]${NC} 旧规则已备份到: $RULES_DST.backup"
    fi
    cp "$RULES_SRC" "$RULES_DST"
    echo -e "${GREEN}[OK]${NC} 全局规则已更新: $RULES_DST"
fi

# ========== 步骤 5：提示安装 VSIX ==========
echo ""
echo -e "${YELLOW}[5/5]${NC} 安装 Windsurf 扩展..."

# 查找最新的 VSIX 文件
VSIX_FILE=$(ls -t "$SCRIPT_DIR"/*.vsix 2>/dev/null | head -1)

if [ -z "$VSIX_FILE" ]; then
    echo -e "${YELLOW}[警告]${NC} 未找到 VSIX 文件"
    echo "        请从 GitHub Releases 下载最新版本"
else
    VSIX_NAME=$(basename "$VSIX_FILE")
    echo -e "${BLUE}[提示]${NC} 请手动安装扩展:"
    echo "        1. 打开 Windsurf"
    echo "        2. 按 Cmd+Shift+P 打开命令面板"
    echo "        3. 输入 Extensions: Install from VSIX"
    echo "        4. 选择文件: $VSIX_FILE"
    echo ""
    
    # 尝试打开 Finder 显示文件
    if command -v open &> /dev/null; then
        echo -e "${BLUE}[提示]${NC} 正在打开文件位置..."
        open -R "$VSIX_FILE"
    fi
fi

# ========== 完成 ==========
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}   安装完成！${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "下一步:"
echo "  [1] 手动安装 VSIX 扩展（如上所述）"
echo "  [2] 重启 Windsurf"
echo "  [3] 开始对话，AI 完成任务后会自动弹窗"
echo ""
echo "配置文件位置:"
echo "  全局规则: $RULES_DST"
echo "  MCP 配置: $WINDSURF_MCP_FILE"
echo ""
