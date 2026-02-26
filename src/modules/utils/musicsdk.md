# MusicSDK 修改记录

## 1. 酷我音乐 (kw)
**文件路径**: `src/modules/utils/musicSdk/kw/musicSearch.js`
**修改目的**: 修复搜索结果中封面图片缺失的问题。
**修改代码**:
```javascript
// 修改前
// img: null,

// 修改后
img: info.prob_albumpic || (info.web_albumpic_short ? `https://img4.kuwo.cn/star/albumcover/500${info.web_albumpic_short}` : null),
```

## 2. 酷狗音乐 (kg)
**文件路径**: `src/modules/utils/musicSdk/kg/musicSearch.js`
**修改目的**: 修复搜索结果中封面图片缺失的问题，优先使用 `Image` 字段，无 `Image` 时尝试使用 `trans_param.union_cover`。
**修改代码**:
```javascript
// 修改前
// img: null,

// 修改后
img: rawData.Image ? rawData.Image.replace('{size}', '240') : (rawData.trans_param?.union_cover?.replace('{size}', '240') || null),
```

## 3. QQ音乐 (tx) - 歌词获取
**文件路径**: `src/modules/utils/musicSdk/tx/lyric.js`
**修改目的**: 原版 SDK 使用 `rendererInvoke` 调用 Electron 主进程的 C++ 模块解密 QRC 歌词。在 Server 纯 Node.js 环境下该 IPC 调用不可用导致程序崩溃。
**修改方案**: 替换为调用 QQ 音乐旧版歌词接口 (`fcg_query_lyric_new.fcg`)。
**好处**:
1. 不需要 `qrc_decode` 加密库支持。
2. 不需要 Electron IPC 环境。
3. 返回数据为 Base64 编码，纯 JS 即可解码。
**修改代码**:
```javascript
// 修改前
import { httpFetch } from '../../request'
import getMusicInfo from './musicInfo'
import { rendererInvoke } from '@common/rendererIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'

const songIdMap = new Map()
const promises = new Map()
export const decodeLyric = (lrc, tlrc, rlrc) => rendererInvoke(WIN_MAIN_RENDERER_EVENT_NAME.handle_tx_decode_lyric, { lrc, tlrc, rlrc })


