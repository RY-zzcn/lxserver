

import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { PassThrough } from 'stream'
const { MusicTagger, MetaPicture } = require('music-tag-native')
import { buildLyrics, parseLyrics } from '../utils/lrcTool'
import { formatPlayTime } from '../common/utils/common'

// --- Cache Naming Patterns ---
export const CACHE_NAMING_PATTERNS = {
    STANDARD: 'standard',       // {Name}_-_{Singer}_-_{Source}_-_{ID}_-_{Quality}
    SIMPLE: 'simple',           // {Name} - {Singer} - {Quality}
    ARTIST_TITLE: 'artist-title',// {Singer} - {Name} - {Quality}
    TITLE_ONLY: 'title-only'    // {Name} - {Quality}
}

let currentNamingPattern = CACHE_NAMING_PATTERNS.STANDARD

export const setNamingPattern = (pattern: string) => {
    if (Object.values(CACHE_NAMING_PATTERNS).includes(pattern as any)) {
        currentNamingPattern = pattern
    }
}

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

export const getCacheDir = (username?: string, isOnlyDownload?: boolean) => {
    const folderName = isOnlyDownload ? 'music' : 'cache'
    let baseDir = ''
    if (currentCacheLocation === CACHE_ROOTS.DATA) {
        baseDir = path.join(global.lx.dataPath, folderName)
    } else {
        baseDir = path.join(process.cwd(), folderName)
    }

    // [New] Segment cache by username
    const userDirName = (username && username !== '_open' && username !== 'default') ? username : '_open'

    const fullPath = path.join(baseDir, userDirName)
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true })
    }
    return fullPath
}

// --- Cache Index Manager ---
interface CacheItem {
    id: string
    songmid?: string
    name: string
    singer: string
    album: string
    albumId?: string
    img?: string
    interval?: string
    source: string
    quality: string
    filename: string
    folder: string // 'cache' or 'music'
    mtime: number
    size: number
    lyricFilename?: string
    ext: string
    hasCover?: boolean
    hasLyric?: boolean
    bitrate?: number
    sampleRate?: number
    bitDepth?: number
}

class CacheIndexManager {
    private indexes: Map<string, Map<string, CacheItem>> = new Map() // "location:username:folder" -> (songId -> CacheItem)

    private getIndexFile(username: string, folder: 'cache' | 'music', location?: string) {
        const loc = location || currentCacheLocation
        const folderName = folder === 'music' ? 'music' : 'cache'
        let baseDir = ''
        if (loc === CACHE_ROOTS.DATA) {
            baseDir = path.join(global.lx.dataPath, folderName)
        } else {
            baseDir = path.join(process.cwd(), folderName)
        }

        const userDirName = (username && username !== '_open' && username !== 'default') ? username : '_open'
        const userDir = path.join(baseDir, userDirName)

        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true })
        }
        const fileName = folder === 'music' ? 'music_index.json' : 'cache_index.json'
        return path.join(userDir, fileName)
    }

    private getKey(username: string, folder: 'cache' | 'music', location?: string) {
        return `${location || currentCacheLocation}:${username}:${folder}`
    }

    load(username: string, folder: 'cache' | 'music', location?: string) {
        const key = this.getKey(username, folder, location)
        const file = this.getIndexFile(username, folder, location)
        if (fs.existsSync(file)) {
            try {
                const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
                this.indexes.set(key, new Map(Object.entries(data)))
            } catch (e) {
                this.indexes.set(key, new Map())
            }
        } else {
            this.indexes.set(key, new Map())
        }
        return this.indexes.get(key)!
    }

    save(username: string, folder: 'cache' | 'music', location?: string) {
        const loc = location || currentCacheLocation
        const key = this.getKey(username, folder, loc)
        const index = this.indexes.get(key)
        if (!index) return

        const file = this.getIndexFile(username, folder, loc)
        try {
            const data = Object.fromEntries(index)
            fs.writeFileSync(file, JSON.stringify(data, null, 2))
        } catch (e) {
            console.error(`[CacheIndex] Failed to save index for ${key}:`, e)
        }
    }

    get(username: string, songId: string, folder: 'cache' | 'music', quality?: string, exact: boolean = false, location?: string) {
        const key = this.getKey(username, folder, location)
        const index = this.indexes.get(key) || this.load(username, folder, location)
        if (quality) {
            const item = index.get(`${songId}_${quality}`)
            if (item) return item
            // exact 模式：精确匹配失败则不 fallback，直接返回 undefined
            if (exact) return undefined
        }
        // Fallback: 非精确模式下扫描同 ID 的任意质量
        const prefix = `${songId}_`
        for (const [k, item] of index.entries()) {
            if (k === songId || k.startsWith(prefix)) return item
        }
        return undefined
    }

    update(username: string, item: CacheItem, folder: 'cache' | 'music', location?: string) {
        const key = this.getKey(username, folder, location)
        const index = this.indexes.get(key) || this.load(username, folder, location)
        // Use composite key id_quality
        const itemKey = `${item.id}_${item.quality || 'unknown'}`
        index.set(itemKey, item)
        this.save(username, folder, location)
    }

    remove(username: string, songId: string, folder: 'cache' | 'music', quality?: string, location?: string) {
        const key = this.getKey(username, folder, location)
        const index = this.indexes.get(key) || this.load(username, folder, location)
        if (quality) {
            if (index.delete(`${songId}_${quality}`)) {
                this.save(username, folder, location)
                return true
            }
        }
        // Legacy or bulk remove by ID
        let deleted = false
        const prefix = `${songId}_`
        for (const k of Array.from(index.keys())) {
            if (k === songId || k.startsWith(prefix)) {
                index.delete(k)
                deleted = true
            }
        }
        if (deleted) this.save(username, folder, location)
        return deleted
    }

    getAll(username: string, folder: 'cache' | 'music', location?: string) {
        return Array.from((this.indexes.get(this.getKey(username, folder, location)) || this.load(username, folder, location)).values())
    }
}

export const indexManager = new CacheIndexManager()

// Ensure directory exists
const ensureDir = (username?: string, isOnlyDownload?: boolean) => {
    const dir = getCacheDir(username, isOnlyDownload)
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }
    return dir
}

