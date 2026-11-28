# Workflow Automation Frontend

独立的前端项目，与 Go API 服务端项目 `../workflow_automation` 同级。

## 本地开发

先在服务端项目启动 Go API（默认 `127.0.0.1:8787`），再运行：

```sh
npm install
npm run dev
```

访问 `http://127.0.0.1:5173`。Vite 将 `/api/*` 请求代理到 Go 服务。自定义后端地址：

```sh
WORKFLOW_API_TARGET=http://127.0.0.1:8787 npm run dev
```

## 构建

```sh
npm run build
npm run preview
```

生产静态文件输出到 `dist/`，需要由独立静态服务器托管。后端只提供 API，不托管此目录。

## Git 源代码管理

任务工作区左侧提供 Git 仓库选择、分支操作和改动文件分组，手机端通过左侧的分支图标打开抽屉。点击文件打开差异窗口，可切换已暂存和工作区差异。面板状态与请求竞态处理封装于 `js/git.js`；具体接口与行为见后端 README 的「任务源代码管理」。