const parseTools = {
  rxps: {
    info: /^{"/,
    lineTime: /^\[(\d+),\d+\]/,
    lineTime2: /^\[([\d:.]+)\]/,
    wordTime: /\(\d+,\d+\)/,
    wordTimeAll: /(\(\d+,\d+\))/g,
    timeLabelFixRxp: /(?:\.0+|0+)$/,
  },
  msFormat(timeMs) {
    if (Number.isNaN(timeMs)) return ''
    let ms = timeMs % 1000
    timeMs /= 1000
    let m = parseInt(timeMs / 60).toString().padStart(2, '0')
    timeMs %= 60
    let s = parseInt(timeMs).toString().padStart(2, '0')
    return `[${m}:${s}.${String(ms).padStart(3, '0')}]`
  },
  parseLyric(lrc) {
    lrc = lrc.trim()
    lrc = lrc.replace(/\r/g, '')
    if (!lrc) return { lyric: '', lxlyric: '' }
    const lines = lrc.split('\n')

    const lxlrcLines = []
    const lrcLines = []

    for (let line of lines) {
      line = line.trim()
      let result = this.rxps.lineTime.exec(line)
      if (!result) {
        if (line.startsWith('[offset')) {
          lxlrcLines.push(line)
          lrcLines.push(line)
        }
        if (this.rxps.lineTime2.test(line)) {
          // lxlrcLines.push(line)
          lrcLines.push(line)
        }
        continue
      }

      const startMsTime = parseInt(result[1])
      const startTimeStr = this.msFormat(startMsTime)
      if (!startTimeStr) continue

      let words = line.replace(this.rxps.lineTime, '')

      lrcLines.push(`${startTimeStr}${words.replace(this.rxps.wordTimeAll, '')}`)

      let times = words.match(this.rxps.wordTimeAll)
      if (!times) continue
      times = times.map(time => {
        const result = /\((\d+),(\d+)\)/.exec(time)
        return `<${Math.max(parseInt(result[1]) - startMsTime, 0)},${result[2]}>`
      })
      const wordArr = words.split(this.rxps.wordTime)
      const newWords = times.map((time, index) => `${time}${wordArr[index]}`).join('')
      lxlrcLines.push(`${startTimeStr}${newWords}`)
    }
    return {
      lyric: lrcLines.join('\n'),
      lxlyric: lxlrcLines.join('\n'),
    }
  },
  parseRlyric(lrc) {
    lrc = lrc.trim()
    lrc = lrc.replace(/\r/g, '')
    if (!lrc) return { lyric: '', lxlyric: '' }
    const lines = lrc.split('\n')

    const lrcLines = []

    for (let line of lines) {
      line = line.trim()
      let result = this.rxps.lineTime.exec(line)
      if (!result) continue

      const startMsTime = parseInt(result[1])
      const startTimeStr = this.msFormat(startMsTime)
      if (!startTimeStr) continue

      let words = line.replace(this.rxps.lineTime, '')

      lrcLines.push(`${startTimeStr}${words.replace(this.rxps.wordTimeAll, '')}`)
    }
    return lrcLines.join('\n')
  },
  removeTag(str) {
    return str.replace(/^[\S\s]*?LyricContent="/, '').replace(/"\/>[\S\s]*?$/, '')
  },
  getIntv(interval) {
    if (!interval) return 0
    if (!interval.includes('.')) interval += '.0'
    let arr = interval.split(/:|\./)
    while (arr.length < 3) arr.unshift('0')
    const [m, s, ms] = arr
    return parseInt(m) * 3600000 + parseInt(s) * 1000 + parseInt(ms)
  },
  fixRlrcTimeTag(rlrc, lrc) {
    // console.log(lrc)
    // console.log(rlrc)
    const rlrcLines = rlrc.split('\n')
    let lrcLines = lrc.split('\n')
    // let temp = []
    let newLrc = []
    rlrcLines.forEach((line) => {
      const result = this.rxps.lineTime2.exec(line)
      if (!result) return
      const words = line.replace(this.rxps.lineTime2, '')
      if (!words.trim()) return
      const t1 = this.getIntv(result[1])

      while (lrcLines.length) {
        const lrcLine = lrcLines.shift()
        const lrcLineResult = this.rxps.lineTime2.exec(lrcLine)
        if (!lrcLineResult) continue
        const t2 = this.getIntv(lrcLineResult[1])
        if (Math.abs(t1 - t2) < 100) {
          newLrc.push(line.replace(this.rxps.lineTime2, lrcLineResult[0]))
          break
        }
        // temp.push(line)
      }
      // lrcLines = [...temp, ...lrcLines]
      // temp = []
    })
    return newLrc.join('\n')
  },
  fixTlrcTimeTag(tlrc, lrc) {
    // console.log(lrc)
    // console.log(tlrc)
    const tlrcLines = tlrc.split('\n')
    let lrcLines = lrc.split('\n')
    // let temp = []
    let newLrc = []
    tlrcLines.forEach((line) => {
      const result = this.rxps.lineTime2.exec(line)
      if (!result) return
      const words = line.replace(this.rxps.lineTime2, '')
      if (!words.trim()) return
      let time = result[1]
      if (time.includes('.')) {
        time += ''.padStart(3 - time.split('.')[1].length, '0')
      }
      const t1 = this.getIntv(time)

      while (lrcLines.length) {
        const lrcLine = lrcLines.shift()
        const lrcLineResult = this.rxps.lineTime2.exec(lrcLine)
        if (!lrcLineResult) continue
        const t2 = this.getIntv(lrcLineResult[1])
        if (Math.abs(t1 - t2) < 100) {
          newLrc.push(line.replace(this.rxps.lineTime2, lrcLineResult[0]))
          break
        }
        // temp.push(line)
      }
      // lrcLines = [...temp, ...lrcLines]
      // temp = []
    })
    return newLrc.join('\n')
  },
  parse(lrc, tlrc, rlrc) {
    const info = {
      lyric: '',
      tlyric: '',
      rlyric: '',
      lxlyric: '',
    }
    if (lrc) {
      let { lyric, lxlyric } = this.parseLyric(this.removeTag(lrc))
      info.lyric = lyric
      info.lxlyric = lxlyric
      // console.log(lyric)
      // console.log(lxlyric)
    }
    if (rlrc) info.rlyric = this.fixRlrcTimeTag(this.parseRlyric(this.removeTag(rlrc)), info.lyric)
    if (tlrc) info.tlyric = this.fixTlrcTimeTag(tlrc, info.lyric)
    // console.log(info.lyric)
    // console.log(info.tlyric)
    // console.log(info.rlyric)

    return info
  },
}


export default {
  successCode: 0,
  async getSongId({ songId, songmid }) {
    if (songId) return songId
    if (songIdMap.has(songmid)) return songIdMap.get(songmid)
    if (promises.has(songmid)) return (await promises.get(songmid)).songId
    const promise = getMusicInfo(songmid)
    promises.set(promise)
    const info = await promise
    songIdMap.set(songmid, info.songId)
    promises.delete(songmid)
    return info.songId
  },
  async parseLyric(lrc, tlrc, rlrc) {
    const { lyric, tlyric, rlyric } = await decodeLyric(lrc, tlrc, rlrc)
    // return {

    // }
    // console.log(lyric)
    // console.log(tlyric)
    // console.log(rlyric)
    return parseTools.parse(lyric, tlyric, rlyric)
  },
  getLyric(mInfo, retryNum = 0) {
    if (retryNum > 3) return Promise.reject(new Error('Get lyric failed'))

    return {
      cancelHttp() {

      },
      promise: this.getSongId(mInfo).then(songId => {
        const requestObj = httpFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
          method: 'post',
          headers: {
            referer: 'https://y.qq.com',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36',
          },
          body: {
            comm: {
              ct: '19',
              cv: '1859',
              uin: '0',
            },
            req: {
              method: 'GetPlayLyricInfo',
              module: 'music.musichallSong.PlayLyricInfo',
              param: {
                format: 'json',
                crypt: 1,
                ct: 19,
                cv: 1873,
                interval: 0,
                lrc_t: 0,
                qrc: 1,
                qrc_t: 0,
                roma: 1,
                roma_t: 0,
                songID: songId,
                trans: 1,
                trans_t: 0,
                type: -1,
              },
            },
          },
        })
        return requestObj.promise.then(({ body }) => {
          // console.log(body)
          if (body.code != this.successCode || body.req.code != this.successCode) return this.getLyric(songId, ++retryNum)
          const data = body.req.data
          return this.parseLyric(data.lyric, data.trans, data.roma)
        })
      }),
    }
  },
}