/**
 * 规范化歌曲 ID：确保带上 source 前缀，与索引中的 Key 保持一致
 */
export const normalizeSongId = (songInfo: any): string => {
    let id = String(songInfo.songmid || songInfo.songId || songInfo.id || '')
    const source = songInfo.source || 'unknown'
    if (id && !id.includes('_') && source !== 'unknown') {
        id = `${source}_${id}`
    }
    return id
}

/**
 * Extract rich metadata from Lx songInfo object
 */
const extractSongMetadata = (songInfo: any) => {
    const meta = songInfo.meta || {}
    const id = normalizeSongId(songInfo)
    return {
        id: id,
        name: songInfo.name || meta.songName || 'Unknown',
        singer: songInfo.singer || meta.singerName || 'Unknown',
        album: songInfo.albumName || meta.albumName || '',
        albumId: String(songInfo.albumId || meta.albumId || ''),
        img: songInfo.img || meta.picUrl || '',
        interval: songInfo.interval || meta.interval || '',
        source: songInfo.source || 'unknown'
    }
}

/**
 * Detect quality tag from bitrate and file metadata
 */
const detectQualityFromBitrate = (bitrate: number | undefined, ext: string, tagger?: any): LX.Quality => {
    const isLossless = (ext === '.flac' || ext === '.wav' || ext === '.ape')
    const br = bitrate || 0 // Already in kbps from music-tag-native

    if (isLossless) {
        const bitDepth = tagger?.bitDepth || 16
        const sampleRate = tagger?.sampleRate || 44100

        if (br > 4500 || sampleRate > 96000) return 'master' as LX.Quality
        if (br > 1000 || bitDepth > 16 || sampleRate > 48000) return 'flac24bit'
        return 'flac'
    }

    // Lossy formats (mp3, m4a, etc.)
    if (br >= 240) return '320k'
    if (br >= 170) return '192k'
    return '128k'
}

