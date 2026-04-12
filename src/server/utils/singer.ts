/**
 * 歌手信息助手
 * 专门从 TX (QQ音乐) 源获取歌手照片
 */

// @ts-ignore
import txSearch from '@/modules/utils/musicSdk/tx/musicSearch'

const singerPicCache = new Map<string, string>()

/**
 * 根据歌手名称获取其照片链接 (仅 TX 源)
 * @param singerName 歌手名
 */
export async function getSingerPic(singerName: string): Promise<string | null> {
    if (singerPicCache.has(singerName)) {
        return singerPicCache.get(singerName)!
    }

    try {
        // 1. 使用内置 SDK 搜索该歌手的歌曲
        // txSearch.musicSearch 返回的是原始 data
        const data = await txSearch.musicSearch(singerName, 1, 5)

        // 2. 尝试从搜索到的歌曲列表中匹配歌手 MID
        const songList = data?.body?.item_song
        if (!songList || songList.length === 0) return null

        let singerMid = ''
        for (const song of songList) {
            // 寻找名字完全对应的歌手
            const target = song.singer.find((s: any) => s.name === singerName)
            if (target) {
                singerMid = target.mid
                break
            }
        }

        // 如果没有完全匹配的，兜底取第一首歌的第一个歌手
        if (!singerMid && songList[0].singer?.[0]) {
            singerMid = songList[0].singer[0].mid
        }

        if (!singerMid) return null

        // 3. 构造照片 URL (遵循参考代码)
        const photoUrl = `https://y.gtimg.cn/music/photo_new/T001R500x500M000${singerMid}.jpg`

        singerPicCache.set(singerName, photoUrl)
        return photoUrl

    } catch (err) {
        console.error(`[SingerUtils] 获取歌手 [${singerName}] 照片失败:`, err)
        return null
    }
}
