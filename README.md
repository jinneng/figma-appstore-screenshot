# App Store to Figma

一键获取 App Store 的应用截图和图标，并导入到 Figma。

## 功能

- 搜索指定国家/地区的 App Store 应用
- 下载应用图标（512x512）
- 下载 iPhone 截图
- 下载 iPad 截图
- 保存应用元数据
- 支持多个国家/地区

## 使用方法

### 1. 下载 App Store 资源

```bash
node index.js "应用名称" [国家代码] [设备类型] [--figma]
```

示例：

```bash
# 搜索美国区的 Instagram，下载所有截图
node index.js "Instagram" US all

# 搜索中国区的微信，只下载 iPhone 截图
node index.js "微信" CN iphone

# 搜索日本区的 LINE，只下载 iPad 截图
node index.js "LINE" JP ipad

# 下载并生成 Figma 预览页面
node index.js "Instagram" US all --figma
```

### 2. 支持的国家代码

- US: United States
- CN: China
- JP: Japan
- GB: United Kingdom
- DE: Germany
- FR: France
- KR: South Korea
- CA: Canada
- AU: Australia
- TW: Taiwan
- HK: Hong Kong
- SG: Singapore

### 3. 支持的设备类型

- `iphone` - 只下载 iPhone 截图
- `ipad` - 只下载 iPad 截图
- `all` - 下载所有截图（默认）

### 4. 下载的文件

所有文件会保存在 `downloads/[bundle-id]/` 目录下：

- `icon.png` - 应用图标
- `iphone-screenshot-1.png`, `iphone-screenshot-2.png`, ... - iPhone 截图
- `ipad-screenshot-1.png`, `ipad-screenshot-2.png`, ... - iPad 截图
- `metadata.json` - 应用元数据
- `preview.html` - Figma 预览页面（使用 --figma 时生成）

## 上传到 Figma

### 方法 1：使用 Figma MCP（推荐）

下载完成后，使用 `--figma` 选项会自动生成预览页面：

```bash
node index.js "Instagram" US all --figma
```

然后在 Claude Code 中使用 Figma MCP 工具：

```javascript
// 使用生成的 preview.html 文件路径
// 例如: file:///Users/kim/appstore-to-figma/downloads/com.instagram.instagram/preview.html
```

### 方法 2：手动上传

1. 打开生成的 `preview.html` 文件
2. 在浏览器中截图或使用 Figma 的导入功能
3. 或者直接将图片文件拖入 Figma

### 方法 3：使用辅助脚本

```bash
# 启动本地服务器
node figma-upload.js com.instagram.instagram

# 然后使用 Figma MCP 捕获 http://localhost:8765/preview.html
```

## 技术栈

- Node.js (ES Modules)
- iTunes Search API
- Figma MCP Server

## 注意事项

- 需要网络连接访问 iTunes API
- 某些应用可能在特定地区不可用
- 截图数量因应用而异