// Generate consistent filename based on pattern with collision handling
const getFileName = (songInfo: any, quality?: string, isOnlyDownload?: boolean, username?: string) => {
    const sanitizeFilename = (str: any) => String(str || '').replace(/[\\/:*?"<>|]/g, '_')

    const id = normalizeSongId(songInfo)
    const source = songInfo.source || 'unknown'
    const q = quality || songInfo.quality || 'unknown'
    const nameStr = sanitizeFilename(songInfo.name || 'Unknown')
    const singerStr = sanitizeFilename(songInfo.singer || 'Unknown')

    let baseName = ''
    if (currentNamingPattern === CACHE_NAMING_PATTERNS.SIMPLE) {
        baseName = `${nameStr} - ${singerStr} - ${sanitizeFilename(q)}`
    } else if (currentNamingPattern === CACHE_NAMING_PATTERNS.ARTIST_TITLE) {
        baseName = `${singerStr} - ${nameStr} - ${sanitizeFilename(q)}`
    } else if (currentNamingPattern === CACHE_NAMING_PATTERNS.TITLE_ONLY) {
        baseName = `${nameStr} - ${sanitizeFilename(q)}`
    } else {
        // Default/Standard: {Name}_-_{Singer}_-_{Source}_-_{ID}_-_{Quality}
        baseName = `${nameStr}_-_${singerStr}_-_${sanitizeFilename(source)}_-_${sanitizeFilename(id)}_-_${sanitizeFilename(q)}`
    }

    // --- Collision Handling ---
    // Only apply suffix logic if we have a username and it's not the standard pattern (which is already unique)
    if (username && currentNamingPattern !== CACHE_NAMING_PATTERNS.STANDARD) {
        const folder: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'
        const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
        const existingItems = indexManager.getAll(normalizedUsername, folder)

        // Find if ANY other version of the same song (Name + Singer + Quality) exists with a different ID
        const conflict = existingItems.find(item =>
            item.name.toLowerCase() === String(songInfo.name || '').toLowerCase() &&
            item.singer.toLowerCase() === String(songInfo.singer || '').toLowerCase() &&
            item.quality === q &&
            item.id !== id
        )

        if (conflict) {
            if (conflict.source !== source) {
                // Different source -> add (source)
                baseName += ` (${source})`
            } else if (conflict.songmid !== id && conflict.id !== id) {
                // Same source, different mid -> add (source mid)
                baseName += ` (${source} ${id})`
            }
        }
    }

    if (baseName.length > 200) baseName = baseName.substring(0, 200)
    return baseName
}

// Helper to sanitize for URL/Path
const sanitize = (str: any) => String(str || '').replace(/[\\/:*?"<>|]/g, '_')

// --- Public APIs ---

/**
 * Sync disk files with index database
 */
export const syncCacheIndex = async (username?: string) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const roots: Array<'cache' | 'music'> = ['cache', 'music']
    const extensions = ['.mp3', '.flac', '.m4a', '.ogg', '.wav']

    for (const folder of roots) {
        const index = indexManager.load(normalizedUsername, folder)

        let updated = false
        const existingKeysInIndex = new Set(index.keys())
        const foundKeysOnDisk = new Set<string>()

        // Pre-build a filename to Item map within this folder for fast lookup
        const filenameToItemMap = new Map<string, CacheItem>()
        for (const item of index.values()) {
            filenameToItemMap.set(item.filename, item)
        }
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue

        const files = fs.readdirSync(dir)
        for (const file of files) {
            if (file === 'cache_index.json' || file === 'music_index.json') continue
            const ext = path.extname(file).toLowerCase()
            if (!extensions.includes(ext)) continue

            const filePath = path.join(dir, file)
            const stats = fs.statSync(filePath)

            // Try to find if this file is already known in index by its filename
            let existing = filenameToItemMap.get(file)

            let songId = existing?.id || ''
            let songName = existing?.name || ''
            let singer = existing?.singer || ''
            let source = existing?.source || ''
            let quality = existing?.quality || ''
            let album = existing?.album || ''
            let hasCover = existing?.hasCover || false

            const nameWithoutExt = path.basename(file, ext)

            if (!existing) {
                // Not found by filename, try to parse from standard format
                const segments = nameWithoutExt.split('_-_')
                if (segments.length >= 5) {
                    songName = segments[0]
                    singer = segments[1]
                    source = segments[2]
                    songId = segments[3]
                    quality = segments[4]
                } else {
                    // Try simple pattern: Name - Singer - Quality
                    const segmentsShort = nameWithoutExt.split(' - ')
                    if (segmentsShort.length >= 2) {
                        songName = segmentsShort[0]
                        singer = segmentsShort[1]
                        quality = segmentsShort[2] || 'unknown'
                        songId = nameWithoutExt // Fallback ID for unknown files
                    } else {
                        // Fallback for completely unknown filenames (e.g. download_4.mp3)
                        songId = nameWithoutExt
                        source = 'unknown'
                        quality = 'unknown'
                    }
                }
            }

            if (!songId) continue
            // Normalize ID
            const normalizedId = songId.includes('_') ? songId : `${source || 'unknown'}_${songId}`
            const compositeKey = `${normalizedId}_${quality || 'unknown'}`
            foundKeysOnDisk.add(compositeKey)

            // Always check for companion lyric file
            const lrcFile = nameWithoutExt + '.lrc'
            const hasLyricOnDisk = fs.existsSync(path.join(dir, lrcFile))

            // Update or add to index if anything changed (size, mtime, or lyric status)
            if (!existing || existing.size !== stats.size || existing.hasLyric !== hasLyricOnDisk || !existing.interval || existing.quality === 'unknown' || !existing.bitrate) {
                let interval = existing?.interval || ''
                let detectedQuality: LX.Quality = (existing?.quality as LX.Quality) || 'unknown'
                let bitrate = existing?.bitrate
                let sampleRate = existing?.sampleRate
                let bitDepth = existing?.bitDepth

                if (existing) {
                    existing.size = stats.size
                    existing.mtime = stats.mtimeMs
                    existing.hasLyric = hasLyricOnDisk
                    existing.lyricFilename = hasLyricOnDisk ? lrcFile : undefined

                    // If interval or quality/bitrate is missing/unknown, try to extract it
                    if (!existing.interval || existing.quality === 'unknown' || !existing.bitrate) {
                        try {
                            const tagger = new MusicTagger()
                            tagger.loadPath(filePath)
                            const dur = tagger.duration
                            if (dur && !existing.interval) existing.interval = formatPlayTime(dur / 1000)

                            existing.bitrate = tagger.bitRate
                            existing.sampleRate = tagger.sampleRate
                            existing.bitDepth = tagger.bitDepth

                            if (!existing.quality || existing.quality === 'unknown') {
                                existing.quality = detectQualityFromBitrate(tagger.bitRate, ext, tagger)
                            }
                            tagger.dispose()
                        } catch (e) { }
                    }
                } else {
                    // (New file logic remains same but uses hasLyricOnDisk)
                    try {
                        const tagger = new MusicTagger()
                        tagger.loadPath(filePath)
                        if (tagger.title && !songName) songName = tagger.title
                        if (tagger.artist && !singer) singer = tagger.artist
                        if (tagger.album && !album) album = tagger.album
                        if (tagger.pictures && tagger.pictures.length > 0) hasCover = true

                        const dur = tagger.duration
                        if (dur) interval = formatPlayTime(dur / 1000)

                        bitrate = tagger.bitRate
                        sampleRate = tagger.sampleRate
                        bitDepth = tagger.bitDepth
                        detectedQuality = detectQualityFromBitrate(tagger.bitRate, ext, tagger)

                        tagger.dispose()
                    } catch (e) { }

                    const item: CacheItem = {
                        id: normalizedId,
                        songmid: normalizedId,
                        name: songName || nameWithoutExt || 'Unknown',
                        singer: singer || 'Unknown',
                        album: album || '',
                        albumId: '',
                        img: '',
                        interval: interval,
                        source: source || 'unknown',
                        quality: detectedQuality,
                        filename: file,
                        folder: folder as any,
                        mtime: stats.mtimeMs,
                        size: stats.size,
                        lyricFilename: hasLyricOnDisk ? lrcFile : undefined,
                        ext: ext.replace('.', ''),
                        hasCover: hasCover,
                        hasLyric: hasLyricOnDisk,
                        bitrate: bitrate,
                        sampleRate: sampleRate,
                        bitDepth: bitDepth
                    }
                    index.set(compositeKey, item)
                }
                updated = true
            }
        }

        // Remove deleted files from index
        for (const key of existingKeysInIndex) {
            if (!foundKeysOnDisk.has(key)) {
                index.delete(key)
                updated = true
            }
        }

        if (updated) {
            indexManager.save(normalizedUsername, folder)
        }
    }
}

/**
 * Get detailed cache list for a user (indexed)
 */
export const getCacheList = async (username?: string) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'

    // Automatically trigger sync if index files don't exist
    const cacheDir = getCacheDir(normalizedUsername, false)
    const musicDir = getCacheDir(normalizedUsername, true)
    const hasCacheIndex = fs.existsSync(path.join(cacheDir, 'cache_index.json'))
    const hasMusicIndex = fs.existsSync(path.join(musicDir, 'music_index.json'))

    if (!hasCacheIndex || !hasMusicIndex) {
        await syncCacheIndex(username)
    }

    const cacheItems = indexManager.getAll(normalizedUsername, 'cache')
    const musicItems = indexManager.getAll(normalizedUsername, 'music')
    const items = [...cacheItems, ...musicItems]

    return items.map(item => ({
        ...item,
        songInfo: {
            id: item.id,
            songmid: item.songmid || item.id,
            name: item.name,
            singer: item.singer,
            source: item.source,
            quality: item.quality,
            albumName: item.album,
            albumId: item.albumId,
            img: item.img,
            interval: item.interval,
            type: item.quality, // Compatibility
            types: {} // To be filled if needed
        },
        hasLyric: item.hasLyric || !!item.lyricFilename
    }))
}

/**
 * Batch rename existing files to the current naming pattern
 */
export const batchRenameCacheFiles = async (username: string | undefined) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const folders: Array<'cache' | 'music'> = ['cache', 'music']

    let successCount = 0
    let failCount = 0
    let skipCount = 0

    for (const folder of folders) {
        const index = indexManager.load(normalizedUsername, folder)
        const items = Array.from(index.values())
        let folderUpdated = false

        for (const item of items) {
            const songInfo = {
                id: item.id,
                songmid: item.songmid || item.id,
                name: item.name,
                singer: item.singer,
                source: item.source,
                quality: item.quality,
                albumName: item.album,
                albumId: item.albumId,
                img: item.img,
                interval: item.interval
            }

            const newBaseName = getFileName(songInfo, item.quality, folder === 'music', normalizedUsername)
            const newFilename = `${newBaseName}.${item.ext}`

            if (newFilename === item.filename) {
                skipCount++
                continue
            }

            const dir = getCacheDir(normalizedUsername, folder === 'music')
            const oldPath = path.join(dir, item.filename)
            const newPath = path.join(dir, newFilename)

            try {
                if (fs.existsSync(oldPath)) {
                    if (!fs.existsSync(newPath)) {
                        fs.renameSync(oldPath, newPath)

                        if (item.lyricFilename) {
                            const oldLrcPath = path.join(dir, item.lyricFilename)
                            const newLrcFilename = `${newBaseName}.lrc`
                            const newLrcPath = path.join(dir, newLrcFilename)
                            if (fs.existsSync(oldLrcPath)) {
                                fs.renameSync(oldLrcPath, newLrcPath)
                                item.lyricFilename = newLrcFilename
                            }
                        }

                        item.filename = newFilename
                        successCount++
                        folderUpdated = true
                    } else {
                        failCount++
                    }
                } else {
                    failCount++
                }
            } catch (e) {
                console.error(`[FileCache] Failed to rename ${item.filename} in ${folder}:`, e)
                failCount++
            }
        }

        if (folderUpdated) {
            indexManager.save(normalizedUsername, folder)
        }
    }

    return { success: true, successCount, failCount, skipCount }
}

/**
 * Batch update ID3 metadata (title, artist, album, cover) from index to physical files
 */
export const batchUpdateMetadata = async (filenames: string[], username: string | undefined) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    let successCount = 0
    let failCount = 0

    const allItems = [
        ...indexManager.getAll(normalizedUsername, 'cache'),
        ...indexManager.getAll(normalizedUsername, 'music')
    ]

    for (const filename of filenames) {
        const item = allItems.find(i => i.filename === filename)
        if (!item) {
            failCount++
            continue
        }

        const dir = getCacheDir(normalizedUsername, item.folder === 'music')
        const filePath = path.join(dir, item.filename)

        if (!fs.existsSync(filePath)) {
            failCount++
            continue
        }

        try {
            let imageBuffer: Buffer | undefined
            const imageUrl = item.img
            if (imageUrl && imageUrl.startsWith('http')) {
                const chunks: Buffer[] = []
                const p = imageUrl.startsWith('https') ? https : http
                imageBuffer = await new Promise<Buffer>((resolveI, rejectI) => {
                    const req = p.get(imageUrl, ires => {
                        ires.on('data', c => chunks.push(c))
                        ires.on('end', () => resolveI(Buffer.concat(chunks)))
                        ires.on('error', rejectI)
                    })
                    req.on('error', rejectI)
                    setTimeout(() => { req.destroy(); rejectI(new Error('Timeout')) }, 8000)
                }).catch(() => undefined)
            }

            const tagger = new MusicTagger()
            tagger.loadPath(filePath)
            tagger.title = item.name || 'Unknown'
            tagger.artist = item.singer || 'Unknown'
            if (item.album) tagger.album = item.album

            if (imageBuffer && imageBuffer.length > 0) {
                tagger.pictures = [new MetaPicture('image/jpeg', new Uint8Array(imageBuffer), 'Cover')]
                item.hasCover = true
            } else if (tagger.pictures && tagger.pictures.length > 0) {
                item.hasCover = true
            } else {
                item.hasCover = false
            }
            tagger.save()
            tagger.dispose()

            const stats = fs.statSync(filePath)
            item.mtime = stats.mtimeMs
            item.size = stats.size

            indexManager.update(normalizedUsername, item, item.folder as 'cache' | 'music')
            successCount++
        } catch (e) {
            console.error(`[FileCache] Failed to update metadata for ${filename}:`, e)
            failCount++
        }
    }

    return { successCount, failCount }
}

