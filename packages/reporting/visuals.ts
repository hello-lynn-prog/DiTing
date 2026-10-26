import { z } from 'zod';
import type { Row } from '../domain/db.js';
import {interactionDimensions} from './interactions.js';

const statement = z.object({ label: z.string().min(1).max(100), text: z.string().min(5).max(900), claim_ids: z.array(z.string()).min(1).max(20) }).strict();
/** Quantitative values come only from certified datasets; qualitative diagrams carry claims. */
export const reportVisualSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('dataset'),title:z.string().min(2).max(120),after_subsection:z.string().min(1).max(150).optional(),dataset_id:z.string(),style:z.enum(['bar','donut','line']).default('bar')}).strict(),
  z.object({kind:z.literal('matrix'),title:z.string().min(2).max(120),after_subsection:z.string().min(1).max(150).optional(),caption:z.string().min(5).max(400),items:z.array(statement).min(2).max(8)}).strict(),
  z.object({kind:z.literal('flow'),title:z.string().min(2).max(120),after_subsection:z.string().min(1).max(150).optional(),caption:z.string().min(5).max(400),items:z.array(statement).min(2).max(6)}).strict(),
]);
export function validateVisuals(sections:Row[], claims:Set<string>, tables:Row[]) {
  for(const section of sections)for(const visual of section.visuals||[]) {
    if(visual.kind==='dataset') {
      const table=tables.find(t=>t.id===visual.dataset_id);
      if(!table)throw Error('章节图表必须引用报告中的认证统计底表：'+section.title+' / '+visual.title+' / '+visual.dataset_id);
      if(visual.style==='line'&&!['publication_day','capture_day'].includes(table.dimension))throw Error('折线图只能采用有时间含义的底表');
      if(visual.style==='donut'&&['wordcloud','cluster'].includes(table.dimension))throw Error('词频和聚类不能绘制为占总体比例的饼图');
      if(visual.style==='donut'&&interactionDimensions.includes(table.dimension))throw Error('公开互动指标不能合并为跨平台公众占比');
    } else for(const item of visual.items)for(const id of item.claim_ids) {
      if(!claims.has(id)||!section.claim_ids.includes(id))throw Error('分析图每项必须引用本章已审查结论：'+section.title+' / '+visual.title+' / '+item.label+' / '+id);
    }
  }
}
