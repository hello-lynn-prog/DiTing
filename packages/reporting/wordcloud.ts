const boilerplate = new Set('发布 发布时间 来源 转载 责任编辑 编辑 作者 点击 阅读 全文 更多 相关新闻 新闻 返回 首页 登录 注册 分享 收藏 评论 免责声明 copyright rights reserved the and for with from this that are was were have has not you your'.split(' '));

/** Display filter only: dates, standalone numbers and page chrome are not topics. */
export function meaningfulWordCloudTerms(terms: string[]): string[] {
  return terms.filter(term => !/\d/u.test(term) && !boilerplate.has(term.toLowerCase()) && (/\p{Script=Han}{2,}/u.test(term) || /^[a-z][a-z-]{1,}$/iu.test(term)));
}