// export default {
//   regexps: {
//     matchLrc: /.+"lyric":"([\w=+/]*)".+/,
//   },
//   getLyric(songmid) {
//     const requestObj = httpFetch(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${songmid}&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&platform=yqq`, {
//       headers: {
//         Referer: 'https://y.qq.com/portal/player.html',
//       },
//     })
//     requestObj.promise = requestObj.promise.then(({ body }) => {
//       if (body.code != 0 || !body.lyric) return Promise.reject(new Error('Get lyric failed'))
//       return {
//         lyric: decodeName(b64DecodeUnicode(body.lyric)),
//         tlyric: decodeName(b64DecodeUnicode(body.trans)),
//       }
//     })
//     return requestObj
//   },
// }

//修改后
import { httpFetch } from '../../request'
// import getMusicInfo from './musicInfo'

const decodeName = (str = '') => {
  if (!str) return ''
  return str.replace(/&#(\d+);/g, (match, dec) => {
    return String.fromCharCode(dec)
  }).replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

const b64DecodeUnicode = (str) => {
  return Buffer.from(str, 'base64').toString('utf8')
}

export default {
  regexps: {
    matchLrc: /.+"lyric":"([\w=+/]*)".+/,
  },
  getLyric(songmid) {
    const songId = songmid.songmid || songmid
    const requestObj = httpFetch(`https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${songId}&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&platform=yqq`, {
      headers: {
        Referer: 'https://y.qq.com/portal/player.html',
      },
    })
    requestObj.promise = requestObj.promise.then(({ body }) => {
      if (body.code != 0 || !body.lyric) return Promise.reject(new Error('Get lyric failed'))
      return {
        lyric: decodeName(b64DecodeUnicode(body.lyric)),
        tlyric: decodeName(b64DecodeUnicode(body.trans)),
      }
    })
    return requestObj
  },
}
```
## 4. QQ音乐 (tx) - 评论总数修复
**文件路径**: src/modules/utils/musicSdk/tx/comment.js
**修改目的**: 修复 QQ 音乐最新评论接口有时返回 commenttotal 为 0，导致前端无法翻页且显示错误的问题。
**修改方案**: 增加回推逻辑，如果 commenttotal 为 0 或不存在，则使用当前获取到的评论列表长度作为 fallback。
**修改代码**:
```javascript
// 修改前
return {
  source: 'tx',
  comments: this.filterNewComment(comment.commentlist),
  total: comment.commenttotal,
  page,
  limit,
  maxPage: Math.ceil(comment.commenttotal / limit) || 1,
}

