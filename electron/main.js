'use strict'

const { app, Tray, Menu, shell, nativeImage, BrowserWindow, dialog } = require('electron')
const path = require('path')
const net = require('net')
const fs = require('fs')

// ─── 单实例锁：防止打开多个后台 ──────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
    app.quit()
} else {
    // 第二个实例启动时，聚焦已有窗口
    app.on('second-instance', () => {
        if (playerWindow && !playerWindow.isDestroyed()) {
            if (playerWindow.isMinimized()) playerWindow.restore()
            playerWindow.show()
            playerWindow.focus()
        }
    })
}

// ─── 配置加载逻辑 ─────────────────────────────────────────────────────────
const defaultStorageRoot = app.getPath('userData')
const basePathConfigFile = path.join(defaultStorageRoot, 'base_path.json')

function getAppConfig() {
    try {
        if (fs.existsSync(basePathConfigFile)) {
            const content = fs.readFileSync(basePathConfigFile, 'utf8')
            return content ? JSON.parse(content) : {}
        }
    } catch (_) { }
    return {}
}

function updateAppConfig(newConfig) {
    try {
        const config = getAppConfig()
        const merged = { ...config, ...newConfig }
        if (!fs.existsSync(defaultStorageRoot)) fs.mkdirSync(defaultStorageRoot, { recursive: true })
        fs.writeFileSync(basePathConfigFile, JSON.stringify(merged))
    } catch (e) { console.error('Save config failed:', e) }
}

function getStoredPath() {
    const data = getAppConfig()
    if (data.storagePath && fs.existsSync(data.storagePath)) {
        return data.storagePath
    }
    return null
}

function saveStoredPath(newPath) {
    updateAppConfig({ storagePath: newPath })
}

if (getAppConfig().disableAcceleration) {
    app.disableHardwareAcceleration()
}

// ─── 核心状态 ──────────────────────────────────────────────────────────────
let storageRoot = null
let SERVER_PORT = 9527
let BASE_URL = ''
let tray = null
let playerWindow = null  // 播放器窗口（常驻，关闭只隐藏）
let adminWindow = null   // 管理后台窗口（可正常关闭）

// 自定义路径（启动后通过 fetchServerPaths() 更新）
let PLAYER_PATH_CONFIG = '/music'
let ADMIN_PATH_CONFIG = ''

const appRoot = app.getAppPath()
const staticPath = app.isPackaged
    ? path.join(appRoot + '.unpacked', 'public')
    : path.join(appRoot, 'public')
process.env.STATIC_PATH = staticPath

if (app.isPackaged) {
    process.chdir(path.dirname(app.getPath('exe')))
}

