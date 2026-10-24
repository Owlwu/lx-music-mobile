// 手机端只提供对端 RPC（由 PC 发起同步时调用），不导出 compare/apply 之类的发起方逻辑
export { default as handler } from './handler'
