
import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { PassThrough } from 'stream'
const { MusicTagger, MetaPicture } = require('music-tag-native')
import { buildLyrics, parseLyrics } from '../utils/lrcTool'

// Define the two possible cache roots
export const CACHE_ROOTS = {
    DATA: 'data', // inside global.lx.dataPath (synced)
    ROOT: 'root'  // relative to process.cwd() (not synced)
}

let currentCacheLocation = CACHE_ROOTS.ROOT

// Helper to get actual directory path
// [Unified Enhancement] Cache Progress Tracker
export const cacheProgress: Map<string, { progress: number; status: string; total?: number; received?: number }> = new Map()

// [New] Active Cache Tasks Tracker: username -> [ { songKey, controller } ]
export const activeTasks: Map<string, Array<{ songKey: string, controller: AbortController }>> = new Map()

const getCacheDir = (username?: string, isOnlyDownload?: boolean) => {
    const folderName = isOnlyDownload ? 'music' : 'cache'
    let baseDir = ''
    if (currentCacheLocation === CACHE_ROOTS.DATA) {
        baseDir = path.join(global.lx.dataPath, folderName)
    } else {
        baseDir = path.join(process.cwd(), folderName)
    }

    // [New] Segment cache by username
    const userDirName = (username && username !== '_open' && username !== 'default') ? username : '_open'

    return path.join(baseDir, userDirName)
}

// Ensure directory exists
const ensureDir = (username?: string, isOnlyDownload?: boolean) => {
    const dir = getCacheDir(username, isOnlyDownload)
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }
    return dir
}