// ─── 服务器启动 ─────────────────────────────────────────────────────────────
async function startServer() {
    const dataDir = path.join(storageRoot, 'data')
    const logsDir = path.join(storageRoot, 'logs')
    process.env.DATA_PATH = dataDir
    process.env.LOG_PATH = logsDir
    process.env.CONFIG_PATH = path.join(storageRoot, 'config.js')

        ;[dataDir, logsDir].forEach(d => { try { fs.mkdirSync(d, { recursive: true }) } catch (_) { } })

    const getAvailablePort = (startPort) => {
        return new Promise((resolve) => {
            const server = net.createServer()
            server.listen(startPort, '0.0.0.0', () => {
                const { port } = server.address()
                server.close(() => resolve(port))
            })
            server.on('error', () => resolve(getAvailablePort(startPort + 1)))
        })
    }

    SERVER_PORT = await getAvailablePort(9527)
    process.env.PORT = SERVER_PORT.toString()
    process.env.BIND_IP = '0.0.0.0'
    BASE_URL = `http://127.0.0.1:${SERVER_PORT}`

    try {
        require('../index.js')
    } catch (err) {
        console.error('Server Failed:', err)
    }
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────
function getIcon(name) {
    const p = path.join(appRoot, 'electron', 'icons', name)
    if (fs.existsSync(p)) return nativeImage.createFromPath(p)
    return null
}

/** 从服务器读取自定义路径配置（/js/config.js 端点已动态注入路径字段） */
async function fetchServerPaths() {
    try {
        const res = await fetch(`${BASE_URL}/js/config.js`)
        const text = await res.text()
        // 解析 window.CONFIG = {...};
        const match = text.match(/window\.CONFIG\s*=\s*(\{[\s\S]*?\});/)
        if (match) {
            const cfg = JSON.parse(match[1])
            if (cfg['player.path']) PLAYER_PATH_CONFIG = cfg['player.path']
            if (cfg['admin.path'] !== undefined) ADMIN_PATH_CONFIG = cfg['admin.path']
            console.log(`[Path Config] player: ${PLAYER_PATH_CONFIG}, admin: ${ADMIN_PATH_CONFIG || '/'}`)
        }
    } catch (e) {
        console.error('fetchServerPaths failed:', e)
    }
}


// ─── 播放器窗口管理（常驻，关闭只隐藏，保持音乐播放） ──────────────────────────
function showPlayerWindow() {
    const playerURL = `${BASE_URL}${PLAYER_PATH_CONFIG || '/music'}`

    if (!playerWindow || playerWindow.isDestroyed()) {
        playerWindow = new BrowserWindow({
            title: 'LX Music Player',
            width: 1200,
            height: 850,
            minWidth: 900,
            minHeight: 650,
            icon: getIcon('icon.png'),
            autoHideMenuBar: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                // 禁用 CORS/混合内容安全检查，允许渲染进程 fetch/WS 连接局域网 LX Music 设备
                webSecurity: false,
            }
        })
        playerWindow.on('page-title-updated', (e) => e.preventDefault())
        // 关闭时只隐藏，保持后台播放
        playerWindow.on('close', (event) => {
            if (!app.isQuiting) {
                event.preventDefault()
                playerWindow.hide()
            }
        })
        playerWindow.loadURL(playerURL)
    } else {
        // 窗口已存在：若已显示且在播放器页，直接聚焦；否则 show+focus
        playerWindow.show()
        playerWindow.focus()
    }
}

// ─── 管理后台窗口管理（独立窗口，不影响播放器） ────────────────────────────────
function showAdminWindow() {
    const adminURL = ADMIN_PATH_CONFIG ? `${BASE_URL}${ADMIN_PATH_CONFIG}` : BASE_URL

    if (!adminWindow || adminWindow.isDestroyed()) {
        adminWindow = new BrowserWindow({
            title: 'LX Music Server Admin',
            width: 1200,
            height: 850,
            minWidth: 900,
            minHeight: 650,
            icon: getIcon('icon.png'),
            autoHideMenuBar: true,
            webPreferences: { nodeIntegration: false, contextIsolation: true }
        })
        adminWindow.on('page-title-updated', (e) => e.preventDefault())
        // 管理后台直接关闭即可（不需要保持后台）
        adminWindow.on('closed', () => {
            adminWindow = null
        })
        adminWindow.loadURL(adminURL)
    } else {
        adminWindow.show()
        adminWindow.focus()
    }
}