/**
 * Link an unindexed local file to a specific online song identity
 */
export const linkLocalFile = async (oldFilename: string, songInfo: any, username: string | undefined) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'

    // Find the item in all possible folders
    const allItems = [
        ...indexManager.getAll(normalizedUsername, 'cache'),
        ...indexManager.getAll(normalizedUsername, 'music')
    ]
    const item = allItems.find(i => i.filename === oldFilename)
    if (!item) throw new Error('File not found in index')

    const folder = item.folder as 'cache' | 'music'
    const dir = getCacheDir(normalizedUsername, folder === 'music')
    const oldPath = path.join(dir, item.filename)
    if (!fs.existsSync(oldPath)) throw new Error('Physical file not found')

    // Prepare new metadata from songInfo
    const metadata = extractSongMetadata(songInfo)
    const newId = metadata.id
    const quality = item.quality || 'unknown'
    const ext = item.ext ? `.${item.ext}` : path.extname(oldFilename)

    // Generate new filename based on pattern
    const newBaseName = getFileName(songInfo, quality, folder === 'music', normalizedUsername)
    const newFilename = newBaseName + ext
    const newPath = path.join(dir, newFilename)

    // Check collision
    if (newFilename !== oldFilename && fs.existsSync(newPath)) {
        throw new Error('Target filename already exists on disk')
    }

    // 1. Rename physical file
    if (newFilename !== oldFilename) {
        fs.renameSync(oldPath, newPath)
        // Also rename lyrics if exists
        if (item.lyricFilename) {
            const oldLrcPath = path.join(dir, item.lyricFilename)
            const newLrcFilename = newBaseName + '.lrc'
            const newLrcPath = path.join(dir, newLrcFilename)
            if (fs.existsSync(oldLrcPath)) {
                fs.renameSync(oldLrcPath, newLrcPath)
                item.lyricFilename = newLrcFilename
            }
        }
    }

    // 2. Update Index
    // Remove old entry (keyed by old ID and quality)
    indexManager.remove(normalizedUsername, item.id, folder, item.quality)

    // Update item properties
    item.id = newId
    item.songmid = newId
    item.name = metadata.name
    item.singer = metadata.singer
    item.album = metadata.album
    item.albumId = metadata.albumId
    item.img = metadata.img
    item.source = metadata.source
    item.filename = newFilename
    item.mtime = Date.now()

    // Add back to index with new identity
    indexManager.update(normalizedUsername, item, folder)

    // 3. Post-link processing: Update ID3 tags and cover
    await batchUpdateMetadata([newFilename], normalizedUsername)

    return {
        success: true,
        filename: newFilename,
        id: newId,
        metadata
    }
}


