<p align="center"><img width="200" src="./doc/images/icon.png" alt="lx-music logo"></p>

<h1 align="center">LX Music 移动版 · 本地播放分支</h1>

<p align="center">一个基于 React Native 开发的<b>纯本地音乐播放器</b>（Android）</p>

## 本分支说明

本仓库是 [lx-music-mobile](https://github.com/lyswhut/lx-music-mobile) 的**个人精简分支**，
已移除全部在线能力，只保留本地音乐播放与跨端同步：

- 播放本地音频（mp3 / flac / ogg / oga / wav / m4a），读取内嵌或同名歌词/封面
- 我的列表：文件夹/文件导入、排序、查重、导入导出 `.lxmc`
- 播放详情页（歌词滚动、封面、单曲音量/倍速）、横竖屏布局、桌面歌词（Android 悬浮窗）
- 文件管理器「用其他应用打开」音频即可播放
- 与 [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) 的跨端同步：列表 / 不喜欢列表 /
  **本地音乐文件同步**（PC 上已下载好的音乐文件同步到手机）

**已移除**：在线音源（酷我/酷狗/QQ/网易云/咪咕）、搜索、排行榜、在线歌单与歌单详情、评论、
自定义源（userApi / QuickJS）、版本检查与更新弹窗、内置下载、`lxmusic://` 分享协议、换源与音质切换。

> `FAQ.md`、`CHANGELOG.md` 来自上游，可能仍描述已移除的功能；以本文件与 `.ai/` 文档为准。

## 技术栈

- React Native 0.73（Android）
- react-native-navigation（原生栈导航）
- 自定义单例 store + 事件（无 Redux）
- react-native-track-player（音频）
- AsyncStorage + react-native-fs（持久化/文件）

已支持的平台：

- Android 5 及以上

***注：不支持 iOS / HarmonyOS NEXT**。*<br>
*桌面版项目地址：<https://github.com/lyswhut/lx-music-desktop>*

## 数据同步

移动端作为同步客户端连接桌面端（`设置 → 同步`），可同步我的列表、不喜欢列表；本地音乐文件同步
需在两端设置好音乐根目录后手动触发。

## 开发

```bash
npm install
npm start            # Metro
npm run dev          # 构建并安装到设备
npm run tsc          # 类型检查
npm run lint         # ESLint
npm run build-test   # Metro 打包校验（CI 同款）
npm run pack:android # release APK
```

架构、模块、数据流、坑位等详见 [`.ai/`](./.ai/) 目录（`PROJECT.md` 为入口）。
打包操作手册见仓库根目录的《如何打包成可以在android手机上直接安装的安装包操作手册.md》。

## 贡献代码

本分支为个人使用而维护，一般不接受功能类 PR；如果你发现问题，欢迎提 issue 或自行 fork。

上游项目的贡献说明见 [lx-music-mobile](https://github.com/lyswhut/lx-music-mobile)。

## 项目协议

本项目基于 [Apache License 2.0](LICENSE) 许可证发行，以下协议是对于 Apache License 2.0 的补充，
如有冲突，以以下协议为准。

---

*词语约定：本协议中的「本项目」指 LX Music（洛雪音乐）移动版项目；「使用者」指签署本协议的使用者。*

### 一、数据来源

1.1 本分支不含任何在线音源、在线数据抓取或自定义源能力，播放的全部音频文件均来自使用者本地设备。

1.2 本分支的「我的列表」等数据来自使用者本地系统或使用者连接的同步服务，本项目不对这些数据的
合法性、准确性负责。

### 二、版权数据

2.1 使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。
请尊重版权，支持正版。

### 三、资源使用

3.1 本项目内使用的部分包括但不限于字体、图片等资源来源于互联网。如果出现侵权可联系本项目移除。

### 四、免责声明

4.1 由于使用本项目产生的包括由于本协议或由于使用或无法使用本项目而引起的任何性质的任何直接、
间接、特殊、偶然或结果性损害（包括但不限于因商誉损失、停工、计算机故障或故障引起的损害赔偿，
或任何及所有其他商业损害或损失）由使用者负责。

### 五、使用限制

5.1 本项目完全免费，且开源发布，面向全世界人用作对技术的学习交流。本项目不对项目内的技术可能
存在违反当地法律法规的行为作保证。

5.2 **禁止在违反当地法律法规的情况下使用本项目。** 对于使用者在明知或不知当地法律法规不允许的
情况下使用本项目所造成的任何违法违规行为由使用者承担，本项目不承担由此造成的任何直接、间接、
特殊、偶然或结果性责任。

### 六、版权保护

6.1 音乐平台不易，请尊重版权，支持正版。

### 七、非商业性质

7.1 本项目仅用于对技术可行性的探索及研究，不接受任何商业合作及捐赠。

### 八、接受协议

8.1 若你使用了本项目，即代表你接受本协议。

---

若对此有疑问请 mail to: lyswhut+qq.com (请将 `+` 替换成 `@`)
