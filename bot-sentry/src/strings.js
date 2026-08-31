export const STRINGS = {
  en: {
    flag:
      "Bot sentry: {model} judged @{username} to be automated{confidence}.{why} " +
      "A person should decide — this is a model's opinion, not a finding.",
    confidence: " ({percent}%)",
    // The prompt is sent to a model, not read by a member, so it stays in one
    // language: models follow English instructions most reliably, and every
    // installer's model would otherwise be judged on a translation nobody read.
  },
  zh_CN: {
    flag:
      "Bot sentry：{model} 判断 @{username} 是自动化账号{confidence}。{why} " +
      "请由人来决定——这是模型的意见，不是结论。",
    confidence: "（{percent}%）",
  },
};