/**
 * Get cover image for a cached file
 */
export const getCacheCover = (filename: string, username?: string) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const roots: Array<'cache' | 'music'> = ['cache', 'music']

    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
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
    }
    return null
}

/**
 * Remove a specific cache file
 */
export const removeCacheFile = (filename: string, username?: string) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const roots: Array<'cache' | 'music'> = ['cache', 'music']
    let deleted = false

    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        const filePath = path.join(dir, path.basename(filename))

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            console.log(`[FileCache] Deleted from ${folder}: ${filename}`)

            // Delete associated lyric file
            const ext = path.extname(filename)
            if (ext !== '.lrc') {
                const lrcPath = path.join(dir, filename.substring(0, filename.length - ext.length) + '.lrc')
                if (fs.existsSync(lrcPath)) {
                    fs.unlinkSync(lrcPath)
                }
            }

            // [Sync] Also find and remove from index if possible
            // Note: Since we only have filename here, we might need a reverse lookup if we wanted to be efficient,
            // but syncCacheIndex will clean up anyway. Let's try to remove from index if we find a match.
            const items = indexManager.getAll(normalizedUsername, folder)
            const item = items.find(i => i.filename === filename)
            if (item) {
                indexManager.remove(normalizedUsername, item.id, folder)
            }

            deleted = true
        }
    }
    return deleted
}

export const setCacheLocation = (location: string) => {
    if (location === CACHE_ROOTS.DATA || location === CACHE_ROOTS.ROOT) {
        currentCacheLocation = location
        console.log(`[FileCache] Base cache location set to: ${location}`)
    }
}

export const getCacheLocation = () => currentCacheLocation

export const checkCache = (songInfo: any, username?: string, isLyricCheck: boolean = false) => {
    try {
        const id = normalizeSongId(songInfo)
        const quality = songInfo.quality || 'unknown'
        const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'

        // 1. Search by exact ID and Quality (Primary Check)
        // exactQuality=true 时：精确匹配，不允许 fallback 到不同音质
        const useExact = !!songInfo.exactQuality
        const folderTypes: Array<'cache' | 'music'> = ['cache', 'music']
        for (const folder of folderTypes) {
            const cached = indexManager.get(normalizedUsername, id, folder, quality, useExact)
            if (cached) {
                // 二次校验：exactQuality 模式下确保音质匹配
                if (useExact && quality && cached.quality !== quality) continue
                const dir = getCacheDir(normalizedUsername, folder === 'music')
                const fileName = isLyricCheck ? cached.lyricFilename : cached.filename
                if (!fileName) continue
                const filePath = path.join(dir, fileName)
                if (fs.existsSync(filePath)) {
                    return {
                        exists: true,
                        path: filePath,
                        filename: fileName,
                        foundIn: normalizedUsername,
                        quality: cached.quality,
                        folder: folder,
                        url: `/api/music/cache/file/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(fileName)}?folder=${folder}`
                    }
                } else {
                    // Stale index entry, cleanup
                    if (!isLyricCheck) indexManager.remove(normalizedUsername, id, folder, cached.quality)
                }
            }
        }

        // 2. Search for Naming Collisions (Same Name + Singer + Quality, but different ID)
        const allItems = [
            ...indexManager.getAll(normalizedUsername, 'cache'),
            ...indexManager.getAll(normalizedUsername, 'music')
        ]

        const collision = allItems.find(item =>
            item.id !== id && // 排除当前正在查询的 ID 本身
            item.name.toLowerCase() === String(songInfo.name || '').toLowerCase() &&
            item.singer.toLowerCase() === String(songInfo.singer || '').toLowerCase() &&
            item.quality === quality &&
            (!isLyricCheck || item.hasLyric)
        )

        if (collision) {
            return {
                exists: true,
                isCollision: true,
                collisionSource: collision.source,
                collisionSongmid: collision.songmid,
                filename: isLyricCheck ? collision.lyricFilename : collision.filename,
                quality: collision.quality,
                foundIn: normalizedUsername,
                folder: collision.folder
            }
        }

        // 3. Fallback for non-exact (only if requested)
        if (!songInfo.exactQuality && !isLyricCheck) {
            const folderTypes: Array<'cache' | 'music'> = ['cache', 'music']
            for (const folder of folderTypes) {
                const cachedAny = indexManager.get(normalizedUsername, id, folder)
                if (cachedAny) {
                    const dir = getCacheDir(normalizedUsername, folder === 'music')
                    const fileName = cachedAny.filename
                    const filePath = path.join(dir, fileName)
                    if (fs.existsSync(filePath)) {
                        return {
                            exists: true,
                            path: filePath,
                            filename: fileName,
                            foundIn: normalizedUsername,
                            quality: cachedAny.quality,
                            folder: folder,
                            url: `/api/music/cache/file/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(fileName)}?folder=${folder}`
                        }
                    }
                }
            }
        }

    } catch (e) {
        console.error('[FileCache] checkCache error:', e)
    }

    return { exists: false }
}