// ─── 托盘创建 ──────────────────────────────────────────────────────────────
function createTray() {
    const icon = getIcon('tray.png') || nativeImage.createEmpty()
    tray = new Tray(icon)
    tray.setToolTip(`LX Music Server (${SERVER_PORT})`)

    const menu = Menu.buildFromTemplate([
        { label: `● 运行中 (端口: ${SERVER_PORT})`, enabled: false },
        { label: `● 存储目录 : ${path.basename(storageRoot)}`, enabled: false },
        { type: 'separator' },
        { label: '打开播放器', click: () => showPlayerWindow() },
        { label: '打开管理后台', click: () => showAdminWindow() },
        { type: 'separator' },
        {
            label: '设置与管理',
            submenu: [
                {
                    label: '开机自动运行',
                    type: 'checkbox',
                    checked: app.getLoginItemSettings().openAtLogin,
                    click: (item) => {
                        app.setLoginItemSettings({ openAtLogin: item.checked })
                    }
                },
                {
                    label: '启动时不显示主界面 (最小化到托盘)',
                    type: 'checkbox',
                    checked: !!getAppConfig().silentStart,
                    click: (item) => {
                        updateAppConfig({ silentStart: item.checked })
                    }
                },
                {
                    label: '关闭硬件加速 (需重启生效)',
                    type: 'checkbox',
                    checked: !!getAppConfig().disableAcceleration,
                    click: (item) => {
                        updateAppConfig({ disableAcceleration: item.checked })
                        dialog.showMessageBox({ type: 'info', title: '提示', message: '更改硬件加速设置需要重启软件才能生效。' })
                    }
                },
                { type: 'separator' },
                {
                    label: '更换存储位置...',
                    click: () => {
                        const result = dialog.showOpenDialogSync({
                            title: '选择数据和日志存放目录',
                            properties: ['openDirectory', 'createDirectory']
                        })
                        if (result && result[0]) {
                            const newPath = result[0]
                            if (newPath === storageRoot) return

                            // 询问用户是否迁移
                            const choice = dialog.showMessageBoxSync({
                                type: 'question',
                                title: '是否迁移数据?',
                                message: '您改变了存储位置，是否需要将原有的数据(包含您的配置、用户的收藏列表)一起迁移到新目录下？\n\n【说明】：迁移后将自动删除旧目录中的数据文件。',
                                buttons: ['迁移原有数据', '仅使用新目录 (当做新空服务端)', '取消']
                            })

                            if (choice === 2) return // 取消

                            if (choice === 0) { // 迁移
                                try {
                                    const itemsToMove = ['data', 'logs', 'config.js']
                                    itemsToMove.forEach(item => {
                                        const src = path.join(storageRoot, item)
                                        const dest = path.join(newPath, item)
                                        if (fs.existsSync(src)) {
                                            fs.cpSync(src, dest, { recursive: true })
                                            // 复制成功后删除旧文件
                                            fs.rmSync(src, { recursive: true, force: true })
                                        }
                                    })
                                } catch (err) {
                                    dialog.showMessageBoxSync({
                                        type: 'error',
                                        title: '迁移遇到问题',
                                        message: `迁移时部分文件被系统占用导致无法被移动或删除，请后续手动去旧目录检查拷贝或删除残余文件。\n\n具体错误: ${err.message}`
                                    })
                                }
                            }

                            saveStoredPath(newPath)
                            if (process.env.PORTABLE_EXECUTABLE_FILE) {
                                app.relaunch({ execPath: process.env.PORTABLE_EXECUTABLE_FILE })
                            } else {
                                app.relaunch()
                            }
                            app.exit()
                        }
                    }
                },
                { type: 'separator' },
                { label: '打开当前存储路径', click: () => shell.openPath(storageRoot) },
                { label: '用外部浏览器打开', click: () => shell.openExternal(BASE_URL) }
            ]
        },
        { type: 'separator' },
        {
            label: '重启软件', click: () => {
                if (process.env.PORTABLE_EXECUTABLE_FILE) {
                    app.relaunch({ execPath: process.env.PORTABLE_EXECUTABLE_FILE })
                } else {
                    app.relaunch()
                }
                app.exit()
            }
        },
        { label: '完全退出', click: () => { app.isQuiting = true; app.quit() } },
    ])
    tray.setContextMenu(menu)
    // 点击托盘图标：若播放器已在前台则最小化，否则显示
    tray.on('click', () => {
        if (playerWindow && !playerWindow.isDestroyed() && playerWindow.isVisible() && playerWindow.isFocused()) {
            playerWindow.hide()
        } else {
            showPlayerWindow()
        }
    })
}

// ─── App 生命周期 ─────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    storageRoot = getStoredPath()

    // 初始化引导
    if (!storageRoot) {
        const choice = dialog.showMessageBoxSync({
            type: 'question',
            title: '初始化存储位置',
            message: '请先选择一个用于存放数据和日志的文件夹。',
            buttons: ['选择文件夹', '使用默认 (AppData)']
        })
        storageRoot = (choice === 0) ? (dialog.showOpenDialogSync({ properties: ['openDirectory', 'createDirectory'] }) || [defaultStorageRoot])[0] : defaultStorageRoot
        saveStoredPath(storageRoot)
    }

    await startServer()
    // 延迟一下再读取路径配置，绉公服务器完全启动
    setTimeout(() => fetchServerPaths(), 3000)
    if (process.platform === 'darwin' && app.dock) app.dock.hide()
    createTray()

    // 启动时根据配置决定是否显示主界面
    if (!getAppConfig().silentStart) {
        showPlayerWindow()
    }
})

// 托盘 App 重写退出逻辑
app.on('before-quit', () => { app.isQuiting = true })
app.on('window-all-closed', () => { })
