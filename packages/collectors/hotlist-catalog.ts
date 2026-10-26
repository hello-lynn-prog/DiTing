/** Exact 27 display channels found in the user's v5 HOTDATA snapshot.
 * Categories may display the same source twice; they are not independent facts.
 */
export const hotlistChannels = [
 ['news','腾讯新闻','qq-news'],['news','今日头条','toutiao'],['news','网易新闻','netease-news'],['news','百度热搜','baidu'],['news','澎湃新闻','thepaper'],['news','新浪新闻','sina-news'],
 ['ai','36氪','36kr'],['ai','GitHub Trending','github'],
 ['tech','IT之家','ithome'],['tech','少数派','sspai'],['tech','Solidot','solidot'],['tech','HackerNews','hackernews'],['tech','ProductHunt','producthunt'],
 ['media','微博热搜','weibo'],['media','抖音热点','douyin'],['media','B站热门','bilibili'],['media','知乎热榜','zhihu'],['media','快手热榜','kuaishou'],['media','贴吧热议','tieba'],['media','虎扑步行街','hupu'],
 ['fin','华尔街见闻','wallstreetcn'],['fin','财联社电报','cls'],['fin','金十数据','jin10'],['fin','雪球热帖','xueqiu'],
 ['stock','财联社-A股','cls'],['stock','新浪财经','sina-finance'],['stock','金十数据-A股','jin10'],
].map(([category,title,source_id])=>({category,title,source_id}));