export const checkLyricCache = (songInfo: any, username?: string) => {
    const id = normalizeSongId(songInfo)
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'

    // Check index first
    const folderTypes: Array<'cache' | 'music'> = ['cache', 'music']
    for (const folder of folderTypes) {
        const cached = indexManager.get(normalizedUsername, id, folder, songInfo.quality)
        if (cached && cached.hasLyric && cached.lyricFilename) {
            const dir = getCacheDir(normalizedUsername, folder === 'music')
            const lrcPath = path.join(dir, cached.lyricFilename)
            if (fs.existsSync(lrcPath)) {
                return {
                    exists: true,
                    path: lrcPath,
                    content: parseLyrics(fs.readFileSync(lrcPath, 'utf-8')),
                    filename: cached.lyricFilename
                }
            }
        }
    }

    // Physical scan fallback
    const roots = ['cache', 'music']
    const basePaths = roots.map(folder => getCacheDir(normalizedUsername, folder === 'music'))
    const cleanId = (sid: string) => String(sid || '').replace(/^(tx|mg|wy|kg|kw|bd|mg)_/, '')
    const targetCleanId = cleanId(id)

    for (const dirPath of basePaths) {
        if (!fs.existsSync(dirPath)) continue
        try {
            const files = fs.readdirSync(dirPath)
            for (const file of files) {
                if (!file.endsWith('.lrc')) continue
                const fileNameWithoutExt = file.substring(0, file.lastIndexOf('.'))
                const segments = fileNameWithoutExt.split('_-_')
                if (segments.length >= 2) {
                    const fileId = segments[segments.length - 2]
                    const fileCleanId = cleanId(fileId)
                    if (fileId === id || fileCleanId === id || fileId === targetCleanId || fileCleanId === targetCleanId) {
                        return {
                            exists: true,
                            path: path.join(dirPath, file),
                            content: parseLyrics(fs.readFileSync(path.join(dirPath, file), 'utf-8')),
                            filename: file
                        }
                    }
                }
            }
        } catch (e) { continue }
    }

    return { exists: false }
}

export const saveLyricCache = (songInfo: any, lyricsObj: any, username?: string, isOnlyDownload?: boolean) => {
    try {
        let baseName: string
        let quality = songInfo.quality || 'unknown'
        let dir: string

        // First check where the audio file actually exists
        const audioResult = checkCache({ ...songInfo, exactQuality: false }, username, false)

        if (audioResult.exists && audioResult.path) {
            // If audio exists, save lyric in the same folder
            dir = path.dirname(audioResult.path)
            quality = audioResult.quality || quality
            baseName = path.basename(audioResult.path, path.extname(audioResult.path))
        } else {
            // Audio not found, fallback to target dir
            dir = ensureDir(username, isOnlyDownload)
            if (songInfo.quality) {
                baseName = getFileName(songInfo, songInfo.quality, isOnlyDownload, username)
            } else {
                baseName = getFileName(songInfo, 'unknown', isOnlyDownload, username)
            }
        }

        const lyricFile = baseName + '.lrc'
        const finalPath = path.join(dir, lyricFile)

        const formattedLrc = buildLyrics(lyricsObj)
        if (!formattedLrc) {
            console.log(`[FileCache] Empty lyrics for ${baseName}, skip saving.`)
            return false
        }

        fs.writeFileSync(finalPath, formattedLrc, { encoding: 'utf-8' })
        console.log(`[FileCache] Lyric cached saved to: ${finalPath}`)

        // Update index
        const id = String(songInfo.id || songInfo.songmid)
        const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
        const folder: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'
        const existing = indexManager.get(normalizedUsername, id, folder, quality)
        if (existing) {
            existing.lyricFilename = lyricFile
            existing.hasLyric = true
            indexManager.save(normalizedUsername, folder)
        }

        void checkAndCleanupCache(username)
        return true
    } catch (err: any) {
        console.error(`[FileCache] Lyric cache save failed: ${err.message}`)
        return false
    }
}

export const downloadAndCache = async (songInfo: any, url: string, quality?: string, username?: string, signal?: AbortSignal, isOnlyDownload?: boolean) => {
    const dir = ensureDir(username, isOnlyDownload)
    const baseName = getFileName(songInfo, quality, isOnlyDownload, username)
    const tempPath = path.join(dir, baseName + '.tmp')
    const songKey = normalizeSongId(songInfo) + '_' + (quality || 'unknown')

    const result = checkCache({ ...songInfo, quality, exactQuality: true }, username, false)
    if (result.exists && !result.isCollision) {
        console.log(`[FileCache] Song already exists, skipping download: ${result.filename}`)
        // 通知前端轮询：文件已存在，视为立即完成
        cacheProgress.set(songKey, { progress: 100, status: 'exists' })
        setTimeout(() => cacheProgress.delete(songKey), 30000)
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
                settle(() => reject(new Error(`Status: ${res.statusCode}`)))
                return
            }

            cacheProgress.set(songKey, { progress: 0, status: 'downloading' })
            const total = parseInt(res.headers['content-length'] || '0', 10)
            let received = 0
            const contentType = res.headers['content-type'] || ''
            let headerExt = '.mp3'
            if (contentType.includes('audio/flac')) headerExt = '.flac'
            else if (contentType.includes('audio/ogg')) headerExt = '.ogg'
            else if (contentType.includes('audio/x-m4a') || contentType.includes('audio/mp4')) headerExt = '.m4a'
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
            fileStream.on('close', async () => {
                if (settled) return
                cacheProgress.set(songKey, { progress: 100, status: 'tagging' })

                let ext = headerExt
                if (fs.existsSync(tempPath)) {
                    try {
                        const { fileTypeFromFile } = await import('file-type')
                        const type = await fileTypeFromFile(tempPath)
                        if (type) ext = `.${type.ext}`
                    } catch (e) { }
                }

                const finalPath = path.join(dir, baseName + ext)
                fs.rename(tempPath, finalPath, async (err) => {
                    if (err) {
                        fs.unlink(tempPath, () => { })
                        settle(() => reject(err))
                        return
                    }

                    let imageBuffer: Buffer | undefined
                    try {
                        const imageUrl = songInfo.img || (songInfo.meta && songInfo.meta.picUrl)
                        if (imageUrl && imageUrl.startsWith('http')) {
                            const chunks: Buffer[] = []
                            const p = imageUrl.startsWith('https') ? https : http
                            imageBuffer = await new Promise((resolveI, rejectI) => {
                                p.get(imageUrl, ires => {
                                    ires.on('data', c => chunks.push(c))
                                    ires.on('end', () => resolveI(Buffer.concat(chunks)))
                                    ires.on('error', rejectI)
                                })
                            })
                        }
                    } catch (e) { }

                    const metadata = extractSongMetadata(songInfo)
                    const id = metadata.id || String(songInfo.id || songInfo.songmid)
                    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
                    const folderType: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'

                    indexManager.update(normalizedUsername, {
                        id, songmid: id, name: metadata.name, singer: metadata.singer,
                        album: metadata.album, albumId: metadata.albumId, img: metadata.img,
                        interval: metadata.interval, source: metadata.source,
                        quality: quality || 'unknown', filename: baseName + ext,
                        folder: folderType, mtime: Date.now(), size: received,
                        ext: ext.replace('.', ''), hasCover: !!(imageBuffer), hasLyric: false
                    }, folderType)

                    try {
                        const tagger = new MusicTagger()
                        tagger.loadPath(finalPath)
                        tagger.title = metadata.name
                        tagger.artist = metadata.singer
                        tagger.album = metadata.album
                        if (imageBuffer) tagger.pictures = [new MetaPicture('image/jpeg', new Uint8Array(imageBuffer), 'Cover')]
                        tagger.save()
                        tagger.dispose()
                    } catch (e) { }

                    cacheProgress.set(songKey, { progress: 100, status: 'finished' })
                    setTimeout(() => cacheProgress.delete(songKey), 30000)
                    settle(() => { resolve(); void checkAndCleanupCache(username) })
                })
            })
            fileStream.on('error', (err) => { fs.unlink(tempPath, () => { }); settle(() => reject(err)) })
        })
        req.on('error', (err) => { fs.unlink(tempPath, () => { }); settle(() => reject(err)) })
    })
}