// Generate consistent filename: Name-Singer-Source-SongId.ext
const getFileName = (songInfo: any, quality?: string, isOnlyDownload?: boolean) => {
    const sanitizeFilename = (str: any) => String(str || '').replace(/[\\/:*?"<>|]/g, '_').replace(/_-_/g, '_- _')

    const id = songInfo.songmid || songInfo.songId || songInfo.id || 'unknown_id'
    const q = quality || songInfo.quality || 'unknown'

    if (isOnlyDownload) {
        // Only Download Mode format: {Name} - {Singer} - {Quality}
        let name = `${sanitizeFilename(songInfo.name || 'Unknown')} - ${sanitizeFilename(songInfo.singer || 'Unknown')} - ${sanitizeFilename(q)}`
        if (name.length > 200) name = name.substring(0, 200)
        return name
    }

    // Default Cache format: {Name}_-_{Singer}_-_{Source}_-_{ID}_-_{Quality}
    let name = `${sanitizeFilename(songInfo.name || 'Unknown')}_-_${sanitizeFilename(songInfo.singer || 'Unknown')}_-_${sanitizeFilename(songInfo.source || 'unknown')}_-_${sanitizeFilename(id)}_-_{sanitizeFilename(q)}`
    if (name.length > 200) name = name.substring(0, 200)

    return name
}

// Helper to sanitize for URL/Path
const sanitize = (str: any) => String(str || '').replace(/[\\/:*?"<>|]/g, '_')

// --- Public APIs ---

/**
 * Get detailed cache list for a user
 */
export const getCacheList = async (username?: string) => {
    const dir = getCacheDir(username)
    if (!fs.existsSync(dir)) return []

    const files = fs.readdirSync(dir)
    const result = []

    const extensions = ['.mp3', '.flac', '.m4a', '.ogg', '.wav']

    for (const file of files) {
        const ext = path.extname(file).toLowerCase()
        if (extensions.includes(ext)) {
            const filePath = path.join(dir, file)
            try {
                const stats = fs.statSync(filePath)

                // Parse info from filename: {Name}_-_{Singer}_-_{Source}_-_{ID}_-_{Quality}.ext
                const nameWithoutExt = path.basename(file, ext)
                const segments = nameWithoutExt.split('_-_')

                let metadata: any = {
                    filename: file,
                    size: stats.size,
                    mtime: stats.mtime,
                    ext: ext,
                    // From filename as fallback
                    name: segments[0] || 'Unknown',
                    singer: segments[1] || 'Unknown',
                    source: segments[2] || 'unknown',
                    id: segments[3] || '',
                    quality: segments[4] || ''
                }

                // [Unified] Try to get tags via MusicTagger for metadata enrichment
                try {
                    const tagger = new MusicTagger()
                    tagger.loadPath(filePath)
                    if (tagger.title) metadata.name = tagger.title
                    if (tagger.artist) metadata.singer = tagger.artist
                    if (tagger.album) metadata.album = tagger.album
                    metadata.hasCover = !!(tagger.pictures && tagger.pictures.length > 0)
                    tagger.dispose()
                } catch (e) {
                    // Ignore metadata read errors for list view
                }

                // [New] Check if .lrc version exists for this specific quality file
                const lrcPath = path.join(dir, nameWithoutExt + '.lrc')
                metadata.hasLyric = fs.existsSync(lrcPath)

                result.push(metadata)
            } catch (e) {
                // Skip files with errors
            }
        }
    }

    // Sort by mtime descending (newest first)
    return result.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
}

/**
 * Get cover image for a cached file
 */
export const getCacheCover = (filename: string, username?: string) => {
    const dir = getCacheDir(username)
    const filePath = path.join(dir, path.basename(filename))

    if (fs.existsSync(filePath)) {
        try {
            const tagger = new MusicTagger()
            tagger.loadPath(filePath)
            const pics = tagger.pictures
            if (pics && pics.length > 0) {
                const pic = pics[0]
                const result = {
                    data: Buffer.from(pic.data),
                    mime: pic.mimeType || 'image/jpeg'
                }
                tagger.dispose()
                return result
            }
            tagger.dispose()
        } catch (e) {
            // console.error(`[Cache] Error reading tags for cover: ${filename}`, e)
        }
    }
    return null
}

/**
 * Remove a specific cache file
 */
export const removeCacheFile = (filename: string, username?: string) => {
    const dir = getCacheDir(username)
    const filePath = path.join(dir, path.basename(filename))

    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        console.log(`[FileCache] Manually deleted: ${filename}`)

        // 删除关联的歌词文件
        const ext = path.extname(filename)
        if (ext !== '.lrc') {
            const lrcPath = path.join(dir, filename.substring(0, filename.length - ext.length) + '.lrc')
            if (fs.existsSync(lrcPath)) {
                fs.unlinkSync(lrcPath)
                console.log(`[FileCache] Manually deleted associated lyric: ${path.basename(lrcPath)}`)
            }
        }

        return true
    }
    return false
}

export const setCacheLocation = (location: string) => {
    if (location === CACHE_ROOTS.DATA || location === CACHE_ROOTS.ROOT) {
        currentCacheLocation = location
        console.log(`[FileCache] Base cache location set to: ${location}`)
    }
}

export const getCacheLocation = () => currentCacheLocation

export const checkCache = (songInfo: any, username?: string, includeTmp = false) => {
    const roots = ['cache', 'music']
    const basePaths = roots.map(folder => {
        if (currentCacheLocation === CACHE_ROOTS.DATA) {
            return path.join((global as any).lx.dataPath, folder)
        } else {
            return path.join(process.cwd(), folder)
        }
    })

    // 待匹配的请求 ID 及其纯净版
    const targetId = String(songInfo.songmid || songInfo.songId || songInfo.id || '')
    const cleanId = (id: string) => String(id || '').replace(/^(tx|mg|wy|kg|kw|bd|mg)_/, '')
    const targetCleanId = cleanId(targetId)

    // 只检查特定目录：传入的 username 目录（如果存在）和公共 _open 目录
    const dirsToCheck: string[] = []
    if (username && username !== '_open') dirsToCheck.push(username)
    dirsToCheck.push('_open')

    let matchedFiles: any[] = []

    for (const baseDir of basePaths) {
        if (!fs.existsSync(baseDir)) continue

        for (const userDir of dirsToCheck) {
            const dirPath = path.join(baseDir, userDir)
            if (!fs.existsSync(dirPath)) continue

            try {
                const files = fs.readdirSync(dirPath)
                for (const file of files) {
                    if (file.startsWith('.')) continue
                    if (!includeTmp && file.endsWith('.tmp')) continue

                    const lastDotIndex = file.lastIndexOf('.')
                    if (lastDotIndex === -1) continue
                    const ext = file.substring(lastDotIndex).toLowerCase()

                    // 通用音频后缀，如果是 includeTmp 模式则额外允许 .tmp
                    const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.m4a', '.ogg', '.wav']
                    if (!AUDIO_EXTENSIONS.includes(ext) && !(includeTmp && ext === '.tmp')) {
                        continue
                    }

                    const fileNameWithoutExt = file.substring(0, lastDotIndex)

                    // 1. 优先尝试解析旧的缓存格式: {Name}_-_{Singer}_-_{Source}_-_{ID}_-_{Quality}
                    const segments = fileNameWithoutExt.split('_-_')
                    if (segments.length >= 5) {
                        const fileId = segments[segments.length - 2]
                        const fileQuality = segments[segments.length - 1]
                        const fileCleanId = cleanId(fileId)

                        const isMatch = (fileId === targetId) ||
                            (fileCleanId === targetId) ||
                            (fileId === targetCleanId) ||
                            (fileCleanId === targetCleanId)

                        if (isMatch) {
                            if (songInfo.exactQuality && songInfo.quality && fileQuality !== String(songInfo.quality)) {
                                continue
                            }
                            matchedFiles.push({
                                exists: true,
                                path: path.join(dirPath, file),
                                filename: file,
                                foundIn: userDir,
                                quality: fileQuality,
                                url: `/api/music/cache/file/${encodeURIComponent(userDir)}/${encodeURIComponent(file)}`
                            })
                        }
                    }
                    // 2. 尝试解析仅下载模式格式: {Name} - {Singer} - {Quality}
                    const segmentsShort = fileNameWithoutExt.split(' - ')
                    if (segmentsShort.length >= 3) {
                        const fileName = segmentsShort[0]
                        const fileSinger = segmentsShort[1]
                        const fileQuality = segmentsShort[segmentsShort.length - 1] // 取最后一个段作为音质

                        // 匹配歌名和歌手 (忽略大小写)
                        const targetName = String(songInfo.name || '').toLowerCase()
                        const targetSinger = String(songInfo.singer || '').toLowerCase()

                        if (fileName.toLowerCase() === targetName && fileSinger.toLowerCase() === targetSinger) {
                            if (songInfo.exactQuality && songInfo.quality && fileQuality !== String(songInfo.quality)) {
                                continue
                            }
                            matchedFiles.push({
                                exists: true,
                                path: path.join(dirPath, file),
                                filename: file,
                                foundIn: userDir,
                                quality: fileQuality,
                                url: `/api/music/cache/file/${encodeURIComponent(userDir)}/${encodeURIComponent(file)}`
                            })
                        }
                    }
                }
            } catch (e) { continue }
        }
    }

    if (matchedFiles.length > 0) {
        const QUALITY_PRIORITY: Record<string, number> = {
            'flac24bit': 1,
            'flac': 2,
            '320k': 3,
            '128k': 4
        }
        matchedFiles.sort((a, b) => {
            const getRank = (q: string) => QUALITY_PRIORITY[q] || 99
            return getRank(a.quality) - getRank(b.quality)
        })
        return matchedFiles[0]
    }

    return { exists: false }
}

export const checkLyricCache = (songInfo: any, username?: string) => {
    const roots = ['cache', 'music']
    const basePaths = roots.map(folder => {
        if (currentCacheLocation === CACHE_ROOTS.DATA) {
            return path.join((global as any).lx.dataPath, folder)
        } else {
            return path.join(process.cwd(), folder)
        }
    })

    const targetId = String(songInfo.songmid || songInfo.songId || songInfo.id || '')
    const cleanId = (id: string) => String(id || '').replace(/^(tx|mg|wy|kg|kw|bd|mg)_/, '')
    const targetCleanId = cleanId(targetId)

    const dirsToCheck: string[] = []
    if (username && username !== '_open') dirsToCheck.push(username)
    dirsToCheck.push('_open')

    for (const baseDir of basePaths) {
        if (!fs.existsSync(baseDir)) continue

        for (const userDir of dirsToCheck) {
            const dirPath = path.join(baseDir, userDir)
            if (!fs.existsSync(dirPath)) continue

            try {
                const files = fs.readdirSync(dirPath)
                for (const file of files) {
                    if (!file.endsWith('.lrc')) continue

                    const fileNameWithoutExt = file.substring(0, file.lastIndexOf('.'))
                    const segments = fileNameWithoutExt.split('_-_')
                    if (segments.length < 2) continue

                    const fileId = segments[segments.length - 2]
                    const fileCleanId = cleanId(fileId)

                    const isMatch = (fileId === targetId) ||
                        (fileCleanId === targetId) ||
                        (fileId === targetCleanId) ||
                        (fileCleanId === targetCleanId)

                    if (isMatch) {
                        const filePath = path.join(dirPath, file)
                        const content = fs.readFileSync(filePath, 'utf-8')
                        return {
                            exists: true,
                            path: filePath,
                            content: parseLyrics(content),
                            filename: file
                        }
                    }
                }
            } catch (e) { continue }
        }
    }

    return { exists: false }
}

export const saveLyricCache = (songInfo: any, lyricsObj: any, username?: string, isOnlyDownload?: boolean) => {
    try {
        const dir = ensureDir(username, isOnlyDownload)
        let baseName: string

        if (songInfo.quality) {
            baseName = getFileName(songInfo, songInfo.quality, isOnlyDownload)
        } else {
            const existingAudio = checkCache({ ...songInfo, exactQuality: false }, username, true)
            if (existingAudio && existingAudio.exists && existingAudio.filename) {
                baseName = existingAudio.filename.substring(0, existingAudio.filename.lastIndexOf('.'))
            } else {
                baseName = getFileName(songInfo, 'unknown', isOnlyDownload)
            }
        }
        const finalPath = path.join(dir, baseName + '.lrc')

        const formattedLrc = buildLyrics(lyricsObj)
        if (!formattedLrc) {
            console.log(`[FileCache] Empty lyrics for ${baseName}, skip saving.`)
            return false
        }

        fs.writeFileSync(finalPath, formattedLrc, { encoding: 'utf-8' })
        console.log(`[FileCache] Lyric cached saved to: ${finalPath}`)
        return true
    } catch (err: any) {
        console.error(`[FileCache] Lyric cache save failed: ${err.message}`)
        return false
    }
}

export const downloadAndCache = async (songInfo: any, url: string, quality?: string, username?: string, signal?: AbortSignal, isOnlyDownload?: boolean) => {
    const dir = ensureDir(username, isOnlyDownload)
    const baseName = getFileName(songInfo, quality, isOnlyDownload)
    const tempPath = path.join(dir, baseName + '.tmp')
    const songKey = String(songInfo.id || songInfo.songmid)

    // Check if file already exists in either format/directory before starting
    const existing = checkCache({ ...songInfo, quality, exactQuality: true }, username, false)
    if (existing.exists) {
        console.log(`[FileCache] Song already exists, skipping download: ${existing.filename}`)
        return Promise.resolve()
    }

    if (signal?.aborted) return

    console.log(`[FileCache] Starting download for: ${baseName}`)

    return new Promise<void>((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http
        let req: http.ClientRequest
        let settled = false

        const settle = (fn: () => void) => {
            if (settled) return
            settled = true
            if (signal) signal.removeEventListener('abort', abortHandler)
            fn()
        }

        const abortHandler = () => {
            console.log(`[FileCache] ABORTING task: ${songKey} (base: ${baseName})`)
            if (req) req.destroy()
            if (fs.existsSync(tempPath)) fs.unlink(tempPath, () => { })
            cacheProgress.delete(songKey)
            settle(() => reject(new Error('Aborted')))
        }

        if (signal) signal.addEventListener('abort', abortHandler)

        req = protocol.get(url, (res) => {
            if (res.statusCode !== 200) {
                fs.unlink(tempPath, () => { })
                cacheProgress.set(songKey, { progress: 0, status: 'error' })
                settle(() => reject(new Error(`Failed to download, status: ${res.statusCode}`)))
                return
            }

            cacheProgress.set(songKey, { progress: 0, status: 'downloading' })
            const total = parseInt(res.headers['content-length'] || '0', 10)
            let received = 0

            const contentType = res.headers['content-type'] || ''
            let headerExt = ''
            if (contentType.includes('audio/mpeg')) headerExt = '.mp3'
            else if (contentType.includes('audio/flac')) headerExt = '.flac'
            else if (contentType.includes('audio/ogg')) headerExt = '.ogg'
            else if (contentType.includes('audio/x-m4a') || contentType.includes('video/mp4')) headerExt = '.m4a'
            else if (contentType.includes('audio/wav')) headerExt = '.wav'

            const fileStream = fs.createWriteStream(tempPath)

            res.on('data', (chunk) => {
                received += chunk.length
                if (total > 0) {
                    const progress = Math.round((received / total) * 100)
                    cacheProgress.set(songKey, { progress, status: 'downloading', total, received })
                }
            })

            res.pipe(fileStream)

            fileStream.on('close', () => {
                if (settled) return
                cacheProgress.set(songKey, { progress: 100, status: 'tagging' })

                const ext = headerExt || '.mp3'
                const finalPath = path.join(dir, baseName + ext)

                if (!fs.existsSync(tempPath)) {
                    if (fs.existsSync(finalPath)) {
                        settle(() => resolve())
                    } else {
                        settle(() => reject(new Error(`Temp file missing: ${tempPath}`)))
                    }
                    return
                }

                fs.rename(tempPath, finalPath, async (err) => {
                    if (err) {
                        fs.unlink(tempPath, () => { })
                        settle(() => reject(err))
                        return
                    }

                    console.log(`[FileCache] Cached saved to: ${finalPath} (${ext})`)

                    try {
                        const songName = songInfo.name || 'Unknown'
                        const artist = songInfo.singer || 'Unknown'
                        const album = songInfo.albumName || (songInfo.meta && songInfo.meta.albumName) || ''

                        let imageBuffer: Buffer | undefined
                        const imageUrl = songInfo.img || (songInfo.meta && songInfo.meta.picUrl) ||
                            (songInfo.album && (songInfo.album.picUrl || songInfo.album.img))

                        if (imageUrl && imageUrl.startsWith('http')) {
                            try {
                                imageBuffer = await new Promise((resCover, rejCover) => {
                                    const imgProtocol = imageUrl.startsWith('https') ? https : http
                                    imgProtocol.get(imageUrl, (imgRes) => {
                                        if (imgRes.statusCode !== 200) { rejCover(new Error('Failed to fetch cover')); return }
                                        const chunks: any[] = []
                                        imgRes.on('data', (chunk) => chunks.push(chunk))
                                        imgRes.on('end', () => resCover(Buffer.concat(chunks)))
                                        imgRes.on('error', rejCover)
                                    }).on('error', rejCover)
                                })
                            } catch (e) { }
                        }

                        const tagger = new MusicTagger()
                        tagger.loadPath(finalPath)
                        tagger.title = songName
                        tagger.artist = artist
                        tagger.album = album
                        if (imageBuffer) {
                            try {
                                const pic = new MetaPicture('image/jpeg', new Uint8Array(imageBuffer), 'Cover')
                                tagger.pictures = [pic]
                            } catch (picErr) { }
                        }
                        tagger.save()
                        tagger.dispose()
                        cacheProgress.set(songKey, { progress: 100, status: 'finished' })
                        setTimeout(() => cacheProgress.delete(songKey), 30000)
                    } catch (tagErr) {
                        cacheProgress.set(songKey, { progress: 100, status: 'finished' })
                    }
                    settle(() => resolve())
                })
            })

            fileStream.on('error', (err) => {
                fs.unlink(tempPath, () => { })
                settle(() => reject(err))
            })
        })

        req.on('error', (err) => {
            fs.unlink(tempPath, () => { })
            settle(() => reject(err))
        })
    })
}

/**
 * Stop active tasks for a user
 */
export const stopUserTasks = (username: string, songKey?: string) => {
    const tasks = activeTasks.get(username)
    if (!tasks) return

    if (songKey) {
        const idx = tasks.findIndex(t => t.songKey === songKey)
        if (idx !== -1) {
            tasks[idx].controller.abort()
            tasks.splice(idx, 1)
        }
    } else {
        tasks.forEach(t => t.controller.abort())
        activeTasks.delete(username)
    }
}

export const serveCacheFile = (req: http.IncomingMessage, res: http.ServerResponse, filename: string, username?: string) => {
    // 同时检查 cache 和 music 目录
    const roots = ['cache', 'music']
    let filePath = ''
    for (const folder of roots) {
        const baseDir = (currentCacheLocation === CACHE_ROOTS.DATA) ?
            path.join((global as any).lx.dataPath, folder) :
            path.join(process.cwd(), folder)
        const userDirName = (username && username !== '_open' && username !== 'default') ? username : '_open'
        const dir = path.join(baseDir, userDirName)
        const checkPath = path.join(dir, path.basename(filename))
        if (fs.existsSync(checkPath)) {
            filePath = checkPath
            break
        }
    }

    if (!filePath) {
        res.writeHead(404)
        res.end('Not Found')
        return
    }

    const stat = fs.statSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
        '.mp3': 'audio/mpeg',
        '.flac': 'audio/flac',
        '.m4a': 'audio/mp4',
        '.ogg': 'audio/ogg',
        '.wav': 'audio/wav'
    }
    const contentType = mimeTypes[ext] || 'application/octet-stream'
    const range = req.headers.range

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-")
        const start = parseInt(parts[0], 10)
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
        const chunksize = (end - start) + 1
        const file = fs.createReadStream(filePath, { start, end })

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': contentType,
        })
        file.pipe(res)
    } else {
        res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes'
        })
        fs.createReadStream(filePath).pipe(res)
    }
}

