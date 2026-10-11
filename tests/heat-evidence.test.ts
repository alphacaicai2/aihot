// Isolation and withdrawals apply to event signals and every saved hot ranking, before republishing.
import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { publishArticle } from '@aihot/backend/publication/publish';
import { groupArticle } from '@aihot/backend/events/group';
import { computeHotRanking, snapshotHeat } from '@aihot/backend/events/hot';
import { latestHotRanking, rankingExtras } from '@aihot/backend/events/hot-read';
import { setVisibility } from '@aihot/backend/admin/content';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { buildApp } from '../apps/api/src/app.ts';
const t=tag(), app=await buildApp();
const rankings:number[]=[];
after(async()=>{if(rankings.length)await sql`DELETE FROM hot_rankings WHERE id=ANY(${rankings}::bigint[])`;await app.close();await stopBoss();await closeDb();});
async function story(){const [s]=await sql<{id:number;public_id:string}[]>`INSERT INTO stories(public_id,title,origin) VALUES(${randomUUID()},${`热点 ${tag()}`},'model') RETURNING id,public_id`;return s!;}
async function material(mode:'editorial'|'hot_signal'|'isolated', s?:number){
 const source=`heat-${tag()}`;
 await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${source},${source},'rss','T1',${mode},'2100-01-01')`;
 const {articleId:id}=await upsertMaterial({sourceId:source,url:`https://example.com/${source}`,title:'事件报道',bodyText:'报道正文',bodyStatus:'ok',publishedAt:new Date(Date.now()-3600000),via:'fetch'});
 await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected) VALUES(${id},1,'rule','pass','事件报道','当前报道摘要',80,false)`;
 if(s){const [f]=await sql<{id:number}[]>`INSERT INTO facts(public_id,story_id,title) VALUES(${tag()},${s},'事件事实') RETURNING id`;await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${f!.id},${id},'report')`;}
 await publishArticle(id);
 return {id,source};
}
async function signal(s:number,a:{id:string;source:string},kind='editorial'){
 await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at) VALUES(${s},${a.id},${`source:${a.source}`},${a.source},${kind},now()-interval '1 hour')`;
}
async function rank(){const r=await computeHotRanking();rankings.push(r.id);return latestHotRanking();}

test('forced grouping cannot turn isolated material into a native discussion signal',async()=>{
 const s=await story(),report=await material('editorial',s.id),isolated=await material('isolated');
 const key=`heat-native-${t}`;
 await sql`UPDATE articles SET identity_key=${`x:${key}`} WHERE id=${report.id}`;
 await sql`UPDATE articles SET x_post=${sql.json({tweetId:`isolated-${t}`,replyTo:key,text:'引用这条事件'})} WHERE id=${isolated.id}`;
 const [before]=await sql`SELECT count(*)::int AS n FROM receipts`;
 assert.equal((await groupArticle(isolated.id,{force:true,signalOnly:true})).verdict,'skipped');
 assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id=${isolated.id}`).length,0);
 assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0]!.n,before!.n);
});