export const stopUserTasks = (username: string, songKey?: string) => {
    const tasks = activeTasks.get(username)
    if (!tasks) return
    if (songKey) {
        const idx = tasks.findIndex(t => t.songKey === songKey)
        if (idx !== -1) { tasks[idx].controller.abort(); tasks.splice(idx, 1) }
    } else {
        tasks.forEach(t => t.controller.abort())
        activeTasks.delete(username)
    }
}

export const serveCacheFile = (req: http.IncomingMessage, res: http.ServerResponse, filename: string, username?: string) => {
    const roots = ['cache', 'music']
    let filePath = ''
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        const checkPath = path.join(dir, path.basename(filename))
        if (fs.existsSync(checkPath)) { filePath = checkPath; break }
    }
    if (!filePath) { res.writeHead(404); res.end('Not Found'); return }
    const stat = fs.statSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
        '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav'
    }
    const contentType = mimeTypes[ext] || 'application/octet-stream'
    const range = req.headers.range
    if (range) {
        const parts = range.replace(/bytes=/, "").split("-")
        const start = parseInt(parts[0], 10)
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
        const chunksize = (end - start) + 1
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes', 'Content-Length': chunksize, 'Content-Type': contentType,
        })
        fs.createReadStream(filePath, { start, end }).pipe(res)
    } else {
        res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' })
        fs.createReadStream(filePath).pipe(res)
    }
}

export const getCacheStats = (username?: string) => {
    const roots = ['cache', 'music']
    const result: any = { cache: { totalSize: 0, fileCount: 0 }, music: { totalSize: 0, fileCount: 0 }, totalSize: 0, fileCount: 0 }
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        const files = fs.readdirSync(dir)
        const extensions = ['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.lrc']
        for (const file of files) {
            const ext = path.extname(file).toLowerCase()
            if (extensions.includes(ext)) {
                try {
                    const stats = fs.statSync(path.join(dir, file))
                    result[folder].totalSize += stats.size
                    result.totalSize += stats.size
                    if (ext !== '.lrc') { result[folder].fileCount++; result.fileCount++ }
                } catch (e) { }
            }
        }
    }
    return result
}

export const clearAllCache = (username?: string) => {
    const roots = ['cache', 'music']
    let deletedCount = 0
    let freedSize = 0
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        const files = fs.readdirSync(dir)
        for (const file of files) {
            try {
                const stats = fs.statSync(path.join(dir, file))
                fs.unlinkSync(path.join(dir, file))
                deletedCount++; freedSize += stats.size
            } catch (e) { }
        }
        indexManager.load(normalizedUsername, folder as any).clear()
        indexManager.save(normalizedUsername, folder as any)
    }
    return { deletedCount, freedSize }
}

export const clearLyricCache = (username?: string) => {
    const roots: Array<'cache' | 'music'> = ['cache', 'music']
    let deletedCount = 0
    let freedSize = 0
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        const files = fs.readdirSync(dir)
        for (const file of files) {
            if (file.endsWith('.lrc')) {
                try {
                    const stats = fs.statSync(path.join(dir, file))
                    fs.unlinkSync(path.join(dir, file))
                    deletedCount++; freedSize += stats.size
                } catch (e) { }
            }
        }
        const items = indexManager.getAll(normalizedUsername, folder)
        items.forEach(item => { if (item.hasLyric) { item.hasLyric = false; item.lyricFilename = undefined } })
        indexManager.save(normalizedUsername, folder)
    }
    return { deletedCount, freedSize }
}

export const checkAndCleanupCache = async (username?: string) => {
    const config = (global as any).lx.config
    if (!config || !config['user.enableCacheSizeLimit']) return
    const { totalSize } = getCacheStats(username)
    const limitBytes = (config['user.cacheSizeLimit'] || 2000) * 1024 * 1024
    if (totalSize <= limitBytes) return
    const roots: Array<'cache' | 'music'> = ['cache', 'music']
    const allFiles: Array<{ path: string, size: number, mtime: number }> = []
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        const files = fs.readdirSync(dir)
        for (const file of files) {
            try {
                const filePath = path.join(dir, file)
                const stats = fs.statSync(filePath)
                allFiles.push({ path: filePath, size: stats.size, mtime: stats.mtime.getTime() })
            } catch (e) { }
        }
    }
    allFiles.sort((a, b) => a.mtime - b.mtime)
    let currentSize = totalSize
    const targetSize = limitBytes * 0.95
    let deletedCount = 0
    for (const file of allFiles) {
        if (currentSize <= targetSize) break
        try { fs.unlinkSync(file.path); currentSize -= file.size; deletedCount++ } catch (e) { }
    }
    console.log(`[FileCache] Cleaned up ${deletedCount} files for ${normalizedUsername}`)
}
/**
 * Switch files between 'cache' and 'music' folders
 */
