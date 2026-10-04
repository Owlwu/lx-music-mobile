
export interface InitState {
  progress: LX.Sync.MusicFile.Progress
  plan: LX.Sync.MusicFile.PlanGroups | null
  localRoot: string
  remoteRoot: string
  remoteDeviceName: string
  /** 正在扫描/比较 */
  busy: boolean
  error: string
}

const state: InitState = {
  progress: {
    running: false,
    stage: 'idle',
    kind: '',
    path: '',
    actionIndex: 0,
    actionTotal: 0,
    fileBytes: 0,
    fileBytesTotal: 0,
    totalBytes: 0,
    doneBytes: 0,
    message: '',
    errors: [],
  },
  plan: null,
  localRoot: '',
  remoteRoot: '',
  remoteDeviceName: '',
  busy: false,
  error: '',
}

export default state