// 修改后
const total = comment.commenttotal || (comment.commentlist ? comment.commentlist.length : 0)
return {
  source: 'tx',
  comments: this.filterNewComment(comment.commentlist),
  total,
  page,
  limit,
  maxPage: Math.ceil(total / limit) || 1,
}
```

## 5. 咪咕音乐 (mg) - 歌单封面域名补全
**文件路径**: `src/modules/utils/musicSdk/mg/musicInfo.js`
**修改目的**: 修复歌单详情中歌曲封面为相对路径导致无法显示的问题。
**修改代码**:
```javascript
// 修改前
// img: item.img3 || item.img2 || item.img1 || null,

// 修改后
let img = item.img3 || item.img2 || item.img1 || null
if (img && !/https?:/.test(img)) img = 'http://d.musicapp.migu.cn' + img
// ...
img,
```

## 6. 酷我音乐 (kw) - 歌单封面解析
**文件路径**: `src/modules/utils/musicSdk/kw/songList.js`
**修改目的**: 修复歌单详情中歌曲封面显示不出的问题。
**修改方案**: 增加对 `pic` 和 `albumpic` 字段的解析，这些字段在歌单详情接口中更常见。
**修改代码**:
```javascript
// 修改前
// img: item.prob_albumpic || (item.web_albumpic_short ? `https://img4.kuwo.cn/star/albumcover/500${item.web_albumpic_short}` : null),

// 修改后
img: item.pic || item.albumpic || item.prob_albumpic || (item.web_albumpic_short ? `https://img4.kuwo.cn/star/albumcover/500${item.web_albumpic_short}` : null),
```

## 7. 酷狗音乐 (kg) - 歌单封面解析
**文件路径**: `src/modules/utils/musicSdk/kg/songList.js`, `src/modules/utils/musicSdk/kg/musicInfo.js`
**修改目的**: 修复歌单详情歌曲列表无封面（硬编码为 null）的问题。
**核心修改**:
1. 将接口从 `v2` 升级到 `v3` (`gateway.kugou.com/v3/album_audio/audio`)。
2. 在 `fields` 请求参数中显式添加 `img,album_img` 字段。
3. 在解析函数中优化封面抓取逻辑，增加对 `{size}` 占位符的批量替换处理。
**修改代码**:
```javascript
// 请求字段增加 img,album_img，并升级 v3
let url = 'http://gateway.kugou.com/v3/album_audio/audio'
fields: 'album_info,author_name,audio_info,ori_audio_name,base,songname,classification,img,album_img'

// filterData2 解析逻辑 (匹配 V3 接口返回的 sizable_cover 和 union_cover)
img: (item.img || item.album_info?.sizable_cover || item.audio_info?.trans_param?.union_cover || item.album_info?.pic || item.album_info?.img || item.album_info?.s_img || '').replace('{size}', '400') || null
```