// Get cache statistics
export const getCacheStats = (username?: string) => {
    const roots = ['cache', 'music']
    let totalSize = 0
    let fileCount = 0

    for (const folder of roots) {
        const baseDir = (currentCacheLocation === CACHE_ROOTS.DATA) ?
            path.join((global as any).lx.dataPath, folder) :
            path.join(process.cwd(), folder)
        const userDirName = (username && username !== '_open' && username !== 'default') ? username : '_open'
        const dir = path.join(baseDir, userDirName)

        if (!fs.existsSync(dir)) continue

        const files = fs.readdirSync(dir)
        const extensions = ['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.lrc']

        for (const file of files) {
            const ext = path.extname(file).toLowerCase()
            if (extensions.includes(ext)) {
                try {
                    const stats = fs.statSync(path.join(dir, file))
                    totalSize += stats.size
                    if (ext !== '.lrc') fileCount++
                } catch (e) { }
            }
        }
    }
    return { totalSize, fileCount }
}

// Clear all cache files
export const clearAllCache = (username?: string) => {
    const roots = ['cache', 'music']
    let deletedCount = 0
    let freedSize = 0

    for (const folder of roots) {
        const baseDir = (currentCacheLocation === CACHE_ROOTS.DATA) ?
            path.join((global as any).lx.dataPath, folder) :
            path.join(process.cwd(), folder)
        const userDirName = (username && username !== '_open' && username !== 'default') ? username : '_open'
        const dir = path.join(baseDir, userDirName)

        if (!fs.existsSync(dir)) continue

        const files = fs.readdirSync(dir)
        const extensions = ['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.lrc', '.tmp']

        for (const file of files) {
            const ext = path.extname(file).toLowerCase()
            if (extensions.includes(ext)) {
                try {
                    const stats = fs.statSync(path.join(dir, file))
                    const size = stats.size
                    fs.unlinkSync(path.join(dir, file))
                    deletedCount++
                    freedSize += size
                } catch (e: any) { }
            }
        }
    }
    return { deletedCount, freedSize }
}

// Clear all lyric cache files (.lrc)
export const clearLyricCache = (username?: string) => {
    const roots = ['cache', 'music']
    let deletedCount = 0
    let freedSize = 0

    for (const folder of roots) {
        const baseDir = (currentCacheLocation === CACHE_ROOTS.DATA) ?
            path.join((global as any).lx.dataPath, folder) :
            path.join(process.cwd(), folder)
        const userDirName = (username && username !== '_open' && username !== 'default') ? username : '_open'
        const dir = path.join(baseDir, userDirName)

        if (!fs.existsSync(dir)) continue

        const files = fs.readdirSync(dir)
        for (const file of files) {
            if (file.endsWith('.lrc')) {
                try {
                    const stats = fs.statSync(path.join(dir, file))
                    const size = stats.size
                    fs.unlinkSync(path.join(dir, file))
                    deletedCount++
                    freedSize += size
                } catch (e: any) { }
            }
        }
    }
    return { deletedCount, freedSize }
}