export const switchFolder = async (filenames: string[], username: string | undefined) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    let successCount = 0
    let failCount = 0

    const cacheIndex = indexManager.load(normalizedUsername, 'cache')
    const musicIndex = indexManager.load(normalizedUsername, 'music')

    const cacheDir = getCacheDir(normalizedUsername, false)
    const musicDir = getCacheDir(normalizedUsername, true)

    for (const filename of filenames) {
        let sourceFolder: 'cache' | 'music' | null = null
        let item: CacheItem | null = null

        // Find which folder it belongs to
        const inCache = Array.from(cacheIndex.values()).find(i => i.filename === filename)
        if (inCache) {
            sourceFolder = 'cache'
            item = inCache
        } else {
            const inMusic = Array.from(musicIndex.values()).find(i => i.filename === filename)
            if (inMusic) {
                sourceFolder = 'music'
                item = inMusic
            }
        }

        if (!sourceFolder || !item) {
            failCount++
            continue
        }

        const targetFolder: 'cache' | 'music' = sourceFolder === 'cache' ? 'music' : 'cache'
        const sourceDir = sourceFolder === 'music' ? musicDir : cacheDir
        const targetDir = targetFolder === 'music' ? musicDir : cacheDir

        const sourcePath = path.join(sourceDir, filename)
        const targetPath = path.join(targetDir, filename)

        try {
            if (fs.existsSync(sourcePath)) {
                // Ensure target directory exists (though getCacheDir should have ensured it)
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })

                // Check collision in target folder
                if (fs.existsSync(targetPath)) {
                    // If target already exists, skip this file
                    console.log(`[FileCache] Move conflict: ${filename} already exists in ${targetFolder}, skipping.`)
                    failCount++
                    continue
                }


                // Move audio file
                fs.renameSync(sourcePath, targetPath)

                // Move lyric file if exists
                if (item.lyricFilename) {
                    const sourceLrcPath = path.join(sourceDir, item.lyricFilename)
                    const targetLrcPath = path.join(targetDir, item.lyricFilename)
                    if (fs.existsSync(sourceLrcPath)) {
                        if (fs.existsSync(targetLrcPath)) fs.unlinkSync(targetLrcPath)
                        fs.renameSync(sourceLrcPath, targetLrcPath)
                    }
                }

                // Update Index
                indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality)
                item.folder = targetFolder
                indexManager.update(normalizedUsername, item, targetFolder)

                successCount++
            } else {
                failCount++
            }
        } catch (e) {
            console.error(`[FileCache] Failed to move ${filename} from ${sourceFolder} to ${targetFolder}:`, e)
            failCount++
        }
    }

    return { successCount, failCount }
}

/**
 * Switch files between 'ROOT' and 'DATA' base locations
 */
export const switchBaseLocation = async (filenames: string[], username: string | undefined) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const sourceLoc = currentCacheLocation
    const targetLoc = sourceLoc === CACHE_ROOTS.ROOT ? CACHE_ROOTS.DATA : CACHE_ROOTS.ROOT

    let successCount = 0
    let failCount = 0

    const folders: Array<'cache' | 'music'> = ['cache', 'music']

    // Helper to get dir for a specific location
    const getLocalDir = (folder: string, loc: string) => {
        const folderName = folder === 'music' ? 'music' : 'cache'
        const base = loc === CACHE_ROOTS.DATA ? global.lx.dataPath : process.cwd()
        const userDir = (username && username !== '_open' && username !== 'default') ? username : '_open'
        return path.join(base, folderName, userDir)
    }

    for (const filename of filenames) {
        let sourceFolder: 'cache' | 'music' | null = null
        let item: CacheItem | null = null

        // Find folder in SOURCE location
        for (const folder of folders) {
            const items = indexManager.getAll(normalizedUsername, folder, sourceLoc)
            const found = items.find(i => i.filename === filename)
            if (found) {
                sourceFolder = folder
                item = found
                break
            }
        }

        if (!sourceFolder || !item) {
            failCount++
            continue
        }

        const sourceDir = getLocalDir(sourceFolder, sourceLoc)
        const targetDir = getLocalDir(sourceFolder, targetLoc)

        const sourcePath = path.join(sourceDir, filename)
        const targetPath = path.join(targetDir, filename)

        try {
            if (fs.existsSync(sourcePath)) {
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true })

                // Check collision in target location
                if (fs.existsSync(targetPath)) {
                    console.log(`[FileCache] Base move conflict: ${filename} already exists at ${targetLoc}, skipping.`)
                    failCount++
                    continue
                }

                // Move audio file
                fs.renameSync(sourcePath, targetPath)

                // Move lyrics
                if (item.lyricFilename) {
                    const sourceLrcPath = path.join(sourceDir, item.lyricFilename)
                    const targetLrcPath = path.join(targetDir, item.lyricFilename)
                    if (fs.existsSync(sourceLrcPath)) {
                        if (fs.existsSync(targetLrcPath)) fs.unlinkSync(targetLrcPath)
                        fs.renameSync(sourceLrcPath, targetLrcPath)
                    }
                }

                // Update Indices
                indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality, sourceLoc)
                // item is now in the other location's index
                indexManager.update(normalizedUsername, item, sourceFolder, targetLoc)

                successCount++
            } else {
                failCount++
            }
        } catch (e) {
            console.error(`[FileCache] Failed to move ${filename} from ${sourceLoc} to ${targetLoc}:`, e)
            failCount++
        }
    }

    return { successCount, failCount, targetLoc }
}