test('an explicitly withdrawn discussion cannot rejoin through forced grouping',async()=>{
 const s=await story(),report=await material('editorial',s.id),post=await material('hot_signal');
 const key=`withdrawn-native-${tag()}`;
 await sql`UPDATE articles SET identity_key=${`x:${key}`} WHERE id=${report.id}`;
 await sql`UPDATE articles SET x_post=${sql.json({tweetId:tag(),replyTo:key,text:'已撤回的讨论'})} WHERE id=${post.id}`;
 await setVisibility(post.id,{visibility:'withdrawn',reason:'withdraw signal',version:0},'test');
 assert.equal((await groupArticle(post.id,{force:true,signalOnly:true})).verdict,'skipped');
 assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id=${post.id}`).length,0);
});

test('heat and hourly snapshots count only currently visible editorial and discussion evidence',async()=>{
 const s=await story(),ed=await material('editorial',s.id),discussion=await material('hot_signal'),isolated=await material('isolated'),withdrawn=await material('editorial',s.id);
 await signal(s.id,ed);await signal(s.id,discussion,'signal');await signal(s.id,isolated,'signal');await signal(s.id,withdrawn);
 await setVisibility(withdrawn.id,{visibility:'withdrawn',reason:'withdraw evidence',version:0},'test');
 const ranking=await rank(),entry=ranking!.entries.find(e=>e.storyId===s.id)!;
 assert.ok(entry);
 assert.deepEqual([entry.participantCount,entry.sourceCount,entry.signalCount],[2,1,1]);
 assert.ok(!entry.participants.some(p=>p.name===isolated.source || p.name===withdrawn.source));
 await snapshotHeat();
 const [hour]=await sql`SELECT participants,cohort FROM story_heat_hourly WHERE story_id=${s.id} ORDER BY hour DESC LIMIT 1`;
 assert.deepEqual([hour!.participants,hour!.cohort],[2,1]);
});

test('a saved ranking stops exposing an isolated source immediately on site and v1',async()=>{
 const s=await story(),a=await material('editorial',s.id),b=await material('hot_signal');await signal(s.id,a);await signal(s.id,b,'signal');
 assert.ok((await rank())!.entries.some(e=>e.storyId===s.id));
 await sql`UPDATE sources SET participation_mode='isolated',updated_at=now() WHERE id=${b.source}`;
 // Before a republish worker or another ranking has run: the saved snapshot must not leak it.
 assert.ok(!(await latestHotRanking())!.entries.some(e=>e.storyId===s.id));
 const site=await app.inject({url:'/api/site/hot'}),v1=await app.inject({url:'/api/v1/hot-topics'});
 assert.equal(site.statusCode,200);assert.equal(v1.statusCode,200);
 assert.ok(!site.body.includes(s.public_id) && !site.body.includes(b.source));
 assert.ok(!v1.body.includes(s.public_id));
});

test('withdrawing a ranked representative hides the stale ranking before the next calculation',async()=>{
 const s=await story(),a=await material('editorial',s.id),b=await material('editorial',s.id);await signal(s.id,a);await signal(s.id,b);
 const ranking=await rank(),entry=ranking!.entries.find(e=>e.storyId===s.id)!;
 await setVisibility(entry.representativeItemId!,{visibility:'withdrawn',reason:'withdraw ranked report',version:0},'test');
 assert.ok(!(await latestHotRanking())!.entries.some(e=>e.storyId===s.id));
});

test('ranking extras reread corrected summaries even while the ranking id remains unchanged',async()=>{
 const s=await story(),a=await material('editorial',s.id),b=await material('hot_signal');await signal(s.id,a);await signal(s.id,b,'signal');
 await sql`UPDATE stories SET digest='更正前的综述',latest='更正前的进展' WHERE id=${s.id}`;
 const ranking=(await rank())!,entry=ranking.entries.find(e=>e.storyId===s.id)!;
 assert.equal((await rankingExtras(ranking)).text(entry).summary,'更正前的综述');
 await sql`UPDATE stories SET digest=NULL,summary=NULL,latest=NULL,version=version+1 WHERE id=${s.id}`;
 assert.deepEqual((await rankingExtras(ranking)).text(entry),{summary:null,latest:null});
});

test('new valid reports keep the existing snapshot and current titles without exposing internal witnesses',async()=>{
 const s=await story(),a=await material('editorial',s.id),b=await material('editorial',s.id);await signal(s.id,a);await signal(s.id,b);
 const ranking=(await rank())!,original=ranking.entries.find(e=>e.storyId===s.id)!;
 assert.ok(original.evidence?.signals.length);
 const added=await material('editorial',s.id);await signal(s.id,added);
 await sql`UPDATE stories SET title='编辑已更正的热点标题',version=version+1 WHERE id=${s.id}`;
 const current=(await latestHotRanking())!,entry=current.entries.find(e=>e.storyId===s.id)!;
 assert.ok(entry,'new evidence must not remove a still-valid snapshot');
 assert.equal(current.id,ranking.id);
 assert.equal(entry.title,'编辑已更正的热点标题');
 assert.equal(entry.participantCount,2,'counts retain the snapshot time');
 const response=await app.inject({url:'/api/site/hot'});
 assert.ok(response.body.includes('编辑已更正的热点标题'));
 assert.ok(!response.body.includes('participantKey') && !response.body.includes('reportIds'),'internal witnesses stay out of public payloads');
});

test('revoking full-text permission removes a cached hot cover without waiting for a new ranking',async()=>{
 const s=await story(),a=await material('editorial',s.id),b=await material('hot_signal');await signal(s.id,a);await signal(s.id,b,'signal');
 await sql`UPDATE sources SET site_fulltext=true WHERE id=${a.source}`;
 await sql`UPDATE articles SET media=${sql.json([{kind:'image',url:'https://example.com/public-cover.png',width:800,height:600}])} WHERE id=${a.id}`;
 await publishArticle(a.id);
 const r=(await rank())!;
 const before=(await app.inject({url:'/api/site/hot'})).json();
 assert.ok(before.entries.find((e:{story:{publicId:string}})=>e.story.publicId===s.public_id)?.cover);
 await sql`UPDATE sources SET site_fulltext=false WHERE id=${a.source}`;
 await publishArticle(a.id);
 assert.equal((await latestHotRanking())!.id,r.id);
 const after=(await app.inject({url:'/api/site/hot'})).json();
 assert.equal(after.entries.find((e:{story:{publicId:string}})=>e.story.publicId===s.public_id)?.cover,null);
});
