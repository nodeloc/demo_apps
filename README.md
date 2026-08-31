# NodeLoc demo apps

一组跑在 [NodeLoc](https://www.nodeloc.com) 社区应用平台（discourse-apps）沙箱里的示例应用，**仅供参考**：
展示 handler 怎么写、effects 怎么声明、以及「页面说什么都不算数」的服务端权威模式在真实玩法里长什么样。

A collection of example apps for the NodeLoc community app platform (discourse-apps),
**for reference only**. They demonstrate handler patterns, declared effects, and the
"nothing the page claims is trusted" model applied to real gameplay and moderation.

## 应用清单

| 目录 | Surface | 一句话 |
|---|---|---|
| [`stellar-quest`](stellar-quest/) | webview | 星球探索——用社区能量驱动的宇宙收集游戏：燃料罐把 `points.spend` 确认框映射进流畅探索循环，40 天体全程序化 CSS 绘制 |
| [`sky-raid`](sky-raid/) | webview | 纵版射击。页面只录按键，服务端用同一份模拟逐帧重放算分——排行榜上没有人能撒谎（另见独立仓库 [nodeloc/sky-raid](https://github.com/nodeloc/sky-raid)） |
| [`bot-sentry`](bot-sentry/) | service | 问一个模型某账号像不像机器，把答案交给人（打旗标）而不是自己动手 |
| [`welcome-bot`](welcome-bot/) | service | 只在成员开出第一个主题时回一次欢迎，然后不再打扰 |
| [`remind-me`](remind-me/) | service | 帖子里写 `!remindme 2h`，时间到了把主题顶回来 |
| [`daily-thread`](daily-thread/) | service | 每天在指定分类开同一个主题（`onInstall` 注册首个定时任务的范式） |
| [`keyword-guard`](keyword-guard/) | service | 命中规则的帖子得到规则携带的回复，规则由节点主自己配置 |
| [`repo-info`](repo-info/) | service | 有人贴 GitHub 链接，机器人说出链接那头是什么（`http.fetch` → `onFetch` 的往返范式） |
| [`node-notice`](node-notice/) | service | 在新主题下张贴节点公告并保持置顶 |

## 跑测试

Handler 是纯 JS，可以在本地直接对着打包产物测——`handlers.test.mjs` 用一个假 host
（预取的 reads 进、声明的 effects 出）验证每个应用的决策逻辑：

```bash
# 需要 nodeloc-apps CLI 的源码提供打包器；默认取本仓库的同级目录
NODELOC_APPS_CLI=/path/to/nodeloc-apps-cli node --test handlers.test.mjs
```

## 平台文档

- 应用开发指南：https://docs.nodeloc.com/miniprogram/introduction
- Handler 与权限：https://docs.nodeloc.com/miniprogram/handlers

## 说明

这些应用按当时的平台能力编写，不保证与最新平台行为完全一致；请以平台文档为准。
欢迎拿去改，出了问题概不负责。 :)
