import { Component, type ErrorInfo, type ReactNode } from 'react'
import { View, Text } from 'react-native'
import { error as logError, flush } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'

interface Props {
  /** 屏幕名，便于区分是哪一个界面崩了 */
  name?: string
  children: ReactNode
}

interface State {
  errorMessage: string
}

/**
 * 界面级错误边界
 *
 * 背景：本项目此前**没有任何** componentDidCatch / ErrorBoundary（全局 grep 为 0 命中）。
 * React 对"渲染期未捕获异常"的默认行为是**卸载整棵组件树** —— 于是用户看到的就是
 * 全屏空白，而与此同时：
 *   - 原生前台播放服务仍在（通知栏还是"正在播放"）；
 *   - 原生悬浮歌词仍是最后一帧（看起来"歌词还正常显示"）；
 *   - 界面上的任何点击都不再有响应（组件树已经没了）。
 * 这与用户反馈的现象完全一致，而原实现不会留下任何可定位的记录。
 *
 * 有了这个边界：异常被拦在屏幕级 → 写 [RENDER] 日志并立即落盘 → 渲染一个可见的降级页，
 * 用户不必再"杀进程重开"，开发者也能拿到确切的错误栈。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { errorMessage: '' }

  static getDerivedStateFromError(error: unknown): State {
    try {
      return { errorMessage: (error as Error)?.message ?? String(error) }
    } catch (err) {
      return { errorMessage: 'unknown render error' }
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    try {
      logError('RENDER', 'react render error caught by boundary (UI would be blank without it)', {
        screen: this.props.name ?? 'unknown',
        name: (error as Error)?.name ?? '',
        message: (error as Error)?.message ?? String(error),
        stack: (error as Error)?.stack ?? '',
        componentStack: info?.componentStack ?? '',
      })
      markEvent('render.errorCaught', { screen: this.props.name ?? 'unknown' })
    } catch (err) {}
    void flush()
  }

  render(): ReactNode {
    if (this.state.errorMessage) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>界面渲染出错（已记录日志）</Text>
          <Text style={styles.titleEn}>UI render error (logged)</Text>
          <Text style={styles.message} selectable>{this.state.errorMessage}</Text>
          <Text style={styles.hint}>
            请返回上一页或重启应用；错误详情已写入运行时日志（设置 → 其他设置 → 错误日志）。
          </Text>
          <Text style={styles.hintEn}>
            Go back or restart the app. Details were written to the runtime log.
          </Text>
        </View>
      )
    }
    return this.props.children
  }
}

const styles = {
  container: {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingHorizontal: 24,
    backgroundColor: '#ffffff',
  },
  title: {
    fontSize: 16,
    fontWeight: 'bold' as const,
    color: '#d33',
    marginBottom: 2,
  },
  titleEn: {
    fontSize: 12,
    color: '#d33',
    marginBottom: 12,
  },
  message: {
    fontSize: 13,
    color: '#333',
    marginBottom: 16,
    textAlign: 'center' as const,
  },
  hint: {
    fontSize: 12,
    color: '#666',
    textAlign: 'center' as const,
    marginBottom: 2,
  },
  hintEn: {
    fontSize: 11,
    color: '#888',
    textAlign: 'center' as const,
  },
}
