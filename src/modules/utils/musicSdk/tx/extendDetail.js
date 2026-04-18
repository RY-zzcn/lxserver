import { httpFetch } from '../../request'
import singer, { filterMusicInfoItem } from './singer'
import { formatSingerName } from '../utils'

const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'

// 获取专辑内歌曲 (参考 qq-music-api.js 的 getAlbumSongList)
const getAlbumSongsApi = async (albummid) => {
    return httpFetch(`https://i.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?platform=h5page&albummid=${albummid}&g_tk=938407465&uin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1&_=1459961045571`).promise.then(({ body }) => {
        if (body.code !== 0) throw new Error('Get TX album songs failed: ' + body.code)
        return body.data && body.data.list ? body.data.list : []
    })
}

export default {
    /**
     * 获取歌手详情
     * @param {string} id 歌手 MID
     */
    getArtistDetail(id) {
        return Promise.all([
            singer.getInfo(id),
            singer.getDesc(id),
        ]).then(([data, desc]) => {
            return {
                source: 'tx',
                id: data.id,
                name: data.info.name || '未知歌手',
                desc: desc || data.info.desc || '',
                avatar: data.info.avatar || `https://y.gtimg.cn/music/photo_new/T001R300x300M000${id}.jpg`,
                musicSize: data.count.music || 0,
                albumSize: data.count.album || 0,
            }
        })
    },

    /**
     * 获取歌手歌曲
     * @param {string} id 歌手 MID
     * @param {number} page
     * @param {number} limit
     * @param {string} order
     */
    getArtistSongs(id, page = 1, limit = 100, order = 'hot') {
        return singer.getSongList(id, page, limit, order)
    },

    /**
     * 获取歌手专辑列表
     * @param {string} id 歌手 MID
     * @param {number} page
     * @param {number} limit
     * @param {string} order
     */
    getArtistAlbums(id, page = 1, limit = 50, order = 'hot') {
        return singer.getAlbumList(id, page, limit, order).then(data => {
            // 转换 data.list 以匹配标准格式 { id, name, img, singer, publishTime, total }
            const formattedList = data.list.map(item => ({
                id: item.mid || item.id,
                name: item.info.name,
                img: item.info.img,
                singer: item.info.author,
                publishTime: '', // TX返回数据中通常没有明确包含，可在需要时从原接口挖掘
                total: item.count,
                source: 'tx',
            }))

            return {
                source: 'tx',
                list: formattedList,
                total: data.total,
            }
        })
    },

    /**
     * 获取专辑歌曲
     * @param {string} id 专辑 MID
     */
    getAlbumSongs(id) {
        return getAlbumSongsApi(id).then(list => {
            const formattedList = list.map(item => {
                // 由于返回结构不一定带 songInfo 嵌套，我们需要模拟类似 singer.filterMusicInfoItem 的入参，或直接用它处理包装项
                // tx album 接口返回的是单纯的 item 对象，包含 songname, songmid 等
                // 为了兼容 tx sdk 中大量依赖的 item.file 等结构，这里我们必须把它转成 tx/singer 期望的格式，再调用 filter
                // 不过由于 filterMusicInfoItem 依赖复杂的数据，更安全的做法是借用或者精简实现一次

                // 我们利用 tx/singer 中暴露的 filterMusicInfoItem 工具函数，但需构建对应的对象结构
                return filterMusicInfoItem({
                    id: item?.songid,
                    mid: item?.songmid,
                    title: item?.songname,
                    singer: item?.singer || [],
                    album: {
                        id: item?.albumid,
                        mid: item?.albummid,
                        name: item?.albumname
                    },
                    interval: item?.interval || 0,
                    file: {
                        media_mid: item?.strMediaMid,
                        size_128mp3: item?.size128 || 0,
                        size_320mp3: item?.size320 || 0,
                        size_flac: item?.sizeflac || 0,
                        size_hires: item?.sizehires || 0,
                    }
                })
            })

            return {
                list: formattedList,
                total: formattedList.length,
                source: 'tx',
            }
        })
    },
}
