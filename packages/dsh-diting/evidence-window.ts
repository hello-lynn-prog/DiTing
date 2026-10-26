export function evidenceWindow(content: string, offset: number, limit: number) {
  const nextOffset=offset+limit, hasMore=nextOffset<content.length;
  return {total_chars:content.length,offset,content:content.slice(offset,nextOffset),has_more:hasMore,next_offset:hasMore?nextOffset:null};
}
