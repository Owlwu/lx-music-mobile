import * as list from './list'
import * as dislike from './dislike'
import * as musicFile from './musicFile'
// export * as theme from './theme'


export const callObj = Object.assign({},
  list.handler,
  dislike.handler,
  musicFile.handler,
)


export const modules = {
  list,
  dislike,
  musicFile,
}

export const featureVersion = {
  list: 1,
  dislike: 1,
  musicFile: 1,
} as const
