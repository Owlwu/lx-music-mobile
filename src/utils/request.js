// import needle from 'needle'
// import progress from 'request-progress'
import BackgroundTimer from 'react-native-background-timer'
import { requestMsg } from './message'

const defaultHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
}
// var proxyUrl = "http://" + user + ":" + password + "@" + host + ":" + port;
// var proxiedRequest = request.defaults({'proxy': proxyUrl});

/**
 * 请求超时自动重试
 * @param {*} url
 * @param {*} options
 */
export const httpFetch = (url, options = { method: 'get' }) => {
  const requestObj = fetchData(url, options)
  return {
    promise: requestObj.request.catch(err => {
      console.log('出错', err.message)
      switch (err.message) {
        case 'socket hang up':
          return Promise.reject(new Error(requestMsg.unachievable))
        case 'Aborted':
          return Promise.reject(new Error(requestMsg.timeout))
        case 'Network request failed':
          return Promise.reject(new Error(requestMsg.notConnectNetwork))
        default:
          return Promise.reject(err)
      }
    }),
    cancelHttp() {
      requestObj.abort()
    },
  }
}

/**
 * http get 请求
 * @param {*} url 地址
 * @param {*} options 选项
 * @param {*} callback 回调
 * @return {Number} index 用于取消请求
 */
export const httpGet = (url, options, callback) => {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  const requestObj = fetchData(url, { ...options, method: 'get' })
  requestObj.request.then(resp => {
    callback(null, resp, resp.body)
  }).catch(err => {
    // debugRequest && console.log(JSON.stringify(err))
    callback(err, null, null)
  })

  return () => {
    requestObj.abort()
  }
}

/*
const fetchWithTimeout = (resource, options) => {
  const { timeout = 8000 } = options

  const controller = new global.AbortController()
  const id = BackgroundTimer.setTimeout(() => controller.abort(), timeout)

  return {
    request: global.fetch(resource, {
      ...options,
      signal: controller.signal,
    }).then(response => {
      BackgroundTimer.clearTimeout(id)
      return response
    }),
    abort() {
      controller.abort()
    },
  }
} */

const handleRequestData = async(url, {
  method = 'get',
  headers = {},
  format = 'json',
  cache = 'no-store',
  ...options
}) => {
  // console.log(url, options)
  headers = Object.assign({
    Accept: 'application/json',
  }, headers)
  options.cache = cache
  if (method.toLocaleLowerCase() === 'post' && !headers['Content-Type']) {
    if (options.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      const formBody = []
      for (let [key, value] of Object.entries(options.form)) {
        let encodedKey = encodeURIComponent(key)
        let encodedValue = encodeURIComponent(value)
        formBody.push(`${encodedKey}=${encodedValue}`)
      }
      options.body = formBody.join('&')
      delete options.form
    } else if (options.formData) {
      headers['Content-Type'] = 'multipart/form-data'
      const formBody = []
      for (let [key, value] of Object.entries(options.form)) {
        let encodedKey = encodeURIComponent(key)
        let encodedValue = encodeURIComponent(value)
        formBody.push(`${encodedKey}=${encodedValue}`)
      }
      options.body = options.formData
      delete options.formData
    } else {
      headers['Content-Type'] = 'application/json'
    }
  }
  if (headers['Content-Type'] === 'application/json' && options.body) {
    options.body = JSON.stringify(options.body)
  }

  return {
    ...options,
    method,
    headers: Object.assign({}, defaultHeaders, headers),
  }
}

// https://stackoverflow.com/a/64945178
const blobToBuffer = (blob) => {
  return new Promise((resolve, reject) => {
    const reader = new global.FileReader()
    reader.onerror = reject
    reader.onload = () => {
      const data = reader.result.slice(reader.result.indexOf('base64,') + 7)
      resolve(Buffer.from(data, 'base64'))
    }
    reader.readAsDataURL(blob)
  })
}

const httpUrlRxp = /^https?:\/\//i

const fetchData = (url, { timeout = 15000, ...options }) => {
  // 硬白名单：只允许 http(s)。本地 file:/content: 若走 RN fetch，会被 BlobModule 的
  // UriHandler 无视 method 地整文件读入，再由 Response.text() 经 FileReaderModule.readAsText
  // 解码成巨型字符串；大文件 OutOfMemoryError 会杀死 mqt_native_modules 线程，导致
  // 所有 JS→原生调用永久排队（App 假死/白屏）。本地文件请用 react-native-fs / 原生模块。
  if (typeof url !== 'string' || !httpUrlRxp.test(url)) {
    return {
      request: Promise.reject(new Error('fetchData: 仅支持 http(s) URL')),
      abort() {},
    }
  }

  console.log('---start---', url)

  const controller = new global.AbortController()
  let id = BackgroundTimer.setTimeout(() => {
    id = null
    controller.abort()
  }, timeout)

  return {
    request: handleRequestData(url, options).then(options => {
      return global.fetch(url, {
        ...options,
        signal: controller.signal,
      }).then(resp => (options.binary ? resp.blob() : resp.text()).then(text => {
        // console.log(options, headers, text)
        return {
          headers: resp.headers.map,
          body: text,
          statusCode: resp.status,
          statusMessage: resp.statusText,
          url: resp.url,
          ok: resp.ok,
        }
      })).then(resp => {
        if (options.binary) {
          return blobToBuffer(resp.body).then(buffer => {
            resp.body = buffer
            return resp
          })
        } else {
          try {
            resp.body = JSON.parse(resp.body)
          } catch {}
          return resp
        }
      }).catch(err => {
        // console.log(err, err.code, err.message)
        return Promise.reject(err)
      }).finally(() => {
        if (id == null) return
        BackgroundTimer.clearTimeout(id)
      })
    }),
    abort() {
      controller.abort()
    },
  }
}

/**
 * 判断是否为本地文件 URL（file: / content:，大小写不敏感；兼容 file:/ 与 file:// 写法）
 * @param {string} url
 * @returns {boolean}
 */
export const isLocalFileUrl = (url) => {
  return typeof url === 'string' && /^(file|content):/i.test(url)
}

export const checkUrl = async(url, options = {}) => {
  if (isLocalFileUrl(url)) {
    // 本地文件 URL 绝不能走 HTTP 探测：RN Android 的 fetch 对非 http(s) URL 会经 BlobModule
    // 的 UriHandler 把整个文件读入内存，随后 Response.text() 调 FileReaderModule.readAsText
    // 把文件解码成 Java 字符串；音频大文件（几十 MB 的 FLAC 等）会 OutOfMemoryError，
    // 该错误逃出 catch(Exception) 后杀死 mqt_native_modules 线程，导致 JS→原生调用永久排队。
    throw new Error('checkUrl: 本地文件 URL 不做 HTTP 探测')
  }
  return fetchData(url, { method: 'head', ...options }).request.then(resp => {
    if (resp.statusCode === 200) {
      return Promise.resolve()
    } else {
      throw new Error(resp.statusCode)
    }
  })
}
