import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";

const MCP_CALLBACK_PORT = 23984; // Port where MCP server listens for responses
const PORT_FILE_DIR = path.join(os.tmpdir(), "ask-continue-ports");

interface AskRequest {
  type: string;
  requestId: string;
  reason: string;
  callbackPort?: number;  // MCP 服务器的回调端口
}

let server: http.Server | null = null;
let statusBarItem: vscode.StatusBarItem;
let statusViewProvider: StatusViewProvider;
let lastPendingRequest: AskRequest | null = null; // 保存最近的待处理请求
let lastPendingRequestTime: number = 0; // 请求时间戳，用于判断请求是否过期

/**
 * 侧边栏状态视图
 */
class StatusViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "askContinue.statusView";
  private _view?: vscode.WebviewView;
  private _serverRunning = false;
  private _port = 23983;
  private _requestCount = 0;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlContent();

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "restart":
          vscode.commands.executeCommand("askContinue.restart");
          break;
        case "showStatus":
          vscode.commands.executeCommand("askContinue.showStatus");
          break;
        case "openPanel":
          vscode.commands.executeCommand("askContinue.openPanel");
          break;
      }
    });
  }

  public updateStatus(running: boolean, port: number) {
    this._serverRunning = running;
    this._port = port;
    if (this._view) {
      this._view.webview.html = this._getHtmlContent();
    }
  }

  public incrementRequestCount() {
    this._requestCount++;
    if (this._view) {
      this._view.webview.html = this._getHtmlContent();
    }
  }

  private _getHtmlContent(): string {
    const statusIcon = this._serverRunning ? "🟢" : "🔴";
    const statusText = this._serverRunning ? "运行中" : "已停止";
    const statusClass = this._serverRunning ? "running" : "stopped";

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 15px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-card {
      background: var(--vscode-editor-background);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .status-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .status-row:last-child {
      margin-bottom: 0;
    }
    .label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .value {
      font-size: 13px;
      font-weight: 500;
    }
    .value.running {
      color: #4ec9b0;
    }
    .value.stopped {
      color: #f14c4c;
    }
    .btn {
      width: 100%;
      padding: 8px 12px;
      margin-top: 8px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .info-box {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textLink-foreground);
      padding: 10px;
      margin-top: 12px;
      font-size: 11px;
      line-height: 1.5;
      color: var(--vscode-descriptionForeground);
    }
    .info-box strong {
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <div class="title">
    💬 Ask Continue
  </div>
  
  <div class="status-card">
    <div class="status-row">
      <span class="label">服务状态</span>
      <span class="value ${statusClass}">${statusIcon} ${statusText}</span>
    </div>
    <div class="status-row">
      <span class="label">监听端口</span>
      <span class="value">${this._port}</span>
    </div>
    <div class="status-row">
      <span class="label">对话次数</span>
      <span class="value">${this._requestCount}</span>
    </div>
  </div>
  
  <button class="btn btn-primary" onclick="openPanel()">📋 重新打开对话弹窗</button>
  <button class="btn" onclick="restart()">🔄 重启服务</button>
  
  <div class="info-box">
    <strong>提示:</strong> 如果不小心关闭了对话弹窗，点击上方按钮重新打开。
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    function openPanel() {
      vscode.postMessage({ command: 'openPanel' });
    }
    function restart() {
      vscode.postMessage({ command: 'restart' });
    }
  </script>
</body>
</html>`;
  }
}

/**
 * Send response back to MCP server
 */
async function sendResponseToMCP(
  requestId: string,
  userInput: string,
  cancelled: boolean,
  callbackPort?: number
): Promise<void> {
  const port = callbackPort || MCP_CALLBACK_PORT;
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      requestId,
      userInput,
      cancelled,
    });

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: port,
        path: "/response",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
        timeout: 5000,
      },
      (res) => {
        if (res.statusCode === 200 || res.statusCode === 404) {
          // 200 = 成功, 404 = 请求已过期/不存在（静默处理）
          resolve();
        } else {
          reject(new Error(`MCP server returned status ${res.statusCode}`));
        }
      }
    );

    req.on("error", (e) => {
      reject(new Error(`Failed to send response to MCP: ${e.message}`));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Show the Ask Continue dialog
 */
async function showAskContinueDialog(request: AskRequest): Promise<void> {
  // 保存当前请求，以便重新打开
  lastPendingRequest = request;
  lastPendingRequestTime = Date.now();
  
  let panel: vscode.WebviewPanel;
  try {
    panel = vscode.window.createWebviewPanel(
    "askContinue",
    "继续对话?",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  panel.webview.html = getWebviewContent(request.reason, request.requestId);
  } catch (err) {
    // Webview 创建失败，发送取消响应
    console.error("[Ask Continue] Failed to create webview panel:", err);
    lastPendingRequest = null;
    try {
      await sendResponseToMCP(request.requestId, "", true, request.callbackPort);
    } catch {
      // 忽略发送错误
    }
    vscode.window.showErrorMessage(`Ask Continue: 无法创建对话窗口 - ${err instanceof Error ? err.message : "未知错误"}`);
    return;
  }

  // 标记是否已发送响应，避免重复发送
  let responseSent = false;

  // Handle messages from webview
  panel.webview.onDidReceiveMessage(
    async (message) => {
      if (responseSent) return;
      
      switch (message.command) {
        case "continue":
          try {
            responseSent = true;
            lastPendingRequest = null; // 清除待处理请求
            let finalText = message.text;
            
            // 处理图片：附加 base64 数据（仅在非"仅路径"模式）
            if (message.images && message.images.length > 0 && message.uploadType !== 'path') {
              const imagesData = message.images.map((img: any, i: number) => 
                '[图片 ' + (i + 1) + ': ' + img.name + ']\n' + img.base64
              ).join('\n\n');
              finalText = finalText + '\n\n' + imagesData;
            }
            
            // 处理非图片文件：附加文件路径信息
            if (message.files && message.files.length > 0) {
              const filesData = message.files.map((f: any, i: number) => 
                '[文件 ' + (i + 1) + ': ' + f.name + ']' + (f.path ? '\n路径: ' + f.path : '')
              ).join('\n\n');
              finalText = finalText + '\n\n' + filesData;
            }
            
            await sendResponseToMCP(request.requestId, finalText, false, request.callbackPort);
            panel.dispose();
          } catch (error) {
            responseSent = false;
            vscode.window.showErrorMessage(
              `发送响应失败: ${error instanceof Error ? error.message : "未知错误"}`
            );
          }
          break;
        case "end":
          try {
            responseSent = true;
            await sendResponseToMCP(request.requestId, "", false, request.callbackPort);
            panel.dispose();
          } catch (error) {
            responseSent = false;
            vscode.window.showErrorMessage(
              `发送响应失败: ${error instanceof Error ? error.message : "未知错误"}`
            );
          }
          break;
        case "cancel":
          try {
            responseSent = true;
            await sendResponseToMCP(request.requestId, "", true, request.callbackPort);
            panel.dispose();
          } catch (error) {
            // Ignore errors on cancel
          }
          break;
        case "readFile":
          // 处理从文件资源管理器拖拽的文件读取请求
          try {
            const filePath = message.path;
            if (filePath && fs.existsSync(filePath)) {
              const fileContent = fs.readFileSync(filePath);
              const base64 = `data:image/${path.extname(filePath).slice(1)};base64,${fileContent.toString('base64')}`;
              const fileName = path.basename(filePath);
              const fileSize = fs.statSync(filePath).size;
              panel.webview.postMessage({
                command: 'fileContent',
                type: message.type,
                base64: base64,
                name: fileName,
                size: fileSize
              });
            }
          } catch (err) {
            console.error('[Ask Continue] Failed to read file:', err);
          }
          break;
      }
    },
    undefined,
    []
  );

  // Handle panel close (treat as cancel only if no response sent yet)
  panel.onDidDispose(async () => {
    // 清除待处理请求（无论是否已发送响应）
    if (lastPendingRequest?.requestId === request.requestId) {
      lastPendingRequest = null;
    }
    if (responseSent) return;
    try {
      await sendResponseToMCP(request.requestId, "", true, request.callbackPort);
    } catch {
      // Ignore errors on dispose
    }
  });
}

/**
 * Generate webview HTML content
 */
function getWebviewContent(reason: string, requestId: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ask Continue</title>
  <style>
    /* ========== 基础样式重置 ========== */
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    /* ========== 主体背景与动画 ========== */
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
      padding: 24px;
      color: #e4e4e7;
      background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%);
      min-height: 100vh;
      position: relative;
      overflow-x: hidden;
    }
    
    /* 科技感背景网格 */
    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-image: 
        linear-gradient(rgba(99, 102, 241, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(99, 102, 241, 0.03) 1px, transparent 1px);
      background-size: 50px 50px;
      pointer-events: none;
      z-index: 0;
    }
    
    /* ========== 主容器 ========== */
    .container {
      max-width: 520px;
      margin: 0 auto;
      position: relative;
      z-index: 1;
    }
    
    /* ========== 头部区域 ========== */
    .header {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-bottom: 24px;
      padding: 16px 0;
      position: relative;
    }
    
    .header::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
      width: 80%;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(99, 102, 241, 0.5), transparent);
    }
    
    .logo {
      width: 42px;
      height: 42px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6, #a855f7);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
      animation: pulse-glow 2s ease-in-out infinite;
    }
    
    @keyframes pulse-glow {
      0%, 100% { box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4); }
      50% { box-shadow: 0 4px 25px rgba(139, 92, 246, 0.6); }
    }
    
    .header-text h1 {
      font-size: 20px;
      font-weight: 700;
      background: linear-gradient(135deg, #e4e4e7, #a5b4fc);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      letter-spacing: -0.5px;
    }
    
    .header-text .subtitle {
      font-size: 12px;
      color: #6b7280;
      margin-top: 2px;
    }
    
    /* ========== 状态标签 ========== */
    .status-badge {
      position: absolute;
      right: 50px;
      top: 50%;
      transform: translateY(-50%);
      background: linear-gradient(135deg, #f59e0b, #f97316);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      padding: 5px 12px;
      border-radius: 20px;
      display: flex;
      align-items: center;
      gap: 5px;
      box-shadow: 0 2px 10px rgba(245, 158, 11, 0.3);
      animation: badge-pulse 1.5s ease-in-out infinite;
    }
    
    @keyframes badge-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.8; }
    }
    
    /* ========== 语言切换按钮 ========== */
    .lang-switch {
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      background: rgba(99, 102, 241, 0.2);
      border: 1px solid rgba(99, 102, 241, 0.3);
      color: #a5b4fc;
      font-size: 11px;
      font-weight: 500;
      padding: 4px 8px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    
    .lang-switch:hover {
      background: rgba(99, 102, 241, 0.3);
      border-color: rgba(99, 102, 241, 0.5);
    }
    
    .lang-switch #langIcon {
      font-size: 12px;
    }
    
    /* ========== 快捷键行 ========== */
    .shortcut-row {
      display: block;
      margin: 2px 0;
    }
    
    /* ========== 原因卡片 ========== */
    .reason-card {
      background: rgba(30, 30, 46, 0.8);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(99, 102, 241, 0.2);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 20px;
      position: relative;
      overflow: hidden;
    }
    
    .reason-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: linear-gradient(180deg, #6366f1, #a855f7);
    }
    
    .reason-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    
    .reason-icon {
      font-size: 16px;
    }
    
    .reason-label {
      font-size: 12px;
      font-weight: 600;
      color: #a5b4fc;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .reason-text {
      font-size: 14px;
      line-height: 1.6;
      color: #d1d5db;
      padding-left: 4px;
    }
    
    /* ========== 输入区域 ========== */
    .input-section {
      margin-bottom: 20px;
    }
    
    .input-label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 500;
      color: #e4e4e7;
      margin-bottom: 10px;
    }
    
    .input-label .icon {
      font-size: 14px;
    }
    
    .optional {
      color: #6b7280;
      font-weight: 400;
      font-size: 12px;
    }
    
    textarea {
      width: 100%;
      min-height: 110px;
      padding: 14px 16px;
      font-family: inherit;
      font-size: 14px;
      line-height: 1.6;
      color: #e4e4e7;
      background: rgba(30, 30, 46, 0.6);
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 10px;
      resize: vertical;
      outline: none;
      transition: all 0.3s ease;
    }
    
    textarea:focus {
      border-color: #6366f1;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
      background: rgba(30, 30, 46, 0.8);
    }
    
    textarea::placeholder {
      color: #6b7280;
    }
    
    /* ========== 上传区域 ========== */
    .upload-section {
      margin-bottom: 20px;
    }
    
    .upload-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    
    .upload-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 500;
      color: #e4e4e7;
    }
    
    .upload-options {
      display: flex;
      gap: 12px;
    }
    
    .upload-options label {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      color: #9ca3af;
      cursor: pointer;
      transition: color 0.2s;
    }
    
    .upload-options label:hover {
      color: #e4e4e7;
    }
    
    .upload-options input[type="radio"] {
      accent-color: #6366f1;
    }
    
    .drop-zone {
      background: rgba(30, 30, 46, 0.5);
      border: 2px dashed rgba(99, 102, 241, 0.3);
      border-radius: 12px;
      padding: 24px 16px;
      text-align: center;
      cursor: pointer;
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }
    
    .drop-zone:hover {
      border-color: rgba(99, 102, 241, 0.6);
      background: rgba(99, 102, 241, 0.05);
    }
    
    .drop-zone.dragover {
      border-color: #6366f1;
      background: rgba(99, 102, 241, 0.1);
      transform: scale(1.01);
    }
    
    .drop-zone.has-files {
      border-color: #10b981;
      border-style: solid;
      padding: 16px;
    }
    
    .drop-text {
      color: #9ca3af;
      font-size: 13px;
      line-height: 1.8;
    }
    
    .drop-text .highlight {
      color: #818cf8;
      font-weight: 500;
      text-decoration: none;
      cursor: pointer;
      transition: color 0.2s;
    }
    
    .drop-text .highlight:hover {
      color: #a5b4fc;
      text-decoration: underline;
    }
    
    .drop-text .kbd {
      background: rgba(99, 102, 241, 0.2);
      color: #a5b4fc;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }
    
    .drop-hint {
      font-size: 11px;
      color: #6b7280;
      margin-top: 8px;
    }
    
    /* ========== 文件预览网格 ========== */
    .files-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 12px;
      justify-content: center;
    }
    
    .file-item {
      position: relative;
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid rgba(99, 102, 241, 0.2);
      border-radius: 8px;
      overflow: hidden;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    
    .file-item:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.2);
    }
    
    .file-item img {
      max-width: 100px;
      max-height: 80px;
      object-fit: cover;
      display: block;
    }
    
    .file-item .file-info {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      min-width: 120px;
      max-width: 160px;
    }
    
    .file-item .file-icon {
      font-size: 24px;
      flex-shrink: 0;
    }
    
    .file-item .file-name {
      font-size: 11px;
      color: #d1d5db;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    .file-item .remove-btn {
      position: absolute;
      top: -4px;
      right: -4px;
      width: 20px;
      height: 20px;
      background: linear-gradient(135deg, #ef4444, #dc2626);
      color: white;
      border: 2px solid rgba(15, 15, 35, 0.8);
      border-radius: 50%;
      font-size: 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s;
      z-index: 10;
    }
    
    .file-item .remove-btn:hover {
      transform: scale(1.1);
    }
    
    .files-info {
      font-size: 12px;
      color: #9ca3af;
      text-align: center;
      margin-bottom: 10px;
    }
    
    .clear-all-btn {
      background: rgba(239, 68, 68, 0.1);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0 auto;
    }
    
    .clear-all-btn:hover {
      background: rgba(239, 68, 68, 0.2);
      border-color: rgba(239, 68, 68, 0.5);
    }
    
    /* ========== 按钮组 ========== */
    .button-group {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }
    
    .btn {
      flex: 1;
      padding: 14px 24px;
      font-size: 14px;
      font-weight: 600;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      position: relative;
      overflow: hidden;
    }
    
    .btn::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
      transition: left 0.5s;
    }
    
    .btn:hover::before {
      left: 100%;
    }
    
    .btn-primary {
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: white;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
    }
    
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.5);
    }
    
    .btn-primary:active {
      transform: translateY(0);
    }
    
    .btn-secondary {
      background: rgba(55, 65, 81, 0.5);
      color: #d1d5db;
      border: 1px solid rgba(107, 114, 128, 0.3);
    }
    
    .btn-secondary:hover {
      background: rgba(75, 85, 99, 0.5);
      border-color: rgba(107, 114, 128, 0.5);
    }
    
    /* ========== 快捷键提示 ========== */
    .shortcuts {
      text-align: center;
      font-size: 11px;
      color: #6b7280;
      margin-bottom: 20px;
    }
    
    .shortcuts kbd {
      background: rgba(99, 102, 241, 0.15);
      color: #a5b4fc;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: inherit;
      font-size: 10px;
      border: 1px solid rgba(99, 102, 241, 0.2);
    }
    
    /* ========== 页脚 ========== */
    .footer {
      text-align: center;
      padding-top: 16px;
      border-top: 1px solid rgba(99, 102, 241, 0.1);
    }
    
    .footer-text {
      font-size: 11px;
      color: #6b7280;
    }
    
    .footer-text a {
      color: #818cf8;
      text-decoration: none;
      font-weight: 500;
      transition: color 0.2s;
    }
    
    .footer-text a:hover {
      color: #a5b4fc;
    }
    
    .footer-star {
      margin-top: 6px;
      font-size: 11px;
      color: #6b7280;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- 头部区域 -->
    <div class="header">
      <div class="logo">🤖</div>
      <div class="header-text">
        <h1 data-zh="Windsurf 对话增强" data-en="Windsurf Dialogue+">Windsurf 对话增强</h1>
        <div class="subtitle" data-zh="智能对话助手" data-en="Smart Dialogue Assistant">智能对话助手</div>
      </div>
      <div class="status-badge" data-zh="待处理" data-en="Pending">
        <span>⚡</span>
        <span>待处理</span>
      </div>
      <button class="lang-switch" id="langSwitch" title="切换语言 / Switch Language">
        <span id="langIcon">🌐</span>
        <span id="langText">EN</span>
      </button>
    </div>
    
    <!-- 公告卡片 -->
    <div class="reason-card">
      <div class="reason-header">
        <span class="reason-icon">📢</span>
        <span class="reason-label" data-zh="公告 · v1.3.2" data-en="Announcement · v1.3.2">公告 · v1.3.2</span>
      </div>
      <div class="reason-text">
        <div data-zh="🔧 连接优化 | 🐍 Python优先 | ⏰ 超时延长 | 🧹 进程清理" data-en="🔧 Connection Fix | 🐍 Python First | ⏰ Timeout Extended | 🧹 Process Cleanup">🔧 连接优化 | 🐍 Python优先 | ⏰ 超时延长 | 🧹 进程清理</div>
        <div style="margin-top: 8px; font-size: 12px; color: #6b7280;" data-zh="GitHub: github.com/1837620622 · 二次开发: 传康KK" data-en="GitHub: github.com/1837620622 · Dev: ChuanKang KK">GitHub: github.com/1837620622 · 二次开发: 传康KK</div>
      </div>
    </div>
    
    <!-- 输入区域 -->
    <div class="input-section">
      <label class="input-label">
        <span class="icon">✏️</span>
        <span data-zh="如需继续，请输入新的指令" data-en="Enter new instruction to continue">如需继续，请输入新的指令</span> <span class="optional" data-zh="(可选)" data-en="(Optional)">(可选)</span>
      </label>
      <textarea 
        id="userInput" 
        placeholder="输入你的下一个指令... / Enter your next instruction..."
        autofocus
      ></textarea>
    </div>

    <!-- 上传区域 -->
    <div class="upload-section">
      <div class="upload-header">
        <div class="upload-title">
          <span>📎</span>
          <span data-zh="上传文件 (可选)" data-en="Upload Files (Optional)">上传文件 (可选)</span>
        </div>
        <div class="upload-options">
          <label><input type="radio" name="uploadType" value="base64" checked> <span data-zh="文件内容" data-en="Content">文件内容</span></label>
          <label><input type="radio" name="uploadType" value="path"> <span data-zh="仅路径" data-en="Path Only">仅路径</span></label>
        </div>
      </div>
      <input type="file" id="fileInput" multiple style="display: none;" />
      <div class="drop-zone" id="dropZone">
        <div id="dropText" class="drop-text">
          <span class="kbd"><span id="pasteKey">Ctrl</span>+V</span> <span data-zh="粘贴" data-en="Paste">粘贴</span> &nbsp;|&nbsp; <span data-zh="拖拽文件" data-en="Drag & Drop">拖拽文件</span> &nbsp;|&nbsp; <a href="#" id="selectFiles" class="highlight" data-zh="点击选择" data-en="Click to Select">点击选择</a>
          <div class="drop-hint" data-zh="支持从左侧文件资源管理器直接拖拽" data-en="Supports dragging from file explorer">支持从左侧文件资源管理器直接拖拽</div>
        </div>
        <div id="filePreviewContainer" style="display: none;">
          <div class="files-grid" id="filesGrid"></div>
          <div class="files-info" id="filesInfo"></div>
          <button type="button" class="clear-all-btn" id="clearAllBtn">
            <span>🗑️</span>
            <span data-zh="清空全部" data-en="Clear All">清空全部</span>
          </button>
        </div>
      </div>
    </div>
    
    <!-- 按钮组 -->
    <div class="button-group">
      <button class="btn btn-primary" id="continueBtn">
        <span>🚀</span>
        <span data-zh="继续执行" data-en="Continue">继续执行</span>
      </button>
      <button class="btn btn-secondary" id="endBtn">
        <span>⭕</span>
        <span data-zh="结束对话" data-en="End">结束对话</span>
      </button>
    </div>
    
    <!-- 快捷键提示 -->
    <div class="shortcuts">
      <span class="shortcut-row" id="shortcutWin"><b>Win:</b> <kbd>Enter</kbd> <span data-zh="继续" data-en="Continue">继续</span> | <kbd>Shift+Enter</kbd> <span data-zh="换行" data-en="Newline">换行</span> | <kbd>Esc</kbd> <span data-zh="结束" data-en="End">结束</span> | <kbd>Ctrl+V</kbd> <span data-zh="粘贴" data-en="Paste">粘贴</span></span>
      <span class="shortcut-row" id="shortcutMac"><b>Mac:</b> <kbd>Enter</kbd> <span data-zh="继续" data-en="Continue">继续</span> | <kbd>Shift+Enter</kbd> <span data-zh="换行" data-en="Newline">换行</span> | <kbd>Esc</kbd> <span data-zh="结束" data-en="End">结束</span> | <kbd>⌘+V</kbd> <span data-zh="粘贴" data-en="Paste">粘贴</span></span>
    </div>
    
    <!-- 页脚 -->
    <div class="footer">
      <div class="footer-text">
        二次开发 by <a href="https://github.com/1837620622" target="_blank">传康KK</a>
      </div>
      <div class="footer-star" data-zh="如果觉得好用，请给个 ⭐ Star" data-en="If helpful, please give a ⭐ Star">如果觉得好用，请给个 ⭐ Star</div>
    </div>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    const textarea = document.getElementById('userInput');
    const continueBtn = document.getElementById('continueBtn');
    const endBtn = document.getElementById('endBtn');
    const dropZone = document.getElementById('dropZone');
    const dropText = document.getElementById('dropText');
    const filePreviewContainer = document.getElementById('filePreviewContainer');
    const filesGrid = document.getElementById('filesGrid');
    const filesInfo = document.getElementById('filesInfo');
    const clearAllBtn = document.getElementById('clearAllBtn');
    
    // 支持多种文件的数组
    let fileList = [];
    
    // 文件选择器
    const fileInput = document.getElementById('fileInput');
    const selectFilesLink = document.getElementById('selectFiles');
    
    selectFilesLink.addEventListener('click', (e) => {
      e.preventDefault();
      fileInput.click();
    });
    
    fileInput.addEventListener('change', (e) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          handleFile(files[i]);
        }
      }
      fileInput.value = ''; // 清空以便重复选择
    });
    
    // 检测Mac系统，更新快捷键提示显示
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0 || navigator.userAgent.toUpperCase().indexOf('MAC') >= 0;
    const shortcutWin = document.getElementById('shortcutWin');
    const shortcutMac = document.getElementById('shortcutMac');
    if (isMac) {
      document.getElementById('pasteKey').textContent = '⌘';
      shortcutWin.style.display = 'none';
      shortcutMac.style.display = 'block';
    } else {
      shortcutWin.style.display = 'block';
      shortcutMac.style.display = 'none';
    }
    
    // ========== 语言切换功能 ==========
    let currentLang = 'zh';
    const langSwitch = document.getElementById('langSwitch');
    const langText = document.getElementById('langText');
    
    function switchLanguage() {
      currentLang = currentLang === 'zh' ? 'en' : 'zh';
      langText.textContent = currentLang === 'zh' ? 'EN' : '中';
      
      // 更新所有带有 data-zh 和 data-en 属性的元素
      document.querySelectorAll('[data-zh][data-en]').forEach(el => {
        el.textContent = el.getAttribute('data-' + currentLang);
      });
    }
    
    langSwitch.addEventListener('click', switchLanguage);
    
    // Focus textarea on load
    textarea.focus();
    
    // Handle keyboard shortcuts
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitContinue();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        submitEnd();
      }
    });
    
    // Handle paste event - 支持粘贴图片和文件
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      
      let hasFile = false;
      for (const item of items) {
        if (item.kind === 'file') {
          hasFile = true;
          const file = item.getAsFile();
          if (file) {
            handleFile(file);
          }
        }
      }
      if (hasFile) {
        e.preventDefault();
      }
    });
    
    // Handle drag and drop
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    
    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    });
    
    // 拖拽放下 - 支持多种文件和从文件资源管理器拖拽
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      
      // 尝试获取 VS Code 资源管理器拖拽的文件 URI
      const uriList = e.dataTransfer?.getData('text/uri-list');
      if (uriList) {
        const uris = uriList.split('\\n').filter(uri => uri.trim() && !uri.startsWith('#'));
        for (const uri of uris) {
          handleFileUri(uri.trim());
        }
        return;
      }
      
      // 处理普通文件拖拽
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          handleFile(files[i]);
        }
      }
    });
    
    // 处理从文件资源管理器拖拽的 URI
    function handleFileUri(uri) {
      // 移除 file:// 前缀
      let filePath = uri;
      if (uri.startsWith('file://')) {
        filePath = decodeURIComponent(uri.replace('file://', ''));
      }
      
      // 获取文件名
      const fileName = filePath.split('/').pop() || filePath.split('\\\\').pop() || 'unknown';
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      
      // 判断是否为图片
      if (isImage(fileName)) {
        // 图片文件：发送消息给扩展读取文件内容
        vscode.postMessage({ command: 'readFile', path: filePath, type: 'image' });
      } else {
        // 非图片文件：直接添加到列表
        const fileData = {
          path: filePath,
          name: fileName,
          size: 0,
          type: '',
          isImage: false,
          id: Date.now() + '_' + Math.random().toString(36).substr(2, 9)
        };
        fileList.push(fileData);
        updateFilePreview();
      }
    }
    
    // 获取文件图标
    function getFileIcon(fileName) {
      const ext = fileName.split('.').pop().toLowerCase();
      const icons = {
        'pdf': '📄', 'doc': '📝', 'docx': '📝', 'txt': '📃',
        'xls': '📊', 'xlsx': '📊', 'csv': '📊',
        'ppt': '📽️', 'pptx': '📽️',
        'zip': '📦', 'rar': '📦', '7z': '📦', 'tar': '📦', 'gz': '📦',
        'js': '💻', 'ts': '💻', 'py': '🐍', 'java': '☕', 'c': '💻', 'cpp': '💻', 'h': '💻',
        'html': '🌐', 'css': '🎨', 'json': '📋', 'xml': '📋', 'yaml': '📋', 'yml': '📋',
        'md': '📖', 'log': '📜',
        'png': '🖼️', 'jpg': '🖼️', 'jpeg': '🖼️', 'gif': '🖼️', 'svg': '🖼️', 'webp': '🖼️', 'bmp': '🖼️',
        'mp3': '🎵', 'wav': '🎵', 'mp4': '🎬', 'avi': '🎬', 'mov': '🎬'
      };
      return icons[ext] || '📁';
    }
    
    // 判断是否为图片
    function isImage(fileName) {
      const ext = fileName.split('.').pop().toLowerCase();
      return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext);
    }
    
    // 处理单个文件 - 添加到文件列表
    function handleFile(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const fileData = {
          base64: e.target.result,
          name: file.name,
          size: file.size,
          type: file.type,
          isImage: file.type.startsWith('image/'),
          id: Date.now() + '_' + Math.random().toString(36).substr(2, 9)
        };
        fileList.push(fileData);
        updateFilePreview();
      };
      reader.readAsDataURL(file);
    }
    
    // 更新文件预览区域
    function updateFilePreview() {
      if (fileList.length === 0) {
        dropText.style.display = 'block';
        filePreviewContainer.style.display = 'none';
        dropZone.classList.remove('has-files');
        filesGrid.innerHTML = '';
        filesInfo.textContent = '';
      } else {
        dropText.style.display = 'none';
        filePreviewContainer.style.display = 'block';
        dropZone.classList.add('has-files');
        
        // 生成文件预览HTML
        filesGrid.innerHTML = fileList.map((file, index) => {
          if (file.isImage && file.base64) {
            return '<div class="file-item" data-id="' + file.id + '">' +
              '<img src="' + file.base64 + '" title="' + file.name + '" />' +
              '<button type="button" class="remove-btn" data-index="' + index + '">✕</button>' +
            '</div>';
          } else {
            return '<div class="file-item" data-id="' + file.id + '">' +
              '<div class="file-info" title="' + (file.path || file.name) + '">' +
                '<span class="file-icon">' + getFileIcon(file.name) + '</span>' +
                '<span class="file-name">' + file.name + '</span>' +
              '</div>' +
              '<button type="button" class="remove-btn" data-index="' + index + '">✕</button>' +
            '</div>';
          }
        }).join('');
        
        // 显示数量统计
        const imageCount = fileList.filter(f => f.isImage).length;
        const otherCount = fileList.length - imageCount;
        const totalSize = fileList.reduce((sum, f) => sum + (f.size || 0), 0);
        let infoText = '共 ' + fileList.length + ' 个文件';
        if (imageCount > 0 && otherCount > 0) {
          infoText = imageCount + ' 张图片 + ' + otherCount + ' 个文件';
        } else if (imageCount > 0) {
          infoText = imageCount + ' 张图片';
        }
        if (totalSize > 0) infoText += ' (' + formatFileSize(totalSize) + ')';
        filesInfo.textContent = infoText;
        
        // 绑定单个删除按钮事件
        filesGrid.querySelectorAll('.remove-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.getAttribute('data-index'));
            fileList.splice(index, 1);
            updateFilePreview();
          });
        });
      }
    }
    
    // 接收扩展发来的文件内容
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'fileContent') {
        if (message.type === 'image' && message.base64) {
          const fileData = {
            base64: message.base64,
            name: message.name,
            size: message.size || 0,
            type: 'image',
            isImage: true,
            id: Date.now() + '_' + Math.random().toString(36).substr(2, 9)
          };
          fileList.push(fileData);
          updateFilePreview();
        }
      }
    });
    
    // Format file size
    function formatFileSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
    
    // 移除全部文件
    clearAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileList = [];
      updateFilePreview();
    });
    
    // Button handlers
    continueBtn.addEventListener('click', submitContinue);
    endBtn.addEventListener('click', submitEnd);
    
    function submitContinue() {
      let text = textarea.value.trim();
      const uploadType = document.querySelector('input[name="uploadType"]:checked')?.value || 'base64';
      
      // 如果有文件，将所有文件信息附加到消息中
      if (fileList.length > 0) {
        const filesText = fileList.map((f, i) => {
          const icon = f.isImage ? '🖼️' : getFileIcon(f.name);
          if (uploadType === 'path' && f.path) {
            // 仅路径模式：显示文件路径
            return '[已上传' + icon + ' ' + (i + 1) + ': ' + f.name + ']\\n路径: ' + f.path;
          } else {
            return '[已上传' + icon + ' ' + (i + 1) + ': ' + f.name + ' (' + formatFileSize(f.size) + ')]';
          }
        }).join('\\n');
        text = (text ? text + '\\n\\n' : '') + filesText;
      }
      
      // 传递文件数据给扩展后端处理
      const images = fileList.filter(f => f.isImage).map(f => ({ name: f.name, base64: f.base64, size: f.size, path: f.path }));
      const files = fileList.filter(f => !f.isImage).map(f => ({ name: f.name, path: f.path, size: f.size }));
      
      vscode.postMessage({ 
        command: 'continue', 
        text: text || '继续', 
        hasImage: images.length > 0, 
        imageCount: images.length, 
        images: images,
        files: files,
        uploadType: uploadType
      });
    }
    
    function submitEnd() {
      vscode.postMessage({ command: 'end' });
    }
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Start the HTTP server to receive requests from MCP
 */
function startServer(port: number, retryCount = 0): void {
  // 先安全关闭旧服务器
  if (server) {
    try {
      server.close();
    } catch {
      // 忽略关闭错误
    }
    server = null;
  }

  const newServer = http.createServer((req, res) => {
    // Set CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/ask") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const request = JSON.parse(body) as AskRequest;

          if (request.type === "ask_continue") {
            // Show dialog with error handling
            try {
              // 使用 await 确保 webview 创建完成
              await showAskContinueDialog(request);
              
              // Update request count in sidebar
              statusViewProvider?.incrementRequestCount();

              // Respond that we received the request
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true }));
            } catch (dialogErr) {
              console.error("[Ask Continue] Error showing dialog:", dialogErr);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Failed to show dialog", details: String(dialogErr) }));
            }
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown request type" }));
          }
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  newServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // 端口被占用，尝试下一个端口（最多重试3次）
      if (retryCount < 3) {
        const nextPort = port + 1;
        console.log(`Port ${port} in use, trying ${nextPort}...`);
        setTimeout(() => startServer(nextPort, retryCount + 1), 100);
      } else {
        updateStatusBar(false, port);
        vscode.window.showWarningMessage(
          `Ask Continue: 端口 ${port - 3} - ${port} 均被占用，服务未启动`
        );
      }
    } else {
      updateStatusBar(false, port);
      console.error(`Ask Continue server error: ${err.message}`);
    }
  });

  newServer.listen(port, "127.0.0.1", () => {
    server = newServer;
    console.log(`Ask Continue server listening on port ${port}`);
    updateStatusBar(true, port);
    
    // 写入端口文件，供 MCP 服务器发现
    writePortFile(port);
  });
}

/**
 * 写入端口文件，供 MCP 服务器发现
 */
function writePortFile(port: number): void {
  try {
    if (!fs.existsSync(PORT_FILE_DIR)) {
      fs.mkdirSync(PORT_FILE_DIR, { recursive: true });
    }
    // 使用进程 ID 作为文件名，确保多窗口不冲突
    const portFile = path.join(PORT_FILE_DIR, `${process.pid}.port`);
    fs.writeFileSync(portFile, JSON.stringify({ port, pid: process.pid, time: Date.now() }));
  } catch (e) {
    console.error("Failed to write port file:", e);
  }
}

/**
 * 清理端口文件
 */
function cleanupPortFile(): void {
  try {
    const portFile = path.join(PORT_FILE_DIR, `${process.pid}.port`);
    if (fs.existsSync(portFile)) {
      fs.unlinkSync(portFile);
    }
  } catch (e) {
    // 忽略清理错误
  }
}

/**
 * 清理旧的 MCP 回调端口进程（启动时自动调用）
 */
async function cleanupOldMcpProcesses(): Promise<void> {
  const isWindows = process.platform === "win32";
  
  // 清理端口 23984-24034 范围内的旧进程（MCP 回调端口范围）
  for (let port = 23984; port <= 24034; port++) {
    try {
      if (isWindows) {
        // Windows: 查找并结束占用端口的进程
        exec(`netstat -ano | findstr :${port} | findstr LISTENING`, (err, stdout) => {
          if (!err && stdout) {
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
              const parts = line.trim().split(/\s+/);
              const pid = parts[parts.length - 1];
              if (pid && /^\d+$/.test(pid) && pid !== process.pid.toString()) {
                exec(`taskkill /F /PID ${pid}`, () => {
                  console.log(`[Ask Continue] Killed old MCP process on port ${port} (PID: ${pid})`);
                });
              }
            }
          }
        });
      } else {
        // Unix/Mac: 使用 lsof
        exec(`lsof -ti:${port}`, (err, stdout) => {
          if (!err && stdout) {
            const pids = stdout.trim().split('\n');
            for (const pid of pids) {
              if (pid && pid !== process.pid.toString()) {
                exec(`kill -9 ${pid}`, () => {
                  console.log(`[Ask Continue] Killed old MCP process on port ${port} (PID: ${pid})`);
                });
              }
            }
          }
        });
      }
    } catch (e) {
      // 忽略单个端口清理错误
    }
  }
  
  // 清理旧的端口文件
  try {
    if (fs.existsSync(PORT_FILE_DIR)) {
      const files = fs.readdirSync(PORT_FILE_DIR);
      for (const file of files) {
        if (file.endsWith('.port')) {
          const filePath = path.join(PORT_FILE_DIR, file);
          try {
            const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            // 如果进程已不存在，删除文件
            if (content.pid && content.pid !== process.pid) {
              if (isWindows) {
                exec(`tasklist /FI "PID eq ${content.pid}"`, (err, stdout) => {
                  if (!stdout || !stdout.includes(content.pid.toString())) {
                    fs.unlinkSync(filePath);
                  }
                });
              } else {
                exec(`ps -p ${content.pid}`, (err) => {
                  if (err) {
                    fs.unlinkSync(filePath);
                  }
                });
              }
            }
          } catch {
            fs.unlinkSync(filePath);
          }
        }
      }
    }
  } catch (e) {
    // 忽略清理错误
  }
}

/**
 * Update status bar and sidebar
 */
function updateStatusBar(running: boolean, port?: number): void {
  if (running && port) {
    statusBarItem.text = `$(check) Ask Continue: ${port} | @1837620622`;
    statusBarItem.tooltip = `Ask Continue 正在运行 (端口 ${port})\n二次开发: github.com/1837620622`;
    statusBarItem.backgroundColor = undefined;
    statusViewProvider?.updateStatus(true, port);
  } else {
    statusBarItem.text = "$(x) Ask Continue: 已停止 | @1837620622";
    statusBarItem.tooltip = "Ask Continue 未运行\n二次开发: github.com/1837620622";
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
    statusViewProvider?.updateStatus(false, port || 23983);
  }
}

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log("Ask Continue extension is now active");

  // Create sidebar view provider
  statusViewProvider = new StatusViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      StatusViewProvider.viewType,
      statusViewProvider
    )
  );

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "askContinue.showStatus";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Get configuration
  const config = vscode.workspace.getConfiguration("askContinue");
  const port = config.get<number>("serverPort", 23983);
  const autoStart = config.get<boolean>("autoStart", true);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("askContinue.showStatus", () => {
      const isRunning = server !== null && server.listening;
      vscode.window.showInformationMessage(
        `Ask Continue 状态: ${isRunning ? `运行中 (端口 ${port})` : "已停止"}`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("askContinue.restart", async () => {
      const config = vscode.workspace.getConfiguration("askContinue");
      const port = config.get<number>("serverPort", 23983);
      
      // 先清理旧进程
      vscode.window.showInformationMessage("Ask Continue: 正在重启服务...");
      await cleanupOldMcpProcesses();
      
      // 等待一小段时间确保端口释放
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 重启服务器
      startServer(port);
      vscode.window.showInformationMessage(`Ask Continue: 服务器已重启 (端口 ${port})`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("askContinue.openPanel", () => {
      if (lastPendingRequest) {
        // 检查请求是否过期（30分钟，延长超时时间）
        const REQUEST_TIMEOUT = 30 * 60 * 1000; // 30 minutes
        if (Date.now() - lastPendingRequestTime > REQUEST_TIMEOUT) {
          lastPendingRequest = null;
          vscode.window.showWarningMessage("Ask Continue: 待处理的请求已过期，请让 AI 重新调用 ask_continue");
          return;
        }
        // 重新打开对话窗口
        showAskContinueDialog(lastPendingRequest);
        vscode.window.showInformationMessage("Ask Continue: 对话窗口已重新打开");
      } else {
        vscode.window.showWarningMessage("Ask Continue: 没有待处理的对话请求。请让 AI 调用 ask_continue 工具。");
      }
    })
  );

  // 启动时自动清理旧的 MCP 进程
  cleanupOldMcpProcesses().then(() => {
    console.log("[Ask Continue] Old MCP processes cleanup completed");
  });

  // Auto-start server
  if (autoStart) {
    startServer(port);
  } else {
    updateStatusBar(false);
  }

  // Watch for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("askContinue.serverPort")) {
        const newPort = vscode.workspace
          .getConfiguration("askContinue")
          .get<number>("serverPort", 23983);
        startServer(newPort);
      }
    })
  );
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  if (server) {
    server.close();
    server = null;
  }
}
